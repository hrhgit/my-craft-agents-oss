/**
 * ISessionManager — abstract interface for the session lifecycle engine.
 *
 * Handler code in server-core programs against this interface;
 * concrete implementations (Electron SessionManager, headless, etc.)
 * satisfy it at runtime.
 */

import type { Workspace, WorkspaceInfo, ActiveSessionInfo } from '@mortise/core/types'
import type { StoredAttachment, AnnotationV1 } from '@mortise/core/types'
import type { PermissionMode } from '@mortise/shared/agent/mode-types'
import type { ThinkingLevel } from '@mortise/shared/agent/thinking-levels'
import type {
  Session,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  PermissionResponseOptions,
  PermissionModeState,
  UnreadSummary,
  PiProjectionEventV1,
  PiProjectionSnapshotV1,
  ExtensionInteractionResponseV1,
} from '@mortise/shared/protocol'
import type { ProjectionApplyResult } from '../projection'
import type { SessionBundle, DispatchMode } from '@mortise/shared/sessions'
import type { SessionShareTransferService } from '../services/session-share-transfer'
import type { EventSink } from '../transport'
import type { WorkspaceTopologySessionCoordinator } from '../domain'

export interface ISessionManager extends WorkspaceTopologySessionCoordinator {
  readonly shareTransferService: SessionShareTransferService
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  waitForInit(): Promise<void>
  initialize(): Promise<void>
  cleanup(): Promise<void>
  setEventSink(sink: EventSink): void
  flushAllSessions(): Promise<void>

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  getSessions(workspaceId?: string): Session[]
  getSession(sessionId: string): Promise<Session | null>
  getPiProjectionSnapshot(sessionId: string): Promise<PiProjectionSnapshotV1 | null>
  applyPiProjectionEvent(event: PiProjectionEventV1): ProjectionApplyResult
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  createAndSendFirstTurn(input: CreateAndSendFirstTurnInput): Promise<{ session: Session; messageId: string }>
  discardFirstTurnAttachmentStaging(workspaceId: string, stagingId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  renameSession(sessionId: string, name: string): Promise<void>
  markSessionRead(sessionId: string): Promise<void>
  markSessionUnread(sessionId: string): Promise<void>
  markAllSessionsRead(workspaceId: string): Promise<void>
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void
  clearActiveViewingSession(workspaceId: string): void

  // ---------------------------------------------------------------------------
  // Session configuration
  // ---------------------------------------------------------------------------

  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void
  setSessionProvider(sessionId: string, provider: string): Promise<void>
  clearDeletedProviderReferences(provider: string): Promise<void>
  updateSessionModel(sessionId: string, workspaceId: string, model: string | null, provider?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    onAck?: (messageId: string) => void,
    rpcContext?: { callerClientId?: string },
  ): Promise<void>
  /** Retry only the host-owned durability boundary for an already accepted turn. */
  retryPendingSettlement(sessionId: string): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }>
  getTaskOutput(taskId: string): Promise<string | null>
  addMessageAnnotation(sessionId: string, messageId: string, annotation: AnnotationV1): void
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<AnnotationV1>,
  ): void

  // ---------------------------------------------------------------------------
  // Permissions & credentials
  // ---------------------------------------------------------------------------

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
  ): boolean
  getSessionPermissionModeState(sessionId: string): PermissionModeState | null

  respondToExtensionInteraction(
    sessionId: string,
    requestId: string,
    response: ExtensionInteractionResponseV1,
  ): boolean

  /**
   * 调用 pi 扩展注册的命令（extension_command_invoke）。
   * 仅 Pi 后端实现（PiAgent.sendExtensionCommandInvoke）；其他后端返回 false。
   * args 为 JSON 字符串。返回 false 时调用方应回退到原生路径。
   */
  invokeExtensionCommand(
    sessionId: string,
    commandId: string,
    args?: string,
    ownerExtensionId?: string,
  ): Promise<import('@mortise/core/types').ExtensionCommandResult>

  /** Reload extensions in all active Pi runtimes; streaming runtimes defer until settled. */
  reloadExtensions(): Promise<{ reloadedSessionCount: number; deferredSessionCount: number }>

  /** Settings-initiated reload with an explicit confirmation boundary for running sessions. */
  requestExtensionReload(interruptRunning: boolean): Promise<import('@mortise/shared/config').PiExtensionReloadResult>

  /**
   * 查询当前会话已注册的 Pi 扩展 slash commands。
   * 非 Pi 后端或会话未就绪时返回空数组。
   */
  listExtensionCommands(sessionId: string): Promise<import('@mortise/shared/agent').PiExtensionCommand[]>

  /**
   * List child sessions in pi's session tree spawned from the given session.
   * Returns child session infos filtered by header.spawnedFrom === piSessionId.
   * Empty array when the backend doesn't support listChildSessions.
   */
  listChildSessions(
    sessionId: string,
  ): Promise<import('@mortise/shared/agent').PiChildSessionInfo[]>

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  setPendingPlanExecution(sessionId: string, target: string | { planPath?: string; artifactId?: string }, draftInputSnapshot?: string): Promise<void>
  markPendingPlanExecutionDispatched(sessionId: string): Promise<void>
  clearPendingPlanExecution(sessionId: string): Promise<void>
  getPendingPlanExecution(sessionId: string): { planPath?: string; artifactId?: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null
  markCompactionComplete(sessionId: string): Promise<void>

  /**
   * Send the plan-approval "I approve this plan, please execute it" message
   * to the session as if the user had clicked "Accept plan" in the desktop UI.
   * If the session is in Explore (safe) mode, also switches it to allow-all
   * so the plan can actually run without per-tool prompts.
   *
   * Used by the messaging gateway so Telegram/WhatsApp accept buttons produce
   * the same server-side effect as the desktop accept button.
   */
  acceptPlan(sessionId: string, planPath?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------------

  /**
   * Export a session as a portable bundle.
   * Flushes pending writes, serializes session data + files.
   * Session must be stopped before export.
   */
  exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null>

  /**
   * Import a session bundle into a target workspace.
   * Creates session directory, writes JSONL + files, registers in memory.
   * Returns the new session ID and any compatibility warnings.
   */
  importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }>

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  getSessionPath(sessionId: string): string | null
  refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }>
  refreshBadge(): void
  getUnreadSummary(): UnreadSummary

  // ---------------------------------------------------------------------------
  // Workspace
  // ---------------------------------------------------------------------------

  getWorkspaces(): Workspace[]
  /** Return client-safe workspace list (no rootPath) for remote clients. */
  getWorkspacesInfo(): WorkspaceInfo[]
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void
  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void

  // ---------------------------------------------------------------------------
  // Server-level observability
  // ---------------------------------------------------------------------------

  /** Count of sessions with active backend processes. Pass workspaceId to scope. */
  getActiveSessionCount(workspaceId?: string): number
  /** Automation summary for a workspace (count of configured automations + scheduler state). */
  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean }
  getAutomationHost(workspaceId: string): import('@mortise/shared/automations').AutomationWorkspaceHostV3 | null
  /** Active sessions across all workspaces (sessions with running backend processes). */
  getActiveSessionsInfo(): ActiveSessionInfo[]

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  reinitializeAuth(provider?: string): Promise<void>
  /**
   * Push runtime updates (e.g. capability toggles) to every active session
   * that uses the given connection. Backstopped by the lazy refresh path in
   * `getOrCreateAgent`.
   */
  refreshProviderRuntime(provider: string): Promise<void>
  /** Recreate Pi hosts/runtimes after models.json or auth.json changes. */
  reloadProviderRuntime(provider?: string): Promise<void>
  /** Inspect one loaded Pi runtime for the global agent settings surface. */
  getAgentRuntimeProfile(): Promise<import('@mortise/shared/config').AgentRuntimeProfile | null>

  /**
   * Install a callback invoked from the canonical V3 automation prompt
   * delivery after a session is created when the matcher declared
   * `telegramTopic`. Wired by the
   * messaging-gateway bootstrap so the SessionManager doesn't need to import
   * the messaging package (avoids a circular package-level import).
   *
   * The callback should be best-effort: failures must not block the session.
   */
  setAutomationBinder?(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string }) => Promise<void>,
  ): void
}

/**
 * Server-owned first-turn transaction for an ordinary new conversation.
 * The provisional runtime/session identity is never returned. Resolution means
 * Pi persisted the first assistant message and SessionManager published the
 * fully durable Session; rejection guarantees no stored Session remains.
 */
export interface CreateAndSendFirstTurnInput {
  workspaceId: string
  message: string
  createOptions?: CreateSessionOptions
  attachments?: FileAttachment[]
  storedAttachments?: StoredAttachment[]
  attachmentStagingId?: string
  sendOptions?: SendMessageOptions
  callerClientId?: string
  signal?: AbortSignal
  /**
   * Host-only publication hook. Runs after Session metadata and projection are
   * durable but before the Session becomes visible or emits public events.
   * A failure aborts and rolls back the provisional Session.
   */
  beforePublish?: (session: Session) => Promise<void> | void
}
