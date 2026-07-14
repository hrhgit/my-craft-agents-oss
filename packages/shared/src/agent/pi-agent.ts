/**
 * Pi Backend (Pi RpcClient)
 *
 * Thin host-side adapter for the Pi coding agent. Uses Pi's public RpcClient
 * API and keeps Craft-specific scaffolding (permission gating, source/tool
 * proxying, UI event translation) on the host side.
 *
 * Pi owns agent runtime, session storage, provider/model registry, and native
 * extension execution. Craft talks to it through RpcClient only.
 */

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../utils/files.ts';
import { createSanitizedEnv } from '../utils/env.ts';
import { getProxyEnvVars } from '../config/proxy-env.ts';
import { PI_AGENT_DIR } from '../config/paths.ts';
import {
  RpcClient as PiRpcClient,
  type PiRuntimeHandle,
  type RpcCapabilities as PiRpcCapabilities,
  type RpcClientEvent as PiRpcClientEvent,
  type RpcClientOptions as PiRpcClientOptions,
  type RpcCommandType as PiRpcCommandType,
  type RpcHostToolResult as PiRpcHostToolResult,
  type RpcExtensionHostCapabilityResponse as PiRpcExtensionHostCapabilityResponse,
} from '@earendil-works/pi-coding-agent/rpc';
import { piHostManager, type PiHostLease } from './backend/pi-host-manager.ts';

import type {
  BackendConfig,
  BackendRuntimeUpdate,
  ChatOptions,
  ExtensionBridgeEvent,
  AuthProjectionPromptRequest,
  HostQueuedUserProjection,
  HostRuntimeErrorProjection,
  PiExtensionCommand,
  SdkMcpServerConfig,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';
import { SourceActivationDrainController } from './source-activation-drain.ts';
import type { ExtensionContributionV1 } from '../protocol/extension-contributions.ts';
import type { ExtensionUIValidationDeltaV1 } from '../protocol/extension-ui-validation.ts';
import {
  validateExtensionInteractionRequestV1,
  validateExtensionInteractionResponseV1,
  type ExtensionInteractionCancelReasonV1,
  type ExtensionInteractionResponseV1,
} from '../protocol/extension-interactions.ts';

import type { PermissionMode } from './mode-manager.ts';
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

// System prompt for Craft Agent context
import { getSystemPrompt } from '../prompts/system.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';

// Credential manager for token storage
import { getCredentialManager } from '../credentials/manager.ts';

// Session-scoped tool callbacks (for source auth, etc.)
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  setLastPlanFilePath,
} from './session-scoped-tools.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';

// Session tool proxy definitions (for registering with Pi RpcClient)
import { getSessionToolProxyDefs, SESSION_TOOL_NAMES } from './backend/pi/session-tool-defs.ts';

// Session tool registry (for executing proxy tool calls)
import {
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  type ToolResult as SessionToolResult,
  type TextContent,
} from '@craft-agent/session-tools-core';
import { createSessionToolContext, type SessionToolContext } from './session-tool-context.ts';
import { getPermissionModeDiagnostics } from './mode-manager.ts';

// McpClientPool for source tool proxying (centralized pool from main process)
import type { McpClientPool } from '../mcp/mcp-pool.ts';

import { homedir } from 'os';

// Session storage (plans folder path)
import { getSessionDataPath, getSessionPath, getSessionPlansPath, getPiNativeSessionDir } from '../sessions/storage.ts';

// Error typing
import { parseError, type AgentError } from './errors.ts';

// Centralized PreToolUse pipeline
import { isDataSourceToolName, runPreToolUseChecks, type PreToolUseCheckResult } from './core/pre-tool-use.ts';
import { getRtkPath } from './core/rtk-detector.ts';
import { getDataSourcesEnabled, getRtkEnabled, getPiShellFullPassthrough } from '../config/storage.ts';
import type { RtkContext } from './core/rtk-rewrite.ts';

// Workspace slug extraction for skill qualification
import { extractWorkspaceSlug } from '../utils/workspace.ts';

// LLM tool types
import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import { writeRuntimeLog, type RuntimeLogLevel } from '../utils/runtime-log.ts';

/**
 * Convert the renderer's typed RemoteUI payload back to Pi's scalar dialog
 * protocol. Pi select/input/editor requests resolve with a string, while the
 * renderer uses result objects for the generic host-rendered interaction.
 */
function remoteUIResponseValue(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload ?? '');

  const result = payload as {
    text?: unknown;
    freeformText?: unknown;
    selections?: unknown;
  };
  if (typeof result.text === 'string') return result.text;
  if (typeof result.freeformText === 'string') return result.freeformText;
  if (Array.isArray(result.selections)) {
    const selections = result.selections.filter((selection): selection is string => typeof selection === 'string');
    if (selections.length > 0) return selections.join(', ');
  }
  return '';
}

// ============================================================
// PiAgent Implementation
// ============================================================

/** Backend-executed session tools currently supported by PiAgent. */
export const PI_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
  'spawn_session',
]);

const PI_RPC_START_TIMEOUT_MS = 15_000;
const PI_ABORT_ACK_TIMEOUT_MS = 5_000;
const SETTLED_EXTENSION_INTERACTION_TTL_MS = 5 * 60_000;
const MAX_SETTLED_EXTENSION_INTERACTIONS = 512;

function craftRpcUiCapabilities() {
  const validationEnabled = process.env.CRAFT_UI_VALIDATION_BUILD === '1'
    && process.env.CRAFT_UI_TEST_HOST === '1'
    && process.env.NODE_ENV !== 'production';
  return {
    kind: 'craft' as const,
    dialogs: true,
    widgets: true,
    editorControl: true,
    contributions: true,
    ...(validationEnabled ? { validation: true } : {}),
    interactionSchemas: [1],
  };
}

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

type PiRpcToolPermissionRequest = Extract<PiRpcClientEvent, { type: 'tool_permission_request' }>;
type PiRpcToolExecuteRequest = Extract<PiRpcClientEvent, { type: 'tool_execute_request' }>;
type PiSessionRpcClient = PiRpcClient | PiRuntimeHandle;
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
        'Ask the user to open this workspace from the Craft Agent desktop app.';
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
// Pi session tree types (spawn_session tool → pi spawnChildSession)
// ============================================================

/** Options for spawning a child session — matches pi's SpawnChildSessionOptions. */
export interface PiSpawnChildSessionOptions {
  prompt?: string;
  connection?: string;
  model?: string;
  enabledSources?: string[];
  permissionMode?: PermissionMode;
  thinkingLevel?: ThinkingLevel;
  name?: string;
  workingDirectory?: string;
  attachments?: Array<{ path: string; name?: string }>;
}

/** Result of spawning a child session in the pi session tree. */
export interface PiSpawnChildSessionResult {
  sessionId: string;
  sessionPath: string;
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
  spawnConfig?: {
    connection?: string;
    model?: string;
    enabledSources?: string[];
    permissionMode?: string;
    thinkingLevel?: string;
  };
}

/**
 * Backend implementation using the Pi coding agent SDK via RpcClient.
 *
 * Extends BaseAgent for common functionality (permission mode, source management,
 * planning heuristics, config watching, usage tracking).
 */
export class PiAgent extends BaseAgent {
  protected backendName = 'Craft Agents Backend';

  // ============================================================
  // Pi RpcClient State
  // ============================================================

  private rpcClient: PiSessionRpcClient | null = null;
  private rpcHostLease: PiHostLease | null = null;
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
  /** Ignore late content events while Pi is acknowledging an abort. */
  private suppressAbortedTurnEvents = false;

  // Event queue for streaming (AsyncGenerator pattern over RpcClient events)
  private eventQueue = new EventQueue();

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
        sessionId: this.config.session?.craftId,
        piSessionId: this.piSessionId,
        workspaceId: this.config.workspace.id,
        workspaceRootPath: this.config.workspace.rootPath,
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

  // Pending permission requests (used by handlePreToolUseRequest for ask-mode prompting)
  private pendingPermissions: Map<string, {
    resolve: (allowed: boolean) => void;
    toolName: string;
  }> = new Map();

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

  // Pool reference for convenience (from this.config.mcpPool)
  private get mcpPool(): McpClientPool | undefined { return this.config.mcpPool; }

  // Cached session tool context (lazy-created on first session tool call)
  private _sessionToolContext: SessionToolContext | null = null;

  // RPC request counter for unique IDs
  private rpcIdCounter: number = 0;

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
    // session dir is the Pi sidecar `.craft/{sessionId}/` under the
    // Pi sessions bucket, NOT the legacy `workspaces/{id}/sessions/{sessionId}/`.
    if (config.session?.craftId && config.workspace.rootPath) {
      this.adapter.setSessionDir(getSessionPath(config.workspace.rootPath, config.session.craftId));
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
      (name) => name !== 'browser_tool',
    ).filter(
      (name) => !PI_BACKEND_SESSION_TOOL_NAMES.has(name),
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

  private resolvePiCliPath(): string {
    const checkedPaths: string[] = [];
    const runtimeCliPath = getBackendRuntime(this.config).paths?.piCli;
    if (runtimeCliPath) {
      checkedPaths.push(runtimeCliPath);
      if (existsSync(runtimeCliPath)) {
        return runtimeCliPath;
      }
    }

    try {
      const resolved = import.meta.resolve('@earendil-works/pi-coding-agent');
      const packageDist = dirname(fileURLToPath(resolved));
      const cliPath = join(packageDist, 'cli.js');
      checkedPaths.push(cliPath);
      if (existsSync(cliPath)) {
        return cliPath;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checkedPaths.push(`@earendil-works/pi-coding-agent resolution failed: ${message}`);
    }

    throw new Error(`Pi CLI entrypoint not found. Checked: ${checkedPaths.join('; ')}`);
  }

  private buildRpcArgs(): string[] {
    const args: string[] = [];
    const browserExtensionPath = process.env.CRAFT_BROWSER_EXTENSION_PATH;
    if (browserExtensionPath && existsSync(browserExtensionPath)) {
      args.push('--extension', browserExtensionPath);
    }
    const messagingExtensionPath = process.env.CRAFT_MESSAGING_EXTENSION_PATH;
    if (messagingExtensionPath && existsSync(messagingExtensionPath)) {
      args.push('--extension', messagingExtensionPath);
    }
    const sessionId = this.config.session?.craftId;
    const branchFromPiSessionFile = this.config.session?.branchFromPiSessionFile;
    const sessionDir = this.config.session
      ? getPiNativeSessionDir(this.config.workspace.rootPath, this.config.session.workingDirectory)
      : undefined;

    if (sessionDir) {
      args.push('--session-dir', sessionDir);
    }
    if (branchFromPiSessionFile) {
      args.push('--fork', branchFromPiSessionFile);
    }
    if (sessionId) {
      args.push('--session-id', sessionId);
    }
    if (this._thinkingLevel) {
      args.push('--thinking', this._thinkingLevel);
    }
    if (this.config.session?.name) {
      args.push('--name', this.config.session.name);
    }
    return args;
  }

  private getCraftExtensionPaths(): string[] {
    return [process.env.CRAFT_BROWSER_EXTENSION_PATH, process.env.CRAFT_MESSAGING_EXTENSION_PATH]
      .filter((value): value is string => Boolean(value && existsSync(value)));
  }

  private startRpcClient(): Promise<void> {
    if (this.rpcClientReady) return this.rpcClientReady;

    const ready = this.startRpcClientUnlocked().catch((error) => {
      if (this.rpcClientReady === ready) {
        this.rpcClientReady = null;
      }
      throw error;
    });
    this.rpcClientReady = ready;
    return ready;
  }

  private withRpcStartupTimeout(startup: Promise<void>): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Pi RpcClient startup timed out after ${PI_RPC_START_TIMEOUT_MS}ms`));
      }, PI_RPC_START_TIMEOUT_MS);
    });

    return Promise.race([startup, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private shouldUseSharedPiHost(runtime: { piAuthProvider?: string }): boolean {
    if (process.env.PI_GLOBAL_HOST === '0' || process.env.CRAFT_PI_HOST_MODE === 'legacy') return false;
    if (runtime.piAuthProvider === 'amazon-bedrock') return false;
    if (this.config.authType === 'environment' || this.config.authType === 'iam_credentials') return false;
    const processScopedOverrides = Object.keys(this.config.envOverrides ?? {}).filter(
      (key) => key !== 'CRAFT_WORKSPACE_PATH',
    );
    return processScopedOverrides.length === 0;
  }

  private async startRpcClientUnlocked(): Promise<void> {
    const runtime = getBackendRuntime(this.config);
    const cwd = this.resolvedCwd();
    const cliPath = this.resolvePiCliPath();
    const usesCompiledBinary = basename(cliPath).toLowerCase() === (process.platform === 'win32' ? 'pi.exe' : 'pi');
    const nodePath = usesCompiledBinary ? cliPath : (runtime.paths?.node || process.execPath);

    this.debug(`Starting Pi RpcClient: ${nodePath} ${cliPath}`);
    this.resetRpcErrorDedup();
    this.rpcProcessFailureHandled = false;

    const sessionId = this.config.session?.craftId || `agent-${Date.now()}`;
    const craftSessionDir = this.config.session
      ? getSessionPath(this.config.workspace.rootPath, sessionId)
      : undefined;

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
    const rpcArgs = this.buildRpcArgs();
    const pipeStderr = process.env.CRAFT_DEBUG === '1';

    this.writePiRuntimeLog('info', 'startup.begin', {
      command: nodePath,
      cliPath,
      cwd,
      runtimeProvider: runtime.piAuthProvider,
      authType: this.config.authType,
      rpcArgs,
      craftSessionDir,
      pipeStderr,
    });

    const clientOptions: PiRpcClientOptions = {
      command: nodePath,
      commandArgs,
      cliPath,
      directExecutable: usesCompiledBinary,
      cwd,
      provider: runtime.piAuthProvider,
      model: this._model,
      envMode: 'replace',
      env: {
        ...createSanitizedEnv(),
        ...getProxyEnvVars(),
        ...awsEnv,
        PI_EXTENSION_TARGET: 'craft',
        CRAFT_DEBUG: (process.argv.includes('--debug') || process.env.CRAFT_DEBUG === '1') ? '1' : '0',
      },
      pipeStderr,
    };

    let rpcClient: PiSessionRpcClient | null = null;
    if (this.shouldUseSharedPiHost(runtime)) {
      try {
        const sessionDir = this.config.session
          ? getPiNativeSessionDir(this.config.workspace.rootPath, this.config.session.workingDirectory)
          : undefined;
        const runtimeId = this.config.session?.craftId ?? `runtime-${Date.now()}`;
        const lease = await piHostManager.acquire({
          key: `${nodePath}\u0000${cliPath}\u0000${PI_AGENT_DIR}`,
          client: clientOptions,
          runtime: {
            runtimeId,
            cwd,
            agentDir: PI_AGENT_DIR,
            extensionTarget: 'craft',
            extensionPaths: this.getCraftExtensionPaths(),
            sessionDir,
            sessionId: this.config.session?.craftId,
            forkFromSessionPath: this.config.session?.branchFromPiSessionFile,
            uiCapabilities: craftRpcUiCapabilities(),
          },
        });
        this.rpcHostLease = lease;
        this.rpcCapabilities = lease.capabilities;
        rpcClient = lease.runtime;
        this.writePiRuntimeLog('info', 'host.runtime.acquired', {
          runtimeId: lease.runtime.runtimeId,
          protocolVersion: lease.capabilities.protocolVersion,
        });
      } catch (error) {
        this.writePiRuntimeLog('warn', 'host.fallback', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!rpcClient) {
      const legacyClient = new PiRpcClient({
        ...clientOptions,
        args: rpcArgs,
        env: {
          ...clientOptions.env,
          ...this.config.envOverrides,
          ...(craftSessionDir ? { CRAFT_SESSION_DIR: craftSessionDir } : {}),
          PI_RPC_UI_CAPABILITIES: JSON.stringify(craftRpcUiCapabilities()),
        },
      });
      rpcClient = legacyClient;
      this.rpcClient = legacyClient;
      this.unsubscribePiEvent = legacyClient.onEvent((event) => this.handlePiEvent(event as unknown as Record<string, unknown>));
      this.unsubscribePiClientEvent = legacyClient.onClientEvent((event) => this.handlePiClientEvent(event));
      const startup = legacyClient.start().then(async () => {
        try {
          const capabilities = await legacyClient.getCapabilities();
          this.rpcCapabilities = capabilities;
          this.debug(
            `Pi RpcClient capabilities loaded: protocol=${this.rpcCapabilities.protocolVersion} ` +
            `version=${this.rpcCapabilities.packageVersion}`
          );
          this.writePiRuntimeLog('info', 'capabilities.loaded', {
            protocolVersion: capabilities.protocolVersion,
            packageVersion: capabilities.packageVersion,
            commands: capabilities.commands,
          });
        } catch (error) {
          this.writePiRuntimeLog('error', 'capabilities.failed', {
            error,
            stderr: legacyClient.getStderr(),
          });
          throw new Error(
            `Pi RpcClient get_capabilities failed. ` +
            `The Pi process may have exited before the capabilities handshake completed. ` +
            `Original error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      });
      await this.withRpcStartupTimeout(startup).catch(async (error) => {
        this.writePiRuntimeLog('error', 'startup.failed', {
          error,
          stderr: legacyClient.getStderr(),
        });
        if (this.rpcClient === legacyClient) {
          this.rpcCapabilities = null;
          try { this.unsubscribePiEvent?.(); } catch {}
          try { this.unsubscribePiClientEvent?.(); } catch {}
          this.unsubscribePiEvent = null;
          this.unsubscribePiClientEvent = null;
          this.rpcClient = null;
          await legacyClient.stop().catch(() => undefined);
        }
        throw error;
      });
    } else {
      this.rpcClient = rpcClient;
      this.unsubscribePiEvent = rpcClient.onEvent((event) => this.handlePiEvent(event as unknown as Record<string, unknown>));
      this.unsubscribePiClientEvent = rpcClient.onClientEvent((event) => this.handlePiClientEvent(event));
      for (const event of this.rpcHostLease?.startupEvents ?? []) this.handlePiClientEvent(event);
    }

    if (this.rpcClient !== rpcClient) throw new Error('Pi RpcClient startup was superseded');
    const state = await rpcClient.getState();
    this.piSessionId = state.sessionId;
    this.config.onSdkSessionIdUpdate?.(state.sessionId);
    this.debug('Pi RpcClient is ready');
    this.writePiRuntimeLog('info', 'startup.ready', {
      piSessionId: this.piSessionId,
      runtimeId: 'runtimeId' in rpcClient ? rpcClient.runtimeId : 'legacy',
    });

    if ('runtimeId' in rpcClient) {
      const provider = runtime.piAuthProvider;
      if (provider && this._model) await rpcClient.setModel(provider, this._model);
      if (this._thinkingLevel) await rpcClient.setThinkingLevel(this._thinkingLevel as any);
    }

    try {
      await rpcClient.setAutoCompaction(true);
      this.debug('PI auto-compaction enabled');
    } catch (error) {
      this.debug(`Failed to configure PI auto-compaction (continuing): ${error instanceof Error ? error.message : String(error)}`);
    }

    await rpcClient.setToolPermissionHandler((request) => this.handleToolPermissionRequest(request));

    // Register session-scoped tools as proxy tools in Pi.
    // These tools (config_validate, source auth, spawn_session, etc.)
    // are executed in the main process when the LLM calls them.
    this.assertBackendSessionToolParity();
    let sessionToolDefs = getSessionToolProxyDefs();

    // Pi owns these tools through the messaging extension and the versioned
    // Host capability protocol. Other backends keep the canonical registry handlers.
    sessionToolDefs = sessionToolDefs.filter(d =>
      d.name !== 'mcp__session__list_messaging_channels'
      && d.name !== 'mcp__session__unbind_messaging_channel'
    );

    sessionToolDefs = sessionToolDefs.filter(d => d.name !== 'mcp__session__browser_tool');

    await rpcClient.registerTools(sessionToolDefs as PiRpcHostToolDefinition[], (request) => this.executeHostTool(request));
    this.debug(`Registered ${sessionToolDefs.length} session tools with Pi RpcClient`);

    await this.registerPoolToolsWithRpcClient();
  }

  /**
   * Send pool's proxy tool defs to Pi for model visibility.
   */
  private async registerPoolToolsWithRpcClient(): Promise<void> {
    const client = this.rpcClient;
    if (!this.mcpPool || !client) return;
    const proxyDefs = this.mcpPool.getProxyToolDefs();
    if (proxyDefs.length > 0) {
      await client.registerTools(proxyDefs as PiRpcHostToolDefinition[], (request) => this.executeHostTool(request));
      this.debug(`Registered ${proxyDefs.length} MCP source tools from pool with Pi RpcClient`);
    }
  }

  /**
   * Build structured Pi auth from connection config.
   * Returns a provider-aware credential object for Pi startup,
   * or null if no piAuthProvider is configured.
   *
   * OAuth tokens from Craft (ChatGPT Plus, Copilot) are passed as
   * api_key type because they function as bearer tokens that the Pi SDK's provider
   * modules use directly. The OAuth exchange happens on the Craft side; by the time
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
          const { refreshGitHubCopilotToken } = await import('@earendil-works/pi-ai/oauth');
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

  private handlePiClientEvent(event: PiRpcClientEvent): void {
    if (
      event.type === 'process_exit' ||
      event.type === 'process_error' ||
      event.type === 'stdin_error'
    ) {
      this.handleRpcClientLifecycleFailure(event);
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

    if (event.type === 'extension_host_capability_request') {
      void this.handleExtensionHostCapabilityRequest(event);
      return;
    }

    if (event.type === 'extension_host_capability_declaration') {
      const sessionId = this.config.session?.craftId ?? this._sessionId;
      const runtimeId = this.currentRpcRuntimeId() ?? `legacy:${sessionId}`;
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
      this.config.onHostCapabilityCancel?.(event.id, this.currentRpcRuntimeId() ?? `legacy:${this.config.session?.craftId ?? this._sessionId}`);
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

    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();
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
  ): Promise<void> {
    const client = this.rpcClient;
    if (!client) return;
    const sessionId = this.config.session?.craftId ?? this._sessionId;
    // Runtime identity is assigned by the Host client. Never accept an extension-supplied
    // route value here: capability authorization and cleanup depend on this boundary.
    const runtimeId = 'runtimeId' in client && typeof client.runtimeId === 'string'
      ? client.runtimeId
      : `legacy:${sessionId}`;
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
        ? { type: 'extension_host_capability_response', version: 1, id: event.id, status: 'success', output: result.output }
        : {
            type: 'extension_host_capability_response', version: 1, id: event.id, status: result.status,
            error: result.error ? {
              code: result.error.code,
              message: result.error.message,
              recoverable: result.error.retryable,
            } : undefined,
          };
    } catch (error) {
      response = {
        type: 'extension_host_capability_response', version: 1, id: event.id, status: 'failed',
        error: { code: 'HOST_CAPABILITY_BRIDGE_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
    try {
      client.respondToExtensionHostCapability(response);
    } catch (error) {
      this.debug(`Failed to respond to extension host capability ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private extensionEventRoute(extensionId: string, runtimeId?: string): Pick<ExtensionBridgeEvent, 'extensionId' | 'runtimeId' | 'sessionId'> {
    const client = this.rpcClient;
    return {
      extensionId,
      runtimeId: runtimeId ?? (client && 'runtimeId' in client ? client.runtimeId : 'legacy'),
      sessionId: this.config.session?.craftId ?? this.piSessionId ?? '',
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
    if (event.method === 'setWidget') {
      return {
        type: 'extension_widget',
        key: event.widgetKey,
        content: event.widgetLines,
        placement: event.widgetPlacement,
        source: extensionId,
        ...route,
      };
    }
    if (event.method === 'select') {
      return {
        type: 'remoteui_request',
        requestId: event.id,
        kind: 'select',
        title: event.title,
        options: event.options.map(title => ({ title })),
        timeout: event.timeout,
        source: extensionId,
        ...route,
      };
    }
    if (event.method === 'confirm') {
      return {
        type: 'remoteui_request',
        requestId: event.id,
        kind: 'confirm',
        title: event.title,
        message: event.message,
        timeout: event.timeout,
        source: extensionId,
        ...route,
      };
    }
    if (event.method === 'input') {
      return {
        type: 'remoteui_request',
        requestId: event.id,
        kind: 'editor',
        title: event.title,
        placeholder: event.placeholder,
        timeout: event.timeout,
        source: extensionId,
        ...route,
      };
    }
    if (event.method === 'editor') {
      return {
        type: 'remoteui_request',
        requestId: event.id,
        kind: 'editor',
        title: event.title,
        prefill: event.prefill,
        source: extensionId,
        ...route,
      };
    }
    if (event.method === 'setTitle') {
      return { type: 'extension_set_title', title: event.title, ...route };
    }
    if (event.method === 'set_editor_text') {
      return { type: 'extension_set_editor_text', text: event.text, ...route };
    }
    return null;
  }

  private handleRpcError(error: unknown): void {
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
    if (parsed.code !== 'unknown_error') {
      this.eventQueue.enqueue({ type: 'typed_error', error: parsed });
    } else {
      this.eventQueue.enqueue({
        type: 'error',
        message: `Pi RpcClient error: ${rawMessage}`,
      });
    }
    this.eventQueue.enqueue({ type: 'complete' });
    this.eventQueue.complete();
  }

  /**
   * Forward a Pi SDK event through the event adapter.
   */
  private handlePiEvent(event: Record<string, unknown>): void {

    // Detect session MCP tool completions (same pattern as in-process version)
    const eventType = event.type as string;
    if (this.suppressAbortedTurnEvents && eventType !== 'turn_end' && eventType !== 'agent_end') {
      return;
    }
    let adaptedEvent = event;

    if (eventType === 'tool_execution_start') {
      const toolName = event.toolName as string;
      if (toolName?.startsWith('session__') || toolName?.startsWith('mcp__session__')) {
        // Session tool tracking is handled by Pi; it sends
        // session_tool_completed events when appropriate.
      }

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

    // Adapt event to CraftAgentEvents
    // The event adapter expects typed PiAgentEvent/AgentSessionEvent objects,
    // but since we're receiving plain JSON, we cast through unknown.
    for (const agentEvent of this.adapter.adaptEvent(adaptedEvent as any)) {
      this.emitPiProjectionEvents(agentEvent);
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

      this.eventQueue.enqueue(agentEvent);
    }

    if (eventType === 'agent_end') {
      this.eventQueue.complete();
    }

    this.emitRawPiProjectionEvents(adaptedEvent);
  }

  /**
   * Runs the centralized permission pipeline for Pi RpcClient tool calls.
   */
  private async handleToolPermissionRequest(req: PiRpcToolPermissionRequest): Promise<
    { action: 'allow' } | { action: 'block'; reason?: string } | { action: 'modify'; input: Record<string, unknown> }
  > {
    const { toolName, toolCallId, input } = req;
    const debugSessionId = this.config.session?.craftId || this._sessionId;
    this.debug(`PreToolUse request from Pi RpcClient: ${toolName} (${req.id}, sessionId=${debugSessionId})`);

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

    const rootPath = this.config.workspace.rootPath ?? this.workingDirectory;
    const workspaceSlug = extractWorkspaceSlug(rootPath, this.config.workspace.id);
    const sessionId = this.config.session?.craftId || this._sessionId;
    const plansFolderPath = sessionId
      ? getSessionPlansPath(rootPath, sessionId)
      : undefined;
    const dataFolderPath = sessionId
      ? getSessionDataPath(rootPath, sessionId)
      : undefined;

    // Build RTK context fresh per call so toggling the preference takes
    // effect without restart. `getRtkPath()` is cached per process.
    const rtkContext: RtkContext | undefined = getRtkEnabled()
      ? { enabled: true, path: getRtkPath(), exclude: [] }
      : undefined;

    const checkResult = runPreToolUseChecks({
      toolName,
      input,
      sessionId,
      permissionMode: this.permissionManager.getPermissionMode(),
      workspaceRootPath: rootPath,
      workspaceId: workspaceSlug,
      plansFolderPath,
      dataFolderPath,
      workingDirectory: this.config.session?.workingDirectory,
      activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
      allSourceSlugs: this.sourceManager.getAllSources().map(s => s.config.slug),
      hasSourceActivation: !!this.onSourceActivationRequest,
      dataSourcesEnabled: getDataSourcesEnabled(),
      permissionManager: this.permissionManager,
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
        const diagnostics = getPermissionModeDiagnostics(sessionId);
        this.debug(`__PERMISSION_BLOCK__${JSON.stringify({
          sessionId,
          toolName,
          effectiveMode: diagnostics.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          reason: checkResult.reason,
        })}`);
        return { action: 'block', reason: checkResult.reason };
      }

      case 'source_activation_needed': {
        const { sourceSlug, sourceExists } = checkResult;
        this.debug(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" not active, attempting activation...`);

        if (this.onSourceActivationRequest) {
          try {
            const activated = await this.onSourceActivationRequest(sourceSlug);
            if (!activated) {
              const reason = sourceExists
                ? `Source "${sourceSlug}" is not active. Activate it by @mentioning it in your message or via the source icon at the bottom of the input field.`
                : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
              return { action: 'block', reason };
            }
            this.debug(`PreToolUse(sessionId=${sessionId}): Source "${sourceSlug}" activated successfully`);
            this.eventQueue.enqueue({
              type: 'source_activated' as const,
              sourceSlug,
              originalMessage: this.getCurrentTurnUserMessage() ?? '',
            });
          } catch (err) {
            const reason = sourceExists
              ? `Source "${sourceSlug}" could not be activated: ${err}`
              : `Source "${sourceSlug}" is not available yet. It needs to be created and configured first.`;
            return { action: 'block', reason };
          }
        }

        // Re-run pipeline after activation
        const postResult = runPreToolUseChecks({
          toolName,
          input,
          sessionId,
          permissionMode: this.permissionManager.getPermissionMode(),
          workspaceRootPath: rootPath,
          workspaceId: workspaceSlug,
          plansFolderPath,
          dataFolderPath,
          workingDirectory: this.config.session?.workingDirectory,
          activeSourceSlugs: Array.from(this.sourceManager.getActiveSlugs()),
          allSourceSlugs: this.sourceManager.getAllSources().map(s => s.config.slug),
          hasSourceActivation: !!this.onSourceActivationRequest,
          dataSourcesEnabled: getDataSourcesEnabled(),
          permissionManager: this.permissionManager,
          prerequisiteManager: this.prerequisiteManager,
          rtkContext,
          onDebug: (msg) => this.debug(`PreToolUse(sessionId=${sessionId}): ${msg}`),
        });

        if (postResult.type === 'modify') {
          return { action: 'modify', input: postResult.input };
        } else if (postResult.type === 'block') {
          return { action: 'block', reason: postResult.reason };
        }
        return { action: 'allow' };
      }

      case 'spawn_session_intercept':
        // These tools are proxy tools handled via tool_execute_request — just allow
        return { action: 'allow' };

      case 'prompt': {
        if (!this.onPermissionRequest) {
          // No permission handler — allow
          if (checkResult.modifiedInput) {
            return { action: 'modify', input: checkResult.modifiedInput };
          }
          return { action: 'allow' };
        }

        const permRequestId = `pi-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.debug(`PreToolUse(sessionId=${sessionId}): Prompting user for ${toolName} - ${checkResult.description}`);

        // Wait for user response via pendingPermissions
        const permissionPromise = new Promise<boolean>((resolve) => {
          this.pendingPermissions.set(permRequestId, {
            resolve,
            toolName,
          });
        });

        this.onPermissionRequest({
          requestId: permRequestId,
          toolName,
          command: checkResult.command,
          description: checkResult.description,
          type: checkResult.promptType,
          appName: checkResult.appName,
          reason: checkResult.reason,
          impact: checkResult.impact,
          requiresSystemPrompt: checkResult.requiresSystemPrompt,
          rememberForMinutes: checkResult.rememberForMinutes,
          commandHash: checkResult.commandHash,
          approvalTtlSeconds: checkResult.approvalTtlSeconds,
        });

        for (const event of this.getProjectionBuilder()?.acceptPromptRequest({
          requestId: permRequestId,
          promptKind: 'permission',
          toolName,
          description: checkResult.description,
          command: checkResult.command,
          permissionType: checkResult.promptType,
          appName: checkResult.appName,
          reason: checkResult.reason,
          impact: checkResult.impact,
          requiresSystemPrompt: checkResult.requiresSystemPrompt,
          rememberForMinutes: checkResult.rememberForMinutes,
          commandHash: checkResult.commandHash,
          approvalTtlSeconds: checkResult.approvalTtlSeconds,
        }) ?? []) {
          this.config.onPiProjectionEvent?.(event);
        }

        const allowed = await permissionPromise;
        this.pendingPermissions.delete(permRequestId);
        for (const event of this.getProjectionBuilder()?.acceptPromptResolution(permRequestId, allowed ? 'allowed' : 'denied') ?? []) {
          this.config.onPiProjectionEvent?.(event);
        }

        if (!allowed) {
          return { action: 'block', reason: 'Permission denied by user.' };
        }

        if (checkResult.modifiedInput) {
          return { action: 'modify', input: checkResult.modifiedInput };
        }
        return { action: 'allow' };
      }
    }
  }

  /**
   * Execute a host proxy tool requested by Pi RpcClient.
   */
  private async executeHostTool(request: PiRpcToolExecuteRequest): Promise<PiRpcHostToolResult> {
    if (!getDataSourcesEnabled() && isDataSourceToolName(request.toolName)) {
      return { content: 'Data sources are disabled in Craft settings.', isError: true };
    }

    // Prerequisite check: block source tools until guide.md is read
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
   * - Session tools (config_validate, etc.) -> session-tools-core handlers.
   * - MCP/API source tools -> centralized source pool proxy.
   *
   * Returns text-result shorthand accepted by Pi's host-tool RPC protocol.
   */
  private async routeToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    // Session-scoped tools — strip mcp__session__ prefix added by the Pi SDK
    // registration (tools are registered as mcp__session__<name>, etc.)
    const strippedName = toolName.startsWith('mcp__session__')
      ? toolName.slice('mcp__session__'.length)
      : toolName;

    if (SESSION_TOOL_NAMES.has(strippedName)) {
      return this.executeSessionTool(strippedName, args);
    }

    // MCP source tools — route through centralized pool
    if (this.mcpPool?.isProxyTool(toolName)) {
      return this.mcpPool.callTool(toolName, args);
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

    const sessionId = this.config.session?.craftId || '';
    const workspacePath = this.config.workspace.rootPath;
    const workspaceId = this.config.workspace.id;

    this._sessionToolContext = createSessionToolContext({
      sessionId,
      workspacePath,
      workspaceId,
      getWorkingDirectory: () => this.config.session?.workingDirectory ?? this.workingDirectory,
      onPlanSubmitted: (planPath: string) => {
        setLastPlanFilePath(sessionId, planPath);
        this.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request: unknown) => {
        this.onAuthRequest?.(request as any);
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
      // spawn_session uses the shared pre-execution pipeline from BaseAgent
      if (toolName === 'spawn_session') {
        try {
          const result = await this.preExecuteSpawnSession(args);
          return { content: JSON.stringify(result, null, 2), isError: false };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `spawn_session failed: ${msg}`, isError: true };
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

  /**
   * Spawn a child session in the pi session tree via Pi RpcClient.
   *
   * Delegates to Pi's native new-session RPC with the current session file as
   * parent metadata so Pi can preserve lineage in its own session tree.
   *
   * This is the thin-wrapper path used by the spawn_session tool: craft no longer
   * creates an independent session file/manager; it just asks pi to branch the
   * active session tree.
   *
   * @param parentSessionId Active Pi session ID retained for the Craft caller contract.
   * @param options Spawn overrides (prompt, connection, model, etc.)
   * @returns { sessionId, sessionPath } of the newly created child session
   */
  async spawnChildSession(
    parentSessionId: string,
    options: PiSpawnChildSessionOptions,
  ): Promise<PiSpawnChildSessionResult> {
    const client = await this.ensureRpcClient();
    const previous = await client.getState();
    const previousSessionFile = previous.sessionFile;
    const parentSession = previousSessionFile ?? parentSessionId;

    try {
      await client.newSession(parentSession);
      if (options.name) {
        await client.setSessionName(options.name);
      }
      if (options.thinkingLevel) {
        await client.setThinkingLevel(options.thinkingLevel as any);
      }
      if (options.model) {
        const provider = options.connection || getBackendRuntime(this.config).piAuthProvider || previous.model?.provider;
        if (provider) {
          await client.setModel(provider, options.model);
        }
      }
      if (options.prompt) {
        await client.prompt(options.prompt);
        await client.waitForIdle(120_000);
      }

      const state = await client.getState();
      return {
        sessionId: state.sessionId,
        sessionPath: state.sessionFile ?? '',
      };
    } finally {
      // 恢复 previous session，避免 prompt 抛错时 RpcClient 停留在 child session
      // 导致下一次主 chat() 打到 child session 而非 parent session。
      if (previousSessionFile) {
        try {
          await client.switchSession(previousSessionFile);
        } catch (switchError) {
          this.debug(`spawnChildSession: failed to restore previous session: ${switchError instanceof Error ? switchError.message : String(switchError)}`);
          await this.stopRpcClient();
        }
      }
    }
  }

  private emitPiProjectionEvents(event: AgentEvent): void {
    const builder = this.getProjectionBuilder();
    const emit = this.config.onPiProjectionEvent;
    if (!builder || !emit) return;
    for (const projectionEvent of builder.accept(event)) emit(projectionEvent);
  }

  projectAuthPromptRequest(request: AuthProjectionPromptRequest): void {
    for (const event of this.getProjectionBuilder()?.acceptAuthPromptRequest(request) ?? []) {
      this.config.onPiProjectionEvent?.(event);
    }
  }

  projectAuthPromptResolution(requestId: string, resolution: 'completed' | 'failed' | 'cancelled'): void {
    for (const event of this.getProjectionBuilder()?.acceptAuthPromptResolution(requestId, resolution) ?? []) {
      this.config.onPiProjectionEvent?.(event);
    }
  }

  projectQueuedUser(message: HostQueuedUserProjection): void {
    for (const event of this.getProjectionBuilder()?.acceptHostQueuedUser(message) ?? []) {
      this.config.onPiProjectionEvent?.(event);
    }
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
    const sessionId = this.config.session?.craftId;
    if (!this.config.onPiProjectionEvent || !sessionId) return null;
    const client = this.rpcClient;
    const runtimeId = client && 'runtimeId' in client && typeof client.runtimeId === 'string'
      ? `${client.runtimeId}:${this.projectionEpoch}`
      : `legacy:${sessionId}`;
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
      const sessions = await client.listChildSessions(parentSessionId);
      return sessions.map(session => ({
        sessionId: session.id,
        sessionPath: session.path,
        name: session.name,
        cwd: session.cwd,
        created: session.created,
        modified: session.modified,
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
        spawnConfig: session.spawnConfig,
      }));
    } catch (error) {
      this.debug(`[listChildSessions] Failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Ask Pi to compact the active session context.
   */
  private async requestCompact(customInstructions?: string): Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number } | null> {
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

  /**
   * 回复 remoteui:request。payload=null 表示取消。
   * 由渲染进程通过 IPC → SessionManager → 此方法转发到 Pi。
   */
  sendRemoteUIResponse(requestId: string, payload: unknown | null, reason?: 'cancelled' | 'no_remote' | 'disconnected'): boolean {
    const client = this.rpcClient;
    if (!client) return false;
    const interactionOwner = this.pendingExtensionInteractions.get(requestId);
    if (interactionOwner) {
      const interaction: ExtensionInteractionResponseV1 = reason || payload === null
        ? {
            schemaVersion: 1,
            status: 'cancelled',
            reason: reason === 'disconnected' || reason === 'no_remote' ? 'host-disconnected' : 'user',
          }
        : payload as ExtensionInteractionResponseV1;
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
    if (payload === null || reason) {
      client.respondToExtensionUI({ type: 'extension_ui_response', id: requestId, cancelled: true });
    } else if (typeof payload === 'object' && payload && 'confirmed' in payload) {
      client.respondToExtensionUI({ type: 'extension_ui_response', id: requestId, confirmed: Boolean((payload as { confirmed?: unknown }).confirmed) });
    } else {
      client.respondToExtensionUI({
        type: 'extension_ui_response',
        id: requestId,
        value: remoteUIResponseValue(payload),
      });
    }
    return true;
  }

  /**
   * 调用扩展注册的命令。
   * Uses Pi's typed `invoke_extension_command` RPC and returns the command ack.
   */
  async sendExtensionCommandInvoke(commandId: string, args?: string, ownerExtensionId?: string): Promise<import('@craft-agent/core/types').ExtensionCommandResult> {
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
    // A runtime that is not open has no extension code to refresh. Its next
    // startup will load the current extension files, so do not resurrect idle
    // or force-closed sessions solely for a manual reload.
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
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent> {
    let message = messageParam;
    // Reset state for new turn
    this._isProcessing = true;
    this.abortReason = undefined;
    this.suppressAbortedTurnEvents = false;
    this.eventQueue.reset();
    this.currentUserMessage = message;
    this.adapter.startTurn();

    // Fire UserPromptSubmit hook event (fire-and-forget)
    this.emitAutomationEvent('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: message,
    });

    // Refresh session-scoped callbacks used by source auth and plan review.
    const sessionId = this.config.session?.craftId;
    if (sessionId) {
      mergeSessionScopedToolCallbacks(sessionId, {
        onPlanSubmitted: (planPath) => this.onPlanSubmitted?.(planPath),
        onAuthRequest: (request) => this.onAuthRequest?.(request),
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

          const recoveryContext = this.buildRecoveryContext();
          if (recoveryContext) {
            message = recoveryContext + message;
            this.debug('Injected recovery context into message');
          }

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

      // Build system prompt
      // 壳模式（fullPassthrough）下跳过 Craft system prompt，使用 Pi 原生 system prompt。
      const piShellPassthrough = getPiShellFullPassthrough();
      const systemPrompt = piShellPassthrough
        ? ''
        : getSystemPrompt(
            undefined, // pinnedPreferencesPrompt
            this.config.debugMode,
            this.config.workspace.rootPath,
            this.config.session?.workingDirectory,
            this.config.systemPromptPreset,
            'Craft Agents Backend', // backendName
            getCoAuthorPreference() // respect user's includeCoAuthoredBy preference (#576)
          );

      // Build context from sources
      const sourceContext = this.sourceManager.formatSourceState();

      const promptModeDiagnostics = getPermissionModeDiagnostics(this._sessionId)
      this.debug(
        `[ModeSnapshot] sessionId=${this._sessionId} chatPrompt mode=${promptModeDiagnostics.permissionMode} ` +
        `modeVersion=${promptModeDiagnostics.modeVersion} changedBy=${promptModeDiagnostics.lastChangedBy} changedAt=${promptModeDiagnostics.lastChangedAt}`
      )

      // Build context parts using centralized PromptBuilder, split into stable
      // vs volatile (issue #862). Stable blocks (workspace capabilities, working
      // directory) stay in the cached system prefix; volatile blocks (date/time,
      // session_state, source state) ride the user-message tail so a per-turn
      // re-stamp doesn't invalidate the prompt cache. buildVolatileContextParts
      // consumes the one-shot mode-change signal, so it is called exactly once.
      const plansFolderPath = getSessionPlansPath(this.config.workspace.rootPath, this._sessionId);
      const stableParts = this.promptBuilder.buildStableContextParts();
      const volatileParts = this.promptBuilder.buildVolatileContextParts(
        { plansFolderPath },
        sourceContext
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

      // System prompt carries only stable context (issue #862): the system block
      // is pi-ai's cache prefix before all history, so anything volatile here
      // re-stamps the prefix every turn and drops cacheRead to 0. Volatile blocks
      // ride the user-message tail instead — exactly as the Claude path already
      // does (buildTextPrompt / buildSDKUserMessage append context to the tail).
      const fullSystemPrompt = piShellPassthrough
        ? ''
        : [
            systemPrompt,
            ...stableParts,
          ].filter(Boolean).join('\n\n');

      // User message: volatile context + attachments + the actual message
      // (skill read directive is already prepended to message by BaseAgent.chat())
      const userParts = [
        ...volatileParts,
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
      await client.prompt(
        userMessage,
        images.length > 0 ? images as any : undefined,
        {
          systemPrompt: fullSystemPrompt || undefined,
          clientMutationId: options?.clientMutationId,
          attachments: options?.attachmentRefs,
        },
      );

      // Yield events as they arrive. The source-activation drain controller
      // captures a pending restart on the first triggering tool_result and
      // drains sibling tool_results from the same parallel-tool batch before
      // firing `source_activated` + `forceAbort` — Pi only picks
      // up new proxy tools on the next handlePrompt, so the restart is needed
      // here too. Without the drain, sibling tool_results from parallel
      // source_test calls are lost (#790).
      const sourceActivationDrain = new SourceActivationDrainController('fire-on-non-tool-result');
      for await (const event of this.eventQueue.drain()) {
        if (event.type === 'queue_overflow') this.emitPiProjectionEvents(event);
        // Pre-yield check: when we're past capture and the incoming event is
        // not a tool_result, fire BEFORE yielding it (the event belongs to
        // the about-to-be-aborted next turn — letting it through would leak
        // a fragment of the cancelled response into the session journal).
        const preFire = sourceActivationDrain.shouldFireBeforeEvent(event);
        if (preFire) {
          this.debug(`source_test activated "${preFire.sourceSlug}", drained sibling tool_results, restarting turn`);
          yield preFire;
          this.forceAbort(AbortReason.SourceActivated);
          return;
        }

        if (sourceActivationDrain.observe(event, () => this.consumePendingSourceActivationRestart())) {
          yield event;
          continue;
        }

        yield event;
      }

      // Stream-end fallback: queue drained naturally with a captured restart
      // still pending. Fire and return (no further events expected).
      const sourceActivationFireAtEnd = sourceActivationDrain.shouldFireAtBoundary();
      if (sourceActivationFireAtEnd) {
        this.debug(`source_test activated "${sourceActivationFireAtEnd.sourceSlug}", stream ended with pending restart, restarting turn`);
        yield sourceActivationFireAtEnd;
        this.forceAbort(AbortReason.SourceActivated);
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('abort')) {
        if (this.abortReason === AbortReason.PlanSubmitted) {
          return;
        }
        if (this.abortReason === AbortReason.AuthRequest) {
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

      yield { type: 'complete' };
    } finally {
      this._isProcessing = false;
    }
  }

  // ============================================================
  // Permission Handling
  // ============================================================

  /**
   * Respond to a pending permission request.
   * Permission checking now happens in the main process, so this resolves locally.
   */
  respondToPermission(requestId: string, allowed: boolean, _alwaysAllow?: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      this.pendingPermissions.delete(requestId);
      pending.resolve(allowed);
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
        void this.rpcClient.setModel(provider, model).catch(error => this.handleRpcError(error));
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
      void this.rpcClient.setThinkingLevel(level as any).catch(error => this.handleRpcError(error));
    } else {
      this.debug(`Thinking level updated but no Pi RpcClient to forward to: ${previousLevel} → ${level}`);
    }
  }

  // ============================================================
  // Source / MCP Integration
  // ============================================================

  override async setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[]
  ): Promise<void> {
    // BaseAgent.setSourceServers() handles:
    //   1. SourceManager state tracking (active slugs)
    //   2. McpClientPool sync (connecting/disconnecting MCP + API sources)
    await super.setSourceServers(mcpServers, apiServers, intendedSlugs);

    // Register pool's proxy tool defs with Pi so the model can call them.
    await this.registerPoolToolsWithRpcClient();
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

    // Deny all pending permissions
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();

    this.abortReason = Object.values(AbortReason).includes(reason as AbortReason)
      ? reason as AbortReason
      : AbortReason.UserStop;
    this._isProcessing = false;
    this.suppressAbortedTurnEvents = true;

    let abortTimeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const client = this.rpcClient;
      if (client) {
        await Promise.race([
          client.abort(),
          new Promise<never>((_, reject) => {
            abortTimeout = setTimeout(() => {
              reject(new Error(`Pi abort acknowledgment timed out after ${PI_ABORT_ACK_TIMEOUT_MS}ms`));
            }, PI_ABORT_ACK_TIMEOUT_MS);
          }),
        ]);
      }
    } catch (error) {
      this.writePiRuntimeLog('warn', 'chat.abort_failed', { error });
      // If the cooperative abort command fails, release this runtime so the
      // stopped generation cannot continue publishing events in the background.
      await this.stopRpcClient();
    } finally {
      if (abortTimeout) clearTimeout(abortTimeout);
      // Wake the chat consumer even if the transport failed while aborting.
      this.eventQueue.complete();
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

    // Reject all pending permissions
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();

    // Signal turn complete to wake up any waiting consumers
    this.eventQueue.complete();

    // Clear bridge cache for aborted turn.
    this.preToolMetadataByCallId.clear();

    // For PlanSubmitted and AuthRequest, just interrupt the turn
    if (reason === AbortReason.PlanSubmitted || reason === AbortReason.AuthRequest) {
      return;
    }

    // For other reasons, send abort to Pi.
    void this.rpcClient?.abort().catch(error => this.handleRpcError(error));
  }

  /**
   * Redirect mid-stream via Pi SDK's steer().
   * Delivers the message after the current tool finishes, skips remaining
   * queued tools, and continues with full context intact.
   * Events flow through the existing generator — no abort needed.
   */
  override redirect(message: string, clientMutationId?: string): boolean {
    if (!this._isProcessing || !this.rpcClient) {
      // Not streaming or no client — fall back to abort
      this.forceAbort(AbortReason.Redirect);
      return false;
    }
    this.debug(`Steering mid-stream: "${message.slice(0, 100)}"`);
    void this.rpcClient.steer(message, undefined, { clientMutationId }).catch(error => this.handleRpcError(error));
    return true;
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
    super.setWorkspace(workspace);
    this.piSessionId = null;
    this._sessionToolContext = null;
    void this.stopRpcClient();
  }

  override clearHistory(): void {
    this.piSessionId = null;
    void this.stopRpcClient();
    super.clearHistory();
    this.debug('History cleared - next chat will start a new Pi RpcClient');
  }

  destroy(): void {
    this.stopConfigWatcher();

    // Unregister session-scoped tool callbacks
    if (this.config.session?.craftId) {
      unregisterSessionScopedToolCallbacks(this.config.session.craftId);
    }

    this._sessionToolContext = null;
    // Pool clients are owned by the main process — don't close them here.
    void this.stopRpcClient();
    this.debug('PiAgent destroyed');
  }

  async disposeForRestart(): Promise<void> {
    this.stopConfigWatcher();

    if (this.config.session?.craftId) {
      unregisterSessionScopedToolCallbacks(this.config.session.craftId);
    }

    this._sessionToolContext = null;
    await this.stopRpcClient();
    this.debug('PiAgent disposed for restart');
  }

  /**
   * Reconnect by stopping RpcClient -- next chat() will spawn fresh.
   */
  async reconnect(): Promise<void> {
    await this.stopRpcClient();
    this.debug('PiAgent reconnected (Pi RpcClient will be restarted on next chat)');
  }

  private async stopRpcClient(): Promise<void> {
    const client = this.rpcClient;
    const runtimeId = this.currentRpcRuntimeId();
    if (runtimeId) {
      this.config.onHostCapabilityRuntimeReleased?.(runtimeId);
      this.config.onExtensionEvent?.({
        type: 'extension_contributions_runtime_reset',
        ...this.extensionEventRoute('pi-runtime', runtimeId),
      });
    }
    const hostLease = this.rpcHostLease;
    this.cancelPendingExtensionInteractions('runtime-disposed');
    this.unsubscribePiEvent?.();
    this.unsubscribePiEvent = null;
    this.unsubscribePiClientEvent?.();
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
    } else if (client && 'stop' in client) {
      await client.stop().catch(error => {
        this.debug(`Failed to stop Pi RpcClient cleanly: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private currentRpcRuntimeId(): string | undefined {
    const client = this.rpcClient;
    return client && 'runtimeId' in client && typeof client.runtimeId === 'string'
      ? client.runtimeId
      : undefined;
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
   * Uses Pi's typed secondary LLM RPC so Craft no longer needs a private
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

  /**
   * Resolve working directory to an absolute path.
   * BaseAgent stores paths with tilde (~) but Node.js spawn doesn't expand tilde.
   */
  private resolvedCwd(): string {
    const wd = this.workingDirectory;
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
