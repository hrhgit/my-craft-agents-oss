/**
 * Pi Backend (Pi RpcClient)
 *
 * Thin host-side adapter for the Pi coding agent. Uses Pi's public RpcClient
 * API and keeps Mortise-specific host bridges and UI event translation on the
 * host side.
 *
 * Pi owns agent runtime, session storage, provider/model registry, and native
 * extension execution. Mortise talks to it through RpcClient only.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import type { AgentEvent } from '@mortise/core/types';
import type { AgentMessage } from '@mortise/pi-agent-core';
import type { FileAttachment } from '../utils/files.ts';
import { atomicWriteFile } from '../utils/files.ts';
import { createSanitizedEnv } from '../utils/env.ts';
import { getProxyEnvVars } from '../config/proxy-env.ts';
import { MORTISE_PROJECT_DIR } from '../config/paths.ts';
import { getPiAgentDir, isPiModelReference, resolvePiModelReference } from '../config/pi-global-config.ts';
import {
  type PiRuntimeHandle,
  type RpcCapabilities as PiRpcCapabilities,
  type RpcClientEvent as PiRpcClientEvent,
  type RpcClientOptions as PiRpcClientOptions,
  type RpcCommandType as PiRpcCommandType,
  type RpcHostToolResult as PiRpcHostToolResult,
  type RpcExtensionHostCapabilityResponse as PiRpcExtensionHostCapabilityResponse,
} from '@mortise/pi-coding-agent/internal/rpc';
import { piHostManager, type PiHostLease } from './backend/pi-host-manager.ts';
import { createMortiseRpcUiCapabilities } from './backend/pi/rpc-ui-capabilities.ts';

import type {
  BackendConfig,
  BackendRuntimeUpdate,
  ChatOptions,
  ChildAttemptRegistration,
  ChildTaskActivityEvent,
  ExtensionBridgeEvent,
  HostQueuedUserProjection,
  HostQueuedCancellationProjection,
  HostRuntimeErrorProjection,
  PiExtensionCommand,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';
import type { ExtensionContributionV1 } from '../protocol/extension-contributions.ts';
import type { ExtensionUIValidationDeltaV1 } from '../protocol/extension-ui-validation.ts';
import type { ExtensionServiceCatalogDTO, ExtensionServiceProviderDTO, ExtensionServiceResultDTO } from '../protocol/extension-services.ts';
import {
  validateExtensionInteractionRequestV1,
  validateExtensionInteractionResponseV1,
  type ExtensionInteractionCancelReasonV1,
  type ExtensionInteractionResponseV1,
} from '../protocol/extension-interactions.ts';

import type { ThinkingLevel } from './thinking-levels.ts';

// Import models from centralized registry
import { getModelById } from '../config/models.ts';

// BaseAgent provides common functionality
import { BaseAgent } from './base-agent.ts';
import type { Workspace } from '../config/storage.ts';

// Event adapter
import { PiEventAdapter } from './backend/pi/event-adapter.ts';
import { PiProjectionBuilder } from './backend/pi/projection-builder.ts';
import { EventQueue } from './backend/event-queue.ts';

// System prompt for Mortise Agent context
import { getSystemPrompt } from '../prompts/system.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';

// Credential manager for token storage
import { getCredentialManager } from '../credentials/manager.ts';

// Session-scoped tool callbacks.
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  setLastPlanFilePath,
} from './session-scoped-tools.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';

// Session host-tool definitions (registered with Pi RpcClient)
import {
  getSessionHostToolDefs,
  PI_EXTENSION_OWNED_SESSION_TOOL_NAMES,
  SESSION_TOOL_NAMES,
} from './backend/pi/session-tool-defs.ts';

// Session tool registry (for executing proxy tool calls)
import {
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  type ToolResult as SessionToolResult,
  type TextContent,
} from '@mortise/session-tools-core';
import { createSessionToolContext, type SessionToolContext } from './session-tool-context.ts';

import { homedir } from 'os';

// Session storage (plans folder path)
import { getSessionPath, getPiNativeSessionDir } from '../sessions/storage.ts';

// Error typing
import { parseError, type AgentError } from './errors.ts';

// Centralized PreToolUse pipeline
import { runPreToolUseChecks, type PreToolUseCheckResult } from './core/pre-tool-use.ts';
import { getRtkPath } from './core/rtk-detector.ts';
import { getRtkEnabled, getPiShellFullPassthrough } from '../config/storage.ts';
import {
  getCustomCompactionPrompt,
  getCustomSystemPrompt,
  getDisabledAgentTools,
  resolveMainAgentSystemPrompt,
  type AgentRuntimeProfile,
} from '../config/agent-settings.ts';
import type { RtkContext } from './core/rtk-rewrite.ts';

// Workspace slug extraction for skill qualification
import { extractWorkspaceSlug } from '../utils/workspace.ts';

// LLM tool types
import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import { writeRuntimeLog, type RuntimeLogLevel } from '../utils/runtime-log.ts';
import {
  WorkspaceCoordinationBridge,
} from './workspace-coordination-bridge.ts';

// ============================================================
// PiAgent Implementation
// ============================================================

/** Backend-executed session tools currently supported by PiAgent. */
export const PI_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
  'subagent',
]);

const PI_ABORT_ACK_TIMEOUT_MS = 5_000;
const CHILD_RUNTIME_CLEANUP_SETTLEMENT_TIMEOUT_MS = 60_000;
const SETTLED_EXTENSION_INTERACTION_TTL_MS = 5 * 60_000;
const MAX_SETTLED_EXTENSION_INTERACTIONS = 512;
const PI_AGENT_DIR = getPiAgentDir();

interface PendingExtensionInteractionOwner {
  extensionId: string;
  runtimeId: string;
  sessionId: string;
  clientId?: string;
  wireSessionId?: string;
}

const AWS_ENVIRONMENT_AUTH_VARS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_SDK_LOAD_CONFIG',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_EC2_METADATA_DISABLED',
] as const;

type PiRpcToolExecutionRequest = Extract<PiRpcClientEvent, { type: 'tool_execution_request' }>;
type PiRpcToolExecuteRequest = Extract<PiRpcClientEvent, { type: 'tool_execute_request' }>;
type PiRpcToolResultRequest = Extract<PiRpcClientEvent, { type: 'tool_result_request' }>;
type PiSessionRpcClient = PiRuntimeHandle;
interface PiCoordinationRpcClient {
  setToolResultHandler(
    handler: ((request: PiRpcToolResultRequest) => Promise<void>) | null,
  ): Promise<void>;
}
type PiRpcHostToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  label?: string;
  promptSnippet?: string;
};

/**
 * Map a transport `err.code` to an agent-facing string for `browser_tool` failures.
 * Returns null for unknown codes so callers can fall back to the raw `err.message`.
 *
 * Receiver-side check: keyed on `err.code === 'X'`, never `instanceof CodedError` —
 * the transport reconstructs a plain `Error` with `.code` attached.
 */
export function mapBrowserToolErrorCode(code: string): string | null {
  switch (code) {
    case 'BROWSER_NO_CAPABLE_CLIENT':
    case 'CAPABILITY_UNAVAILABLE':
      return 'No connected desktop client supports browser tools, or no client is currently connected. ' +
        'Ask the user to open this workspace from the Mortise Agent desktop app.';
    case 'CLIENT_DISCONNECTED':
      return 'The desktop client that owned this browser session disconnected. ' +
        'Ask the user to reconnect and retry.';
    case 'CLIENT_REQUEST_TIMEOUT':
      return 'Browser operation timed out (>30s). The desktop client may be unresponsive.';
    case 'BROWSER_INSTANCE_NOT_OWNED':
      return 'That browser instance ID doesn\'t belong to this session. ' +
        'Use `windows` to list owned instances, or `open` to create a new one.';
    case 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED':
      return 'File upload from a remote agent is not supported. ' +
        'Ask the user to attach the file to the session.';
    case 'BROWSER_REMOTE_EVALUATE_BLOCKED':
      return 'JavaScript evaluation is disabled on this desktop client. ' +
        'Ask the user to enable it in settings.';
    default:
      return null;
  }
}

// ============================================================
// Pi session tree types (subagent tool -> Pi spawnChildSession)
// ============================================================

/** Options for spawning a child session — matches pi's SpawnChildSessionOptions. */
export interface PiSpawnChildSessionOptions {
  prompt?: string;
  connection?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  name?: string;
  attachments?: Array<{ path: string; name?: string }>;
  template?: string;
  systemPrompt?: string;
  tools?: string[];
  background?: boolean;
  agent?: string;
  forkTurns?: number | 'all';
  schema?: Record<string, unknown>;
}

/** Result of spawning a child session in the pi session tree. */
export interface PiSpawnChildSessionResult {
  sessionId: string;
  sessionPath: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  output?: string;
}

/** Info about a child session in the pi session tree (filtered by spawnedFrom). */
export interface PiChildSessionInfo {
  sessionId: string;
  sessionPath: string;
  name?: string;
  cwd: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  lastOutput?: string;
  error?: string;
  persistedClientMutationIds: string[];
  history: Array<{
    role: string;
    text: string;
    timestamp?: number;
    stopReason?: string;
    clientMutationId?: string;
  }>;
  spawnConfig?: {
    connection?: string;
    model?: string;
    thinkingLevel?: string;
    template?: string;
    systemPrompt?: string;
    tools?: string[];
    background?: boolean;
    backgroundOperationId?: string;
    agent?: string;
    forkTurns?: number | 'all';
    seedMessageCount?: number;
    schema?: Record<string, unknown>;
  };
}

type ReliableForkMessage = Extract<AgentMessage, { role: 'user' | 'assistant' }>;

function selectReliableForkMessages(messages: AgentMessage[], forkTurns?: number | 'all'): ReliableForkMessage[] {
  if (forkTurns === undefined) return [];
  const reliable = messages.flatMap((message): ReliableForkMessage[] => {
    if (message.role === 'user') return [message];
    if (message.role !== 'assistant' || (message.stopReason !== 'stop' && message.stopReason !== 'length')) return [];
    const content = message.content.filter(block => block.type === 'text');
    if (content.length === 0) return [];
    return [{ ...message, content }];
  });
  const firstUserIndex = reliable.findIndex(message => message.role === 'user');
  if (firstUserIndex < 0) return [];
  const completeHistory = reliable.slice(firstUserIndex);
  if (forkTurns === 'all') return completeHistory;
  let remaining = forkTurns;
  let start = completeHistory.length;
  for (let index = completeHistory.length - 1; index >= 0; index -= 1) {
    if (completeHistory[index]?.role !== 'user') continue;
    remaining -= 1;
    if (remaining === 0) {
      start = index;
      break;
    }
  }
  return completeHistory.slice(start);
}

interface ChildInboxMessage {
  id: string;
  message: string;
  state: 'pending' | 'delivered';
  createdAt: string;
}

interface ChildInbox {
  schemaVersion: 1;
  messages: ChildInboxMessage[];
}

const MAX_PENDING_CHILD_INBOX_MESSAGES = 100;

/**
 * Backend implementation using the Pi coding agent SDK via RpcClient.
 *
 * Extends BaseAgent for common coordination, planning heuristics, config
 * watching, and usage tracking.
 */
export class PiAgent extends BaseAgent {
  protected backendName = 'Mortise Backend';

  // ============================================================
  // Pi RpcClient State
  // ============================================================

  private rpcClient: PiSessionRpcClient | null = null;
  private rpcHostLease: PiHostLease | null = null;
  private readonly childRuntimeLeases = new Set<PiHostLease>();
  private readonly childRuntimeClientSubscriptions = new Map<string, {
    refCount: number;
    unsubscribe: () => void;
  }>();
  private readonly childCoordinationBridges = new Map<string, WorkspaceCoordinationBridge>();
  private readonly childRuntimeAcquisitions = new Set<Promise<void>>();
  private readonly childInboxWrites = new Map<string, Promise<void>>();
  private childRuntimeEpoch = 0;
  private childRuntimeDisposed = false;
  private childRuntimeTeardown: Promise<void> | null = null;
  private rpcClientReady: Promise<void> | null = null;
  private rpcCapabilities: PiRpcCapabilities | null = null;
  private unsubscribePiEvent: (() => void) | null = null;
  private unsubscribePiClientEvent: (() => void) | null = null;
  private rpcProcessFailureHandled = false;

  // Pi session ID (managed by Pi, reported back through RpcClient)
  private piSessionId: string | null = null;

  // State
  private _isProcessing: boolean = false;
  private abortReason?: AbortReason;

  // Event adapter
  private adapter: PiEventAdapter;
  private projectionBuilder: PiProjectionBuilder | null = null;
  private projectionEpoch = randomUUID();
  private activeAttemptId: string | undefined;
  /** Ignore late content events while Pi is acknowledging an abort. */
  private suppressAbortedTurnEvents = false;
  private readonly agentSettledWaiters = new Map<string, Set<() => void>>();
  private settlementRetry: {
    attemptId: string;
    runtime: PiSessionRpcClient;
    attempt: number;
    timer?: ReturnType<typeof setTimeout>;
    inFlight: boolean;
  } | undefined;

  // This queue observes one chat() call. Canonical projection delivery belongs
  // to the long-lived runtime subscription and does not depend on this queue.
  private activeEventStream: { attemptId?: string; queue: EventQueue } | undefined;

  private waitForAgentSettled(attemptId: string): Promise<void> {
    return new Promise(resolve => {
      const finish = () => resolve();
      const waiters = this.agentSettledWaiters.get(attemptId) ?? new Set<() => void>();
      waiters.add(finish);
      this.agentSettledWaiters.set(attemptId, waiters);
    });
  }

  private resolveAgentSettledWaiters(attemptId: string): void {
    const waiters = [...(this.agentSettledWaiters.get(attemptId) ?? [])];
    this.agentSettledWaiters.delete(attemptId);
    for (const resolve of waiters) resolve();
  }

  private resolveAllAgentSettledWaiters(): void {
    for (const attemptId of this.agentSettledWaiters.keys()) {
      this.resolveAgentSettledWaiters(attemptId);
    }
  }

  private completeActiveAttempt(attemptId: string): void {
    this.clearSettlementRetry(attemptId);
    this.resolveAgentSettledWaiters(attemptId);
    if (this.activeEventStream?.attemptId === attemptId) {
      this.activeEventStream.queue.complete();
      this.activeEventStream = undefined;
    }
    if (this.activeAttemptId === attemptId) {
      this.activeAttemptId = undefined;
      this._isProcessing = false;
    }
  }

  /**
   * A runtime replacement cannot emit Pi's final agent_settled event after its
   * subscriptions are removed. Close every Mortise waiter at that same boundary
   * so the active chat generator cannot remain suspended on a retired runtime.
   */
  private settleTurnForRuntimeReplacement(): void {
    this.clearSettlementRetry();
    this.resolveAllAgentSettledWaiters();
    this.coordinationBridge?.completeTurn();
    this.activeEventStream?.queue.complete();
    this.activeEventStream = undefined;
    this.activeAttemptId = undefined;
    this._isProcessing = false;
  }

  private clearSettlementRetry(attemptId?: string): void {
    const retry = this.settlementRetry;
    if (!retry || (attemptId && retry.attemptId !== attemptId)) return;
    if (retry.timer) clearTimeout(retry.timer);
    this.settlementRetry = undefined;
  }

  private scheduleSettlementRetry(attemptId: string, reportedAttempt: number): void {
    const runtime = this.rpcClient;
    if (!runtime || this.activeAttemptId !== attemptId) return;
    let retry = this.settlementRetry;
    if (!retry || retry.attemptId !== attemptId || retry.runtime !== runtime) {
      this.clearSettlementRetry();
      retry = { attemptId, runtime, attempt: reportedAttempt, inFlight: false };
      this.settlementRetry = retry;
    } else {
      retry.attempt = Math.max(retry.attempt, reportedAttempt);
    }
    if (retry.timer || retry.inFlight) return;

    const delayMs = Math.min(30_000, 250 * (2 ** Math.min(7, Math.max(0, retry.attempt - 1))));
    const scheduledRetry = retry;
    scheduledRetry.timer = setTimeout(() => {
      if (
        this.settlementRetry !== scheduledRetry
        || this.activeAttemptId !== attemptId
        || this.rpcClient !== runtime
      ) return;
      scheduledRetry.timer = undefined;
      scheduledRetry.inFlight = true;
      const attempted = scheduledRetry.attempt;
      void runtime.retrySettlement(attemptId).catch(error => {
        this.writePiRuntimeLog('warn', 'runtime.settlement_retry_failed', {
          attemptId,
          attempt: attempted,
          error,
        });
      }).finally(() => {
        if (this.settlementRetry !== scheduledRetry) return;
        scheduledRetry.inFlight = false;
        if (this.activeAttemptId === attemptId && this.rpcClient === runtime) {
          scheduledRetry.attempt = Math.max(scheduledRetry.attempt, attempted + 1);
          this.scheduleSettlementRetry(attemptId, scheduledRetry.attempt);
        }
      });
    }, delayMs);
    scheduledRetry.timer.unref?.();
  }

  private stopRpcClientDetached(reason: string): void {
    void this.stopRpcClient().catch(error => {
      this.writePiRuntimeLog('warn', 'host.runtime_detached_cleanup_failed', { reason, error });
    });
  }

  // Error deduplication — suppress identical consecutive errors after a threshold.
  private lastRpcError: string | null = null;
  private rpcErrorRepeatCount = 0;
  private static readonly MAX_IDENTICAL_RPC_ERRORS = 3;

  private resetRpcErrorDedup(): void {
    this.lastRpcError = null;
    this.rpcErrorRepeatCount = 0;
  }

  /** Returns the most recent Pi RpcClient stderr output. Empty string if nothing captured. */
  getRecentStderr(): string {
    return this.rpcClient?.getStderr() ?? '';
  }

  private writePiRuntimeLog(level: RuntimeLogLevel, event: string, meta?: Record<string, unknown>): void {
    writeRuntimeLog(level, {
      scope: 'pi-rpc',
      event,
      meta: {
        sessionId: this.config.session?.mortiseId,
        piSessionId: this.piSessionId,
        workspaceId: this.config.workspace.id,
        workspaceRootPath: this.workspaceRoot,
        providerKey: this.config.providerKey,
        provider: this.config.provider,
        providerType: this.config.providerType,
        model: this._model,
        ...meta,
      },
    });
  }

  private supportsPiRpcCommand(command: PiRpcCommandType): boolean {
    return this.rpcCapabilities?.commands.includes(command) ?? true;
  }

  private requirePiRpcCommand(command: PiRpcCommandType, operation: string = command): void {
    if (this.supportsPiRpcCommand(command)) return;
    throw new Error(
      `Pi RpcClient command "${command}" is required for ${operation}, but the active Pi ` +
      `RPC protocol does not advertise it. Upgrade Pi to a compatible version.`
    );
  }

  /** Trusted interaction ownership captured from Pi, never accepted from the renderer. */
  private pendingExtensionInteractions = new Map<string, PendingExtensionInteractionOwner>();
  /** Prevent late or duplicate interaction responses from falling through to the legacy scalar protocol. */
  private settledExtensionInteractions = new Map<string, number>();

  // Metadata captured before PreToolUse stripping, keyed by toolCallId.
  // This provides a deterministic bridge when Pi event metadata is unavailable.
  private preToolMetadataByCallId: Map<string, {
    intent?: string;
    displayName?: string;
    capturedAt: number;
  }> = new Map();

  // Current user message (for context in summarization)
  private currentUserMessage: string = '';

  // Cached session tool context (lazy-created on first session tool call)
  private _sessionToolContext: SessionToolContext | null = null;

  // RPC request counter for unique IDs
  private rpcIdCounter: number = 0;
  private coordinationBridge: WorkspaceCoordinationBridge | null = null;

  // OAuth token refresh (ChatGPT Plus)
  private tokenRefreshInProgress: Promise<void> | null = null;

  // Global mutex: keyed by providerKey so multiple PiAgent instances
  // sharing the same provider don't race concurrent token refreshes.
  private static globalRefreshMutex: Map<string, Promise<void>> = new Map();

  // ============================================================
  // Constructor
  // ============================================================

  constructor(config: BackendConfig) {
    const resolvedModel = config.model || '';
    const modelDef = getModelById(resolvedModel);
    super(config, resolvedModel, modelDef?.contextWindow);

    this._supportsBranching = true;

    this.piSessionId = config.session?.sdkSessionId || null;
    this.adapter = new PiEventAdapter();
    if (modelDef?.contextWindow) {
      this.adapter.setContextWindow(modelDef.contextWindow);
    }

    // Set session dir on adapter for concurrent-safe toolMetadataStore lookups.
    // session dir is the Pi sidecar `.mortise/{sessionId}/` under the
    // Pi sessions bucket, NOT the legacy `workspaces/{id}/sessions/{sessionId}/`.
    if (config.session?.mortiseId) {
      this.adapter.setSessionDir(getSessionPath(config.workspace.id, config.session.mortiseId));
    }

    if (!config.isHeadless) {
      this.startConfigWatcher();
    }
  }

  /**
   * Guardrail: ensure every backend-mode session tool from core is implemented here.
   * This fails fast in development/CI instead of surfacing as runtime "Unknown session tool".
   */
  private assertBackendSessionToolParity(): void {
    const missing = [...SESSION_BACKEND_TOOL_NAMES].filter(
      (name) => !PI_BACKEND_SESSION_TOOL_NAMES.has(name) && !PI_EXTENSION_OWNED_SESSION_TOOL_NAMES.has(name),
    );

    if (missing.length > 0) {
      throw new Error(
        `PiAgent missing backend session tool implementations: ${missing.join(', ')}`,
      );
    }
  }

  // ============================================================
  // RpcClient Management
  // ============================================================

  private async ensureRpcClient(): Promise<PiSessionRpcClient> {
    // Fast path: client already initialized successfully.
    const readyClientPromise = this.rpcClientReady;
    if (this.rpcClient && readyClientPromise) {
      try {
        await readyClientPromise;
      } catch {
        // The ready promise can reject before cleanup runs; clear the stale
        // handles and retry below instead of permanently poisoning callers.
        if (this.rpcClientReady === readyClientPromise) {
          this.rpcClient = null;
          this.rpcClientReady = null;
        }
      }
      if (this.rpcClient) {
        return this.rpcClient;
      }
    }

    // Mutex: if a startRpcClient() is in flight, await its promise instead of
    // starting a second subprocess. startRpcClient assigns this.rpcClientReady
    // before any await, so reading it here is safe within a single microtask.
    const readyPromise = this.rpcClientReady;
    if (readyPromise) {
      try {
        await readyPromise;
      } catch {
        // startRpcClient failed and reset rpcClientReady to null; fall through to retry.
        if (this.rpcClientReady === readyPromise) {
          this.rpcClient = null;
          this.rpcClientReady = null;
        }
      }
      if (this.rpcClient) return this.rpcClient;
      // startRpcClient failed and reset rpcClientReady to null; fall through to retry.
    }

    await this.startRpcClient();
    if (!this.rpcClient) {
      throw new Error('Pi RpcClient failed to start');
    }
    return this.rpcClient;
  }

  private resolvePiRuntimePath(): string {
	const runtimePath = getBackendRuntime(this.config).paths?.piRuntime;
	if (!runtimePath) {
	  throw new Error('Mortise Agent runtime path was not provided by the runtime resolver');
	}
	if (!existsSync(runtimePath)) {
	  throw new Error(`Mortise Agent runtime is missing: ${runtimePath}`);
	}
	return runtimePath;
  }

  private getMortiseExtensionPaths(): string[] {
    const bundledDirectory = process.env.MORTISE_BUNDLED_PI_EXTENSIONS_PATH;
    if (bundledDirectory && existsSync(bundledDirectory)) {
      return [bundledDirectory];
    }
    return [
      process.env.MORTISE_BROWSER_EXTENSION_PATH,
      process.env.MORTISE_MESSAGING_EXTENSION_PATH,
    ]
      .filter((value): value is string => Boolean(value && existsSync(value)));
  }

  /** Start the Pi runtime and complete deferred resource preparation. */
  async prepareRuntime(): Promise<void> {
    await this.ensureRpcClient();
  }

  private startRpcClient(): Promise<void> {
    if (this.rpcClientReady) return this.rpcClientReady;

    const ready = this.startRpcClientUnlocked().catch(async (error) => {
      await this.stopRpcClient();
      if (this.rpcClientReady === ready) {
        this.rpcClientReady = null;
      }
      throw error;
    });
    this.rpcClientReady = ready;
    return ready;
  }

  private piHostKey(runtimePath: string, env: Record<string, string | undefined>): string {
    const environmentFingerprint = createHash('sha256')
      .update(JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right))))
      .digest('hex');
	return `${runtimePath}\u0000${PI_AGENT_DIR}\u0000${environmentFingerprint}`;
  }

  private piHostEnvironment(env: Record<string, string | undefined>): Record<string, string> {
    const hostEnvironment: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (key !== 'MORTISE_SESSION_DIR' && value !== undefined) hostEnvironment[key] = value;
    }
    return hostEnvironment;
  }

  private async startRpcClientUnlocked(): Promise<void> {
    const runtime = getBackendRuntime(this.config);
    const cwd = this.resolvedWorkspaceRoot();
	const runtimePath = this.resolvePiRuntimePath();
	const expectedBinary = process.platform === 'win32' ? 'pi.exe' : 'pi';
	if (basename(runtimePath).toLowerCase() !== expectedBinary) {
	  throw new Error(`Mortise Agent runtime must be the compiled ${expectedBinary} binary: ${runtimePath}`);
	}

	this.debug(`Starting Mortise Agent runtime: ${runtimePath}`);
    this.resetRpcErrorDedup();
    this.rpcProcessFailureHandled = false;

    const commandArgs: string[] = [];

    if (this.config.authType === 'oauth' && runtime.piAuthProvider === 'github-copilot') {
      const slug = this.config.providerKey || 'pi';
      const stored = await getCredentialManager().getProviderOAuth(slug);
      if (stored?.refreshToken && (!stored.expiresAt || stored.expiresAt < Date.now() + 5 * 60_000)) {
        this.debug('Copilot token expired or expiring soon — refreshing before session start');
        await this.refreshAndPushTokens();
      }
    }

    const piAuth = await this.getPiAuth();
    const awsEnv = this.buildAwsEnv(piAuth, runtime);
    const pipeStderr = process.env.MORTISE_DEBUG === '1';

    this.writePiRuntimeLog('info', 'startup.begin', {
	  command: runtimePath,
	  runtimePath,
      cwd,
      runtimeProvider: runtime.piAuthProvider,
      authType: this.config.authType,
      pipeStderr,
    });

	const hostEnvironment = this.piHostEnvironment({
	  ...createSanitizedEnv(),
	  ...getProxyEnvVars(),
	  ...awsEnv,
	  ...this.config.envOverrides,
	  MORTISE_DEBUG: (process.argv.includes('--debug') || process.env.MORTISE_DEBUG === '1') ? '1' : '0',
	});
    const clientOptions: PiRpcClientOptions = {
	  command: runtimePath,
	  commandArgs,
	  runtimePath,
	  directExecutable: true,
      cwd,
      provider: runtime.piAuthProvider,
      model: this._model,
      envMode: 'replace',
	  env: hostEnvironment,
      pipeStderr,
    };

    const sessionDir = this.config.session
      ? getPiNativeSessionDir(this.config.workspace.id)
      : undefined;
    const runtimeId = this.config.session?.mortiseId ?? `runtime-${Date.now()}`;
    const lease = await piHostManager.acquire({
	  key: this.piHostKey(runtimePath, clientOptions.env ?? {}),
      client: clientOptions,
      runtime: {
        runtimeId,
        cwd,
        agentDir: PI_AGENT_DIR,
        projectConfigDir: MORTISE_PROJECT_DIR,
        extensionPaths: this.getMortiseExtensionPaths(),
		extensionServiceScope: this.config.extensionServiceScope ?? 'session',
		extensionServiceWorkspaceKey: this.config.workspace.id,
        sessionDir,
        sessionId: this.config.session?.mortiseId,
        forkFromSessionPath: this.config.session?.branchFromPiSessionFile,
        spawnConfig: this.config.session?.extensionBootstrap
          ? { extensionBootstrap: this.config.session.extensionBootstrap }
          : undefined,
        uiCapabilities: createMortiseRpcUiCapabilities(),
      },
    });
    this.rpcHostLease = lease;
    this.rpcCapabilities = lease.capabilities;
    const rpcClient = lease.runtime;
    this.rpcClient = rpcClient;
    this.unsubscribePiEvent = rpcClient.onEvent((event) => this.handlePiEvent(event as unknown as Record<string, unknown>));
    this.unsubscribePiClientEvent = rpcClient.onClientEvent((event) => this.handlePiClientEvent(event));
    for (const event of lease.startupEvents) this.handlePiClientEvent(event);
    this.writePiRuntimeLog('info', 'host.runtime.acquired', {
      runtimeId: rpcClient.runtimeId,
      protocolVersion: lease.capabilities.protocolVersion,
    });

    if (this.rpcClient !== rpcClient) throw new Error('Pi RpcClient startup was superseded');
    const state = await rpcClient.getState();
    this.piSessionId = state.sessionId;
    this.config.onSdkSessionIdUpdate?.(state.sessionId);
    this.debug('Pi RpcClient is ready');
    this.writePiRuntimeLog('info', 'startup.ready', {
      piSessionId: this.piSessionId,
      runtimeId: rpcClient.runtimeId,
    });

    const provider = runtime.piAuthProvider;
    if (provider && this._model) await rpcClient.setModel(provider, this._model);
    if (this._thinkingLevel) await rpcClient.setThinkingLevel(this._thinkingLevel as any);

    try {
      await rpcClient.setAutoCompaction(true);
      this.debug('PI auto-compaction enabled');
    } catch (error) {
      this.debug(`Failed to configure PI auto-compaction (continuing): ${error instanceof Error ? error.message : String(error)}`);
    }

    await rpcClient.setToolExecutionHandler(async (request) => {
      const decision = await this.handleToolExecutionBoundary(request);
      return this.getCoordinationBridge().beforeTool({
        toolName: request.toolName,
        toolCallId: request.toolCallId,
        input: request.input,
        ...('assistantResponseId' in request && typeof request.assistantResponseId === 'string'
          ? { assistantResponseId: request.assistantResponseId }
          : {}),
        assistantTimestamp: 'assistantTimestamp' in request && typeof request.assistantTimestamp === 'number'
          ? request.assistantTimestamp
          : Date.now(),
      }, decision);
    });
    const coordinationClient = rpcClient as PiSessionRpcClient & PiCoordinationRpcClient;
    await coordinationClient.setToolResultHandler(request => this.handleCoordinatedToolResult(request));

    // Register canonical session-scoped host tools in Pi.
    // These tools (subagent, etc.)
    // are executed in the main process when the LLM calls them.
    this.assertBackendSessionToolParity();
    let sessionToolDefs = getSessionHostToolDefs();

    // Bundled extensions own browser and messaging tools through versioned Host capabilities.
    sessionToolDefs = sessionToolDefs.filter(d => !PI_EXTENSION_OWNED_SESSION_TOOL_NAMES.has(d.name));

    await rpcClient.registerTools(sessionToolDefs as PiRpcHostToolDefinition[], (request) => this.executeHostTool(request));
    this.debug(`Registered ${sessionToolDefs.length} session tools with Pi RpcClient`);

    const profile = await rpcClient.getState();
    const disabledTools = new Set(getDisabledAgentTools());
    await rpcClient.setActiveTools(profile.activeTools.filter((name) => !disabledTools.has(name)));
    await rpcClient.setCompactionPrompt(getCustomCompactionPrompt());

    const prepareStartedAt = Date.now();
    try {
      await rpcClient.prepareRuntime();
      this.writePiRuntimeLog('info', 'runtime.prepare.ready', {
        runtimeId: rpcClient.runtimeId,
        durationMs: Date.now() - prepareStartedAt,
      });
    } catch (error) {
      // Preparation is also guarded inside prompt(). Keep the runtime usable so
      // one broken optional resource cannot disable the composer.
      this.writePiRuntimeLog('warn', 'runtime.prepare.degraded', {
        runtimeId: rpcClient.runtimeId,
        durationMs: Date.now() - prepareStartedAt,
        error,
      });
    }
  }

  async getAgentProfile(): Promise<AgentRuntimeProfile> {
    const state = await (await this.ensureRpcClient()).getState();
    return {
      systemPrompt: state.systemPrompt,
      compactionPrompt: state.compactionPrompt,
      activeTools: state.activeTools,
      tools: state.tools,
    };
  }

  /**
   * Build structured Pi auth from connection config.
   * Returns a provider-aware credential object for Pi startup,
   * or null if no piAuthProvider is configured.
   *
   * OAuth tokens from Mortise (ChatGPT Plus, Copilot) are passed as
   * api_key type because they function as bearer tokens that the Pi SDK's provider
   * modules use directly. The OAuth exchange happens on the Mortise side; by the time
   * it reaches Pi, it's just an access token.
   */
  private async getPiAuth(): Promise<{
    provider: string;
    credential:
      | { type: 'api_key'; key: string }
      | { type: 'oauth'; access: string; refresh: string; expires: number }
      | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string }
  } | null> {
    const piAuthProvider = getBackendRuntime(this.config).piAuthProvider;
    if (!piAuthProvider) return null;

    try {
      const credentialManager = getCredentialManager();
      const slug = this.config.providerKey || 'pi';

      if (this.config.authType === 'oauth') {
        const oauth = await credentialManager.getProviderOAuth(slug);
        if (oauth?.accessToken) {
          // Copilot: pass full OAuth credential so the Pi SDK can derive the
          // correct API endpoint from the Copilot token's proxy-ep field.
          // The refresh token is the GitHub access token used to obtain fresh
          // Copilot tokens when they expire (~1 hour).
          if (piAuthProvider === 'github-copilot' && oauth.refreshToken) {
            this.debug(`Retrieved Copilot OAuth credential for Pi provider: ${piAuthProvider}`);
            return {
              provider: piAuthProvider,
              credential: {
                type: 'oauth',
                access: oauth.accessToken,
                refresh: oauth.refreshToken,
                expires: oauth.expiresAt ?? 0,
              },
            };
          }
          // Other OAuth providers: pass as api_key (bearer token)
          this.debug(`Retrieved OAuth access token for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: { type: 'api_key', key: oauth.accessToken },
          };
        }
      } else if (this.config.authType === 'iam_credentials') {
        // AWS IAM credentials — pass structured fields so RpcClient can
        // identify the credential type. Actual AWS env var injection happens
        // at process start for proper isolation.
        const iam = await credentialManager.getProviderIamCredentials(slug);
        if (iam) {
          this.debug(`Retrieved IAM credentials for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: {
              type: 'iam',
              accessKeyId: iam.accessKeyId,
              secretAccessKey: iam.secretAccessKey,
              region: iam.region,
              sessionToken: iam.sessionToken,
            },
          };
        }
      } else {
        // API key-based connections.
        // NOTE: authType === 'environment' (e.g. Bedrock with ~/.aws/credentials)
        // intentionally falls through here, finds no API key, and returns null.
        // buildAwsEnv() re-adds only the AWS credential-chain variables needed
        // for Bedrock environment auth after the base subprocess env is sanitized.
        const apiKey = await credentialManager.getProviderApiKey(slug);
        if (apiKey) {
          this.debug(`Retrieved API key credential for Pi provider: ${piAuthProvider}`);
          return {
            provider: piAuthProvider,
            credential: { type: 'api_key', key: apiKey },
          };
        }
      }

      this.debug(`No credentials found for Pi provider: ${piAuthProvider}`);
      return null;
    } catch (error) {
      this.debug(`Failed to retrieve Pi auth: ${error}`);
      return null;
    }
  }

  /**
   * Build AWS environment variables from piAuth credentials for the Pi RPC process.
   *
   * The Pi SDK's Bedrock provider reads from the AWS default credential chain
   * (env vars), not from Pi AuthStorage. We inject at spawn time so credentials
   * are scoped to the Pi RPC process and don't leak to the main process.
   *
   * NOTE: IAM credentials (especially STS session tokens) are immutable after
   * spawn — they cannot be refreshed in a running Pi RPC process. Long sessions
   * with temporary credentials (~1h STS tokens) will fail on expiry.
   */
  private buildAwsEnv(
    piAuth: Awaited<ReturnType<PiAgent['getPiAuth']>>,
    runtime: { piAuthProvider?: string },
  ): Record<string, string> {
    if (runtime.piAuthProvider !== 'amazon-bedrock') return {};

    const env: Record<string, string> = {};

    if (piAuth?.credential.type === 'iam') {
      env.AWS_ACCESS_KEY_ID = piAuth.credential.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = piAuth.credential.secretAccessKey;
      if (piAuth.credential.region) env.AWS_REGION = piAuth.credential.region;
      if (piAuth.credential.sessionToken) env.AWS_SESSION_TOKEN = piAuth.credential.sessionToken;
      this.debug('Injecting IAM credentials into Pi RPC env for AWS SDK');
    } else if (this.config.authType === 'environment') {
      for (const key of AWS_ENVIRONMENT_AUTH_VARS) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      this.debug('Injecting AWS environment credential chain into Pi RPC env');
    }

    return env;
  }

  /**
   * Refresh OAuth tokens in the shared Pi credential store.
   * Handles Anthropic-via-Pi, Copilot, and ChatGPT OAuth connections.
   */
  private async refreshAndPushTokens(): Promise<void> {
    if (this.config.authType !== 'oauth') return;

    const slug = this.config.providerKey || 'pi';

    // Global mutex — if another PiAgent instance on the same provider key
    // is already refreshing, just wait for that to finish.
    const existing = PiAgent.globalRefreshMutex.get(slug);
    if (existing) {
      this.debug(`Waiting on existing refresh for slug "${slug}"`);
      await existing;
      return;
    }

    const refreshPromise = (async () => {
      const piAuthProvider = getBackendRuntime(this.config).piAuthProvider;
      const credentialManager = getCredentialManager();
      const stored = await credentialManager.getProviderOAuth(slug);

      if (!stored?.refreshToken) {
        this.debug('No refresh token available — re-auth required');
        this.onBackendAuthRequired?.('No refresh token — please sign in again');
        return;
      }

      try {
        if (piAuthProvider === 'github-copilot') {
          // Copilot: refresh the short-lived Copilot token using the GitHub access token
          const { refreshGitHubCopilotToken } = await import('@mortise/pi-ai/oauth');
          const newCreds = await refreshGitHubCopilotToken(stored.refreshToken);
          await credentialManager.setProviderOAuth(slug, {
            accessToken: newCreds.access,
            refreshToken: newCreds.refresh,
            expiresAt: newCreds.expires,
          });
        } else {
          this.debug(`No token refresh logic for piAuthProvider=${piAuthProvider} — re-auth required`);
          this.onBackendAuthRequired?.('Token refresh not supported for this provider — please sign in again');
          return;
        }
        this.debug('Token refresh successful');

        this.debug('Updated Pi credential store with refreshed credentials');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.debug(`Token refresh failed: ${msg}`);
        this.onBackendAuthRequired?.(`Token refresh failed: ${msg}`);
      }
    })();

    // Store in both instance and global mutex
    this.tokenRefreshInProgress = refreshPromise;
    PiAgent.globalRefreshMutex.set(slug, refreshPromise);

    try {
      await refreshPromise;
    } finally {
      this.tokenRefreshInProgress = null;
      // Only clear global if it's still our promise (no newer refresh started)
      if (PiAgent.globalRefreshMutex.get(slug) === refreshPromise) {
        PiAgent.globalRefreshMutex.delete(slug);
      }
    }
  }

  private handlePiClientEvent(
    event: PiRpcClientEvent,
    sourceRuntime: PiSessionRpcClient | null = this.rpcClient,
  ): void {
    if (
      event.type === 'process_exit' ||
      event.type === 'process_error' ||
      event.type === 'stdin_error'
    ) {
      if (sourceRuntime === this.rpcClient) this.handleRpcClientLifecycleFailure(event);
      return;
    }

    if ((event as unknown as { type?: string }).type === 'extension_ui_cancel') {
      const cancelled = event as unknown as {
        id?: unknown
        extensionId?: unknown
        clientId?: unknown
        runtimeId?: unknown
        sessionId?: unknown
        schemaVersion?: unknown
        reason?: unknown
      };
      if (typeof cancelled.id !== 'string' || cancelled.schemaVersion !== 1) return;
      const owner = this.pendingExtensionInteractions.get(cancelled.id);
      if (!owner) return;
      if (cancelled.extensionId !== owner.extensionId) return;
      if (cancelled.clientId !== undefined && cancelled.clientId !== owner.clientId) return;
      if (cancelled.runtimeId !== undefined && cancelled.runtimeId !== owner.runtimeId) return;
      if (cancelled.sessionId !== undefined && cancelled.sessionId !== owner.wireSessionId) return;
      const reason = cancelled.reason as ExtensionInteractionCancelReasonV1;
      if (!['user', 'timeout', 'aborted', 'host-disconnected', 'runtime-disposed'].includes(reason)) return;
      this.pendingExtensionInteractions.delete(cancelled.id);
      this.rememberSettledExtensionInteraction(cancelled.id);
      this.config.onExtensionEvent?.({
        type: 'extension_interaction_cancel',
        requestId: cancelled.id,
        schemaVersion: 1,
        reason,
        extensionId: owner.extensionId,
        runtimeId: owner.runtimeId,
        sessionId: owner.sessionId,
      });
      return;
    }

    if (event.type === 'extension_ui_request') {
      const bridgeEvent = this.mapExtensionUiRequest(event);
      if (bridgeEvent) this.config.onExtensionEvent?.(bridgeEvent);
      return;
    }

    if ((event as unknown as { type?: string }).type === 'extension_ui_validation') {
      const validation = event as unknown as {
        extensionId: string;
        runtimeId?: string;
        delta: Record<string, unknown> & { schemaVersion: 1; revision: number; operation: string };
      };
      if (typeof validation.extensionId !== 'string' || !validation.delta || validation.delta.schemaVersion !== 1) return;
      const route = this.extensionEventRoute(validation.extensionId, validation.runtimeId);
      this.config.onExtensionEvent?.({
        type: 'extension_ui_validation',
        ...route,
        delta: {
          ...validation.delta,
          extensionId: route.extensionId,
          runtimeId: route.runtimeId,
          sessionId: route.sessionId,
        } as ExtensionUIValidationDeltaV1,
      });
      return;
    }

    if ((event as unknown as { type?: string }).type === 'extension_frontend_state') {
      const frontend = event as unknown as {
        extensionId?: unknown
        runtimeId?: unknown
        state?: import('../protocol/extension-frontend-channels.ts').ExtensionFrontendStateV2
      };
      if (typeof frontend.extensionId !== 'string' || !frontend.state) return;
      const route = this.extensionEventRoute(frontend.extensionId, typeof frontend.runtimeId === 'string' ? frontend.runtimeId : undefined);
      this.config.onExtensionEvent?.({
        type: 'extension_frontend_state',
        ...route,
        state: frontend.state,
        workspaceId: this.config.workspace.id,
      });
      return;
    }

    if ((event as unknown as { type?: string }).type === 'extension_frontend_reset') {
      const reset = event as unknown as { extensionId?: unknown; runtimeId?: unknown };
      if (typeof reset.extensionId !== 'string') return;
      this.config.onExtensionEvent?.({
        type: 'extension_contributions_runtime_reset',
        ...this.extensionEventRoute(reset.extensionId, typeof reset.runtimeId === 'string' ? reset.runtimeId : undefined),
        workspaceId: this.config.workspace.id,
      });
      return;
    }

    if (event.type === 'extension_host_capability_request') {
      if (sourceRuntime) void this.handleExtensionHostCapabilityRequest(event, sourceRuntime);
      return;
    }

    if (event.type === 'extension_host_capability_route_rejected') {
      writeRuntimeLog('warn', {
        scope: 'capability',
        event: 'route_rejected',
        correlation: {
          sessionId: event.sessionId,
          runtimeId: event.runtimeId,
          clientId: event.clientId,
          requestId: event.id,
        },
        data: {
          phase: event.phase,
          reason: event.reason,
          expected: event.expected,
          actual: event.actual,
        },
      });
      return;
    }

    if (event.type === 'extension_host_capability_declaration') {
      if (!sourceRuntime) return;
      const { runtimeId, sessionId } = this.hostCapabilityRoute(sourceRuntime);
      this.config.onHostCapabilityDeclaration?.({
        version: 1,
        sessionId,
        runtimeId,
        extensionId: event.extensionId,
        declarations: event.declarations,
      });
      return;
    }

    if (event.type === 'extension_host_capability_cancel') {
      if (sourceRuntime) this.config.onHostCapabilityCancel?.(event.id, sourceRuntime.runtimeId);
      return;
    }

    if (event.type === 'extension_error') {
      this.config.onExtensionEvent?.({
        type: 'extension_notify',
        message: event.error,
        notificationType: 'error',
        source: event.extensionPath,
        ...this.extensionEventRoute(event.extensionId, event.runtimeId),
      });
    }
  }

  private handleRpcClientLifecycleFailure(
    event: Extract<PiRpcClientEvent, { type: 'process_exit' | 'process_error' | 'stdin_error' }>
  ): void {
    if (this.rpcProcessFailureHandled) return;
    this.rpcProcessFailureHandled = true;
    const failedRuntimeId = this.currentRpcRuntimeId();
    if (failedRuntimeId) {
      this.config.onHostCapabilityRuntimeReleased?.(failedRuntimeId);
      this.config.onExtensionEvent?.({
        type: 'extension_contributions_runtime_reset',
        ...this.extensionEventRoute('pi-runtime', failedRuntimeId),
      });
    }

    this.debug(`Pi RpcClient lifecycle failure: ${event.type}: ${event.message}`);
    this.writePiRuntimeLog('error', 'lifecycle.failure', {
      lifecycleEvent: event.type,
      message: event.message,
      code: event.type === 'process_exit' ? event.code : undefined,
      signal: event.type === 'process_exit' ? event.signal : undefined,
      stderr: event.stderr || this.getRecentStderr(),
    });
    this.handleRpcError(new Error(event.message));
    this.settleTurnForRuntimeReplacement();

    this.cancelPendingExtensionInteractions('host-disconnected');
    this.preToolMetadataByCallId.clear();

    try { this.unsubscribePiEvent?.(); } catch {}
    try { this.unsubscribePiClientEvent?.(); } catch {}
    const failedHostLease = this.rpcHostLease;
    this.unsubscribePiEvent = null;
    this.unsubscribePiClientEvent = null;
    this.rpcClient = null;
    this.rpcHostLease = null;
    this.rpcClientReady = null;
    this.rpcCapabilities = null;
    if (failedHostLease) {
      void failedHostLease.release().catch(error => {
        this.debug(`Failed to release crashed Pi runtime: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private async handleExtensionHostCapabilityRequest(
    event: Extract<PiRpcClientEvent, { type: 'extension_host_capability_request' }>,
    client: PiSessionRpcClient,
  ): Promise<void> {
    // Runtime identity is assigned by the Host client. Never accept an extension-supplied
    // route value here: capability authorization and cleanup depend on this boundary.
    const { runtimeId, sessionId } = this.hostCapabilityRoute(client);
    const responseRoute = {
      runtimeId,
      sessionId: event.sessionId ?? sessionId,
      ...(event.clientId ? { clientId: event.clientId } : {}),
    };
    const startedAt = Date.now();
    const correlation = { sessionId, runtimeId, clientId: event.clientId, requestId: event.id };
    writeRuntimeLog('info', {
      scope: 'capability-bridge', event: 'requested', correlation,
      data: { capability: event.capability, operation: event.operation, extensionId: event.extensionId, timeoutMs: event.timeoutMs },
    });
    let response: PiRpcExtensionHostCapabilityResponse;
    try {
      const result = this.config.onHostCapabilityRequest
        ? await this.config.onHostCapabilityRequest({
            version: 1,
            requestId: event.id,
            capability: event.capability,
            sessionId,
            runtimeId,
            extensionId: event.extensionId,
            operation: event.operation,
            input: event.input,
            timeoutMs: event.timeoutMs,
          }, (progress) => {
            try {
              client.reportExtensionHostCapabilityProgress({
                type: 'extension_host_capability_progress',
                version: 1,
                id: event.id,
                sequence: progress.sequence,
                progress: progress.progress,
                ...responseRoute,
              });
              writeRuntimeLog('debug', {
                scope: 'capability-bridge', event: 'progress', correlation,
                data: { sequence: progress.sequence },
              });
            } catch (error) {
              this.debug(`Failed to report host capability progress ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
          })
        : {
            requestId: event.id,
            status: 'unsupported' as const,
            error: { code: 'HOST_CAPABILITIES_UNAVAILABLE', message: 'Host capabilities are unavailable.' },
          };
      response = result.status === 'success'
        ? { type: 'extension_host_capability_response', version: 1, id: event.id, status: 'success', output: result.output, ...responseRoute }
        : {
            type: 'extension_host_capability_response', version: 1, id: event.id, status: result.status,
            ...responseRoute,
            error: result.error ? {
              code: result.error.code,
              message: result.error.message,
              recoverable: 'retryable' in result.error && result.error.retryable === true,
            } : undefined,
          };
    } catch (error) {
      response = {
        type: 'extension_host_capability_response', version: 1, id: event.id, status: 'failed',
        ...responseRoute,
        error: { code: 'HOST_CAPABILITY_BRIDGE_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
    try {
      client.respondToExtensionHostCapability(response);
      writeRuntimeLog(response.status === 'success' ? 'info' : 'warn', {
        scope: 'capability-bridge', event: 'responded', correlation,
        data: { status: response.status, errorCode: response.status === 'success' ? undefined : response.error?.code, durationMs: Date.now() - startedAt },
      });
    } catch (error) {
      this.debug(`Failed to respond to extension host capability ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
      writeRuntimeLog('error', {
        scope: 'capability-bridge', event: 'response_failed', correlation,
        data: { error, durationMs: Date.now() - startedAt },
      });
    }
  }

  private hostCapabilityRoute(runtime: PiSessionRpcClient): { runtimeId: string; sessionId: string } {
    return {
      runtimeId: runtime.runtimeId,
      sessionId: runtime === this.rpcClient
        ? this.config.session?.mortiseId ?? this._sessionId
        : runtime.runtimeSummary.sessionId,
    };
  }

  private extensionEventRoute(extensionId: string, runtimeId?: string): Pick<ExtensionBridgeEvent, 'extensionId' | 'runtimeId' | 'sessionId'> {
    const client = this.rpcClient;
    const resolvedRuntimeId = runtimeId ?? client?.runtimeId;
    if (!resolvedRuntimeId) {
      throw new Error('Pi extension event is missing its global host runtime identity');
    }
    return {
      extensionId,
      runtimeId: resolvedRuntimeId,
      sessionId: this.config.session?.mortiseId ?? this.piSessionId ?? '',
    };
  }

  private cancelPendingExtensionInteractions(reason: ExtensionInteractionCancelReasonV1): void {
    for (const [requestId, owner] of this.pendingExtensionInteractions) {
      this.rememberSettledExtensionInteraction(requestId);
      try {
        this.config.onExtensionEvent?.({
          type: 'extension_interaction_cancel',
          requestId,
          schemaVersion: 1,
          reason,
          extensionId: owner.extensionId,
          runtimeId: owner.runtimeId,
          sessionId: owner.sessionId,
        });
      } catch (error) {
        this.writePiRuntimeLog('warn', 'extension.interaction_cancel_broadcast_failed', {
          extensionId: owner.extensionId,
          requestId,
          error,
        });
      }
    }
    this.pendingExtensionInteractions.clear();
  }

  private rememberSettledExtensionInteraction(requestId: string): void {
    const now = Date.now();
    for (const [id, settledAt] of this.settledExtensionInteractions) {
      if (now - settledAt > SETTLED_EXTENSION_INTERACTION_TTL_MS) this.settledExtensionInteractions.delete(id);
    }
    this.settledExtensionInteractions.delete(requestId);
    this.settledExtensionInteractions.set(requestId, now);
    while (this.settledExtensionInteractions.size > MAX_SETTLED_EXTENSION_INTERACTIONS) {
      const oldest = this.settledExtensionInteractions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.settledExtensionInteractions.delete(oldest);
    }
  }

  private wasExtensionInteractionSettled(requestId: string): boolean {
    const settledAt = this.settledExtensionInteractions.get(requestId);
    if (settledAt === undefined) return false;
    if (Date.now() - settledAt <= SETTLED_EXTENSION_INTERACTION_TTL_MS) return true;
    this.settledExtensionInteractions.delete(requestId);
    return false;
  }

  private mapExtensionUiRequest(event: Extract<PiRpcClientEvent, { type: 'extension_ui_request' }>): ExtensionBridgeEvent | null {
    const extensionId = 'extensionId' in event && typeof event.extensionId === 'string'
      ? event.extensionId
      : 'pi-extension';
    const route = this.extensionEventRoute(extensionId, event.runtimeId);
    if ((event as unknown as { method?: string }).method === 'interact') {
      const interactionEvent = event as unknown as {
        id: string
        request: unknown
        timeout?: number
      };
      const error = validateExtensionInteractionRequestV1(interactionEvent.request);
      if (error) {
        this.writePiRuntimeLog('warn', 'extension.interaction_rejected', {
          extensionId,
          requestId: interactionEvent.id,
          error,
        });
        if (typeof interactionEvent.id === 'string' && interactionEvent.id.length > 0) {
          try {
            (this.rpcClient?.respondToExtensionUI as ((response: unknown) => void) | undefined)?.({
              type: 'extension_ui_response',
              id: interactionEvent.id,
              extensionId,
              ...(event.clientId ? { clientId: event.clientId } : {}),
              ...(event.runtimeId ? { runtimeId: event.runtimeId } : {}),
              ...(event.sessionId ? { sessionId: event.sessionId } : {}),
              interaction: { schemaVersion: 1, status: 'cancelled', reason: 'host-disconnected' },
            });
            this.rememberSettledExtensionInteraction(interactionEvent.id);
          } catch (responseError) {
            this.writePiRuntimeLog('warn', 'extension.interaction_rejection_response_failed', {
              extensionId,
              requestId: interactionEvent.id,
              error: responseError,
            });
          }
        }
        return null;
      }
      this.pendingExtensionInteractions.set(interactionEvent.id, {
        ...route,
        clientId: event.clientId,
        wireSessionId: event.sessionId,
      });
      return {
        type: 'extension_interaction_request',
        requestId: interactionEvent.id,
        request: interactionEvent.request as import('../protocol/extension-interactions.ts').ExtensionInteractionRequestV1,
        timeout: interactionEvent.timeout,
        ...route,
      };
    }
    if ((event as { method: string }).method === 'contribution') {
      const contributionEvent = event as unknown as {
        operation: 'upsert' | 'remove' | 'reset' | 'snapshot'
        revision: number
        contribution: ExtensionContributionV1
        contributionId: string
        contributions: ExtensionContributionV1[]
      }
      const base = {
        schemaVersion: 1 as const,
        extensionId,
        sessionId: route.sessionId,
        runtimeId: route.runtimeId,
        revision: contributionEvent.revision,
      }
      return {
        type: 'extension_contribution',
        delta: contributionEvent.operation === 'upsert'
          ? { ...base, operation: 'upsert', contribution: contributionEvent.contribution }
          : contributionEvent.operation === 'remove'
            ? { ...base, operation: 'remove', contributionId: contributionEvent.contributionId }
            : contributionEvent.operation === 'snapshot'
              ? { ...base, operation: 'snapshot', contributions: contributionEvent.contributions }
              : { ...base, operation: 'reset' },
        ...route,
      }
    }
    if (event.method === 'notify') {
      return {
        type: 'extension_notify',
        message: event.message,
        notificationType: event.notifyType,
        source: extensionId,
        ...route,
      };
    }
    if (event.method === 'setStatus') {
      this.writePiRuntimeLog('debug', 'extension.set_status', {
        statusKey: event.statusKey,
        statusText: event.statusText,
      });
      return {
        type: 'extension_status',
        key: event.statusKey,
        status: event.statusText ?? '',
        source: extensionId,
        ...route,
      };
    }
    return null;
  }

  private reportRpcError(error: unknown): void {
    const rawMessage = error instanceof Error ? error.message : String(error);
    this.debug(`Pi RpcClient error: ${rawMessage}`);
    const errorMsg = rawMessage.toLowerCase();

    if (this.config.authType === 'oauth' && (
      errorMsg.includes('401') ||
      errorMsg.includes('421') ||
      errorMsg.includes('unauthorized') ||
      errorMsg.includes('misdirected') ||
      (errorMsg.includes('token') && errorMsg.includes('expired')) ||
      errorMsg.includes('authentication')
    )) {
      this.refreshAndPushTokens().catch(err => {
        this.debug(`Token refresh after auth error failed: ${err}`);
      });
    }

    if (rawMessage === this.lastRpcError) {
      this.rpcErrorRepeatCount++;
      if (this.rpcErrorRepeatCount > PiAgent.MAX_IDENTICAL_RPC_ERRORS) {
        this.debug(`Suppressing repeated Pi RpcClient error (${this.rpcErrorRepeatCount}x): ${rawMessage}`);
        return;
      }
    } else {
      this.lastRpcError = rawMessage;
      this.rpcErrorRepeatCount = 1;
    }

    const parsed = parseError(error instanceof Error ? error : new Error(rawMessage));
    const queue = this.activeEventStream?.queue;
    if (!queue) return;
    if (parsed.code !== 'unknown_error') {
      queue.enqueue({ type: 'typed_error', error: parsed });
    } else {
      queue.enqueue({
        type: 'error',
        message: `Pi RpcClient error: ${rawMessage}`,
      });
    }
  }

  private handleRpcError(error: unknown): void {
    const attemptId = this.activeAttemptId;
    this.reportRpcError(error);
    if (!attemptId) return;
    this.activeEventStream?.queue.enqueue({ type: 'complete', terminalStatus: 'failed' });
    this.completeActiveAttempt(attemptId);
  }

  private handleRpcControlError(operation: string, error: unknown): void {
    this.writePiRuntimeLog('warn', 'control.failed', { operation, error });
    this.reportRpcError(error);
  }

  /**
   * Forward a Pi SDK event through the event adapter.
   */
  private handlePiEvent(event: Record<string, unknown>): void {
    // Frontend channel events are runtime bridge traffic, not conversation
    // events. Forward them before the compatibility adapter sees them.
    if (event.type === 'extension_frontend_state') {
      const frontend = event as {
        extensionId?: unknown
        runtimeId?: unknown
        state?: import('../protocol/extension-frontend-channels.ts').ExtensionFrontendStateV2
      }
      if (typeof frontend.extensionId === 'string' && frontend.state) {
        this.config.onExtensionEvent?.({
          type: 'extension_frontend_state',
          ...this.extensionEventRoute(frontend.extensionId, typeof frontend.runtimeId === 'string' ? frontend.runtimeId : undefined),
          state: frontend.state,
          workspaceId: this.config.workspace.id,
        })
      }
      return
    }

    if (event.type === 'extension_frontend_reset') {
      const reset = event as { extensionId?: unknown; runtimeId?: unknown }
      if (typeof reset.extensionId === 'string') {
        this.config.onExtensionEvent?.({
          type: 'extension_contributions_runtime_reset',
          ...this.extensionEventRoute(reset.extensionId, typeof reset.runtimeId === 'string' ? reset.runtimeId : undefined),
          workspaceId: this.config.workspace.id,
        })
      }
      return
    }

	const eventAttemptId = typeof event.attemptId === 'string' ? event.attemptId : undefined;
	const eventStream = this.activeEventStream
	  && this.activeEventStream.attemptId === eventAttemptId
	  ? this.activeEventStream
	  : undefined;

    if (event.type === 'settlement_failed') {
      const attempt = typeof event.attempt === 'number' && Number.isFinite(event.attempt)
        ? Math.max(1, Math.trunc(event.attempt))
        : 1;
      this.writePiRuntimeLog('error', 'runtime.settlement_failed', {
        attemptId: eventAttemptId,
        attempt,
        error: typeof event.error === 'string' ? event.error : 'Unknown Session persistence failure',
      });
	  if (eventStream && eventAttemptId) this.scheduleSettlementRetry(eventAttemptId, attempt);
    }

    // Detect canonical or persisted legacy session tool completions.
    const eventType = event.type as string;
    const suppressCompatibilityEvent = this.suppressAbortedTurnEvents
      && eventType !== 'turn_end'
      && eventType !== 'agent_end'
      && eventType !== 'agent_settled'
      && eventType !== 'pi_user_message_persisted';
    let adaptedEvent = event;

    if (eventType === 'tool_execution_start') {
      const toolName = event.toolName as string;
      // Deterministic metadata bridge: if the Pi event lacks toolMetadata,
      // inject metadata captured from pre_tool_use_request before stripping.
      const toolCallId = event.toolCallId as string | undefined;
      const existingMeta = event.toolMetadata as { intent?: string; displayName?: string } | undefined;
      if (toolCallId && !existingMeta) {
        const cached = this.preToolMetadataByCallId.get(toolCallId);
        if (cached && (cached.intent || cached.displayName)) {
          adaptedEvent = {
            ...event,
            toolMetadata: {
              intent: cached.intent,
              displayName: cached.displayName,
              source: 'interceptor',
            },
          };
          this.debug(`Injected pre-tool metadata for ${toolName} (${toolCallId}) from bridge cache`);
        }
      }
    }

    if (eventType === 'tool_execution_end') {
      const toolCallId = event.toolCallId as string | undefined;
      if (toolCallId) {
        this.preToolMetadataByCallId.delete(toolCallId);
      }
    }

    // Adapt event to MortiseAgentEvents
    // The event adapter expects typed PiAgentEvent/AgentSessionEvent objects,
    // but since we're receiving plain JSON, we cast through unknown.
    if (!suppressCompatibilityEvent) {
      for (const agentEvent of this.adapter.adaptEvent(adaptedEvent as any)) {
		this.emitPiProjectionEvents(agentEvent, eventAttemptId);
		this.config.onAgentEvent?.(agentEvent);
        // Track Read tool calls for prerequisite checking
        if (agentEvent.type === 'tool_start' && agentEvent.toolName === 'Read') {
          this.prerequisiteManager.trackReadTool(agentEvent.input as Record<string, unknown>);
        }
        // Reset prerequisite state on compaction (LLM loses guide content)
        if (agentEvent.type === 'info' && typeof agentEvent.message === 'string' && agentEvent.message.startsWith('Compacted')) {
          this.resetPrerequisiteState();
        }

        // Fire PostToolUse / PostToolUseFailure hook events (fire-and-forget)
        if (agentEvent.type === 'tool_result') {
          const hookEvent = agentEvent.isError ? 'PostToolUseFailure' : 'PostToolUse';
          this.emitAutomationEvent(hookEvent, {
            hook_event_name: hookEvent,
            tool_name: agentEvent.toolName ?? (event.toolName as string) ?? 'unknown',
            tool_input: agentEvent.input,
            ...(agentEvent.isError
              ? { error: typeof agentEvent.result === 'string' ? agentEvent.result : undefined }
              : { tool_response: typeof agentEvent.result === 'string' ? agentEvent.result : undefined }),
          });
        }

			if (
			  eventStream
			  && (agentEvent.type === 'pi_user_message_persisted'
				|| agentEvent.type === 'error'
				|| agentEvent.type === 'typed_error'
				|| agentEvent.type === 'complete')
			) {
			  eventStream.queue.enqueue(agentEvent);
			  if (agentEvent.type === 'pi_user_message_persisted') eventStream.queue.complete();
			}
      }
    }

	if (eventType === 'agent_settled') {
	  if (eventAttemptId && this.activeAttemptId === eventAttemptId) {
		this.coordinationBridge?.completeTurn();
		this.completeActiveAttempt(eventAttemptId);
	  }
	}

    this.emitRawPiProjectionEvents(adaptedEvent);
  }

  /**
   * Runs host-owned coordination and neutral tool normalization after Extension
   * handlers have made their policy decisions.
   */
  private async handleToolExecutionBoundary(req: PiRpcToolExecutionRequest): Promise<
    { action: 'allow' } | { action: 'block'; reason?: string } | { action: 'modify'; input: Record<string, unknown> }
  > {
    const { toolName, toolCallId, input } = req;
    const debugSessionId = this.config.session?.mortiseId || this._sessionId;
    this.debug(`PreToolUse request from Pi RpcClient: ${toolName} (${req.id}, sessionId=${debugSessionId})`);

	if (this.onBeforeToolExecution) {
	  const coordination = await this.onBeforeToolExecution({
		attemptId: req.attemptId,
		runtimeId: req.runtimeId,
		toolCallId,
		toolName,
		input,
	  });
	  if (!coordination.allowed) {
		return { action: 'block', reason: coordination.reason };
	  }
    }

    // Capture metadata BEFORE centralized checks strip it out.
    // This bridge is deterministic and avoids relying solely on same-process store lookups.
    const preIntent = typeof input._intent === 'string' ? input._intent : undefined;
    const preDisplayName = typeof input._displayName === 'string' ? input._displayName : undefined;
    if (toolCallId && (preIntent || preDisplayName)) {
      this.preToolMetadataByCallId.set(toolCallId, {
        intent: preIntent,
        displayName: preDisplayName,
        capturedAt: Date.now(),
      });
      this.debug(`Captured pre-tool metadata for ${toolName} (${toolCallId}, sessionId=${debugSessionId}): intent=${!!preIntent}, displayName=${!!preDisplayName}`);
    }

    // Fire PreToolUse automation event — await so automations run before tool executes
    await this.emitAutomationEvent('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: input,
    });

    const rootPath = this.workspaceRoot;
    const workspaceSlug = extractWorkspaceSlug(rootPath, this.config.workspace.id);
    const sessionId = this.config.session?.mortiseId || this._sessionId;
    // Build RTK context fresh per call so toggling the preference takes
    // effect without restart. `getRtkPath()` is cached per process.
    const rtkContext: RtkContext | undefined = getRtkEnabled()
      ? { enabled: true, path: getRtkPath(), exclude: [] }
      : undefined;

    const checkResult = runPreToolUseChecks({
      toolName,
      input,
      workspaceRootPath: rootPath,
      workspaceId: workspaceSlug,
      prerequisiteManager: this.prerequisiteManager,
      rtkContext,
      onDebug: (msg) => this.debug(`PreToolUse(sessionId=${sessionId}): ${msg}`),
    });

    switch (checkResult.type) {
      case 'allow':
        return { action: 'allow' };

      case 'modify':
        return { action: 'modify', input: checkResult.input };

      case 'block': {
        this.debug(`Host tool boundary blocked ${toolName}: ${checkResult.reason}`);
        return { action: 'block', reason: checkResult.reason };
      }

      case 'subagent_intercept':
        // These tools are proxy tools handled via tool_execute_request — just allow
        return { action: 'allow' };

    }
  }

  /**
   * Execute a host proxy tool requested by Pi RpcClient.
   */
  private async executeHostTool(request: PiRpcToolExecuteRequest): Promise<PiRpcHostToolResult> {
    // Prerequisite check: block tools until selected skill instructions are read.
    const prereqResult = this.prerequisiteManager.checkPrerequisites(request.toolName);
    if (!prereqResult.allowed) {
      return { content: prereqResult.blockReason!, isError: true };
    }

    try {
      return await this.routeToolCall(request.toolName, request.input);
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  /**
   * Route a proxy tool call to the appropriate handler based on tool name.
   *
   * - Session tools -> session-tools-core handlers.
   *
   * Returns text-result shorthand accepted by Pi's host-tool RPC protocol.
   */
  private async routeToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    if (SESSION_TOOL_NAMES.has(toolName)) {
      return this.executeSessionTool(toolName, args);
    }

    // Unknown tool
    return {
      content: `Unknown proxy tool: ${toolName}`,
      isError: true,
    };
  }

  /**
   * Get or create a SessionToolContext for executing session-scoped tools.
   * Cached per agent instance since the workspace/session don't change.
   */
  private getSessionToolContext(): SessionToolContext {
    if (this._sessionToolContext) return this._sessionToolContext;

    const sessionId = this.config.session?.mortiseId || '';
    const workspacePath = this.workspaceRoot;
    this._sessionToolContext = createSessionToolContext({
      sessionId,
      workspaceId: this.config.workspace.id,
      workspacePath,
      onPlanSubmitted: (planPath: string) => {
        setLastPlanFilePath(sessionId, planPath);
        this.onPlanSubmitted?.(planPath);
      },
    });

    attachSessionSelfManagementBindings(this._sessionToolContext, sessionId);

    return this._sessionToolContext;
  }

  /** Execute a session-scoped tool by name. */
  private async executeSessionTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> {
    try {
      // subagent uses the shared pre-execution pipeline from BaseAgent
      if (toolName === 'subagent') {
        try {
          const result = await this.preExecuteSubagent(args);
          return { content: JSON.stringify(result, null, 2), isError: false };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `subagent failed: ${msg}`, isError: true };
        }
      }

      const def = SESSION_TOOL_REGISTRY.get(toolName);
      if (!def) {
        return { content: `Unknown session tool: ${toolName}`, isError: true };
      }
      if (!def.handler) {
        return {
          content: `Session tool '${toolName}' is backend-executed (${def.executionMode}) but has no PiAgent adapter implementation.`,
          isError: true,
        };
      }

      const ctx = this.getSessionToolContext();
      const result: SessionToolResult = await def.handler(ctx, args);

      // Convert ToolResult to RpcClient host-tool response format.
      const text = result.content
        .filter((c): c is TextContent => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return { content: text, isError: !!result.isError };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.debug(`Session tool ${toolName} failed: ${msg}`);
      return { content: `Session tool error: ${msg}`, isError: true };
    }
  }



  private async requestEnsureSessionReady(): Promise<string | null> {
    const client = await this.ensureRpcClient();
    const state = await client.getState();
    if (state.sessionId && this.piSessionId !== state.sessionId) {
      this.piSessionId = state.sessionId;
      this.config.onSdkSessionIdUpdate?.(state.sessionId);
    }
    return state.sessionId ?? null;
  }

  private assertChildRuntimeActive(epoch?: number): void {
    if (
      this.childRuntimeDisposed
      || this.childRuntimeTeardown
      || (epoch !== undefined && epoch !== this.childRuntimeEpoch)
    ) {
      throw new Error('Parent runtime is unavailable for child task execution');
    }
  }

  private async acquireChildRuntimeLease(
    acquire: () => Promise<PiHostLease>,
  ): Promise<{ lease: PiHostLease; epoch: number }> {
    this.assertChildRuntimeActive();
    const epoch = this.childRuntimeEpoch;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
    this.childRuntimeAcquisitions.add(barrier);
    try {
      const lease = await acquire();
      try {
        this.assertChildRuntimeActive(epoch);
      } catch (error) {
        await lease.release();
        throw error;
      }
      this.childRuntimeLeases.add(lease);
      this.retainChildRuntimeClientEvents(lease);
      return { lease, epoch };
    } finally {
      this.childRuntimeAcquisitions.delete(barrier);
      releaseBarrier();
    }
  }

  private retainChildRuntimeClientEvents(lease: PiHostLease): void {
    const runtimeId = lease.runtime.runtimeId;
    const existing = this.childRuntimeClientSubscriptions.get(runtimeId);
    if (existing) {
      existing.refCount++;
      return;
    }
    const unsubscribeClient = lease.runtime.onClientEvent(event => {
      this.handlePiClientEvent(event, lease.runtime);
    });
    const unsubscribeActivity = lease.runtime.onEvent(event => {
      const childSessionId = lease.runtime.runtimeSummary.sessionId;
      if (!childSessionId) return;
      let activity: ChildTaskActivityEvent | undefined;
      if (event.type === 'tool_execution_start') {
        activity = {
          childSessionId,
          phase: 'activity',
          status: 'running',
          summary: `Started tool ${event.toolName}`,
          timestamp: Date.now(),
        };
      } else if (event.type === 'tool_execution_end') {
        activity = {
          childSessionId,
          phase: 'activity',
          status: 'running',
          summary: `${event.isError ? 'Failed' : 'Completed'} tool ${event.toolName}`,
          timestamp: Date.now(),
        };
      } else if (event.type === 'agent_start') {
        activity = {
          childSessionId,
          phase: 'status',
          status: 'running',
          summary: 'Subagent is running',
          timestamp: Date.now(),
        };
      }
      if (activity) this.config.onChildTaskActivity?.(activity);
    });
    this.childRuntimeClientSubscriptions.set(runtimeId, {
      refCount: 1,
      unsubscribe: () => {
        unsubscribeClient();
        unsubscribeActivity();
      },
    });
    for (const event of lease.startupEvents) this.handlePiClientEvent(event, lease.runtime);
  }

  private releaseChildRuntimeClientEvents(runtimeId: string): void {
    const subscription = this.childRuntimeClientSubscriptions.get(runtimeId);
    if (!subscription) return;
    subscription.refCount--;
    if (subscription.refCount > 0) return;
    this.childRuntimeClientSubscriptions.delete(runtimeId);
    subscription.unsubscribe();
    this.childCoordinationBridges.get(runtimeId)?.close();
    this.childCoordinationBridges.delete(runtimeId);
    this.config.onHostCapabilityRuntimeReleased?.(runtimeId);
  }

  private async startChildExecution(
    runtime: PiRuntimeHandle,
    childSessionId: string,
    sessionPath: string,
    background: boolean,
    attemptId: string,
  ): Promise<ChildAttemptRegistration> {
    const acquire = this.config.onChildAttemptStarted;
    if (!acquire) throw new Error('Child Attempt registration is unavailable');
    return acquire({
      runtimeId: runtime.runtimeId,
      childSessionId,
      sessionPath,
      background,
      attemptId,
    });
  }

  private getChildExecution(runtime: PiRuntimeHandle, childSessionId: string): ChildAttemptRegistration {
    const execution = this.config.getChildAttempt?.(runtime.runtimeId, childSessionId);
    if (!execution) throw new Error('Active child Attempt is unavailable');
    return execution;
  }

  private async abandonChildExecution(
    runtime: PiRuntimeHandle,
    childSessionId: string,
    attemptId: string,
  ): Promise<void> {
    await this.config.onChildAttemptAbandoned?.(runtime.runtimeId, childSessionId, attemptId);
  }

  private async failChildOperation(
    runtime: PiRuntimeHandle,
    childSessionId: string,
    sessionPath: string,
    execution: ChildAttemptRegistration,
    reason: string,
  ): Promise<void> {
    if (!execution.operationId || !this.config.onChildTaskSettled) return;
    await this.config.onChildTaskSettled({
      operationId: execution.operationId,
      attemptId: execution.attemptId,
      runtimeId: runtime.runtimeId,
      childSessionId,
      sessionPath,
      status: 'failed',
      output: reason,
      modified: new Date().toISOString(),
    });
  }

  /**
   * Spawn a child session in the pi session tree via Pi RpcClient.
   *
   * Delegates to Pi's native new-session RPC with the current session file as
   * parent metadata so Pi can preserve lineage in its own session tree.
   *
   * This is the thin-wrapper path used by the subagent tool: Mortise no longer
   * creates an independent session file/manager; it just asks pi to branch the
   * active session tree.
   *
   * @param parentSessionId Active Pi session ID retained for the Mortise caller contract.
   * @param options Spawn overrides (prompt, connection, model, etc.)
   * @returns { sessionId, sessionPath } of the newly created child session
   */
  async spawnChildSession(
    parentSessionId: string,
    options: PiSpawnChildSessionOptions,
  ): Promise<PiSpawnChildSessionResult> {
    for (const attachment of options.attachments ?? []) {
      if (!isAbsolute(attachment.path) || !existsSync(attachment.path)) {
        throw new Error(`Child task attachment must be an existing absolute path: ${attachment.path}`);
      }
    }
    const parent = await this.ensureRpcClient();
    const parentLease = this.rpcHostLease;
    if (!parentLease) throw new Error('Pi multi-runtime host is unavailable for child task execution');
    const previous = await parent.getState();
    const seedMessages = selectReliableForkMessages(await parent.getMessages(), options.forkTurns);
    const resolvedOptions = this.resolveChildRuntimeOptions(options, previous);
    const spawnConfig = {
      connection: resolvedOptions.connection,
      model: resolvedOptions.model,
      thinkingLevel: resolvedOptions.thinkingLevel,
      template: options.template,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      background: options.background,
      agent: options.agent,
      forkTurns: options.forkTurns,
      seedMessageCount: seedMessages.length,
      schema: options.schema,
    };
    const childSessionId = randomUUID();
    const { lease, epoch } = await this.acquireChildRuntimeLease(() => parentLease.acquireRuntime({
      runtimeId: `subagent-${childSessionId}`,
      cwd: this.resolvedWorkspaceRoot(),
      agentDir: PI_AGENT_DIR,
      projectConfigDir: MORTISE_PROJECT_DIR,
      extensionPaths: this.getMortiseExtensionPaths(),
	  extensionServiceScope: 'session',
	  extensionServiceWorkspaceKey: this.config.workspace.id,
      sessionDir: this.getChildSessionDir(),
      sessionId: childSessionId,
      parentSession: previous.sessionFile,
      spawnedFrom: parentSessionId,
      spawnConfig,
      seedMessages,
      persistInitialState: true,
      uiCapabilities: {
        kind: 'none',
        dialogs: false,
        contributions: false,
        interactionSchemas: [],
      },
    }));
    const runtime = lease.runtime;
    let releaseHere = true;
    let settlement: { promise: Promise<void>; cancel: () => void } | undefined;
    let childExecution: ChildAttemptRegistration | undefined;
    let promptAccepted = false;
    try {
      await this.configureChildRuntime(runtime, resolvedOptions, previous);
      this.assertChildRuntimeActive(epoch);
      const state = await runtime.getState();
      const sessionId = state.sessionId;
      const sessionPath = state.sessionFile ?? runtime.runtimeSummary.sessionFile ?? '';
      if (!options.prompt?.trim()) {
        return { sessionId, sessionPath, status: 'interrupted' };
      }

      const attachmentContext = options.attachments?.map(attachment =>
        `[Attached file: ${attachment.name ?? basename(attachment.path)}]\n[Path: ${attachment.path}]`,
      ) ?? [];
      const schemaInstruction = options.schema
        ? `Return only JSON that satisfies this JSON Schema:\n${JSON.stringify(options.schema, null, 2)}`
        : undefined;
      const childPrompt = [...attachmentContext, options.prompt, schemaInstruction].filter(Boolean).join('\n\n');
      this.assertChildRuntimeActive(epoch);
      const disposition = await runtime.prompt(childPrompt, undefined, {
        systemPrompt: options.systemPrompt,
        attachments: options.attachments?.map(attachment => ({
          id: randomUUID(),
          name: attachment.name ?? basename(attachment.path),
        })),
      });
      if (disposition.status !== 'started') {
        throw new Error(`Child prompt was not started: ${disposition.status}`);
      }
      childExecution = await this.startChildExecution(
        runtime,
        sessionId,
        sessionPath,
        options.background === true,
        disposition.attemptId,
      );
      const { attemptId, operationId: backgroundOperationId } = childExecution;
      settlement = this.watchChildSettlement(runtime, sessionId, attemptId);
      promptAccepted = true;
      this.assertChildRuntimeActive(epoch);
      if (options.background) {
        releaseHere = false;
        void settlement.promise
          .then(() => this.childRuntimeDisposed
            ? undefined
            : this.notifyChildTaskSettled(
                parentSessionId,
                sessionId,
                sessionPath,
                backgroundOperationId,
                attemptId,
                runtime.runtimeId,
              ))
          .catch(error => this.debug(`Child task ${sessionId} remains pending verification: ${error instanceof Error ? error.message : String(error)}`))
          .catch(error => this.debug(`Child task ${sessionId} delivery failed: ${error instanceof Error ? error.message : String(error)}`))
          .finally(async () => {
            await this.releaseChildRuntimeLease(lease);
          })
          .catch(error => this.debug(`Child task ${sessionId} release failed: ${error instanceof Error ? error.message : String(error)}`));
        return { sessionId, sessionPath, status: 'running' };
      }

      await settlement.promise;
      const output = await runtime.getLastAssistantText();
      const persisted = (await this.listChildSessions(parentSessionId)).find(child => child.sessionId === sessionId);
      return {
        sessionId,
        sessionPath,
        status: persisted?.status ?? 'interrupted',
        ...(output ? { output } : {}),
      };
    } catch (error) {
      if (promptAccepted && settlement && childExecution) {
        this.debug(
          `Child prompt was accepted before the parent runtime changed; retaining settlement tracking: ${error instanceof Error ? error.message : String(error)}`,
        );
        releaseHere = false;
        return await this.finishChildOperation(
          parentSessionId,
          { lease, runtime, child: {
            sessionId: childSessionId,
            sessionPath: runtime.runtimeSummary.sessionFile ?? '',
          } as PiChildSessionInfo, epoch },
          settlement.promise,
          childExecution,
          options.background === true,
          childExecution.operationId,
        );
      }
      settlement?.cancel();
      if (childExecution && !promptAccepted) {
        await this.abandonChildExecution(runtime, childSessionId, childExecution.attemptId)
          .catch(() => undefined);
      }
      throw error;
    } finally {
      if (releaseHere) await this.releaseChildRuntimeLease(lease);
    }
  }

  private async configureChildRuntime(
    runtime: PiRuntimeHandle,
    options: PiSpawnChildSessionOptions,
    parentState: Awaited<ReturnType<PiRuntimeHandle['getState']>>,
  ): Promise<void> {
    if (options.name) await runtime.setSessionName(options.name);
    let semanticModel: ReturnType<typeof resolvePiModelReference>;
    if (options.model) {
      semanticModel = isPiModelReference(options.model)
        ? resolvePiModelReference(options.model, {
            current: parentState.model ? {
              provider: parentState.model.provider,
              model: parentState.model.id,
              thinkingLevel: parentState.thinkingLevel,
            } : undefined,
          })
        : undefined;
      if (isPiModelReference(options.model) && !semanticModel) {
        throw new Error(`Model reference is unavailable: ${options.model}`);
      }
    }
    const provider = semanticModel?.provider || options.connection || getBackendRuntime(this.config).piAuthProvider || parentState.model?.provider;
    const model = semanticModel?.model ?? options.model ?? parentState.model?.id;
    if (provider && model) await runtime.setModel(provider, model);
    const thinkingLevel = options.thinkingLevel ?? semanticModel?.thinkingLevel ?? parentState.thinkingLevel;
    if (thinkingLevel) await runtime.setThinkingLevel(thinkingLevel);

    await runtime.setToolExecutionHandler(async request => {
      const decision = await this.handleToolExecutionBoundary(request);
      return this.getChildCoordinationBridge(runtime).beforeTool({
        toolName: request.toolName,
        toolCallId: request.toolCallId,
        input: request.input,
        ...('assistantResponseId' in request && typeof request.assistantResponseId === 'string'
          ? { assistantResponseId: request.assistantResponseId }
          : {}),
        assistantTimestamp: 'assistantTimestamp' in request && typeof request.assistantTimestamp === 'number'
          ? request.assistantTimestamp
          : Date.now(),
      }, decision);
    });
    await runtime.setToolResultHandler(result => this.handleCoordinatedToolResult(result));
    this.assertBackendSessionToolParity();
    const sessionToolDefs = getSessionHostToolDefs()
      .filter(definition => !PI_EXTENSION_OWNED_SESSION_TOOL_NAMES.has(definition.name));
    await runtime.registerTools(
      sessionToolDefs as PiRpcHostToolDefinition[],
      request => this.executeHostTool(request),
    );
    const profile = await runtime.getState();
    const disabledTools = new Set(getDisabledAgentTools());
    const requestedTools = options.tools ? new Set(options.tools) : undefined;
    await runtime.setActiveTools(profile.activeTools.filter(name =>
      !disabledTools.has(name) && (!requestedTools || requestedTools.has(name)),
    ));
    await runtime.setCompactionPrompt(getCustomCompactionPrompt());
  }

  private resolveChildRuntimeOptions(
    options: PiSpawnChildSessionOptions,
    parentState: Awaited<ReturnType<PiRuntimeHandle['getState']>>,
  ): PiSpawnChildSessionOptions {
    let semanticModel: ReturnType<typeof resolvePiModelReference>;
    if (options.model && isPiModelReference(options.model)) {
      semanticModel = resolvePiModelReference(options.model, {
        current: parentState.model ? {
          provider: parentState.model.provider,
          model: parentState.model.id,
          thinkingLevel: parentState.thinkingLevel,
        } : undefined,
      });
      if (!semanticModel) throw new Error(`Model reference is unavailable: ${options.model}`);
    }
    return {
      ...options,
      connection: semanticModel?.provider || options.connection || getBackendRuntime(this.config).piAuthProvider || parentState.model?.provider,
      model: semanticModel?.model ?? options.model ?? parentState.model?.id,
      thinkingLevel: options.thinkingLevel ?? semanticModel?.thinkingLevel ?? parentState.thinkingLevel,
    };
  }

  private getChildSessionDir(): string {
    const parentSessionId = this.config.session?.mortiseId;
    if (!parentSessionId) throw new Error('Child tasks require a persisted parent Session');
    return join(getSessionPath(this.config.workspace.id, parentSessionId), 'subagents');
  }

  private emitPiProjectionEvents(event: AgentEvent, attemptId?: string): void {
    const builder = this.getProjectionBuilder();
    const emit = this.config.onPiProjectionEvent;
    if (!builder || !emit) return;
    for (const projectionEvent of builder.accept(event, attemptId)) emit(projectionEvent);
  }

  projectQueuedUser(message: HostQueuedUserProjection): void {
    for (const event of this.getProjectionBuilder()?.acceptHostQueuedUser(message) ?? []) {
      this.config.onPiProjectionEvent?.(event);
    }
  }

  projectQueuedCancellation(message: HostQueuedCancellationProjection): number {
    const events = this.getProjectionBuilder()?.acceptHostQueueCancellation(message) ?? [];
    for (const event of events) {
      this.config.onPiProjectionEvent?.(event);
    }
    return events.length;
  }

  projectRuntimeError(error: HostRuntimeErrorProjection): void {
    for (const event of this.getProjectionBuilder()?.acceptHostRuntimeError(error) ?? []) {
      this.config.onPiProjectionEvent?.(event);
    }
  }

  private emitRawPiProjectionEvents(event: Record<string, unknown>): void {
    const builder = this.getProjectionBuilder();
    const emit = this.config.onPiProjectionEvent;
    if (!builder || !emit) return;
    for (const projectionEvent of builder.acceptRuntimeEvent(event)) emit(projectionEvent);
  }

  private getProjectionBuilder(): PiProjectionBuilder | null {
    const sessionId = this.config.session?.mortiseId;
    if (!this.config.onPiProjectionEvent || !sessionId) return null;
    const client = this.rpcClient;
    const runtimeId = client
      ? `${client.runtimeId}:${this.projectionEpoch}`
      : `pending:${sessionId}:${this.projectionEpoch}`;
    if (!this.projectionBuilder || this.projectionBuilder.runtimeId !== runtimeId) {
      this.projectionBuilder = new PiProjectionBuilder(
        sessionId,
        runtimeId,
        this.config.getPiProjectionSnapshot?.(),
      );
    }
    return this.projectionBuilder;
  }

  /**
   * Verify whether a spawn_child_session request actually succeeded on the Pi
   * side after the result was lost (timeout / RpcClient error). Calls
   * list_child_sessions and rewrites the rejection message if a child session
   * created during the spawn window is found.
   *
   * Used to surface orphan sessions instead of blindly assuming failure. Does
   * NOT auto-delete the orphan — the caller may still want it. list_child_sessions
   * is read-only and never triggers a spawn, so there is no recursion risk.
   */
  async listChildSessions(parentSessionId: string): Promise<PiChildSessionInfo[]> {
    try {
      const client = await this.ensureRpcClient();
      this.requirePiRpcCommand('list_child_sessions', 'child session listing');
      // ensureRpcClient() hydrates piSessionId from getState(). Prefer that
      // authoritative runtime identity over a pre-readiness Mortise ID hint.
      const sessions = await client.listChildSessions(this.piSessionId ?? parentSessionId, this.getChildSessionDir());
      return sessions.map(session => ({
        sessionId: session.id,
        sessionPath: session.path,
        name: session.name,
        cwd: session.cwd,
        created: session.created,
        modified: session.modified,
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
        status: session.status,
        lastOutput: session.lastOutput,
        error: session.error,
        persistedClientMutationIds: session.persistedClientMutationIds,
        history: session.history,
        spawnConfig: session.spawnConfig,
      }));
    } catch (error) {
      this.debug(`[listChildSessions] Failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async sendChildSessionMessage(
    parentSessionId: string,
    childSessionId: string,
    message: string,
    options: { background?: boolean; systemPrompt?: string; tools?: string[] } = {},
  ): Promise<PiSpawnChildSessionResult> {
    const child = (await this.listChildSessions(parentSessionId)).find(item => item.sessionId === childSessionId);
    if (!child) throw new Error(`Child task not found: ${childSessionId}`);
    if (child.status === 'completed' || child.status === 'failed') {
      throw new Error(`Cannot message terminal child task: ${childSessionId}`);
    }
    const messageId = randomUUID();
    if (child.status === 'interrupted') {
      await this.queueChildInboxMessage(child, messageId, message);
      return {
        sessionId: child.sessionId,
        sessionPath: child.sessionPath,
        status: 'interrupted',
        ...(child.lastOutput ? { output: child.lastOutput } : {}),
      };
    }
    const opened = await this.acquireChildRuntime(parentSessionId, childSessionId, options);
    let persistence: { promise: Promise<boolean>; cancel: () => void } | undefined;
    let settlement: { promise: Promise<void>; cancel: () => void } | undefined;
    let accepted = false;
    let childExecution: ChildAttemptRegistration | undefined;
    try {
      const isStreaming = (await opened.runtime.getState()).isStreaming;
      await this.queueChildInboxMessage(opened.child, messageId, message, opened.epoch);
      this.assertChildRuntimeActive(opened.epoch);
      if (!isStreaming) {
        await this.releaseChildRuntimeLease(opened.lease);
        return { sessionId: opened.child.sessionId, sessionPath: opened.child.sessionPath, status: 'interrupted' };
      }
      persistence = this.watchChildMessagePersistence(opened.runtime, [messageId]);
      const disposition = await opened.runtime.steer(message, undefined, { clientMutationId: messageId });
      if (disposition.status !== 'queued') throw new Error(`Child steer was not queued: ${disposition.status}`);
      childExecution = await this.startChildExecution(
        opened.runtime,
        opened.child.sessionId,
        opened.child.sessionPath,
        true,
        disposition.attemptId,
      );
      const { attemptId, operationId: backgroundOperationId } = childExecution;
      settlement = this.watchChildSettlement(opened.runtime, opened.child.sessionId, attemptId);
      accepted = true;
      return await this.finishChildOperation(
        parentSessionId,
        opened,
        settlement.promise,
        childExecution,
        true,
        backgroundOperationId,
        [messageId],
        persistence,
      );
    } catch (error) {
      settlement?.cancel();
      persistence?.cancel();
      if (!accepted) {
        await this.removeChildInboxMessages(opened.child, [messageId], opened.epoch).catch(() => undefined);
        if (childExecution) {
          await this.failChildOperation(
            opened.runtime,
            opened.child.sessionId,
            opened.child.sessionPath,
            childExecution,
            `Child steer was rejected before Pi accepted it: ${error instanceof Error ? error.message : String(error)}`,
          ).catch(() => undefined);
        }
      }
      await this.releaseChildRuntimeLease(opened.lease);
      throw error;
    }
  }

  async resumeChildSession(
    parentSessionId: string,
    childSessionId: string,
    options: { background?: boolean; systemPrompt?: string; tools?: string[] } = {},
  ): Promise<PiSpawnChildSessionResult> {
    const opened = await this.acquireChildRuntime(parentSessionId, childSessionId, options);
    let persistence: { promise: Promise<boolean>; cancel: () => void } | undefined;
    let settlement: { promise: Promise<void>; cancel: () => void } | undefined;
    let childExecution: ChildAttemptRegistration | undefined;
    let accepted = false;
    let pendingMessages: ChildInboxMessage[] = [];
    try {
      if ((await opened.runtime.getState()).isStreaming) {
        await this.releaseChildRuntimeLease(opened.lease);
        return { sessionId: opened.child.sessionId, sessionPath: opened.child.sessionPath, status: 'running' };
      }
      pendingMessages = await this.getPendingChildInboxMessages(opened.child, opened.epoch);
      persistence = this.watchChildMessagePersistence(opened.runtime, pendingMessages.map(item => item.id));
      let disposition: Awaited<ReturnType<PiRuntimeHandle['prompt']>>;
      if (pendingMessages.length > 0) {
		const [first, ...rest] = pendingMessages;
		disposition = await opened.runtime.prompt(
		  first!.message,
		  undefined,
		  {
			systemPrompt: options.systemPrompt ?? opened.child.spawnConfig?.systemPrompt,
			clientMutationId: first!.id,
		  },
		);
      } else {
		disposition = await opened.runtime.continue({
		  systemPrompt: options.systemPrompt ?? opened.child.spawnConfig?.systemPrompt,
		});
      }
      if (disposition.status !== 'started') throw new Error(`Child continuation was not started: ${disposition.status}`);
      childExecution = await this.startChildExecution(
        opened.runtime,
        opened.child.sessionId,
        opened.child.sessionPath,
        options.background === true,
        disposition.attemptId,
      );
      const { attemptId, operationId: backgroundOperationId } = childExecution;
	  settlement = this.watchChildSettlement(opened.runtime, opened.child.sessionId, attemptId);
	  accepted = true;
      for (const pending of pendingMessages.slice(1)) {
		const followUpDisposition = await opened.runtime.followUp(pending.message, undefined, { clientMutationId: pending.id });
		if (followUpDisposition.status !== 'queued' || followUpDisposition.attemptId !== attemptId) {
		  throw new Error(`Child follow-up was not queued for Attempt ${attemptId}`);
		}
	  }
      return await this.finishChildOperation(
        parentSessionId,
        opened,
        settlement.promise,
        childExecution,
        options.background === true,
        backgroundOperationId,
        pendingMessages.map(item => item.id),
        persistence,
      );
    } catch (error) {
      if (accepted && settlement && childExecution) {
        this.debug(
          `Child resume accepted its first message but deferred remaining inbox work after a follow-up rejection: ${error instanceof Error ? error.message : String(error)}`,
        );
        return await this.finishChildOperation(
          parentSessionId,
          opened,
          settlement.promise,
          childExecution,
          options.background === true,
          childExecution.operationId,
          pendingMessages.map(item => item.id),
          persistence,
        );
      }
      settlement?.cancel();
      persistence?.cancel();
      if (!accepted && childExecution) {
        await this.abandonChildExecution(
          opened.runtime,
          opened.child.sessionId,
          childExecution.attemptId,
        ).catch(() => undefined);
      }
      await this.releaseChildRuntimeLease(opened.lease);
      throw error;
    }
  }

  async interruptChildSession(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<PiSpawnChildSessionResult> {
    await this.ensureRpcClient();
    const parentLease = this.rpcHostLease;
    if (!parentLease) throw new Error('Pi multi-runtime host is unavailable for child task execution');
    const child = (await this.listChildSessions(parentSessionId)).find(item => item.sessionId === childSessionId);
    if (!child) throw new Error(`Child task not found: ${childSessionId}`);
    const active = (await parentLease.client.listRuntimes()).find(item => item.sessionId === childSessionId);
    if (!active) {
      return { sessionId: child.sessionId, sessionPath: child.sessionPath, status: child.status, output: child.lastOutput };
    }
    const { lease, epoch } = await this.acquireChildRuntimeLease(() => parentLease.acquireRuntime({
      runtimeId: active.runtimeId,
      cwd: active.cwd,
      agentDir: PI_AGENT_DIR,
      projectConfigDir: MORTISE_PROJECT_DIR,
	  extensionServiceScope: 'session',
	  extensionServiceWorkspaceKey: this.config.workspace.id,
    }));
    try {
      this.assertChildRuntimeActive(epoch);
	  const { attemptId } = this.getChildExecution(lease.runtime, child.sessionId);
	  const settled = lease.runtime.waitForIdle(attemptId);
		  const disposition = await lease.runtime.abort();
		  if (disposition.status !== 'accepted' || disposition.attemptId !== attemptId) {
			throw new Error(`Child abort was not accepted for Attempt ${attemptId}`);
		  }
      await settled;
      return { sessionId: child.sessionId, sessionPath: child.sessionPath, status: 'interrupted' };
    } finally {
      await this.releaseChildRuntimeLease(lease);
    }
  }

  async prepareChildTasksForParentDeletion(): Promise<{ childSessionIds: string[] }> {
    const client = await this.ensureRpcClient();
    this.requirePiRpcCommand('list_child_sessions', 'parent Session deletion');
    const parentSessionId = this.piSessionId ?? (await client.getState()).sessionId;
    if (!parentSessionId) return { childSessionIds: [] };
    const children = await client.listChildSessions(parentSessionId, this.getChildSessionDir());
    for (const child of children) {
      if (child.status !== 'running') continue;
      const result = await this.interruptChildSession(parentSessionId, child.id);
      if (result.status === 'running') {
        throw new Error(`Child task did not settle before parent deletion: ${child.id}`);
      }
    }
    return { childSessionIds: children.map(child => child.id) };
  }

  private async acquireChildRuntime(
    parentSessionId: string,
    childSessionId: string,
    options: { systemPrompt?: string; tools?: string[] },
  ): Promise<{ lease: PiHostLease; runtime: PiRuntimeHandle; child: PiChildSessionInfo; epoch: number }> {
    const parent = await this.ensureRpcClient();
    const parentLease = this.rpcHostLease;
    if (!parentLease) throw new Error('Pi multi-runtime host is unavailable for child task execution');
    const child = (await this.listChildSessions(parentSessionId)).find(item => item.sessionId === childSessionId);
    if (!child) throw new Error(`Child task not found: ${childSessionId}`);
    const active = (await parentLease.client.listRuntimes()).find(item => item.sessionId === childSessionId);
    const { lease, epoch } = await this.acquireChildRuntimeLease(() => parentLease.acquireRuntime(active ? {
      runtimeId: active.runtimeId,
      cwd: active.cwd,
      agentDir: PI_AGENT_DIR,
      projectConfigDir: MORTISE_PROJECT_DIR,
	  extensionServiceScope: 'session',
	  extensionServiceWorkspaceKey: this.config.workspace.id,
    } : {
      runtimeId: `subagent-${childSessionId}`,
      cwd: this.resolvedWorkspaceRoot(),
      agentDir: PI_AGENT_DIR,
      projectConfigDir: MORTISE_PROJECT_DIR,
      extensionPaths: this.getMortiseExtensionPaths(),
	  extensionServiceScope: 'session',
	  extensionServiceWorkspaceKey: this.config.workspace.id,
      sessionPath: child.sessionPath,
      uiCapabilities: {
        kind: 'none',
        dialogs: false,
        contributions: false,
        interactionSchemas: [],
      },
    }));
    try {
      if (!active) {
        const parentState = await parent.getState();
        await this.configureChildRuntime(lease.runtime, {
          connection: child.spawnConfig?.connection,
          model: child.spawnConfig?.model,
          thinkingLevel: child.spawnConfig?.thinkingLevel as ThinkingLevel | undefined,
          template: child.spawnConfig?.template,
          background: child.spawnConfig?.background,
          tools: options.tools ?? child.spawnConfig?.tools,
          systemPrompt: options.systemPrompt ?? child.spawnConfig?.systemPrompt,
        }, parentState);
      }
      this.assertChildRuntimeActive(epoch);
      return { lease, runtime: lease.runtime, child, epoch };
    } catch (error) {
      await this.releaseChildRuntimeLease(lease);
      throw error;
    }
  }

  private async finishChildOperation(
    parentSessionId: string,
    opened: { lease: PiHostLease; runtime: PiRuntimeHandle; child: PiChildSessionInfo; epoch: number },
    settled: Promise<void>,
    execution: ChildAttemptRegistration,
    background: boolean,
    backgroundOperationId?: string,
    inboxMessageIds: string[] = [],
    persistence?: { promise: Promise<boolean>; cancel: () => void },
  ): Promise<PiSpawnChildSessionResult> {
    if (background) {
      void settled
        .then(async () => {
          if (await (persistence?.promise ?? Promise.resolve(true))) {
            await this.completeChildInboxMessages(opened.child, inboxMessageIds, opened.epoch);
          }
        })
        .then(() => this.childRuntimeDisposed ? undefined : this.notifyChildTaskSettled(
          parentSessionId,
          opened.child.sessionId,
          opened.child.sessionPath,
          backgroundOperationId,
          execution.attemptId,
          opened.runtime.runtimeId,
        ))
        .catch(error => {
          persistence?.cancel();
          this.debug(`Child task ${opened.child.sessionId} remains pending verification: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(async () => {
          await this.releaseChildRuntimeLease(opened.lease);
        });
      return { sessionId: opened.child.sessionId, sessionPath: opened.child.sessionPath, status: 'running' };
    }
    try {
      await settled;
    } catch (error) {
      persistence?.cancel();
      throw error;
    }
    if (await (persistence?.promise ?? Promise.resolve(true))) {
      await this.completeChildInboxMessages(opened.child, inboxMessageIds, opened.epoch);
    }
    const output = await opened.runtime.getLastAssistantText();
    const persisted = (await this.listChildSessions(parentSessionId))
      .find(child => child.sessionId === opened.child.sessionId);
    await this.releaseChildRuntimeLease(opened.lease);
    return {
      sessionId: opened.child.sessionId,
      sessionPath: opened.child.sessionPath,
      status: persisted?.status ?? 'interrupted',
      ...(output ? { output } : {}),
    };
  }

  private getChildInboxPath(child: PiChildSessionInfo): string {
    return `${child.sessionPath}.inbox.json`;
  }

  private async readChildInbox(child: PiChildSessionInfo): Promise<ChildInbox> {
    try {
      const parsed = JSON.parse(await readFile(this.getChildInboxPath(child), 'utf8')) as Partial<ChildInbox>;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.messages)) {
        return { schemaVersion: 1, messages: parsed.messages };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { schemaVersion: 1, messages: [] };
  }

  private mutateChildInbox(
    child: PiChildSessionInfo,
    mutate: (inbox: ChildInbox) => void,
    epoch?: number,
  ): Promise<void> {
    const path = this.getChildInboxPath(child);
    const previous = this.childInboxWrites.get(path) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      if (epoch !== undefined) this.assertChildRuntimeActive(epoch);
      const inbox = await this.readChildInbox(child);
      if (epoch !== undefined) this.assertChildRuntimeActive(epoch);
      mutate(inbox);
      await atomicWriteFile(path, `${JSON.stringify(inbox, null, 2)}\n`);
    });
    this.childInboxWrites.set(path, next);
    void next.then(
      () => {
        if (this.childInboxWrites.get(path) === next) this.childInboxWrites.delete(path);
      },
      () => {
        if (this.childInboxWrites.get(path) === next) this.childInboxWrites.delete(path);
      },
    );
    return next;
  }

  private async queueChildInboxMessage(
    child: PiChildSessionInfo,
    id: string,
    message: string,
    epoch?: number,
  ): Promise<void> {
    await this.mutateChildInbox(child, (inbox) => {
      if (inbox.messages.some(item => item.id === id)) return;
      inbox.messages = inbox.messages.filter(item => item.state === 'pending');
      if (inbox.messages.length >= MAX_PENDING_CHILD_INBOX_MESSAGES) {
        throw new Error(`Child task inbox is full (${MAX_PENDING_CHILD_INBOX_MESSAGES} pending messages)`);
      }
      inbox.messages.push({
        id,
        message,
        state: 'pending',
        createdAt: new Date().toISOString(),
      });
    }, epoch);
  }

  private async completeChildInboxMessages(child: PiChildSessionInfo, ids: string[], epoch?: number): Promise<void> {
    if (ids.length === 0) return;
    const completed = new Set(ids);
    await this.mutateChildInbox(child, (inbox) => {
      inbox.messages = inbox.messages.filter(item => !completed.has(item.id));
    }, epoch);
  }

  private async removeChildInboxMessages(child: PiChildSessionInfo, ids: string[], epoch?: number): Promise<void> {
    if (ids.length === 0) return;
    const removed = new Set(ids);
    await this.mutateChildInbox(child, (inbox) => {
      inbox.messages = inbox.messages.filter(item => !removed.has(item.id));
    }, epoch);
  }

  private watchChildMessagePersistence(
    runtime: PiRuntimeHandle,
    ids: string[],
  ): { promise: Promise<boolean>; cancel: () => void } {
    if (ids.length === 0) return { promise: Promise.resolve(true), cancel: () => undefined };
    const pending = new Set(ids);
    let finish!: (persisted: boolean) => void;
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const settle = (persisted: boolean) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      finish(persisted);
    };
    const promise = new Promise<boolean>(resolve => { finish = resolve; });
    unsubscribe = runtime.onEvent(event => {
      if (event.type !== 'pi_user_message_persisted') return;
      const clientMutationId = (event as { clientMutationId?: unknown }).clientMutationId;
      if (typeof clientMutationId !== 'string') return;
      pending.delete(clientMutationId);
      if (pending.size === 0) settle(true);
    });
    timer = setTimeout(() => settle(false), 600_000);
    timer.unref?.();
    return { promise, cancel: () => settle(false) };
  }

  private watchChildSettlement(
    runtime: PiRuntimeHandle,
    childSessionId: string,
    attemptId: string,
  ): { promise: Promise<void>; cancel: () => void } {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    let unsubscribe: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let callerFinished = false;
    let cancelled = false;
    let hostSettlement: Promise<void> | undefined;
    const settleHost = (): Promise<void> => {
      if (!hostSettlement) {
        hostSettlement = Promise.resolve(
          this.config.onChildAttemptSettled?.(runtime.runtimeId, childSessionId, attemptId),
        );
      }
      return hostSettlement;
    };
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    unsubscribe = runtime.onEvent(event => {
      if (cancelled || event.type !== 'agent_settled' || event.attemptId !== attemptId) return;
      if (timer) clearTimeout(timer);
      unsubscribe();
      void settleHost().then(
        () => {
          if (!callerFinished) {
            callerFinished = true;
            resolvePromise();
          }
        },
        cause => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          if (!callerFinished) {
            callerFinished = true;
            rejectPromise(error);
          } else {
            this.debug(`Late child settlement failed for ${runtime.runtimeId}: ${error.message}`);
          }
        },
      );
    });
    timer = setTimeout(() => {
      if (callerFinished || cancelled) return;
      callerFinished = true;
      rejectPromise(new Error(
        `Timed out waiting for child runtime ${runtime.runtimeId}; execution ${attemptId} remains pending verification`,
      ));
    }, 600_000);
    timer.unref?.();
    return {
      promise,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        if (!callerFinished) {
          callerFinished = true;
          resolvePromise();
        }
      },
    };
  }

  private async getPendingChildInboxMessages(child: PiChildSessionInfo, epoch?: number): Promise<ChildInboxMessage[]> {
    await this.childInboxWrites.get(this.getChildInboxPath(child));
    if (epoch !== undefined) this.assertChildRuntimeActive(epoch);
    const inbox = await this.readChildInbox(child);
    const persistedMutationIds = new Set(child.persistedClientMutationIds);
    const alreadyPersisted = inbox.messages
      .filter(item => item.state === 'pending' && persistedMutationIds.has(item.id))
      .map(item => item.id);
    if (alreadyPersisted.length > 0) {
      await this.completeChildInboxMessages(child, alreadyPersisted, epoch);
    }
    return inbox.messages.filter(item => item.state === 'pending' && !alreadyPersisted.includes(item.id));
  }

  private async notifyChildTaskSettled(
    parentSessionId: string,
    childSessionId: string,
    sessionPath: string,
    operationId?: string,
    attemptId?: string,
    runtimeId?: string,
  ): Promise<void> {
    if (!operationId || !attemptId || !runtimeId || !this.config.onChildTaskSettled) return;
    const child = (await this.listChildSessions(parentSessionId))
      .find(candidate => candidate.sessionId === childSessionId);
    await this.config.onChildTaskSettled({
      operationId,
      attemptId,
      runtimeId,
      childSessionId,
      sessionPath,
      status: child?.status === 'running' || !child ? 'interrupted' : child.status,
      output: child?.lastOutput,
      modified: child?.modified ?? new Date().toISOString(),
    });
  }

  /**
   * Ask Pi to compact the active session context.
   */
  private async requestCompact(
    customInstructions?: string,
  ): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number } | null> {
	const result = await (await this.ensureRpcClient()).compact(customInstructions);
    return {
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBefore: result.tokensBefore,
    };
  }

  /**
   * Ask Pi to refresh runtime-affecting custom endpoint config in-place.
   */
  private async requestRuntimeConfigUpdate(update: BackendRuntimeUpdate): Promise<boolean> {
    const client = this.rpcClient;
    if (!client) return true;
    const runtime = getBackendRuntime(this.config);
    const provider = runtime.piAuthProvider;
    if (!provider) return true;
    await client.setModel(provider, update.model);
    return true;
  }

  // ============================================================
  // 扩展桥接：向 Pi RpcClient 发送扩展相关指令
  // ============================================================

  /** Forward a validated versioned interaction response to Pi. */
  respondToExtensionInteraction(requestId: string, interaction: ExtensionInteractionResponseV1): boolean {
    const client = this.rpcClient;
    if (!client) return false;
    const interactionOwner = this.pendingExtensionInteractions.get(requestId);
    if (interactionOwner) {
      const error = validateExtensionInteractionResponseV1(interaction);
      if (error) {
        this.writePiRuntimeLog('warn', 'extension.interaction_response_rejected', {
          extensionId: interactionOwner.extensionId,
          requestId,
          error,
        });
        return false;
      }
      (client.respondToExtensionUI as (response: unknown) => void)({
        type: 'extension_ui_response',
        id: requestId,
        extensionId: interactionOwner.extensionId,
        runtimeId: interactionOwner.runtimeId,
        ...(interactionOwner.clientId ? { clientId: interactionOwner.clientId } : {}),
        ...(interactionOwner.wireSessionId ? { sessionId: interactionOwner.wireSessionId } : {}),
        interaction,
      });
      this.pendingExtensionInteractions.delete(requestId);
      this.rememberSettledExtensionInteraction(requestId);
      try {
        this.config.onExtensionEvent?.({
          type: 'extension_interaction_settled',
          schemaVersion: 1,
          requestId,
          extensionId: interactionOwner.extensionId,
          runtimeId: interactionOwner.runtimeId,
          sessionId: interactionOwner.sessionId,
          outcome: interaction.status,
        });
      } catch (error) {
        this.writePiRuntimeLog('warn', 'extension.interaction_settled_broadcast_failed', {
          extensionId: interactionOwner.extensionId,
          requestId,
          error,
        });
      }
      return true;
    }
    if (this.wasExtensionInteractionSettled(requestId)) {
      this.writePiRuntimeLog('debug', 'extension.interaction_duplicate_response_ignored', { requestId });
      return true;
    }
    return false;
  }

  private getCoordinationBridge(): WorkspaceCoordinationBridge {
    if (!this.coordinationBridge) {
      const sessionId = this.config.session?.mortiseId || this._sessionId;
      this.coordinationBridge = new WorkspaceCoordinationBridge({
        workspaceRoot: this.workspaceRoot,
        workspaceId: this.config.workspace.id,
        sessionId,
      });
    }
    return this.coordinationBridge;
  }

  private getChildCoordinationBridge(runtime: PiRuntimeHandle): WorkspaceCoordinationBridge {
    let bridge = this.childCoordinationBridges.get(runtime.runtimeId);
    if (!bridge) {
      bridge = new WorkspaceCoordinationBridge({
        workspaceRoot: this.workspaceRoot,
        workspaceId: this.config.workspace.id,
        sessionId: runtime.runtimeSummary.sessionId,
      });
      this.childCoordinationBridges.set(runtime.runtimeId, bridge);
    }
    return bridge;
  }

  private async handleCoordinatedToolResult(request: PiRpcToolResultRequest): Promise<void> {
    const coordination = request.runtimeId && this.childCoordinationBridges.has(request.runtimeId)
      ? this.childCoordinationBridges.get(request.runtimeId)
      : this.coordinationBridge;
    await coordination?.recordResult(request);
    if (!request.runtimeId) return;
    await this.config.onChildToolExecutionCompleted?.({
      runtimeId: request.runtimeId,
      attemptId: request.attemptId,
      toolCallId: request.toolCallId,
      isError: request.isError,
    });
  }

  /**
   * 调用扩展注册的命令。
   * Uses Pi's typed `invoke_extension_command` RPC and returns the command ack.
   */
  async sendExtensionCommandInvoke(commandId: string, args?: string, ownerExtensionId?: string): Promise<import('@mortise/core/types').ExtensionCommandResult> {
    try {
      const client = await this.ensureRpcClient();
      this.requirePiRpcCommand('invoke_extension_command', 'extension command invocation');
      const result = await client.invokeExtensionCommandResult(commandId, args, ownerExtensionId);
      if (!result.invoked && result.error) {
        this.debug(`[sendExtensionCommandInvoke] Pi extension command "${commandId}" was not invoked: ${result.error}`);
      }
      return {
        invoked: result.invoked,
        error: result.error,
        customMessages: result.customMessages?.map(message => ({
          customType: message.customType,
          content: typeof message.content === 'string'
            ? message.content
            : message.content
              .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
              .map(part => part.text)
              .join(''),
          display: message.display !== false,
          details: message.details,
          timestamp: message.timestamp,
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.debug(`[sendExtensionCommandInvoke] Failed for "${commandId}": ${message}`);
      return { invoked: false, error: message };
    }
  }

  async reloadExtensions(): Promise<{ reloaded: boolean; deferred: boolean }> {
    const client = this.rpcClient;
    // An unopened session has no extension runtime to refresh; it will load
    // the current package state when its next turn initializes the host.
    if (!client) return { reloaded: false, deferred: false };
    if (this.rpcClientReady) await this.rpcClientReady;
    if (this.rpcClient !== client) return { reloaded: false, deferred: false };
    return await client.reloadExtensions();
  }

  /**
   * Query currently registered Pi extension slash commands.
   *
   * The RPC stream does not emit command-registration events, so renderer
   * consumers need this snapshot to avoid missing commands registered before
   * their event listeners mounted.
   */
  async listExtensionCommands(): Promise<PiExtensionCommand[]> {
    try {
      const client = await this.ensureRpcClient();
      // getState maps to get_runtime_state for a runtime handle. Pi emits the
      // current contribution snapshots before returning that state response.
      await client.getState();
      this.requirePiRpcCommand('get_commands', 'extension command listing');
      const commands = await client.getCommands();
      return commands
        .filter(command => command.source === 'extension')
        .map(command => ({
          name: command.name,
          description: command.description,
          source: command.extensionId ?? command.sourceInfo?.source ?? 'extension',
          path: command.sourceInfo?.path,
        }));
    } catch (error) {
      this.debug(`[listExtensionCommands] Failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Ensure branched Pi sessions are backend-ready before first user message.
   * Called by SessionManager during branch creation to avoid creating
   * transcript-only branches without real Pi session context.
   */
  override async ensureBranchReady(): Promise<void> {
    const isBranchedSession = !!this.config.session?.branchFromMessageId;
    if (!isBranchedSession) return;

    // Branched sessions must include parent session path metadata for Pi forking.
    if (!this.config.session?.branchFromSessionPath) {
      throw new Error('Pi branch preflight failed: missing branchFromSessionPath metadata');
    }

    const sessionId = await this.requestEnsureSessionReady();
    if (!sessionId) {
      throw new Error('Pi branch preflight failed: RpcClient did not provide a session ID');
    }

    if (this.piSessionId !== sessionId) {
      this.piSessionId = sessionId;
      this.config.onSdkSessionIdUpdate?.(sessionId);
    }
  }

  // ============================================================
  // Chat (AsyncGenerator backed by the Pi RpcClient event queue)
  // ============================================================

  protected async *chatImpl(
    messageParam: string,
    attachments?: FileAttachment[],
    options: ChatOptions = {},
  ): AsyncGenerator<AgentEvent> {
    const message = messageParam;
    if (this.activeAttemptId || this.activeEventStream) {
	  throw new Error(`Pi runtime is already bound to Attempt ${this.activeAttemptId ?? 'unknown'}`);
    }
    this._isProcessing = true;
    this.abortReason = undefined;
    this.suppressAbortedTurnEvents = false;
    this.currentUserMessage = message;
    this.adapter.startTurn();
    let promptAccepted = false;
    let attemptId: string | undefined;
    const eventQueue = new EventQueue();
    this.activeEventStream = { queue: eventQueue };

    // Fire UserPromptSubmit hook event (fire-and-forget)
    this.emitAutomationEvent('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: message,
    });

    // Refresh session-scoped callbacks used by plan review.
    const sessionId = this.config.session?.mortiseId;
    if (sessionId) {
      mergeSessionScopedToolCallbacks(sessionId, {
        onPlanSubmitted: (planPath) => this.onPlanSubmitted?.(planPath),
      });
    }

    try {
      let client: PiSessionRpcClient;
      // Ensure Pi RpcClient is started and ready.
      try {
        client = await this.ensureRpcClient();
      } catch (rpcError) {
        const errorMsg = rpcError instanceof Error ? rpcError.message : String(rpcError);
        this.debug(`Failed to start Pi RpcClient: ${errorMsg}`);
        this.writePiRuntimeLog('error', 'chat.ensure_rpc_failed', {
          error: rpcError,
          stderr: this.getRecentStderr(),
        });

        // If resume failed, clear and try fresh
        if (this.piSessionId && !options?.isRetry) {
          this.piSessionId = null;
          await this.stopRpcClient();
          this.clearSessionForRecovery();

          client = await this.ensureRpcClient();
        } else {
          throw rpcError;
        }
      }

      const trimmedMessage = message.trim();
      const compactMatch = trimmedMessage.match(/^\/compact(?:\s+([\s\S]+))?$/i);
      if (compactMatch) {
        const customInstructions = compactMatch[1]?.trim() || undefined;
		const compactResult = await this.requestCompact(customInstructions);
        if (compactResult) {
          yield {
            type: 'info',
            message: `Compacted context to fit within limits (from ~${compactResult.tokensBefore.toLocaleString()} tokens)`,
          };
        } else {
          yield { type: 'info', message: 'Compacted context to fit within limits' };
        }
        yield { type: 'complete' };
        return;
      }

      // Build system prompt. Pi remains the default source; a saved Mortise
      // SYSTEM.md is an explicit host override and must win over passthrough.
      const hasCustomSystemPrompt = getCustomSystemPrompt() !== undefined;
      const piShellPassthrough = getPiShellFullPassthrough() && !hasCustomSystemPrompt;
      const systemPrompt = piShellPassthrough
        ? ''
        : resolveMainAgentSystemPrompt(
            getSystemPrompt(
              undefined, // pinnedPreferencesPrompt
              this.config.debugMode,
              this.workspaceRoot,
              this.workspaceRoot,
              this.config.systemPromptPreset,
              'Mortise Backend', // backendName
              getCoAuthorPreference() // respect user's includeCoAuthoredBy preference (#576)
            )
          );

      // Process attachments
      const attachmentParts: string[] = [];
      const images: Array<{ type: string; data: string; mimeType: string }> = [];
      for (const att of attachments || []) {
        if (att.mimeType?.startsWith('image/') && att.base64) {
          images.push({
            type: 'image',
            data: att.base64,
            mimeType: att.mimeType,
          });
        } else if (att.mimeType?.startsWith('image/') && (att.storedPath || att.path)) {
          attachmentParts.push(`[Attached image: ${att.name}]\n[Stored at: ${att.storedPath || att.path}]`);
        } else if (att.mimeType === 'application/pdf' && att.storedPath) {
          attachmentParts.push(`[Attached PDF: ${att.name}]\n[Stored at: ${att.storedPath}]`);
        } else if (att.storedPath) {
          let pathInfo = `[Attached file: ${att.name}]\n[Stored at: ${att.storedPath}]`;
          if (att.markdownPath) {
            pathInfo += `\n[Markdown version: ${att.markdownPath}]`;
          }
          attachmentParts.push(pathInfo);
        }
      }

      const fullSystemPrompt = piShellPassthrough ? '' : systemPrompt;

      // Keep the user's turn intact. Only explicit attachment references belong
      // beside it; runtime and Extension state stay out of the user message.
      const userParts = [
        ...attachmentParts,
        message,
      ].filter(Boolean);
      const userMessage = userParts.join('\n\n');

      // Send prompt to Pi RpcClient
      const turnId = `turn-${++this.rpcIdCounter}`;
      this.debug(`Sending Pi RpcClient prompt ${turnId}`);
      // Pi agent-session.ts 用 `systemPrompt !== undefined` 判断是否覆盖。
      // 壳模式下 fullSystemPrompt === ''，必须传 undefined 让 Pi 回落到原生 system prompt，
      // 否则会把原生 prompt 覆盖成空字符串，导致 agent 完全丢失 system prompt。
	  const disposition = await client.prompt(
        userMessage,
        images.length > 0 ? images as any : undefined,
        {
		  systemPrompt: fullSystemPrompt || undefined,
          clearSystemPrompt: piShellPassthrough,
          // Clear any suffix retained by a runtime that handled an earlier turn.
          appendSystemPrompt: '',
		  clientMutationId: options?.clientMutationId,
		  origin: options?.origin,
		  interruptedAttempt: options?.interruptedAttempt,
          attachments: options?.attachmentRefs,
        },
      );
      if (disposition.status !== 'started') {
        throw new Error(`Pi prompt was not started: ${disposition.status}`);
      }
      attemptId = disposition.attemptId;
      this.activeAttemptId = attemptId;
      this.activeEventStream = { attemptId, queue: eventQueue };
      promptAccepted = true;

	  for await (const event of eventQueue.drain()) {
        if (event.type === 'queue_overflow') this.emitPiProjectionEvents(event);
        yield event;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('abort')) {
		if (!promptAccepted) eventQueue.complete();
        if (this.abortReason === AbortReason.PlanSubmitted) {
          return;
        }
        return;
      }

      const errorObj = error instanceof Error ? error : new Error(String(error));
      const typedError = this.parsePiError(errorObj);

      if (typedError.code !== 'unknown_error') {
        yield { type: 'typed_error', error: typedError };
      } else {
        yield { type: 'error', message: errorObj.message };
      }

      yield { type: 'complete', terminalStatus: 'failed' };
	  if (!promptAccepted) eventQueue.complete();
    } finally {
	  if (this.activeEventStream?.queue === eventQueue && eventQueue.isComplete) {
		this.activeEventStream = undefined;
	  }
	  if (!this.activeAttemptId) this._isProcessing = false;
    }
  }

  // ============================================================
  // Model Forwarding
  // ============================================================

  async updateRuntimeConfig(update: BackendRuntimeUpdate): Promise<boolean> {
    const previousModel = this.getModel();
    const previousRuntime = getBackendRuntime(this.config);

    this.config = {
      ...this.config,
      providerType: update.providerType ?? this.config.providerType,
      authType: update.authType ?? this.config.authType,
      model: update.model,
      runtime: {
        ...previousRuntime,
        ...(update.runtime ?? {}),
      },
    };
    this._model = update.model;

    if (!this.rpcClient) {
      this.debug(`Runtime config updated locally (no Pi RpcClient): ${previousModel} → ${update.model}`);
      return true;
    }

    const updated = await this.requestRuntimeConfigUpdate({
      ...update,
      providerType: this.config.providerType,
      authType: this.config.authType,
      runtime: getBackendRuntime(this.config),
    });
    this.debug(`Runtime config refreshed in Pi RpcClient: ${previousModel} → ${update.model}`);
    return updated;
  }

  override setModel(model: string): void {
    const previousModel = this.getModel();
    super.setModel(model);
    // Forward to Pi RpcClient so it uses the new model on next turn.
    if (this.rpcClient) {
      const provider = getBackendRuntime(this.config).piAuthProvider;
      if (provider) {
        this.debug(`Forwarding model change to Pi RpcClient: ${previousModel} → ${model}`);
        void this.rpcClient.setModel(provider, model).catch(error => this.handleRpcControlError('set_model', error));
      }
    } else {
      this.debug(`Model updated but no Pi RpcClient to forward to: ${previousModel} → ${model}`);
    }
  }

  override setThinkingLevel(level: ThinkingLevel): void {
    const previousLevel = this.getThinkingLevel();
    super.setThinkingLevel(level);
    // Forward to Pi RpcClient so it uses the new thinking level on next turn.
    if (this.rpcClient) {
      this.debug(`Forwarding thinking level change to Pi RpcClient: ${previousLevel} → ${level}`);
      void this.rpcClient.setThinkingLevel(level as any).catch(error => this.handleRpcControlError('set_thinking_level', error));
    } else {
      this.debug(`Thinking level updated but no Pi RpcClient to forward to: ${previousLevel} → ${level}`);
    }
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  isProcessing(): boolean {
    return this._isProcessing;
  }

  async abort(reason?: string): Promise<void> {
    // Fire Stop hook event (fire-and-forget)
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });

    this.abortReason = Object.values(AbortReason).includes(reason as AbortReason)
      ? reason as AbortReason
      : AbortReason.UserStop;
    this._isProcessing = false;
    this.suppressAbortedTurnEvents = true;

    const attemptId = this.activeAttemptId;
    let abortTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const client = this.rpcClient;
      if (client && attemptId) {
        const settled = this.waitForAgentSettled(attemptId);
        await Promise.race([
		  client.abort().then(disposition => {
			if (disposition.status !== 'accepted' || disposition.attemptId !== attemptId) {
			  throw new Error(`Pi abort was not accepted for Attempt ${attemptId}`);
			}
			return settled;
		  }),
          new Promise<never>((_, reject) => {
            abortTimeout = setTimeout(() => {
              reject(new Error(`Pi abort acknowledgment or settlement timed out after ${PI_ABORT_ACK_TIMEOUT_MS}ms`));
            }, PI_ABORT_ACK_TIMEOUT_MS);
          }),
        ]);
      }
    } catch (error) {
      this.writePiRuntimeLog('warn', 'chat.abort_failed', { error });
      // If the cooperative abort command fails, release this runtime so the
      // stopped generation cannot continue publishing events in the background.
      await this.stopRpcClient();
      if (attemptId) this.completeActiveAttempt(attemptId);
    } finally {
      if (abortTimeout) clearTimeout(abortTimeout);
      // A successful abort waits for Pi's agent_settled event, which closes the
      // queue. Failure paths close it in catch after the runtime is stopped.
      if (!this.rpcClient && attemptId) this.completeActiveAttempt(attemptId);
    }

    // Clear bridge cache for this interrupted turn.
    this.preToolMetadataByCallId.clear();

  }

  forceAbort(reason: AbortReason): void {
    // Fire Stop hook event (fire-and-forget)
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });

    this.abortReason = reason;
    this._isProcessing = false;
    this.suppressAbortedTurnEvents = true;

    // Clear bridge cache for aborted turn.
    this.preToolMetadataByCallId.clear();

    // Plan review hands control back to the host UI.
    const attemptId = this.activeAttemptId;
    if (reason === AbortReason.PlanSubmitted) {
      this.coordinationBridge?.completeTurn();
      if (attemptId) this.completeActiveAttempt(attemptId);
      return;
    }

    // For other reasons, send abort to Pi.
    const client = this.rpcClient;
    if (!client) {
      this.coordinationBridge?.completeTurn();
      if (attemptId) this.completeActiveAttempt(attemptId);
      return;
    }
    if (!attemptId) return;
    const settled = this.waitForAgentSettled(attemptId);
    let abortTimeout: ReturnType<typeof setTimeout> | null = null;
    void Promise.race([
	  client.abort().then(disposition => {
		if (disposition.status !== 'accepted' || disposition.attemptId !== attemptId) {
		  throw new Error(`Pi abort was not accepted for Attempt ${attemptId}`);
		}
		return settled;
	  }),
      new Promise<never>((_, reject) => {
        abortTimeout = setTimeout(
          () => reject(new Error('Pi force-abort settlement timed out')),
          PI_ABORT_ACK_TIMEOUT_MS,
        );
      }),
    ])
      .catch(async error => {
        this.writePiRuntimeLog('warn', 'chat.force_abort_failed', { error });
        // A timed-out abort is not a settlement acknowledgment. Retire the
        // runtime before exposing terminal state so it cannot publish after UI
        // completion against the replaced Session projection.
        await this.stopRpcClient();
        this.handleRpcError(error);
      })
      .finally(() => {
        if (abortTimeout) clearTimeout(abortTimeout);
      })
      .catch(error => {
        this.writePiRuntimeLog('error', 'chat.force_abort_cleanup_failed', { error });
        this.settleTurnForRuntimeReplacement();
      });
  }

  /**
   * Redirect mid-stream via Pi SDK's steer().
   * Delivers the message after the current tool finishes, skips remaining
   * queued tools, and continues with full context intact.
   * Events flow through the existing generator — no abort needed.
   */
  override async redirect(
    message: string,
    clientMutationId?: string,
    options: ChatOptions = {},
  ): Promise<boolean> {
    if (!this._isProcessing || !this.rpcClient) {
      // Not streaming or no client — fall back to abort
      this.forceAbort(AbortReason.Redirect);
      return false;
    }
    this.debug(`Steering mid-stream: "${message.slice(0, 100)}"`);
    try {
      const activeAttemptId = this.activeAttemptId;
	  if (!activeAttemptId) return false;
	  const disposition = await this.rpcClient.steer(message, undefined, {
		clientMutationId,
		origin: options.origin,
	  });
      return disposition.status === 'accepted' && disposition.attemptId === activeAttemptId;
    } catch (error) {
      this.writePiRuntimeLog('warn', 'chat.steer_rejected', { error });
      this.debug(`Pi steer was rejected: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async sendExtensionFrontendMessage(extensionId: string, channelId: string, message: unknown): Promise<unknown> {
    const client = this.rpcClient;
    if (!client) return undefined;
    return await client.sendExtensionFrontendMessage(extensionId, channelId, message);
  }

  override async followUp(
    message: string,
    attachments?: FileAttachment[],
    options: ChatOptions = {},
  ): Promise<boolean> {
    if (!this._isProcessing || !this.rpcClient) return false;
    this.debug(`Queueing native Pi follow-up: "${message.slice(0, 100)}"`);
    const attachmentParts: string[] = [];
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    for (const attachment of attachments ?? []) {
      if (attachment.mimeType?.startsWith('image/') && attachment.base64) {
        images.push({ type: 'image', data: attachment.base64, mimeType: attachment.mimeType });
      } else if (attachment.mimeType?.startsWith('image/') && (attachment.storedPath || attachment.path)) {
        attachmentParts.push(`[Attached image: ${attachment.name}]\n[Stored at: ${attachment.storedPath || attachment.path}]`);
      } else if (attachment.mimeType === 'application/pdf' && attachment.storedPath) {
        attachmentParts.push(`[Attached PDF: ${attachment.name}]\n[Stored at: ${attachment.storedPath}]`);
      } else if (attachment.storedPath) {
        let pathInfo = `[Attached file: ${attachment.name}]\n[Stored at: ${attachment.storedPath}]`;
        if (attachment.markdownPath) pathInfo += `\n[Markdown version: ${attachment.markdownPath}]`;
        attachmentParts.push(pathInfo);
      }
    }
    const userMessage = [...attachmentParts, message].filter(Boolean).join('\n\n');
    try {
      const activeAttemptId = this.activeAttemptId;
	  if (!activeAttemptId) return false;
      const disposition = await this.rpcClient.followUp(
        userMessage,
        images.length > 0 ? images : undefined,
		{
		  clientMutationId: options.clientMutationId,
		  origin: options.origin,
		  attachments: options.attachmentRefs,
		},
      );
      return disposition.status === 'queued' && disposition.attemptId === activeAttemptId;
    } catch (error) {
      this.debug(`Native Pi follow-up was rejected: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  override async withdrawQueued(clientMutationId: string): Promise<boolean> {
    if (!this.rpcClient) return false;
    try {
      const result = await this.rpcClient.withdrawQueued(clientMutationId);
      return result.status === 'removed';
    } catch (error) {
      this.debug(`Native Pi queued-message withdrawal failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // ============================================================
  // Session ID overrides — Pi maintains its own runtime session id
  // ============================================================

  override getSessionId(): string | null {
    return this.piSessionId;
  }

  override setSessionId(sessionId: string | null): void {
    this.piSessionId = sessionId;
  }

  override setWorkspace(workspace: Workspace): void {
    this.settleTurnForRuntimeReplacement();
    this.coordinationBridge?.close();
    this.coordinationBridge = null;
    super.setWorkspace(workspace);
    this.piSessionId = null;
    this._sessionToolContext = null;
    this.stopRpcClientDetached('workspace-replaced');
  }

  override clearHistory(): void {
    this.piSessionId = null;
    this.settleTurnForRuntimeReplacement();
    this.stopRpcClientDetached('history-cleared');
    super.clearHistory();
    this.debug('History cleared - next chat will start a new Pi RpcClient');
  }

  destroy(): void {
    this.childRuntimeDisposed = true;
    this.settleTurnForRuntimeReplacement();
    this.coordinationBridge?.close();
    this.coordinationBridge = null;
    this.stopConfigWatcher();

    // Unregister session-scoped tool callbacks
    if (this.config.session?.mortiseId) {
      unregisterSessionScopedToolCallbacks(this.config.session.mortiseId);
    }

    this._sessionToolContext = null;
    void this.stopChildRuntimes('agent destroyed').catch(error => {
      this.writePiRuntimeLog('error', 'child_runtime.teardown_failed', { error });
    });
    // Pool clients are owned by the main process — don't close them here.
    this.stopRpcClientDetached('agent-destroyed');
    this.debug('PiAgent destroyed');
  }

  async disposeForRestart(): Promise<void> {
    this.childRuntimeDisposed = true;
    this.stopConfigWatcher();

    if (this.config.session?.mortiseId) {
      unregisterSessionScopedToolCallbacks(this.config.session.mortiseId);
    }

    this._sessionToolContext = null;
    try {
      await this.stopParentAndChildRuntimes('parent runtime disposed');
    } finally {
      this.settleTurnForRuntimeReplacement();
      this.coordinationBridge?.close();
      this.coordinationBridge = null;
    }
    this.debug('PiAgent disposed for restart');
  }

  /**
   * Reconnect by stopping RpcClient -- next chat() will spawn fresh.
   */
  async reconnect(): Promise<void> {
    try {
      await this.stopParentAndChildRuntimes('parent runtime reconnected');
    } finally {
      this.settleTurnForRuntimeReplacement();
    }
    this.debug('PiAgent reconnected (Pi RpcClient will be restarted on next chat)');
  }

  private async stopParentAndChildRuntimes(reason: string): Promise<void> {
    const results = await Promise.allSettled([
      this.stopChildRuntimes(reason),
      this.stopRpcClient(),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to fully stop parent and child runtimes: ${reason}`);
    }
  }

  private async stopChildRuntimes(reason: string): Promise<void> {
    if (this.childRuntimeTeardown) return this.childRuntimeTeardown;
    this.childRuntimeEpoch++;
    const teardown = (async () => {
      await Promise.all([...this.childRuntimeAcquisitions]);
      const leases = [...this.childRuntimeLeases];
      const runtimes = new Map(leases.map(lease => [lease.runtime.runtimeId, lease.runtime]));
      const runtimeResults = await Promise.allSettled([...runtimes.values()].map(async (runtime) => {
		const state = await runtime.getState();
		if (!state.isStreaming) return;
		if (!state.sessionId) throw new Error(`Active child Session identity is unavailable for ${runtime.runtimeId}`);
		const { attemptId } = this.getChildExecution(runtime, state.sessionId);
		const settled = runtime.waitForIdle(attemptId, CHILD_RUNTIME_CLEANUP_SETTLEMENT_TIMEOUT_MS);
		const disposition = await runtime.abort();
		if (disposition.status !== 'accepted' || disposition.attemptId !== attemptId) {
		  throw new Error(`Child abort was not accepted for Attempt ${attemptId}`);
		}
        await settled;
      }));
      const releaseResults = await Promise.allSettled(leases.map(lease => this.releaseChildRuntimeLease(lease)));
      const inboxResults = await Promise.allSettled([...this.childInboxWrites.values()]);
      const failures = [...runtimeResults, ...releaseResults, ...inboxResults]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
      if (leases.length > 0) this.debug(`Stopped ${leases.length} child task runtime(s): ${reason}`);
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to fully stop child task runtimes: ${reason}`);
      }
    })();
    this.childRuntimeTeardown = teardown;
    try {
      await teardown;
    } finally {
      if (this.childRuntimeTeardown === teardown) this.childRuntimeTeardown = null;
    }
  }

  private async releaseChildRuntimeLease(lease: PiHostLease): Promise<void> {
    try {
      await lease.release();
    } finally {
      this.childRuntimeLeases.delete(lease);
      this.releaseChildRuntimeClientEvents(lease.runtime.runtimeId);
    }
  }

  async extensionServicesList(): Promise<ExtensionServiceCatalogDTO> {
    return await (await this.ensureRpcClient()).extensionServicesList() as ExtensionServiceCatalogDTO
  }
  async extensionServicesDescribe(capability: string): Promise<ExtensionServiceProviderDTO[]> {
    return await (await this.ensureRpcClient()).extensionServicesDescribe(capability) as ExtensionServiceProviderDTO[]
  }
  async extensionServicesInvoke(input: { requestId: string; runtimeId?: string; sessionId?: string; capability: string; operation: string; provider?: string; input: unknown; timeoutMs?: number }): Promise<ExtensionServiceResultDTO> {
    return await (await this.ensureRpcClient()).extensionServicesInvoke(input) as ExtensionServiceResultDTO
  }
  async extensionServicesCancel(requestId: string): Promise<boolean> {
    return await (await this.ensureRpcClient()).extensionServicesCancel(requestId)
  }

  private async stopRpcClient(): Promise<void> {
    try {
      this.coordinationBridge?.releasePending();
    } catch (error) {
      this.writePiRuntimeLog('warn', 'host.coordination_release_failed', { error });
    }
    const runtimeId = this.currentRpcRuntimeId();
    if (runtimeId) {
      try {
        this.config.onHostCapabilityRuntimeReleased?.(runtimeId);
        this.config.onExtensionEvent?.({
          type: 'extension_contributions_runtime_reset',
          ...this.extensionEventRoute('pi-runtime', runtimeId),
        });
      } catch (error) {
        this.writePiRuntimeLog('warn', 'host.runtime_release_callback_failed', { runtimeId, error });
      }
    }
    const hostLease = this.rpcHostLease;
    this.cancelPendingExtensionInteractions('runtime-disposed');
    try {
      this.unsubscribePiEvent?.();
    } catch (error) {
      this.writePiRuntimeLog('warn', 'host.event_unsubscribe_failed', { channel: 'agent', error });
    }
    this.unsubscribePiEvent = null;
    try {
      this.unsubscribePiClientEvent?.();
    } catch (error) {
      this.writePiRuntimeLog('warn', 'host.event_unsubscribe_failed', { channel: 'client', error });
    }
    this.unsubscribePiClientEvent = null;
    this.rpcClient = null;
    this.rpcHostLease = null;
    this.rpcClientReady = null;
    this.rpcCapabilities = null;
    this.projectionBuilder = null;
    this.projectionEpoch = randomUUID();
    this.preToolMetadataByCallId.clear();
    this.resetRpcErrorDedup();

    if (hostLease) {
      await hostLease.release().catch(error => {
        this.debug(`Failed to release Pi runtime cleanly: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private currentRpcRuntimeId(): string | undefined {
    return this.rpcClient?.runtimeId;
  }

  // ============================================================
  // Mini Completion (for title generation + summarization)
  // ============================================================

  async runMiniCompletion(prompt: string): Promise<string | null> {
    try {
      const client = await this.ensureRpcClient();
      this.requirePiRpcCommand('run_mini_completion', 'mini completion');
      return await client.runMiniCompletion(prompt);
    } catch (error) {
      this.debug(`[runMiniCompletion] Failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Execute an LLM query.
   *
   * Uses Pi's typed secondary LLM RPC so Mortise no longer needs a private
   * pi-agent-server `llm_query` bridge.
   */
  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    try {
      const client = await this.ensureRpcClient();
      this.requirePiRpcCommand('query_llm', 'secondary LLM query');
      const result = await client.queryLlm(request);
      return {
        text: result.text,
        model: result.model,
        inputTokens: result.usage?.input,
        outputTokens: result.usage?.output,
        warning: result.stopReason === 'length' ? 'Pi queryLlm stopped because the model reached the max token limit.' : undefined,
      };
    } catch (error) {
      throw error;
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Resolve the canonical workspace root for subprocess APIs. */
  private resolvedWorkspaceRoot(): string {
    const wd = this.workspaceRoot;
    if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
    if (wd === '~') return homedir();
    return wd;
  }

  // ============================================================
  // Error Parsing
  // ============================================================

  /**
   * Parse a Pi error into a typed AgentError.
   */
  private parsePiError(error: Error): AgentError {
    const errorMessage = error.message.toLowerCase();

    // Auth errors
    if (
      errorMessage.includes('api key') ||
      errorMessage.includes('unauthorized') ||
      errorMessage.includes('401') ||
      errorMessage.includes('authentication')
    ) {
      // For OAuth connections, attempt token refresh before giving up
      if (this.config.authType === 'oauth') {
        this.refreshAndPushTokens().catch(err => {
          this.debug(`Token refresh from parsePiError failed: ${err}`);
        });
      }

      return {
        code: 'invalid_api_key',
        title: 'Invalid API Key',
        message: 'Your API key was rejected. Check your credentials in Settings.',
        actions: [
          { key: 's', label: 'Update API key', command: '/settings', action: 'settings' },
        ],
        canRetry: this.config.authType === 'oauth',
        originalError: error.message,
      };
    }

    // Rate limiting
    if (errorMessage.includes('rate') || errorMessage.includes('429')) {
      return {
        code: 'rate_limited',
        title: 'Rate Limited',
        message: 'Too many requests. Please wait a moment before trying again.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 5000,
        originalError: error.message,
      };
    }

    // Service errors
    if (
      errorMessage.includes('agent process exited') ||
      errorMessage.includes('process exited') ||
      errorMessage.includes('client not started') ||
      errorMessage.includes('stdin is not writable')
    ) {
      return {
        code: 'service_error',
        title: 'Pi Process Exited',
        message: 'The Pi agent process exited before your message could be sent. Please try again.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 1000,
        originalError: error.message,
      };
    }

    // Service errors
    if (
      errorMessage.includes('500') ||
      errorMessage.includes('502') ||
      errorMessage.includes('503') ||
      errorMessage.includes('service') ||
      errorMessage.includes('overloaded')
    ) {
      return {
        code: 'service_error',
        title: 'Service Error',
        message: 'The AI service is temporarily unavailable. Please try again.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 2000,
        originalError: error.message,
      };
    }

    // Network errors
    if (
      errorMessage.includes('network') ||
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('fetch failed')
    ) {
      return {
        code: 'network_error',
        title: 'Connection Error',
        message: 'Could not connect to the server. Check your internet connection.',
        actions: [
          { key: 'r', label: 'Retry', action: 'retry' },
        ],
        canRetry: true,
        retryDelayMs: 1000,
        originalError: error.message,
      };
    }

    // Fall back to shared error parsing
    return parseError(error);
  }

  // ============================================================
  // Debug
  // ============================================================

  protected override debug(message: string): void {
    this.onDebug?.(`[pi] ${message}`);
  }
}

// Alias for consistency with other backend naming
export { PiAgent as PiBackend };
