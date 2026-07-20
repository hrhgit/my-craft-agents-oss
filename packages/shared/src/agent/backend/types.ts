/**
 * Backend Abstraction Types
 *
 * Defines the core interface that all AI backends (Claude, OpenAI, etc.) must implement.
 * The MortiseAgent facade delegates to these backends, enabling provider switching while
 * maintaining a consistent API surface.
 *
 * Key design decisions:
 * - Provider-agnostic events: All backends emit the same AgentEvent types
 * - Capabilities-driven UI: Model/thinking selectors read from capabilities()
 * - Callback pattern: Facade sets callbacks after creating backend
 * - AsyncGenerator for streaming: Consistent with existing MortiseAgent API
 */

import type { AgentEvent, ExtensionCommandResult } from '@mortise/core/types';
import type { PiProjectionEventV1, PiProjectionSnapshotV1 } from '../../protocol/pi-projection.ts';
import type { CapabilityRequestV1, CapabilityResultV1 } from '../../protocol/capabilities.ts';
import type { ExtensionContributionDeltaV1 } from '../../protocol/extension-contributions.ts';
import type { ExtensionInteractionBridgeCancelV1, ExtensionInteractionBridgeRequestV1, ExtensionInteractionBridgeSettledV1 } from '../../protocol/extension-interactions.ts';
import type { ExtensionUIValidationDeltaV1 } from '../../protocol/extension-ui-validation.ts';
import type { FileAttachment } from '../../utils/files.ts';
import type { ThinkingLevel } from '../thinking-levels.ts';
import type { PermissionMode } from '../mode-manager.ts';
import type { Workspace } from '../../config/storage.ts';
import type { SessionHeader as Session } from '../../sessions/types.ts';
import type { AgentRuntimeProfile } from '../../config/agent-settings.ts';

// Import AbortReason and RecoveryMessage from core module (single source of truth)
import { AbortReason, type RecoveryMessage } from '../core/index.ts';
export { AbortReason, type RecoveryMessage };

/** Runtime backend provider. Mortise shells Pi; provider brands live in Pi config. */
export type ModelProvider = 'pi';

export interface HostRuntimeErrorProjection {
  phase: 'startup' | 'send' | 'queue' | 'recovery';
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface HostQueuedUserProjection {
  message: string;
  clientMutationId: string;
  messageId?: string;
  timestamp?: number;
  attachments?: Array<{
    id: string;
    name: string;
    mediaType?: string;
    size?: number;
  }>;
}

export interface IsolatedAgentRequest {
  prompt: string;
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
}

export type LlmProviderType = 'pi' | 'pi_compat';
export type LlmAuthType =
  | 'api_key'
  | 'api_key_with_endpoint'
  | 'oauth'
  | 'iam_credentials'
  | 'bearer_token'
  | 'service_account_file'
  | 'environment'
  | 'none';

export interface BackendRuntimeUpdate {
  model: string;
  providerType?: LlmProviderType;
  authType?: LlmAuthType;
  runtime?: {
    baseUrl?: string;
    piAuthProvider?: string;
    customEndpoint?: { api: string; supportsImages?: boolean };
    customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
    [key: string]: unknown;
  };
}
import type { AgentEvent as AutomationAgentEvent, AgentAutomationInput } from '../../automations/types.ts';

// ============================================================
// Callback Types
// ============================================================

/**
 * 扩展事件桥接类型：从 Pi RpcClient 转发到主进程的扩展事件联合类型。
 * 对应 Pi RpcClient 扩展 UI 事件。
 */
export type ExtensionBridgeEvent = {
  extensionId: string;
  runtimeId: string;
  sessionId: string;
} & (
  | { type: 'extension_notify'; message: string; notificationType?: 'info' | 'warning' | 'error'; source?: string }
  | { type: 'extension_status'; key?: string; status: string; source?: string }
  | { type: 'extension_widget'; key: string; content: string[] | undefined; placement?: 'aboveEditor' | 'belowEditor'; source?: string }
  | { type: 'extension_contribution'; delta: ExtensionContributionDeltaV1 }
  | { type: 'extension_ui_validation'; delta: ExtensionUIValidationDeltaV1 }
  | { type: 'extension_contributions_runtime_reset'; workspaceId?: string }
  | ExtensionInteractionBridgeRequestV1
  | ExtensionInteractionBridgeCancelV1
  | ExtensionInteractionBridgeSettledV1
  | { type: 'extension_command_registered'; name: string; description?: string; source: string }
  | { type: 'extension_set_title'; title: string }
  | { type: 'extension_set_editor_text'; text: string }
  | {
      type: 'remoteui_request';
      requestId: string;
      kind: 'select' | 'confirm' | 'editor';
      title: string;
      message?: string;
      options?: Array<{ title: string; description?: string }>;
      allowMultiple?: boolean;
      allowFreeform?: boolean;
      allowComment?: boolean;
      prefill?: string;
      placeholder?: string;
      timeout?: number;
      source: string;
    }
);

export interface PiExtensionCommand {
  name: string;
  description?: string;
  source: string;
  path?: string;
}

/**
 * Permission prompt types for different tool categories.
 */
export type PermissionRequestType = 'bash' | 'file_write' | 'tool_mutation' | 'mcp_mutation' | 'admin_approval';

/**
 * Permission request callback signature.
 * Called when a tool requires user permission before execution.
 */
export type PermissionCallback = (request: {
  requestId: string;
  toolName: string;
  command?: string;
  description: string;
  type?: PermissionRequestType;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  commandHash?: string;
  approvalTtlSeconds?: number;
}) => void;

/**
 * Plan submission callback signature.
 * Called when agent submits a plan for user review.
 */
export type PlanCallback = (planPath: string) => void;

// ============================================================
// Lifecycle Types
// ============================================================

/**
 * Result of backend post-initialization (auth injection, config setup).
 * Returned by postInit() so the session layer can surface warnings.
 */
export interface PostInitResult {
  /** Whether auth credentials were successfully injected */
  authInjected: boolean;
  /** Optional warning message to surface in UI */
  authWarning?: string;
  /** Severity level for the warning */
  authWarningLevel?: 'error' | 'warning' | 'info';
}

/**
 * Host runtime context passed from the application shell (Electron/CLI/etc.).
 * This is intentionally provider-agnostic metadata; backend drivers resolve
 * provider-specific paths from this context internally.
 */
export interface BackendHostRuntimeContext {
  /** App root path (packaged app path or repository root in development) */
  appRootPath: string;
  /** Optional resources path (needed for packaged Windows runtime resolution) */
  resourcesPath?: string;
  /** Whether the host app is running as a packaged build */
  isPackaged: boolean;
  /** Optional runtime override for Node/Bun executable */
  nodeRuntimePath?: string;
}

/**
 * Provider-agnostic backend configuration used by the session layer.
 * Provider-specific runtime details are resolved by backend drivers internally.
 */
export interface CoreBackendConfig {
  /** Workspace configuration */
  workspace: Workspace;

  /** Session configuration (for resume) */
  session?: Session;

  /** Initial model ID */
  model?: string;

  /** Mini/utility model for summarization/title generation/mini-completions */
  miniModel?: string;

  /** Initial thinking level */
  thinkingLevel?: ThinkingLevel;

  /** Headless mode flag (disables interactive tools) */
  isHeadless?: boolean;

  /** Skip agent-level config file watching (server already owns a workspace-level watcher) */
  skipConfigWatcher?: boolean;

  /** Debug mode configuration */
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };

  /** System prompt preset ('default' | 'mini' | custom string) */
  systemPromptPreset?: 'default' | 'mini' | string;

  /** Host-owned ingress for Agent lifecycle events. */
  automationEventSink?: (event: AutomationAgentEvent, input: AgentAutomationInput, signal?: AbortSignal) => Promise<void>;

  /**
   * Per-session environment variable overrides for the SDK subprocess.
   * Spread after process.env in backend-specific option builders.
   */
  envOverrides?: Record<string, string>;

  /** Callback when SDK session ID is captured/updated */
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void;

  /** Callback when SDK session ID is cleared (e.g., after failed resume) */
  onSdkSessionIdCleared?: () => void;

  /**
   * Called when the agent decides the persisted branch-fork metadata
   * (branchFromSdkSessionId / branchFromSdkCwd / branchFromSdkTurnId) is
   * unrecoverable on this machine — typically because the parent's sdk cwd
   * doesn't exist locally (cross-machine session import) or the SDK fork
   * spawn failed before establishing a child session.
   *
   * Implementations MUST clear all four fields (including sdkSessionId)
   * atomically and persist. `onSdkSessionIdCleared` is insufficient because
   * it only clears sdkSessionId — branch fields would reload from disk
   * on next launch and re-trigger the failure.
   */
  onBranchForkInvalidated?: () => void;

  /** Callback to get recent messages for recovery context */
  getRecoveryMessages?: () => RecoveryMessage[];

  /** Latest Host-authored projection state used to seed a replacement Pi runtime. */
  getPiProjectionSnapshot?: () => PiProjectionSnapshotV1 | undefined;

  /**
   * Get ALL parent messages for branch fork fallback (not limited to 6).
   * Called when SDK-level branch fork fails and we need to summarize
   * the parent conversation for context injection via mini completion.
   * Returns empty array for non-branched sessions.
   */
  getBranchFallbackMessages?: () => RecoveryMessage[];

  /**
   * Callback to get branch seed messages (up to branch cutoff) for first turn in seeded branch mode.
   * When provided and non-empty, BaseAgent injects a hidden context block before the first user turn.
   */
  getBranchSeedMessages?: () => RecoveryMessage[];

  /** Callback invoked after branch seed context has been injected. */
  markBranchSeedApplied?: () => void;

  /** One-shot hidden summary to inject on the first turn of a transferred session. */
  getTransferredSessionSummary?: () => string | null;

  /** Callback invoked after transferred session summary has been injected. */
  markTransferredSessionSummaryApplied?: () => void;

  /**
   * Optional callback to resize an oversized image for API compatibility.
   * Called from PreToolUse when Read targets an image exceeding the base64 size limit.
   * Returns path to the resized temp file, or null if resize not possible.
   * Provided by the host app (Electron uses nativeImage, server could use sharp, etc.).
   */
  onImageResize?: (filePath: string, maxSizeBytes: number) => Promise<string | null>;

  /**
   * 扩展事件桥接回调：当 Pi RpcClient 转发扩展事件（remoteui:request、
   * extension_notify、extension_status、extension_widget、extension_command_registered 等）时调用。
   * 由 SessionManager 通过 eventSink 广播到渲染进程。
   */
  onExtensionEvent?: (event: ExtensionBridgeEvent) => void;

  /** Pi-first conversation projection stream. Must not contain Mortise Message DTOs. */
  onPiProjectionEvent?: (event: PiProjectionEventV1) => void;

  /** Execute a Pi extension's request against the host-owned capability router. */
  onHostCapabilityRequest?: (
    request: CapabilityRequestV1,
    onProgress: (event: import('@mortise/shared/protocol').CapabilityProgressV1) => void,
  ) => Promise<CapabilityResultV1>;

  /** Cancel an in-flight host capability after an extension abort or timeout. */
  onHostCapabilityCancel?: (requestId: string, runtimeId: string) => void;
  onHostCapabilityDeclaration?: (declaration: import('../../protocol/capabilities.ts').ExtensionCapabilityDeclarationV1) => void;

  /** Release all in-flight capabilities owned by a stopped Pi runtime. */
  onHostCapabilityRuntimeReleased?: (runtimeId: string) => void;

}

// ============================================================
// Backend Interface
// ============================================================

/**
 * Options for the chat method.
 */
export interface ChatOptions {
  /** Retry flag (internal use for session recovery) */
  isRetry?: boolean;
  /** Override thinking level for this message only */
  thinkingOverride?: ThinkingLevel;
  /** Frontend identity forwarded to Pi for optimistic projection reconciliation. */
  clientMutationId?: string;
  /** Sanitized display metadata forwarded to Pi; never include paths or contents. */
  attachmentRefs?: Array<{ id: string; name: string; mediaType?: string; size?: number }>;
}

/**
 * Core backend interface - all AI providers must implement this.
 *
 * The interface is designed to:
 * 1. Abstract provider runtime differences
 * 2. Enable the facade pattern in MortiseAgent
 * 3. Support streaming via AsyncGenerator
 * 4. Allow capability-based UI adaptation
 */
export interface AgentBackend {
  // ============================================================
  // Chat & Lifecycle
  // ============================================================

  /**
   * Send a message and stream back events.
   * This is the core agentic loop - handles tool execution, permission checks, etc.
   *
   * @param message - User message text
   * @param attachments - Optional file attachments
   * @param options - Optional chat configuration
   * @yields AgentEvent stream
   */
  chat(
    message: string,
    attachments?: FileAttachment[],
    options?: ChatOptions
  ): AsyncGenerator<AgentEvent>;

  /**
   * Abort current query (user stop or internal abort).
   *
   * @param reason - Optional reason for abort (for logging/debugging)
   */
  abort(reason?: string): Promise<void>;

  /**
   * Force abort with specific reason.
   * Used for true hard-stop semantics (user stop, redirect fallback, teardown).
   *
   * @param reason - AbortReason enum value
   */
  forceAbort(reason: AbortReason): void;

  /**
   * Interrupt the current turn because control is being handed to the UI.
   *
   * Used for pause points like plan submission and auth requests, where the
   * session should stop cleanly without necessarily using the backend's
   * hardest abort primitive.
   *
   * @param reason - AbortReason enum value for the handoff boundary
   */
  interruptForHandoff(reason: AbortReason): void;

  /**
   * Redirect the agent mid-stream with a new user message.
   * Called when the user sends a message while the agent is still processing.
   *
   * Each backend decides its own strategy:
   * - Backends with native steering (e.g., Pi) inject the message into the
   *   current stream and return true — events continue through the existing
   *   generator, no abort needed.
   * - Backends without steering call forceAbort(Redirect) internally and
   *   return false — the session layer queues the message for re-send.
   *
   * @param message - The new user message
   * @returns true if steered (events flow through existing stream),
   *          false if aborted (session layer must queue + re-send)
   */
  redirect(message: string, clientMutationId?: string): boolean;

  /**
   * Run a simple text completion using the backend's auth infrastructure.
   * Used for connection testing, title generation, and summarization.
   */
  runMiniCompletion(prompt: string): Promise<string | null>;

  /** Run a complete tool-capable Agent Loop without creating a persisted Session. */
  runIsolatedAgent(request: IsolatedAgentRequest): Promise<string | null>;

  /**
   * Clean up backend resources and watchers.
   */
  destroy(): void;

  /**
   * Alias for destroy() for consistency.
   */
  dispose(): void;

  /**
   * Post-construction initialization.
   * Handles auth injection, initial config generation, etc.
   * Called after construction and callback wiring, before first chat().
   */
  postInit(): Promise<PostInitResult>;

  /**
   * Ensure branch sessions are backend-ready before first user message.
   * Called at branch creation time to avoid creating "fake branches" that have
   * copied transcript history but no actual backend branch context.
   *
   * Default behavior can be a no-op for providers that don't need preflight.
   */
  ensureBranchReady(): Promise<void>;

  /**
   * Check if currently processing a query.
   */
  isProcessing(): boolean;

  // ============================================================
  // Model & Thinking Configuration
  // ============================================================

  /** Get current model ID */
  getModel(): string;

  /** Set model (should validate against capabilities) */
  setModel(model: string): void;

  /**
   * Update runtime-affecting provider config without recreating the backend.
   * Backends return false when the update cannot be applied in-place and the
   * session manager should fall back to an idle restart.
   */
  updateRuntimeConfig?(update: BackendRuntimeUpdate): Promise<boolean>;

  /**
   * Dispose resources before an idle backend restart. Backends with subprocesses
   * can wait for child process exit here to avoid transient process leaks.
   */
  disposeForRestart?(): Promise<void>;

  /** Get current thinking level */
  getThinkingLevel(): ThinkingLevel;

  /** Set thinking level */
  setThinkingLevel(level: ThinkingLevel): void;

  // ============================================================
  // Permission Mode
  // ============================================================

  /** Get current permission mode */
  getPermissionMode(): PermissionMode;

  /** Set permission mode */
  setPermissionMode(mode: PermissionMode): void;

  /** Cycle to next permission mode */
  cyclePermissionMode(): PermissionMode;

  // ============================================================
  // State
  // ============================================================

  /** Get SDK session ID (for resume, null if no session) */
  getSessionId(): string | null;

  /** Whether this backend supports session branching */
  readonly supportsBranching: boolean;

  /**
   * Spawn a child session in the backend's session tree (pi session tree for
   * PiAgent). When absent, the session manager falls back to creating an
   * independent mortise session. Present on PiAgent; the spawn_session tool path
   * delegates here so mortise no longer reimplements session creation.
   */
  spawnChildSession?(
    parentSessionId: string,
    options: import('../pi-agent.ts').PiSpawnChildSessionOptions,
  ): Promise<import('../pi-agent.ts').PiSpawnChildSessionResult>;

  /**
   * List child sessions spawned from the given parent session ID (filtered by
   * the backend's session tree `spawnedFrom` field). Used by the SubagentPanel
   * to render the active branch set. Present on PiAgent.
   */
  listChildSessions?(
    parentSessionId: string,
  ): Promise<import('../pi-agent.ts').PiChildSessionInfo[]>;

  /**
   * Get a bound summarize callback for passing to API tool builders.
   */
  getSummarizeCallback(): (prompt: string) => Promise<string | null>;

  // ============================================================
  // Session & Workspace State
  // ============================================================

  /** Update the working directory */
  updateWorkingDirectory(path: string): void;

  /** Update the SDK cwd (transcript storage location) */
  updateSdkCwd(path: string): void;

  /** Set workspace configuration */
  setWorkspace(workspace: Workspace): void;

  /** Set session ID */
  setSessionId(sessionId: string | null): void;

  /** Generate a session title from user message */
  generateTitle(message: string, options?: { language?: string }): Promise<string | null>;

  /** Regenerate a session title from recent conversation */
  regenerateTitle(recentUserMessages: string[], lastAssistantResponse: string, options?: { language?: string }): Promise<string | null>;

  // ============================================================
  // Permission Resolution
  // ============================================================

  /**
   * Respond to a pending permission request.
   *
   * @param requestId - Permission request ID
   * @param allowed - Whether permission was granted
   * @param alwaysAllow - Whether to remember this permission for session
   */
  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void;

  /**
   * 回复 pi 扩展发起的 remoteui:request。
   * 仅 Pi 后端实现（PiAgent.sendRemoteUIResponse）；其他后端可不实现。
   * payload=null 表示用户取消。
   */
  sendRemoteUIResponse?(requestId: string, payload: unknown | null, reason?: 'cancelled' | 'no_remote' | 'disconnected'): boolean;

  /**
   * 调用 pi 扩展注册的命令（extension_command_invoke）。
   * 仅 Pi 后端实现（PiAgent.sendExtensionCommandInvoke）；其他后端可不实现。
   * args 为 JSON 字符串。
   */
  sendExtensionCommandInvoke?(commandId: string, args?: string, ownerExtensionId?: string): Promise<ExtensionCommandResult>;

  /** Reload the current Pi runtime's extension set without replacing the session. */
  reloadExtensions?(): Promise<{ reloaded: boolean; deferred: boolean }>;

  /** Inspect the effective prompt and tool registry for settings UI. */
  getAgentProfile?(): Promise<AgentRuntimeProfile>;

  /**
   * 查询 Pi 当前会话已注册的扩展 slash commands。
   * 仅 Pi 后端实现；非 Pi 后端可不实现。
   */
  listExtensionCommands?(): Promise<PiExtensionCommand[]>;

  /** Project a Host failure through Pi's sequence-owning projection builder. */
  projectRuntimeError?(error: HostRuntimeErrorProjection): void;

  /** Keep a Host-queued user message visible until Pi accepts it. */
  projectQueuedUser?(message: HostQueuedUserProjection): void;

  // ============================================================
  // Callbacks (set by facade after construction)
  // ============================================================

  /** Called when a tool requires permission */
  onPermissionRequest: PermissionCallback | null;

  /** Called when agent submits a plan */
  onPlanSubmitted: PlanCallback | null;

  /** Called when permission mode changes */
  onPermissionModeChange: ((mode: PermissionMode) => void) | null;

  /** Called with debug messages */
  onDebug: ((message: string) => void) | null;

  /**
   * Called when backend-specific authentication is required.
   * Replaces per-backend callbacks (onChatGptAuthRequired, onGithubAuthRequired).
   * The session layer wires this to surface auth warnings in the UI.
   */
  onBackendAuthRequired: ((reason: string) => void) | null;

  /** Called when agent requests spawning a new session */
  onSpawnSession: ((request: import('../base-agent.ts').SpawnSessionRequest) => Promise<import('../base-agent.ts').SpawnSessionResult>) | null;
}

/**
 * Configuration for creating a backend.
 */
export interface BackendConfig extends CoreBackendConfig {
  /**
   * Provider route to use for this backend.
   * Determines which agent class is instantiated:
   * - 'pi' → PiAgent (Pi via @mortise/pi-coding-agent)
   */
  provider: ModelProvider;

  /**
   * Full provider type from Pi provider.
   * Includes compat variants and cloud providers.
   * Used for routing validation, credential lookup, etc.
   */
  providerType?: LlmProviderType;

  /**
   * Authentication mechanism from Pi provider.
   * Determines how credentials are retrieved and passed to the backend.
   */
  authType?: LlmAuthType;

  /** MCP token override (for testing) */
  mcpToken?: string;

  /**
   * Connection slug for credential routing.
   * Set by factory when creating from a connection.
   * Used to read/write credentials under the correct key.
   */
  providerKey?: string;

  /** Host-owned ingress for Agent lifecycle events. */
  automationEventSink?: (event: AutomationAgentEvent, input: AgentAutomationInput, signal?: AbortSignal) => Promise<void>;

  /**
   * Opaque runtime payload resolved by backend drivers.
   * This keeps provider-specific runtime details out of the public config surface.
   */
  runtime?: Record<string, unknown>;
}

/* Pi-only backend provider standard. */
