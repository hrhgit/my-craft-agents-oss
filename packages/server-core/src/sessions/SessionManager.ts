import type { EventSink, RpcServer } from '@mortise/server-core/transport'
import { CLIENT_BROWSER_INVOKE } from '@mortise/server-core/transport'
import type { ISessionManager, IBrowserPaneManager, CreateAndSendFirstTurnInput } from '@mortise/server-core/handlers'
import { RemoteBrowserPaneManager } from './RemoteBrowserPaneManager'
import { validateFilePath, getWorkspaceAllowedDirs } from '@mortise/server-core/handlers'
import { createExtensionEventForwarder } from '../handlers/pi-extension-bridge'
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '@mortise/server-core/runtime'
import { basename, dirname, isAbsolute, join, relative } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir, rename, rm, readdir, rmdir, lstat, open } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { unregisterSessionScopedToolCallbacks, mergeSessionScopedToolCallbacks, AbortReason, type BrowserPaneFns, generateConversationSummary } from '@mortise/shared/agent'
import { requirePrimaryLocalWorkspaceRoot, type AgentEvent, type PlanArtifactV1, type PlanModeStateV1 } from '@mortise/core/types'
import {
  resolveSessionProvider,
  createBackendFromProvider,
  resolveBackendContext,
  createBackendFromResolvedContext,
  type AgentBackend,
  type CoreBackendConfig,
  type BackendHostRuntimeContext,
  type HostRuntimeErrorProjection,
  type ChildTaskBackgroundOperation,
  type ChildAttemptRegistrationRequest,
  type ChildAttemptRegistration,
  type ChildTaskSettledOperation,
  type PostInitResult,
  buildPiProjectionSnapshotFromHostProjection,
  PiProjectionBuilder,
  invalidateBackendRuntimes,
  BackendExtensionRuntimeRegistry,
  backendTypeFromProcess,
  type BackendExtensionWorkspaceSnapshot,
  type ExtensionBridgeEvent,
} from '@mortise/shared/agent/backend'
type ChildToolExecutionCompleted = Parameters<NonNullable<CoreBackendConfig['onChildToolExecutionCompleted']>>[0]
import { alternateMidStreamBehavior, readPiGlobalProviders, readPiGlobalSettings, getDefaultThinkingLevel, getMidStreamBehavior, resetManagedAnthropicAuthEnvVars, getPersistedUiLanguage, resolveTitleLanguageName, resolveSubagentConfigs, type PiExtensionReloadActiveSession, type PiExtensionReloadResult } from '@mortise/shared/config'
import { AgentRunService, type AgentRunRecord } from '../agent-runs'
import { SessionShareTransferService } from '@mortise/server-core/services'
import { InitGate, WorkspaceLocationActivityRegistry, type WorkspaceTopologySessionCoordinator } from '@mortise/server-core/domain'
import { i18n } from '@mortise/shared/i18n'
import {
  getWorkspaces,
  getWorkspaceByNameOrId,
  loadPreferences,
  MODEL_REGISTRY,
  type Workspace,
  type WorkspaceInfo,
} from '@mortise/shared/config'
import type { ActiveSessionInfo, SessionProcessingStatus } from '@mortise/core/types'
import { getDefaultWorkspaceTopologyStore, initializeWorkspace as initializeWorkspaceRegistration } from '@mortise/shared/workspaces'
import {
  // Session persistence functions
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
  createSession as createStoredSession,
  deleteSession as deleteStoredSession,
  updateSessionMetadata,
  setPendingPlanExecution as setStoredPendingPlanExecution,
  markCompactionComplete as markStoredCompactionComplete,
  markPendingPlanExecutionDispatched as markStoredPendingPlanExecutionDispatched,
  clearPendingPlanExecution as clearStoredPendingPlanExecution,
  getPendingPlanExecution as getStoredPendingPlanExecution,
  getSessionAttachmentsPath,
  getSessionPath as getSessionStoragePath,
  ensureSessionDir,
  getSessionFilePath,
  tryGetSessionFilePath,
  generateSessionId,
  sessionPersistenceQueue,
  getHeaderMetadataSignature,
  durableMessageOutbox,
  findPiSessionProjectionById,
  appendPiBranchMessagesViaSessionManager,
  appendStoredMessagesViaPiSessionManager,
  writeTreeSessionUiMetadataAsync,
  projectTreeSessionProjectionAsStoredSession,
  serializeSession,
  validateBundle,
  validateSessionId,
  type SessionBundle,
  type DispatchMode,
  type StoredSession,
  type StoredMessage,
  type SessionHeader,
  type MessageOutboxRecord,
  type MessageOutboxStore,
  pickMortiseSessionMetadata,
  parsePlanCustomMessage,
  RemovedSessionFieldError,
} from '@mortise/shared/sessions'
import type { JsonValue } from '@mortise/shared/storage'
import { ConfigWatcher, type ConfigWatcherCallbacks } from '@mortise/shared/config'
import { getLastApiError } from '@mortise/shared/interceptor'
import { restoreFiles } from '@mortise/shared/utils/bundle-files'
import { CodedError, type Session, type SessionEvent, type FileAttachment, type SendMessageOptions, type UnreadSummary, type PiProjectionEventV1, type PiProjectionSnapshotV1, type ExtensionInteractionResponseV1, type ExtensionFileStateV1, validateExtensionFileStateV1, RPC_CHANNELS, SESSION_SETTLEMENT_ERROR_CODE, generateMessageId, type SessionPublicationFailure } from '@mortise/shared/protocol'
import {
  ConversationProjector,
  resolvePiBranchTarget,
  type PiBranchProjection,
  type PiBranchProjectionEntry,
  type ProjectionApplyResult,
} from '../projection'
import {
  CapabilityRouter,
  ELECTRON_CAPABILITY_POLICY_V1,
  createCapabilityAuthorizationPolicy,
  createSessionRuntimeCapabilityProviders,
  type CapabilityProvider,
} from '../capabilities'
import { createDefaultOperationCoordinator, type OperationCoordinator } from '../operations'
import { messageToStored, storedToMessage, type Message, type StoredAttachment, type ToolDisplayMeta } from '@mortise/core/types'
import { ATTACHMENT_MESSAGE_TOTAL_LIMIT_BYTES, ATTACHMENT_SINGLE_FILE_LIMIT_BYTES, atomicWriteFile, formatToolInputPaths, perf, encodeIconToDataUrlAsync, getEmojiIcon, resolveToolIcon, readFileAttachment, selectSpreadMessages, normalizePath, writeRuntimeLog } from '@mortise/shared/utils'
import { loadAllSkills } from '@mortise/shared/skills'
import { getToolIconsDir } from '@mortise/shared/config'
import { getDefaultSummarizationModel } from '@mortise/shared/config/models'
import { getCredentialManager } from '@mortise/shared/credentials'
import { type ThinkingLevel, DEFAULT_THINKING_LEVEL, isValidThinkingLevel, normalizeThinkingLevel } from '@mortise/shared/agent/thinking-levels'
import {
  AutomationWorkspaceHostV3,
  type AutomationActionExecutionResultV1,
  type AutomationExecutionContextV1,
  type PromptActionV3,
  type SessionReferenceV1,
} from '@mortise/shared/automations'
import { createAutomationWebhookExecutor } from '../services/automation-webhook-executor'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature, filterAttachmentsForModelInput, normalizeProviderRuntimeBaseUrl } from './runtime-config'
import { SessionCoordinator } from './SessionCoordinator'
import {
  FileToolSideEffectLedger,
  type ToolSideEffectRecorder,
} from '../session-control'
import { ExtensionFrontendStateCache, type ExtensionFrontendStateEvent } from './extension-frontend-state-cache'

// Import from server-core domain utilities
import { sanitizeForTitle, shouldActivateBrowserOverlay, normalizeBrowserToolName, rollbackFailedBranchCreation, releaseBrowserOwnershipOnForcedStop } from '@mortise/server-core/domain'
import { resizeImageForAPI, resizeIconBuffer } from '@mortise/server-core/services'
export { sanitizeForTitle }

function serializeOutboxAttachments(attachments: FileAttachment[] | undefined): JsonValue | undefined {
  if (!attachments?.length) return undefined
  return attachments.map(({ type, path, name, mimeType, size, storedPath, markdownPath }) => ({
    type, path, name, mimeType, size,
    ...(storedPath ? { storedPath } : {}),
    ...(markdownPath ? { markdownPath } : {}),
  })) as unknown as JsonValue
}

function serializeStoredAttachmentRefs(attachments: StoredAttachment[] | undefined): JsonValue | undefined {
  if (!attachments?.length) return undefined
  return attachments.map(({ id, type, name, mimeType, size, originalSize, storedPath, thumbnailPath, markdownPath, wasResized }) => ({
    id,
    type,
    name,
    mimeType,
    size,
    ...(originalSize !== undefined ? { originalSize } : {}),
    ...(storedPath ? { storedPath } : {}),
    ...(thumbnailPath ? { thumbnailPath } : {}),
    ...(markdownPath ? { markdownPath } : {}),
    ...(wasResized !== undefined ? { wasResized } : {}),
  })) as unknown as JsonValue
}

function serializeSessionRecoveryOptions(session: {
  name?: string
  thinkingLevel?: string
  model?: string
  provider?: string
}): JsonValue {
  return {
    ...(session.name ? { name: session.name } : {}),
    ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.provider ? { provider: session.provider } : {}),
  }
}

// Module-level platform ref — set once during init via setSessionPlatform()
let _platform: PlatformServices | null = null

export class InvalidSessionThinkingLevelError extends TypeError {
  readonly code = 'SESSION_THINKING_LEVEL_INVALID' as const
  readonly thinkingLevel: unknown

  constructor(thinkingLevel: unknown) {
    super(`Session thinkingLevel is not supported: ${String(thinkingLevel)}`)
    this.name = 'InvalidSessionThinkingLevelError'
    this.thinkingLevel = thinkingLevel
  }
}

export type AuthProviderResolution =
  | { status: 'unconfigured' }
  | { status: 'missing'; slug: string }
  | { status: 'configured'; slug: string }

export function resolveAuthProviderForReinitialization(
  explicitProvider: string | undefined,
  defaultProvider: string | undefined,
  providers: Readonly<Record<string, unknown>>,
): AuthProviderResolution {
  const slug = explicitProvider || defaultProvider
  if (!slug) return { status: 'unconfigured' }
  if (providers[slug] === undefined) return { status: 'missing', slug }
  return { status: 'configured', slug }
}

export class SessionProjectionPersistenceError extends Error {
  readonly code = 'SESSION_PROJECTION_PERSISTENCE_FAILED' as const
  readonly retryable = true
  readonly sessionId: string
  readonly cause: unknown
  readonly data: { sessionId: string; retryable: true }

  constructor(sessionId: string, cause: unknown) {
    super(`Failed to persist Session projection ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SessionProjectionPersistenceError'
    this.sessionId = sessionId
    this.cause = cause
    this.data = { sessionId, retryable: true }
  }
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unavailable on some platforms and filesystems.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export function selectPiProjectionReplaceStrategy(
  platform: NodeJS.Platform,
  targetIsRegularFile: boolean,
): 'direct' | 'displace-existing' {
  return platform === 'win32' && targetIsRegularFile ? 'displace-existing' : 'direct'
}

async function writePiProjectionSnapshotAtomically(target: string, contents: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const displaced = `${target}.${process.pid}.${randomUUID()}.replaced`
  let preserveDisplaced = false

  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    const existing = await lstat(target).catch(() => undefined)
    const replaceByDisplacement = async (): Promise<void> => {
      // Bun/Node rename-over-existing can fail with EPERM on Windows. Keep the
      // previous durable file recoverable until the prepared replacement has
      // been committed under the canonical name.
      await rename(target, displaced)
      preserveDisplaced = true
      try {
        await rename(temporary, target)
      } catch (commitError) {
        try {
          await rename(displaced, target)
          preserveDisplaced = false
        } catch (restoreError) {
          throw new AggregateError(
            [commitError, restoreError],
            `Failed to commit or restore atomic file replacement for ${target}`,
          )
        }
        throw commitError
      }
      preserveDisplaced = false
      await rm(displaced, { force: true }).catch(() => undefined)
    }

    if (selectPiProjectionReplaceStrategy(process.platform, existing?.isFile() === true) === 'displace-existing') {
      // On Windows the rename-over-existing promise can remain pending rather
      // than rejecting, so choose the recoverable replacement path up front.
      await replaceByDisplacement()
    } else {
      try {
        await rename(temporary, target)
      } catch (replaceError) {
        const existingAfterFailure = await lstat(target).catch(() => undefined)
        if (!existingAfterFailure?.isFile()) throw replaceError
        await replaceByDisplacement()
      }
    }

    await syncDirectoryBestEffort(dirname(target))
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
    if (!preserveDisplaced) await rm(displaced, { force: true }).catch(() => undefined)
  }
}

export class SessionPublicationDurabilityError extends Error {
  readonly code = 'SESSION_PUBLICATION_DURABILITY_FAILED' as const
  readonly retryable: boolean
  readonly terminal = true
  readonly outcome = 'unpublished' as const
  readonly sessionId: string
  readonly stage: 'runtime' | 'metadata' | 'projection'
  readonly cause: unknown
  readonly data: {
    sessionId: string
    stage: 'runtime' | 'metadata' | 'projection'
    retryable: boolean
    terminal: true
    outcome: 'unpublished'
  }

  constructor(sessionId: string, stage: 'runtime' | 'metadata' | 'projection', cause: unknown) {
    super(`Failed to publish Session ${sessionId} during ${stage} durability: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SessionPublicationDurabilityError'
    this.retryable = (cause as { retryable?: unknown } | null)?.retryable !== false
    this.sessionId = sessionId
    this.stage = stage
    this.cause = cause
    this.data = {
      sessionId,
      stage,
      retryable: this.retryable,
      terminal: true,
      outcome: 'unpublished',
    }
  }
}

export class SessionSendDurabilityError extends Error {
  readonly code = 'SESSION_PERSISTENCE_FAILED' as const
  readonly retryable = true
  readonly terminal = true
  readonly outcome = 'unaccepted' as const
  readonly sessionId: string
  readonly messageId: string
  readonly cause: unknown
  readonly data: {
    sessionId: string
    messageId: string
    stage: 'canonical-user-message'
    retryable: true
    terminal: true
    outcome: 'unaccepted'
  }

  constructor(sessionId: string, messageId: string, cause: unknown) {
    super(`Pi did not durably persist user message ${messageId} for Session ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SessionSendDurabilityError'
    this.sessionId = sessionId
    this.messageId = messageId
    this.cause = cause
    this.data = {
      sessionId,
      messageId,
      stage: 'canonical-user-message',
      retryable: true,
      terminal: true,
      outcome: 'unaccepted',
    }
  }
}

export class SessionSettlementDurabilityError extends Error {
  readonly code = 'SESSION_SETTLEMENT_FAILED' as const
  readonly retryable = true
  readonly terminal = false
  readonly outcome = 'accepted-pending-settlement' as const
  readonly sessionId: string
  readonly cause: unknown
  readonly data: {
    sessionId: string
    stage: 'turn-settlement'
    retryable: true
    terminal: false
    outcome: 'accepted-pending-settlement'
  }

  constructor(sessionId: string, cause: unknown) {
    super(`Session ${sessionId} accepted the user message but could not durably settle the turn: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SessionSettlementDurabilityError'
    this.sessionId = sessionId
    this.cause = cause
    this.data = {
      sessionId,
      stage: 'turn-settlement',
      retryable: true,
      terminal: false,
      outcome: 'accepted-pending-settlement',
    }
  }
}

// Scoped logger — upgraded from console fallback when setSessionPlatform() is called.
// Named `sessionLog` so all ~30 existing call sites remain unchanged.
let sessionLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'session')

export function setSessionPlatform(platform: PlatformServices): void {
  _platform = platform
  sessionLog = createScopedLogger(platform.logger, 'session')
}

interface SessionRuntimeHooks {
  updateBadgeCount: (count: number) => void
  captureException: (error: unknown, context?: { errorSource?: string; sessionId?: string }) => void
  onSessionStarted: () => void
  onSessionStopped: () => void
}

const defaultSessionRuntimeHooks: SessionRuntimeHooks = {
  updateBadgeCount: () => {},
  onSessionStarted: () => {},
  onSessionStopped: () => {},
  captureException: (error, context) => {
    const err = error instanceof Error ? error : new Error(String(error))
    if (_platform?.captureError) {
      _platform.captureError(err)
      return
    }
    sessionLog.error('[runtime-hooks] captureException fallback:', {
      errorSource: context?.errorSource,
      sessionId: context?.sessionId,
      message: err.message,
      stack: err.stack,
    })
  },
}

let sessionRuntimeHooks: SessionRuntimeHooks = defaultSessionRuntimeHooks

export function setSessionRuntimeHooks(hooks: Partial<SessionRuntimeHooks>): void {
  sessionRuntimeHooks = {
    ...sessionRuntimeHooks,
    ...hooks,
  }
}

function buildBackendHostRuntimeContext(): BackendHostRuntimeContext {
  if (!_platform) throw new Error('setSessionPlatform() must be called before session creation')
  return {
    appRootPath: _platform.appRootPath,
    resourcesPath: _platform.resourcesPath,
    resourcesBasePath: _platform.resourcesBasePath,
    isPackaged: _platform.isPackaged,
    immutableRuntime: _platform.immutableRuntime,
  }
}

/**
 * Feature flags for agent behavior
 */
export const AGENT_FLAGS = {
  /** Default modes enabled for new sessions */
  defaultModesEnabled: true,
} as const

const MAX_ANNOTATIONS_PER_MESSAGE = 200
const MAX_ANNOTATION_JSON_BYTES = 32 * 1024

// Window during which fs.watch metadata-revert events from our own atomic write
// are ignored, so the watcher does not roll back the in-memory mutation we
// just persisted. See onSessionMetadataChange.
const METADATA_WRITE_GUARD_MS = 5000

/**
 * Text sent to the session when a plan is approved outside the desktop UI
 * (for example, from a messaging integration). The agent reads this text,
 * so it intentionally remains stable and is not localized.
 */

// validateSpawnAttachmentPath removed — use shared validateFilePath from @mortise/server-core/handlers

const CLAUDE_TURN_ANCHORS_VERSION = 1
const CLAUDE_TURN_ANCHORS_FILE = 'claude-turn-anchors.json'

interface ClaudeTurnAnchorRecord {
  sdkSessionId: string
  sdkMessageUuid: string
}

interface ClaudeTurnAnchorsIndex {
  version: number
  anchors: Record<string, ClaudeTurnAnchorRecord>
}

function getClaudeTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', CLAUDE_TURN_ANCHORS_FILE)
}

function isClaudeMessageUuid(turnId: string): boolean {
  return /^msg_[A-Za-z0-9]+$/.test(turnId)
}

async function loadClaudeTurnAnchors(sessionPath: string): Promise<ClaudeTurnAnchorsIndex> {
  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClaudeTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, ClaudeTurnAnchorRecord> = {}

    for (const [messageId, value] of Object.entries(anchors)) {
      if (!messageId || typeof messageId !== 'string') continue
      if (!value || typeof value !== 'object') continue
      const sdkSessionId = (value as { sdkSessionId?: unknown }).sdkSessionId
      const sdkMessageUuid = (value as { sdkMessageUuid?: unknown }).sdkMessageUuid
      if (typeof sdkSessionId === 'string' && sdkSessionId && typeof sdkMessageUuid === 'string' && sdkMessageUuid) {
        normalized[messageId] = { sdkSessionId, sdkMessageUuid }
      }
    }

    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
}

async function getClaudeTurnAnchor(sessionPath: string, messageId: string): Promise<ClaudeTurnAnchorRecord | undefined> {
  if (!messageId) return undefined
  const index = await loadClaudeTurnAnchors(sessionPath)
  return index.anchors[messageId]
}

async function saveClaudeTurnAnchor(
  sessionPath: string,
  messageId: string,
  sdkSessionId: string,
  sdkMessageUuid: string,
): Promise<void> {
  if (!messageId || !sdkSessionId || !sdkMessageUuid) return

  const index = await loadClaudeTurnAnchors(sessionPath)
  const previous = index.anchors[messageId]
  if (previous && previous.sdkSessionId === sdkSessionId && previous.sdkMessageUuid === sdkMessageUuid) return

  index.anchors[messageId] = {
    sdkSessionId,
    sdkMessageUuid,
  }

  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
}

/**
 * Resolve tool display metadata for a tool call.
 * Returns metadata with base64-encoded icon for viewer compatibility.
 *
 * @param toolName - Tool name from the event (e.g., "Skill", "mcp__linear__list_issues")
 * @param toolInput - Tool input (used for Skill tool to get skill identifier)
 * @param workspaceRootPath - Path to workspace for loading skills
 */
const BROWSER_TOOL_ICON_FILENAME = 'chrome.svg'
let browserToolIconDataUrlCache: string | null | undefined

async function getBrowserToolIconDataUrl(): Promise<string | undefined> {
  // Cache miss sentinel: undefined means "not computed yet"
  if (browserToolIconDataUrlCache !== undefined) {
    return browserToolIconDataUrlCache ?? undefined
  }

  try {
    const iconCandidates = [
      join(getToolIconsDir(), BROWSER_TOOL_ICON_FILENAME),
      // Dev fallback (before sync to ~/.mortise/tool-icons)
      join(process.cwd(), 'apps', 'electron', 'resources', 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
      // Packaged fallback (app resources)
      join(process.resourcesPath, 'tool-icons', BROWSER_TOOL_ICON_FILENAME),
    ]

    for (const iconPath of iconCandidates) {
      if (!existsSync(iconPath)) continue
      const encoded = await encodeIconToDataUrlAsync(iconPath, { resize: resizeIconBuffer })
      if (encoded) {
        browserToolIconDataUrlCache = encoded
        return encoded
      }
    }

    browserToolIconDataUrlCache = null
  } catch {
    browserToolIconDataUrlCache = null
  }

  return browserToolIconDataUrlCache ?? undefined
}

const SESSION_TOOL_DISPLAY_NAMES: Record<string, string> = {
  subagent: 'Subagent',
  browser_tool: 'Browser',
  list_sessions: 'List Sessions',
  create_session: 'Create Session',
  read_session: 'Read Session',
  send_message_to_session: 'Send Message to Session',
  list_messaging_channels: 'List Messaging Channels',
  unbind_messaging_channel: 'Unbind Messaging Channel',
}

export async function resolveToolDisplayMeta(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  workspaceRootPath: string,
): Promise<ToolDisplayMeta | undefined> {
  const directSessionDisplayName = SESSION_TOOL_DISPLAY_NAMES[toolName]
  if (directSessionDisplayName) {
    return {
      displayName: directSessionDisplayName,
      iconDataUrl: toolName === 'browser_tool' ? await getBrowserToolIconDataUrl() : undefined,
      category: 'native' as const,
    }
  }

  // Check if it's an MCP tool (format: mcp__<serverSlug>__<toolName>)
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const serverSlug = parts[1]
      const toolSlug = parts.slice(2).join('__')

      // Only current Mortise documentation tools remain namespaced MCP tools.
      const internalMcpServers: Record<string, Record<string, string>> = {
        'mortise-docs': {
          'SearchMortise': 'Search Docs',
        },
      }

      const internalServer = internalMcpServers[serverSlug]
      if (internalServer) {
        const displayName = internalServer[toolSlug]
        if (displayName) {
          const normalizedBrowserTool = normalizeBrowserToolName(toolSlug)
          return {
            displayName,
            iconDataUrl: normalizedBrowserTool ? await getBrowserToolIconDataUrl() : undefined,
            category: 'native' as const,
          }
        }
      }

    }
    return undefined
  }

  // Check if it's the Skill tool
  if (toolName === 'Skill' && toolInput) {
    // Skill input has 'skill' param with format: "skillSlug" or "workspaceId:skillSlug"
    const skillParam = toolInput.skill as string | undefined
    if (skillParam) {
      // Extract skill slug (remove workspace prefix if present)
      const skillSlug = skillParam.includes(':') ? skillParam.split(':').pop() : skillParam
      if (skillSlug) {
        // Load skills and find the one being invoked
        try {
          const skills = loadAllSkills(workspaceRootPath)
          const skill = skills.find(s => s.slug === skillSlug)
          if (skill) {
            // Try file-based icon first, fall back to emoji icon from metadata
            const iconDataUrl = skill.iconPath
              ? await encodeIconToDataUrlAsync(skill.iconPath, { resize: resizeIconBuffer })
              : getEmojiIcon(skill.metadata.icon)
            return {
              displayName: skill.metadata.name,
              iconDataUrl,
              description: skill.metadata.description,
              category: 'skill' as const,
            }
          }
        } catch {
          // Skills loading failed, skip
        }
      }
    }
    return undefined
  }

  // CLI tool icon resolution for Bash commands
  // Parses the command string to detect known tools (git, npm, docker, etc.)
  // and resolves their brand icon from ~/.mortise/tool-icons/
  if (toolName === 'Bash' && toolInput?.command) {
    try {
      const toolIconsDir = getToolIconsDir()
      const match = resolveToolIcon(String(toolInput.command), toolIconsDir)
      if (match) {
        return {
          displayName: match.displayName,
          iconDataUrl: match.iconDataUrl,
          category: 'native' as const,
        }
      }
    } catch {
      // Icon resolution is best-effort — never crash the session for it
    }
  }

  // Native browser tool names (with Chrome icon)
  const normalizedBrowserToolName = normalizeBrowserToolName(toolName)
  if (normalizedBrowserToolName) {
    const browserDisplayName = normalizedBrowserToolName
      .split('_')
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' ')
      .replace(/^browser\s+/i, 'Browser ')

    return {
      displayName: browserDisplayName,
      iconDataUrl: await getBrowserToolIconDataUrl(),
      category: 'native' as const,
    }
  }

  // Native tool display names (no icons - UI handles these with built-in icons)
  // This ensures toolDisplayMeta is always populated for consistent display
  const nativeToolNames: Record<string, string> = {
    'Read': 'Read',
    'Write': 'Write',
    'Edit': 'Edit',
    'Bash': 'Terminal',
    'Grep': 'Search',
    'Glob': 'Find Files',
    'Task': 'Agent',
    'Agent': 'Agent',
    'WebFetch': 'Fetch URL',
    'WebSearch': 'Web Search',
    'TodoWrite': 'Update Todos',
    'NotebookEdit': 'Edit Notebook',
    'KillShell': 'Kill Shell',
    'TaskOutput': 'Task Output',
  }

  const nativeDisplayName = nativeToolNames[toolName]
  if (nativeDisplayName) {
    return {
      displayName: nativeDisplayName,
      category: 'native' as const,
    }
  }

  // Unknown tool - no display metadata (will fall back to tool name in UI)
  return undefined
}

/** Agent type - unified backend interface for all providers */
type AgentInstance = AgentBackend

export type SessionBackendFactory = (
  args: {
    context: Parameters<typeof createBackendFromResolvedContext>[0]['context']
    coreConfig: CoreBackendConfig
    provisional: boolean
    createDefaultBackend: () => AgentBackend
  },
) => AgentBackend

export type WorkspaceRuntimeBackendFactory = (args: {
  workspace: Workspace
  context: Parameters<typeof createBackendFromResolvedContext>[0]['context']
  coreConfig: CoreBackendConfig
}) => AgentBackend

export interface SessionManagerOptions {
  resolveWorkspaceByNameOrId?: (nameOrId: string) => Workspace | null
  createSessionBackend?: SessionBackendFactory
  toolSideEffectRecorderFactory?: (workspaceId: string, sessionId: string) => ToolSideEffectRecorder
  extensionRuntime?: BackendExtensionRuntimeRegistry
  /** Durable outbox boundary; injectable for isolated recovery/durability tests. */
  messageOutbox?: MessageOutboxStore
  /** Optional Workspace warmup backend used by focused runtime tests. */
  createWorkspaceRuntimeBackend?: WorkspaceRuntimeBackendFactory
  /** Durable receipts for Extension-initiated Session operations. */
  operationCoordinator?: OperationCoordinator
}

interface WorkspaceRuntimeWarmup {
  workspaceId: string
  status: 'warming' | 'ready' | 'degraded'
  startedAt: number
  completedAt?: number
  error?: string
  agent?: AgentBackend
  ready: Promise<void>
}

export type WorkspaceSessionInterruptionTarget =
  | { workspaceId: string; scope: 'workspace' }
  | { workspaceId: string; scope: 'location'; locationId: string }

export interface WorkspaceSessionInterruptionResult {
  selectedSessionIds: string[]
  interruptedSessionIds: string[]
}

interface SubagentDeliveryRecord extends ChildTaskBackgroundOperation {
  state: 'running' | 'ready' | 'delivered'
  status?: ChildTaskSettledOperation['status']
  output?: string
  modified?: string
  messageId: string
  updatedAt: string
}

interface SubagentDeliveryLedger {
  schemaVersion: 2
  operations: Record<string, SubagentDeliveryRecord>
}

interface LegacySubagentDeliveryRecord {
  operationId?: string
  attemptId?: string
  runtimeId?: string
  childSessionId?: string
  sessionPath?: string
  state?: SubagentDeliveryRecord['state']
  status?: SubagentDeliveryRecord['status']
  output?: string
  modified?: string
  messageId?: string
  updatedAt?: string
}

interface ChildAttemptRecord {
  attemptId: string
  runtimeId: string
  childSessionId: string
  sessionPath: string
  state: 'open' | 'closed'
  operationIds: Set<string>
  pendingTools: Map<string, { toolName: string; result?: { isError: boolean } }>
  receiptChain: Promise<void>
  normalSettlement?: Promise<void>
  revocationSettlement?: Promise<void>
  operationSettlements: Map<string, Promise<void>>
}

interface ManagedSession {
  id: string
  workspace: Workspace
  agent: AgentInstance | null  // Lazy-loaded - null until first message
  messages: Message[]
  isProcessing: boolean
  deleting?: boolean
  /** Set when user requests stop - allows event loop to drain before clearing isProcessing */
  stopRequested?: boolean
  lastMessageAt: number
  streamingText: string
  // Incremented each time a new message starts processing.
  // Used to detect if a follow-up message has superseded the current one (stale-request guard).
  processingGeneration: number
  // NOTE: Parent-child tracking state (pendingTools, parentToolStack, toolToParentMap,
  // pendingTextParent) has been removed. MortiseAgent now provides parentToolUseId
  // directly on all events using the SDK's authoritative parent_tool_use_id field.
  // See: packages/shared/src/agent/tool-matching.ts
  // Session name (user-defined or AI-generated)
  name?: string
  /** Opaque Extension-owned state captured before the Session existed. */
  extensionBootstrap?: import('@mortise/shared/protocol').ExtensionSessionBootstrapV1
  /** Session-authoritative state published by the Pi Plan Mode extension. */
  planModeState?: PlanModeStateV1
  /** Durable Accept & Compact handoff state. */
  pendingPlanExecution?: SessionHeader['pendingPlanExecution']
  /** Legacy test/compatibility marker; plan-mode now owns this lifecycle. */
  pendingCompactionCompletion?: boolean
  // SDK session ID for conversation continuity
  sdkSessionId?: string
  // Token usage for display
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
  }
  // Read/unread tracking - ID of last message user has read
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  // SDK cwd for session storage - set once at creation, never changes.
  // Ensures SDK can find session transcripts across provider resume/fork flows.
  sdkCwd?: string
  // Shared viewer URL (if shared via viewer)
  sharedUrl?: string
  // Shared session ID in viewer (for revoke)
  sharedId?: string
  // Model to use for this session (overrides global config if set)
  model?: string
  // Pi provider slug selected for this session.
  provider?: string
  // Thinking level for this session.
  thinkingLevel?: ThinkingLevel
  // System prompt preset for mini agents ('default' | 'mini')
  systemPromptPreset?: 'default' | 'mini' | string
  // Role/type of the last message (for badge display without loading messages)
  lastMessageRole?: 'user' | 'assistant' | 'tool' | 'error'
  // ID of the last final (non-intermediate) assistant message - pre-computed for unread detection
  lastFinalMessageId?: string
  // Turn baseline: last final assistant message ID at turn start (runtime-only, not persisted)
  turnStartFinalMessageId?: string
  // External session metadata updates seen while processing (applied after turn stop)
  pendingExternalMetadata?: SessionHeader
  // Provider/auth changed while this turn was active; rebuild before the next turn.
  pendingProviderRuntimeRestart?: boolean
  // Guard: suppress external metadata revert after programmatic writes.
  // fs.watch fires during atomic write (unlink+rename) and can read stale data, reverting in-memory state.
  _metadataWriteGuardUntil?: number
  // Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration)
  // Used for shimmer effect on session title
  isAsyncOperationOngoing?: boolean
  // Preview of first user message (for sidebar display fallback)
  preview?: string
  // When the session was first created (ms timestamp from JSONL header)
  createdAt?: number
  // Total message count (pre-computed in JSONL header for fast list loading)
  messageCount?: number
  // Message queue for handling new messages while processing
  // When a message arrives during processing, we interrupt and queue
  messageQueue: Array<{
    message: string
    attachments?: FileAttachment[]
    storedAttachments?: StoredAttachment[]
    options?: SendMessageOptions
    messageId?: string  // Pre-generated ID for matching with UI
    optimisticMessageId?: string  // Frontend's ID for reliable event matching
    onAck?: (messageId: string) => void
    onAccepted?: (messageId: string) => void
    onReject?: (error: unknown) => void
  }>
  agentEventChain: Promise<void>
  pendingToolSideEffects: Map<string, { attemptId: string; toolName: string }>
  pendingInputAcks: Map<string, { resolve: (messageId: string) => void; reject: (error: unknown) => void }>
  // Workspace location captured when the current unit of work started. It must
  // not be re-derived after a topology mutation.
  activeWorkspaceLocationId?: string
  // A topology interruption fences every automatic recovery path until a new
  // explicit request starts work against the updated Workspace topology.
  workspaceTopologyAutoResumeBlocked?: boolean
  workspaceTopologyGeneration: number
  workspaceTopologyInterruption?: Promise<void>
  workspaceTopologyInterruptionFailure?: unknown
  // A terminal backend event has arrived, but host metadata/projection is not
  // durable yet. New sends must retry this boundary before entering a new turn.
  pendingSettlementReason?: 'complete' | 'interrupted' | 'error' | 'timeout'
  settlementPromise?: Promise<void>
  // Map of shellId -> command for killing background shells
  backgroundShellCommands: Map<string, string>
  // Map of taskId -> output info for background task results
  backgroundTaskOutputs: Map<string, { outputFile: string; summary: string; status: string; completedAt: number }>
  // Whether messages have been loaded from disk (for lazy loading)
  messagesLoaded: boolean
  // Auth retry tracking (for mid-session token expiry)
  // Store last sent message/attachments to enable retry after token refresh
  lastSentMessage?: string
  lastSentAttachments?: FileAttachment[]
  lastSentStoredAttachments?: StoredAttachment[]
  lastSentOptions?: SendMessageOptions
  lastSentMessageId?: string
  // Flag to prevent infinite retry loops (reset at start of each sendMessage)
  authRetryAttempted?: boolean
  // Flag indicating auth retry is in progress (to prevent complete handler from interfering)
  authRetryInProgress?: boolean
  authRetryFailureCode?: string
  authRetryTopologyGeneration?: number
  // Whether this session is hidden from session list (e.g., mini edit sessions)
  hidden?: boolean
  // Ordinary new conversations remain internal until Pi atomically persists
  // the first user message. Runtime-only; never serialized.
  publicationState?: 'provisional' | 'publishing' | 'abandoning'
  pendingPublicationFailure?: SessionPublicationFailure
  publicationPromise?: Promise<boolean>
  beforePublish?: (session: Session) => Promise<void> | void
  abandonPromise?: Promise<void>
  pendingTitleUserMessage?: string
  branchFromMessageId?: string
  // Branch context strategy:
  // - sdk-fork: provider-level fork from parent SDK session
  // - seeded-fresh-session: fresh backend session seeded with transcript up to branch cutoff
  branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session'
  // Parent session's SDK session ID (used only when branchContextStrategy === 'sdk-fork')
  branchFromSdkSessionId?: string
  // Parent session's storage path (used only when branchContextStrategy === 'sdk-fork')
  branchFromSessionPath?: string
  // Parent Pi session JSONL file (used only for shared Pi-native storage)
  branchFromPiSessionFile?: string
  // Parent session's sdkCwd — needed so the fork subprocess uses the correct
  // ~/.claude/projects/{cwd-hash}/ directory to find the parent's session file.
  branchFromSdkCwd?: string
  // SDK assistant message UUID at the branch point — used as resumeSessionAt
  // to trim the forked conversation at the branch point.
  branchFromSdkTurnId?: string
  // One-shot flag for seeded branch mode - set true after first turn seed injection.
  branchSeedApplied?: boolean
  // One-shot hidden summary injected on the first turn after a remote transfer.
  transferredSessionSummary?: string
  // Whether the transferred-session summary has already been injected.
  transferredSessionSummaryApplied?: boolean
  // Metadata for sessions created by automations
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number }
  // Promise that resolves when the agent instance is ready (for title gen to await)
  agentReady?: Promise<void>
  agentReadyResolve?: () => void
  // Per-session env overrides for SDK subprocess (e.g., ANTHROPIC_BASE_URL).
  // Stored on managed session so it persists across agent recreations (auth-retry, etc.)
  envOverrides?: Record<string, string>
  // Runtime-affecting backend config signature captured when the live agent was created/refreshed.
  backendRuntimeSignature?: string
  /**
   * Signature over fields that cannot be propagated via `update_runtime_config`
   * (see `runtime-config.ts:buildRestartRequiredSignature`). When this drifts,
   * the agent must be disposed + recreated rather than refreshed in place.
   */
  backendRestartSignature?: string
  // Whether the previous turn was interrupted (for context injection on next message).
  // Ephemeral — not persisted to disk. Cleared after one-shot injection.
  wasInterrupted?: boolean
}

/**
 * Create a ManagedSession from any session-like source (SessionHeader, StoredSession).
 * Spreads all matching fields from the source so new persistent fields automatically propagate.
 * Runtime-only fields get sensible defaults.
 */
export function createManagedSession(
  source: { mortiseId: string } & Partial<ManagedSession>,
  workspace: Workspace,
  overrides?: Partial<ManagedSession>,
): ManagedSession {
  const s = source as Record<string, unknown>
  const sourceFields = Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined)
  ) as Partial<ManagedSession>

  const managed = {
    // Spread all session-like fields from source (name, model, etc.)
    // This ensures new persistent fields automatically flow through without manual copying.
    ...sourceFields,
    // Map mortiseId → id (ManagedSession 内部用 id 字段，值等于 SessionHeader.mortiseId)
    id: source.mortiseId,
    // Runtime-only defaults (not persisted)
    workspace,
    agent: null,
    messages: [],
    isProcessing: false,
    lastMessageAt: (s.lastMessageAt ?? s.lastUsedAt ?? Date.now()) as number,
    streamingText: '',
    processingGeneration: 0,
    workspaceTopologyGeneration: 0,
    messageQueue: [],
    agentEventChain: Promise.resolve(),
    pendingToolSideEffects: new Map(),
    pendingInputAcks: new Map(),
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    messagesLoaded: false,
    // Caller overrides (thinkingLevel, messagesLoaded, etc.)
    ...overrides,
  } as ManagedSession

  if (managed.thinkingLevel !== undefined && !isValidThinkingLevel(managed.thinkingLevel)) {
    throw new InvalidSessionThinkingLevelError(managed.thinkingLevel)
  }

  if (managed.branchFromMessageId && !managed.branchContextStrategy) {
    managed.branchContextStrategy = managed.branchFromSdkSessionId
      ? 'sdk-fork'
      : 'seeded-fresh-session'
  }

  if (managed.branchContextStrategy === 'seeded-fresh-session' && managed.branchSeedApplied === undefined) {
    // If an SDK session ID already exists, first turn has already happened.
    managed.branchSeedApplied = !!managed.sdkSessionId
  }

  managed.sdkCwd = managed.sdkCwd ?? requirePrimaryLocalWorkspaceRoot(workspace)

  return managed
}

export function resolveSessionThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  if (value === undefined) return fallback
  if (!isValidThinkingLevel(value)) throw new InvalidSessionThinkingLevelError(value)
  return value
}

export type SubmittedPlanMessage = Message & { planPath: string }

export function createSubmittedPlanMessage(
  sessionId: string,
  planPath: string,
  content: string,
  timestamp: number,
): SubmittedPlanMessage {
  const artifactId = `plan-${randomUUID()}`
  const artifact: PlanArtifactV1 = {
    schemaVersion: 1,
    kind: 'plan',
    artifactId,
    revision: 1,
    state: 'ready',
    review: { status: 'not_requested' },
    checklist: [],
    createdAt: timestamp,
    finalizedAt: timestamp,
  }
  return {
    id: `plan-message-${sessionId}-${randomUUID()}`,
    role: 'assistant',
    content,
    timestamp,
    artifact,
    planPath,
  }
}

function remapBranchedMessageIdentities(
  messages: StoredMessage[],
  importedIdMap: ReadonlyMap<string, string>,
  branchSessionId: string,
): StoredMessage[] {
  return messages.map((message) => {
    const messageId = importedIdMap.get(message.id) ?? message.id
    const annotations = message.annotations?.map(annotation => ({
      ...annotation,
      target: {
        ...annotation.target,
        source: { sessionId: branchSessionId, messageId },
      },
    }))
    return {
      ...message,
      id: messageId,
      ...(annotations ? { annotations } : {}),
    }
  })
}

export function getPiProjectionRecoveryMessages(
  snapshot: PiProjectionSnapshotV1 | undefined,
): Array<{ type: 'user' | 'assistant'; content: string }> {
  return getPiProjectionConversationMessages(snapshot).slice(-6)
}

function getPiProjectionConversationMessages(
  snapshot: PiProjectionSnapshotV1 | undefined,
): Array<{ type: 'user' | 'assistant'; content: string }> {
  if (!snapshot) return []
  return snapshot.entities
    .filter(entity => entity.entityType === 'content_block'
      && (entity.kind === 'user_text' || entity.kind === 'assistant_text'))
    .sort((a, b) => a.createdSeq - b.createdSeq)
    .flatMap(entity => {
      const payload = entity.payload as { text?: unknown; isIntermediate?: unknown }
      if (entity.kind === 'assistant_text' && payload.isIntermediate === true) return []
      return typeof payload.text === 'string' && payload.text
        ? [{
            type: entity.kind === 'user_text' ? 'user' as const : 'assistant' as const,
            content: payload.text,
          }]
        : []
    })
}

function syncPiProjectionComputedMetadata(
  managed: ManagedSession,
  snapshot: PiProjectionSnapshotV1,
): void {
  const messageKeys = new Set<string>()
  let preview: { seq: number; text: string } | undefined
  let lastRole: { seq: number; role: ManagedSession['lastMessageRole'] } | undefined
  let lastFinal: { seq: number; messageId: string } | undefined

  const updateLastRole = (seq: number, role: NonNullable<ManagedSession['lastMessageRole']>): void => {
    if (!lastRole || seq >= lastRole.seq) lastRole = { seq, role }
  }

  for (const entity of snapshot.entities) {
    const payload = entity.payload && typeof entity.payload === 'object' && !Array.isArray(entity.payload)
      ? entity.payload as Record<string, unknown>
      : undefined

    if (entity.entityType === 'content_block' && payload?.role === 'user') {
      const messageId = typeof payload.messageId === 'string'
        ? payload.messageId
        : typeof payload.clientMutationId === 'string'
          ? payload.clientMutationId
          : entity.entityId
      messageKeys.add(`user:${messageId}`)
      updateLastRole(entity.lastSeq, 'user')
      if (typeof payload.text === 'string' && payload.text.trim()
        && (!preview || entity.createdSeq < preview.seq)) {
        preview = {
          seq: entity.createdSeq,
          text: payload.text.replace(/\s+/g, ' ').trim().slice(0, 150),
        }
      }
      continue
    }

    if (entity.kind === 'user_attachment' && payload) {
      const messageId = typeof payload.ownerMessageId === 'string'
        ? payload.ownerMessageId
        : typeof payload.clientMutationId === 'string'
          ? payload.clientMutationId
          : entity.entityId
      messageKeys.add(`user:${messageId}`)
      updateLastRole(entity.lastSeq, 'user')
      continue
    }

    if (entity.entityType === 'content_block' && payload?.role === 'assistant'
      && payload.contentKind !== 'thinking') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : entity.entityId
      messageKeys.add(`assistant:${messageId}`)
      updateLastRole(entity.lastSeq, 'assistant')
      if (entity.kind === 'assistant_text' && payload.streaming !== true
        && payload.isIntermediate !== true && (!lastFinal || entity.lastSeq >= lastFinal.seq)) {
        lastFinal = { seq: entity.lastSeq, messageId }
      }
      continue
    }

    if (entity.entityType === 'tool_run') {
      messageKeys.add(`tool:${entity.entityId}`)
      updateLastRole(entity.lastSeq, 'tool')
      continue
    }

    if (entity.kind === 'runtime_error') {
      messageKeys.add(`error:${entity.entityId}`)
      updateLastRole(entity.lastSeq, 'error')
    }
  }

  managed.messageCount = messageKeys.size
  managed.preview = preview?.text
  managed.lastMessageRole = lastRole?.role
  managed.lastFinalMessageId = lastFinal?.messageId
}

/**
 * Resolve supportsBranching for a managed session.
 * Prefers the live agent instance; falls back to true for all backends.
 */
function resolveSupportsBranching(managed: ManagedSession): boolean {
  // If agent is live, use its instance property (authoritative)
  if (managed.agent) {
    return managed.agent.supportsBranching
  }

  return true // default: branching enabled for all backends
}

function needsPiProjectionWallClockBackfill(snapshot: PiProjectionSnapshotV1): boolean {
  return snapshot.entities.some((entity) => {
    if (entity.kind !== 'user_text' || entity.createdAt !== undefined) return false
    if (!entity.payload || typeof entity.payload !== 'object') return true
    const payload = entity.payload as Record<string, unknown>
    if (payload.queueStatus === 'queued') return false
    return typeof payload.timestamp !== 'number'
  })
}

function isPiProjectionSnapshotProcessing(snapshot: PiProjectionSnapshotV1): boolean {
  const lifecycle = snapshot.entities
    .filter(entity => entity.kind === 'agent_start' || entity.kind === 'agent_end'
      || entity.kind === 'agent_settled'
      || entity.kind === 'turn_start' || entity.kind === 'turn_end'
      || entity.kind === 'compaction_start' || entity.kind === 'compaction_end'
      || entity.kind === 'runtime_error')
    .sort((a, b) => b.lastSeq - a.lastSeq)[0]
  const payload = lifecycle?.payload && typeof lifecycle.payload === 'object'
    ? lifecycle.payload as Record<string, unknown>
    : undefined
  return lifecycle?.kind === 'agent_start'
    || lifecycle?.kind === 'turn_start'
    || lifecycle?.kind === 'compaction_start'
    || (lifecycle?.kind === 'agent_end' && payload?.settlementPending === true)
}

/**
 * A crashed runtime has no trustworthy process-death timestamp. Use the last
 * fully persisted message as the conservative end of its measurable work.
 */
function getLastCompletePiMessageTime(snapshot: PiProjectionSnapshotV1): number | undefined {
  const messages = new Map<string, { lastSeq: number; lastAt?: number; complete: boolean }>()

  for (const entity of snapshot.entities) {
    if (entity.entityType !== 'content_block'
      || !entity.payload || typeof entity.payload !== 'object' || Array.isArray(entity.payload)) continue
    const payload = entity.payload as Record<string, unknown>
    if (payload.role !== 'user' && payload.role !== 'assistant') continue

    const messageId = typeof payload.messageId === 'string' && payload.messageId
      ? payload.messageId
      : entity.entityId
    const queueStatus = payload.queueStatus
    const blockComplete = payload.role === 'user'
      ? payload.streaming !== true
        && queueStatus !== 'queued' && queueStatus !== 'cancelled' && queueStatus !== 'interrupted'
      : payload.streaming === false
        && (typeof payload.stopReason === 'string'
          || typeof payload.isIntermediate === 'boolean'
          || typeof payload.isFinal === 'boolean')
    const timestamps = [entity.createdAt, entity.updatedAt, payload.timestamp]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    const blockAt = timestamps.length > 0 ? Math.max(...timestamps) : undefined
    const current = messages.get(messageId)
    messages.set(messageId, {
      lastSeq: Math.max(current?.lastSeq ?? 0, entity.lastSeq),
      lastAt: blockAt === undefined
        ? current?.lastAt
        : Math.max(current?.lastAt ?? 0, blockAt),
      complete: (current?.complete ?? true) && blockComplete,
    })
  }

  return [...messages.values()]
    .filter(message => message.complete && message.lastAt !== undefined)
    .sort((a, b) => b.lastSeq - a.lastSeq)[0]?.lastAt
}

function getLastPersistedPiProjectionTime(snapshot: PiProjectionSnapshotV1): number | undefined {
  const timestamps = snapshot.entities.flatMap(entity => [entity.createdAt, entity.updatedAt])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined
}

/** Return true only for an explicitly configured Pi provider key. */
function hasConfiguredPiProvider(provider?: string): boolean {
  return !!provider && Object.hasOwn(readPiGlobalProviders(), provider)
}

const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  contextTokens: 0, costUsd: 0,
}

/**
 * Convert a ManagedSession to a renderer-side Session object.
 * Uses pickMortiseSessionMetadata() for Mortise-owned persistent fields so new
 * fields propagate automatically.
 */
function managedToSession(
  m: ManagedSession,
  overrides?: Partial<Session>,
  options: { includeSessionFolderPath?: boolean } = {},
): Session {
  const includeSessionFolderPath = options.includeSessionFolderPath ?? true
  return {
    ...pickMortiseSessionMetadata(m),
    // Mortise metadata uses mortiseId, while ManagedSession runtime state uses id.
    // Renderer Session DTO still exposes id, so map it explicitly here.
    id: m.id,
    // Pre-computed fields from header (not in MORTISE_SESSION_METADATA_FIELDS)
    preview: m.preview,
    lastMessageRole: m.lastMessageRole,
    tokenUsage: m.tokenUsage,
    messageCount: m.messageCount,
    lastFinalMessageId: m.lastFinalMessageId,
    // Runtime-only fields
    workspaceId: m.workspace.id,
    workspaceName: m.workspace.name,
    messages: [],
    isProcessing: m.isProcessing,
    ...(m.deleting ? { deletionState: 'deleting' as const } : {}),
    ...(m.pendingPublicationFailure
      ? { pendingFailure: m.pendingPublicationFailure }
      : m.pendingSettlementReason || m.settlementPromise
      ? {
          pendingFailure: {
            code: SESSION_SETTLEMENT_ERROR_CODE,
            message: `Session ${m.id} has an accepted turn pending host settlement`,
            data: {
              sessionId: m.id,
              stage: 'turn-settlement' as const,
              retryable: true as const,
              terminal: false as const,
              outcome: 'accepted-pending-settlement' as const,
            },
          },
        }
      : {}),
    ...(includeSessionFolderPath
      ? { sessionFolderPath: getSessionStoragePath(m.workspace.id, m.id) }
      : {}),
    supportsBranching: resolveSupportsBranching(m),
    ...overrides,
  } as Session
}

export class SessionManager implements ISessionManager, WorkspaceTopologySessionCoordinator {
  /** Canonical resolver; tests may inject an isolated workspace without mutating global config. */
  private readonly resolveWorkspaceByNameOrId: (nameOrId: string) => Workspace | null
  /** Session backend construction boundary; production uses the canonical shared factory. */
  private readonly createSessionBackend: SessionBackendFactory
  private readonly toolSideEffectRecorderFactory: (workspaceId: string, sessionId: string) => ToolSideEffectRecorder
  private readonly toolSideEffectWrites = new Map<string, Promise<void>>()
  private sessions: Map<string, ManagedSession> = new Map()
  private readonly extensionFrontendStates = new ExtensionFrontendStateCache()
  private extensionReloadPromise: Promise<PiExtensionReloadResult> | null = null
  private piProjectionBySession = new Map<string, ConversationProjector>()
  private piProjectionRetiredRuntimeIds = new Map<string, Set<string>>()
  private piProjectionWrites = new Map<string, Promise<void>>()
  private piProjectionPendingSnapshots = new Map<string, PiProjectionSnapshotV1>()
  private piProjectionWriteErrors = new Map<string, unknown>()
  private subagentDeliveryWrites = new Map<string, Promise<void>>()
  private subagentDeliveryTasks = new Map<string, Promise<void>>()
  private subagentLifecycleTasks = new Map<string, Set<Promise<void>>>()
  private readonly childAttempts = new Map<string, ChildAttemptRecord>()
  private readonly workspaceLocationActivities = new WorkspaceLocationActivityRegistry()
  private readonly extensionOperationCoordinator: OperationCoordinator
  private capabilityPrompt?: (request: import('@mortise/shared/protocol').CapabilityRequestV1) => Promise<boolean>
  private readonly capabilityRouter = new CapabilityRouter({
    requireDeclarations: true,
    authorize: createCapabilityAuthorizationPolicy({
      rules: ELECTRON_CAPABILITY_POLICY_V1,
      sessionExists: (sessionId) => this.sessions.has(sessionId),
      prompt: (request) => this.capabilityPrompt?.(request) ?? Promise.resolve(false),
    }),
    audit: (event) => {
      sessionLog.info('[HostCapability]', event)
      const logEvent = event.errorCode === 'CAPABILITY_TIMEOUT' ? 'timed_out' : event.phase
      writeRuntimeLog(logEvent === 'timed_out' ? 'warn' : 'info', {
        scope: 'capability',
        event: logEvent,
        correlation: {
          sessionId: event.sessionId,
          runtimeId: event.runtimeId,
          requestId: event.requestId,
        },
        data: {
          capability: event.capability,
          operation: event.operation,
          extensionId: event.extensionId,
          status: event.status,
          errorCode: event.errorCode,
          durationMs: event.durationMs,
          sequence: event.sequence,
        },
      })
    },
  })
  readonly shareTransferService = new SessionShareTransferService({
    logger: sessionLog,
    store: {
      resolve: (sessionId) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return null
        return {
          id: managed.id,
          workspaceId: managed.workspace.id,
          workspaceRootPath: requirePrimaryLocalWorkspaceRoot(managed.workspace),
          isProcessing: managed.isProcessing,
          sharedId: managed.sharedId,
          sharedUrl: managed.sharedUrl,
          name: managed.name,
        }
      },
      loadStoredSession: session => loadStoredSession(session.workspaceId, session.id),
      setAsyncOperation: (sessionId, ongoing) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return
        managed.isAsyncOperationOngoing = ongoing
        this.sendEvent({ type: 'async_operation', sessionId, isOngoing: ongoing }, managed.workspace.id)
      },
      updateShareMetadata: async (sessionId, metadata) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) throw new Error('Session not found')
        managed.sharedId = metadata.sharedId
        managed.sharedUrl = metadata.sharedUrl
        await updateSessionMetadata(managed.workspace.id, sessionId, metadata)
      },
      emitShareEvent: (event, workspaceId) => this.sendEvent(event, workspaceId),
      persistAndFlush: async sessionId => {
        const managed = this.sessions.get(sessionId)
        if (!managed) throw new Error('Session not found')
        this.persistSession(managed)
        await sessionPersistenceQueue.flush(sessionId)
      },
      summarize: async sessionId => {
        const managed = this.sessions.get(sessionId)
        return managed ? this.generateRemoteTransferSummary(managed) : null
      },
      createImported: async (workspaceId, payload) => {
        const session = await this.createSession(workspaceId, { name: payload.name })
        const managed = this.sessions.get(session.id)
        if (!managed) throw new Error(`Transferred session ${session.id} was not created`)
        managed.transferredSessionSummary = payload.summary
        managed.transferredSessionSummaryApplied = false
        this.persistSession(managed)
        await sessionPersistenceQueue.flush(session.id)
        return { sessionId: session.id }
      },
    },
  })
  // Delta batching for performance - reduces IPC events from 50+/sec to ~20/sec
  // Config watchers for live updates - one per workspace
  private configWatchers: Map<string, ConfigWatcher> = new Map()
  private readonly extensionRuntime: BackendExtensionRuntimeRegistry
  private readonly messageOutbox: MessageOutboxStore
  private readonly createWorkspaceRuntimeBackend: WorkspaceRuntimeBackendFactory
  private readonly workspaceRuntimeWarmups = new Map<string, WorkspaceRuntimeWarmup>()
  // Canonical V3 host runtime - one scheduler/store/ledger owner per workspace.
  private automationHosts: Map<string, AutomationWorkspaceHostV3> = new Map()
  private automationHostInitializationErrors = new Map<string, string>()
  // Promise deduplication for lazy-loading messages (prevents race conditions)
  private messageLoadingPromises: Map<string, Promise<void>> = new Map()
  /**
   * Track which session the user is actively viewing (per workspace).
   * Map of workspaceId -> sessionId. Used to determine if a session should be
   * marked as unread when assistant completes - if user is viewing it, don't mark unread.
   */
  private activeViewingSession: Map<string, string> = new Map()
  /** Coordinates startup initialization waiters from IPC handlers. */
  private initGate = new InitGate()
  // O(1) index: taskId → sessionId for background task output lookup (avoids O(n) session scan)
  private taskOutputIndex: Map<string, string> = new Map()
  /**
   * Per-session in-flight runtime-refresh promise. Ensures `updateRuntimeConfig`
   * (or a dispose) cannot overlap with another refresh OR with a send-path
   * `getOrCreateAgent` on the same session. Without this serialization, a
   * `SAVE`-triggered refresh and a `sendMessage`-triggered refresh can both
   * see `agent.isProcessing()=false`, both fire `updateRuntimeConfig`, and the
   * subprocess can race the resulting `chat` against the still-pending update.
   */
  private agentRefreshLocks: Map<string, Promise<void>> = new Map()
  /** Coalesce the global Pi watcher callbacks installed once per workspace. */
  private providerRuntimeReloadTimer?: ReturnType<typeof setTimeout>
  /** Monotonic clock to ensure strictly increasing message timestamps */
  private lastTimestamp = 0

  /**
   * Optional binder installed by the messaging-gateway bootstrap. When set,
   * `executeNewAutomationSession` calls it after creating a session whose matcher
   * declared `telegramTopic`, so the new session is bound to a Telegram forum
   * topic in the workspace's paired supergroup. Best-effort — failures must
   * not block the session.
   */
  private automationBinder?: (input: {
    workspaceId: string
    sessionId: string
    topicName: string
  }) => Promise<void>
  private readonly sessionCoordinator: SessionCoordinator

  constructor(options: SessionManagerOptions = {}) {
    this.resolveWorkspaceByNameOrId = options.resolveWorkspaceByNameOrId ?? getWorkspaceByNameOrId
    this.createSessionBackend = options.createSessionBackend ?? (args => args.createDefaultBackend())
    this.extensionRuntime = options.extensionRuntime ?? new BackendExtensionRuntimeRegistry({
      backendType: backendTypeFromProcess(),
    })
    this.messageOutbox = options.messageOutbox ?? durableMessageOutbox
    this.createWorkspaceRuntimeBackend = options.createWorkspaceRuntimeBackend
      ?? ((args) => createBackendFromResolvedContext({
        context: args.context,
        coreConfig: args.coreConfig,
        hostRuntime: buildBackendHostRuntimeContext(),
      }))
    this.toolSideEffectRecorderFactory = options.toolSideEffectRecorderFactory
      ?? ((workspaceId, sessionId) => new FileToolSideEffectLedger(workspaceId, sessionId))
    this.extensionOperationCoordinator = options.operationCoordinator ?? createDefaultOperationCoordinator()
    this.sessionCoordinator = new SessionCoordinator(this, {
      resolveAttachments: async (workspaceId, attachments) => {
        const builtAttachments: FileAttachment[] = []
        for (const attachmentInput of attachments) {
          const safePath = await validateFilePath(attachmentInput.path, getWorkspaceAllowedDirs(workspaceId))
          const attachment = readFileAttachment(safePath)
          if (!attachment) continue
          if (attachmentInput.name) attachment.name = attachmentInput.name
          builtAttachments.push(attachment)
        }
        return builtAttachments.length > 0 ? builtAttachments : undefined
      },
    })
    for (const provider of createSessionRuntimeCapabilityProviders({
      getSession: sessionId => this.getSession(sessionId),
      listSessions: workspaceId => this.getSessions(workspaceId),
      getSessionCwd: sessionId => {
        const managed = this.sessions.get(sessionId)
        return managed ? requirePrimaryLocalWorkspaceRoot(managed.workspace) : undefined
      },
      submitMessage: (sessionId, message, operationId, delivery) => (
        this.submitExtensionSessionMessage(sessionId, message, operationId, delivery)
      ),
      compactSession: async (sessionId, operationId, instructions) => {
        const command = instructions ? `/compact ${instructions}` : '/compact'
        await this.sendMessage(sessionId, command, undefined, undefined, { operationId })
      },
      interruptSession: sessionId => this.cancelProcessing(sessionId),
      updateSessionModel: (sessionId, workspaceId, model, provider) => (
        this.updateSessionModel(sessionId, workspaceId, model, provider)
      ),
      updateSessionThinkingLevel: (sessionId, level) => this.setSessionThinkingLevel(sessionId, level),
      createAndSubmit: async (workspaceId, message, operationId, options) => {
        const result = await this.createAndSendFirstTurn({
          workspaceId,
          message,
          createOptions: options.name ? { name: options.name } : undefined,
          sendOptions: { operationId },
          signal: options.signal,
        })
        return result.session.id
      },
      runChildTask: async input => {
        const managed = this.sessions.get(input.parentSessionId)
        if (!managed || managed.deleting) throw new Error('Parent Session is unavailable')
        const agent = managed.agent
        if (!agent?.spawnChildSession) throw new Error('Child task execution is unavailable for this Session')
        const parentSessionId = agent.getSessionId()
        if (!parentSessionId) throw new Error('Parent Pi Session identity is unavailable')
        return agent.spawnChildSession(parentSessionId, {
          prompt: input.prompt,
          connection: managed.provider,
          model: input.model ?? managed.model,
          thinkingLevel: input.thinkingLevel,
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          background: false,
        })
      },
    }, this.extensionOperationCoordinator)) {
      this.capabilityRouter.register(provider)
    }
  }

  /**
   * Centralized setter for session processing state.
   * Automatically notifies the power manager on transitions (true→false, false→true)
   * so callers don't need to remember to call onSessionStarted/onSessionStopped.
   */
  private setProcessing(managed: ManagedSession, processing: boolean): void {
    const was = managed.isProcessing
    managed.isProcessing = processing
    if (!was && processing) {
      this.workspaceLocationActivities.begin({
        workspaceId: managed.workspace.id,
        locationId: managed.activeWorkspaceLocationId ?? managed.workspace.primaryLocationId,
        kind: 'session',
        activityId: managed.id,
      })
      sessionRuntimeHooks.onSessionStarted()
    } else if (was && !processing) {
      this.workspaceLocationActivities.end('session', managed.id)
      sessionRuntimeHooks.onSessionStopped()
    }
    if (was !== processing) {
      this.emitUnreadSummaryChanged()
    }
  }

  private async recordToolSideEffect(
    managed: ManagedSession,
    input: {
      attemptId: string
      toolCallId: string
      toolName: string
      status: 'started' | 'completed' | 'outcome-unknown'
      isError?: boolean
    },
  ): Promise<void> {
    const previous = this.toolSideEffectWrites.get(managed.id) ?? Promise.resolve()
    const write = previous.then(() => this.toolSideEffectRecorderFactory(managed.workspace.id, managed.id).record({
      sessionId: managed.id,
      ...input,
    }))
    this.toolSideEffectWrites.set(managed.id, write)
    try {
      await write
    } finally {
      if (this.toolSideEffectWrites.get(managed.id) === write) this.toolSideEffectWrites.delete(managed.id)
    }
  }

  private async settleUnknownToolSideEffects(managed: ManagedSession): Promise<void> {
    const pending = [...managed.pendingToolSideEffects.entries()]
    for (const [toolCallId, tool] of pending) {
      await this.recordToolSideEffect(managed, {
        attemptId: tool.attemptId,
        toolCallId,
        toolName: tool.toolName,
        status: 'outcome-unknown',
      })
      managed.pendingToolSideEffects.delete(toolCallId)
    }
  }

  /** Wait until initialize() has completed (sessions loaded from disk).
   *  Resolves immediately if already initialized. */
  waitForInit(): Promise<void> {
    return this.initGate.wait()
  }

  /**
   * Install the automation→topic binder. Wired by the messaging-gateway
   * bootstrap so SessionManager doesn't need to import the messaging
   * package (avoids a package-level circular dependency).
   */
  setAutomationBinder(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string }) => Promise<void>,
  ): void {
    this.automationBinder = fn
  }

  private browserPaneManager: IBrowserPaneManager | null = null
  private rpcServer: RpcServer | null = null
  private remoteBpms = new Map<string, RemoteBrowserPaneManager>()
  /** Pinned desktop client per session for `client:browser:invoke` routing. */
  private browserHostByCanvas = new Map<string, string>()
  private eventSink: EventSink | null = null

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  registerCapabilityProvider(provider: CapabilityProvider): () => void {
    return this.capabilityRouter.register(provider)
  }

  setCapabilityPrompt(prompt: (request: import('@mortise/shared/protocol').CapabilityRequestV1) => Promise<boolean>): void {
    this.capabilityPrompt = prompt
  }

  setBrowserPaneManager(bpm: IBrowserPaneManager): void {
    this.browserPaneManager = bpm
    bpm.setSessionPathResolver((sessionId) => this.getSessionPath(sessionId))
  }

  /**
   * Provide the WS RPC server so remote clients can host browser tools.
   *
   * When called, the SM activates the remote-bridge code path: per-session
   * `RemoteBrowserPaneManager` instances are created lazily by
   * {@link getBrowserPaneManagerForSession}, and the browser-host client is
   * resolved via {@link getBrowserHostClient} with capability-aware fallback.
   *
   * Local Electron callers do not need to call this — they already
   * call `setBrowserPaneManager(bpm)` with the in-process BPM, which takes
   * precedence over the remote bridge in {@link getBrowserPaneManagerForSession}.
   */
  setRpcServer(server: RpcServer): void {
    this.rpcServer = server
    sessionLog.info('[browser-pane] setRpcServer called — remote browser bridge is now available')
  }

  /**
   * Resolve the {@link IBrowserPaneManager} that owns the user's local browser
   * for a given session. Returns:
   *
   * 1. The locally-injected `browserPaneManager` when present (Electron client co-located
   *    with the agent), regardless of session.
   * 2. A session-bound {@link RemoteBrowserPaneManager} when `rpcServer` is set.
   *    Cached in `remoteBpms` so repeat lookups don't allocate.
   * 3. `null` when there's neither a local BPM nor an RPC server.
   */
  getBrowserPaneManagerForSession(sid: string): IBrowserPaneManager | null {
    if (this.browserPaneManager) return this.browserPaneManager
    if (!this.rpcServer) return null

    const cached = this.remoteBpms.get(sid)
    if (cached) return cached

    const session = this.sessions.get(sid)
    if (!session) return null

    const bridge = new RemoteBrowserPaneManager({
      sessionId: sid,
      workspaceId: session.workspace.id,
      rpcServer: this.rpcServer,
      getHostClient: () => this.getBrowserHostClient(sid),
    })
    this.remoteBpms.set(sid, bridge)
    return bridge
  }

  /**
   * Record which desktop client should host this session's browser. Called
   * with `ctx.clientId` from the `sessions.sendMessage` RPC handler so the
   * agent's browser_* tools route back to the client that posted the message.
   *
   * No-op when `callerClientId` is undefined — preserves the existing pin
   * (lets reconnected clients continue holding the host role).
   */
  private setLastMessageClientId(sid: string, callerClientId: string | undefined): void {
    if (!callerClientId) return
    this.browserHostByCanvas.set(sid, callerClientId)
  }

  /**
   * Called by the transport bootstrap on `onClientDisconnected`. Drops any
   * pins held by `clientId` so the next browser tool call re-resolves via
   * {@link findClientsWithCapability} instead of trying to ship to a dead client.
   */
  onClientDisconnected(clientId: string): void {
    for (const [sid, pinned] of this.browserHostByCanvas) {
      if (pinned === clientId) this.browserHostByCanvas.delete(sid)
    }
  }

  /**
   * Pinned client first, with fallback to any connected client for the workspace
   * that advertises `client:browser:invoke`. The fallback handles reconnect-with-
   * new-clientId so the agent isn't stuck waiting for another user message.
   */
  private getBrowserHostClient(sid: string): string | null {
    if (!this.rpcServer) return null
    const pinned = this.browserHostByCanvas.get(sid)
    if (pinned && this.rpcServer.hasClientCapability(pinned, CLIENT_BROWSER_INVOKE)) {
      return pinned
    }
    const session = this.sessions.get(sid)
    if (!session) return null
    const candidates = this.rpcServer.findClientsWithCapability(
      CLIENT_BROWSER_INVOKE,
      { workspaceId: session.workspace.id },
    )
    const fallback = candidates[0]
    if (!fallback) return null
    this.browserHostByCanvas.set(sid, fallback)
    return fallback
  }

  /** Returns a strictly increasing timestamp (ms). When Date.now() collides with
   *  the previous value, increments by 1 to preserve event ordering. */
  private monotonic(): number {
    const now = Date.now()
    this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1
    return this.lastTimestamp
  }

  /**
   * Apply external session header metadata to in-memory state and emit UI events.
   * Returns true if any in-memory metadata field changed.
   */
  private async applyExternalSessionMetadata(managed: ManagedSession, header: SessionHeader): Promise<boolean> {
    const sessionId = managed.id
    let changed = false

    // Name
    if (managed.name !== header.name) {
      managed.name = header.name
      this.sendEvent({ type: 'name_changed', sessionId, name: header.name }, managed.workspace.id)
      changed = true
    }

    if (changed) {
      sessionLog.info(`External metadata change detected for session ${sessionId}`)

      // Prevent stale pending writes from reverting externally-updated metadata.
      await sessionPersistenceQueue.cancel(sessionId)
      this.persistSession(managed)
    }

    return changed
  }

  /**
   * Set up ConfigWatcher for a workspace to broadcast live updates
   * for workspace configuration changes.
   * Called eagerly at boot and on client connect
   * (GET_WORKSPACE / SWITCH_WORKSPACE).
   * Idempotent — returns immediately if already watching.
   * workspaceId must be the global config ID (what the renderer knows).
   */
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    // Check if already watching this workspace
    if (this.configWatchers.has(workspaceRootPath)) {
      this.setupAutomationHost(workspaceRootPath, workspaceId)
      return
    }

    sessionLog.info(`Setting up ConfigWatcher for workspace: ${workspaceId} (${workspaceRootPath})`)

    const callbacks: ConfigWatcherCallbacks = {
      onProvidersChange: () => {
        sessionLog.info(`Pi providers changed in ${workspaceId}`)
        this.broadcastProvidersChanged()
        if (this.providerRuntimeReloadTimer) clearTimeout(this.providerRuntimeReloadTimer)
        this.providerRuntimeReloadTimer = setTimeout(() => {
          this.providerRuntimeReloadTimer = undefined
          void this.reloadProviderRuntime().catch(error => {
            sessionLog.error(`Failed to reload Pi runtimes after external config change: ${error instanceof Error ? error.message : error}`)
          })
        }, 150)
        this.providerRuntimeReloadTimer.unref?.()
      },
      onAppThemeChange: (theme) => {
        sessionLog.info(`App theme changed`)
        this.broadcastAppThemeChanged(theme)
      },
      onSkillsListChange: async (skills) => {
        sessionLog.info(`Skills list changed in ${workspaceRootPath} (${skills.length} skills)`)
        this.broadcastSkillsChanged(workspaceId, skills)
      },
      onSkillChange: async (slug, skill) => {
        sessionLog.info(`Skill '${slug}' changed:`, skill ? 'updated' : 'deleted')
        // Broadcast updated list to UI
        const { loadAllSkills } = await import('@mortise/shared/skills')
        const skills = loadAllSkills(workspaceRootPath)
        this.broadcastSkillsChanged(workspaceId, skills)
      },

      // Session metadata changes (edits to the Mortise metadata in Pi JSONL headers).
      // Detects changes from both internal writes (self) and external sources
      // (other instances, scripts, manual edits).
      onSessionMetadataChange: (sessionId, header) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return

        // Check if this is our own write echoing back via fs.watch().
        // Self-writes don't need in-memory sync (already up to date), but
        // still need to notify the automation system for event matching.
        const incomingSignature = getHeaderMetadataSignature(header)
        const lastWrittenSignature = sessionPersistenceQueue.getLastWrittenSignature(sessionId)
        const isSelfWrite = !!(lastWrittenSignature && incomingSignature === lastWrittenSignature)

        // For external writes: sync in-memory state + emit UI events.
        // Skip for self-writes to avoid feedback loops (especially on Windows
        // where fs.watch fires aggressively: unlink + rename = 2+ events).
        if (!isSelfWrite) {
          // Defer external metadata application when:
          // 1. Session is actively processing (agent running), OR
          // 2. Session was just written programmatically.
          const hasWriteGuard = managed._metadataWriteGuardUntil && Date.now() < managed._metadataWriteGuardUntil
          if (managed.isProcessing || hasWriteGuard) {
            managed.pendingExternalMetadata = header
            if (hasWriteGuard) {
              sessionLog.info(`Deferred external metadata update for session ${sessionId} (recent programmatic write)`)
            } else {
              sessionLog.info(`Deferred external metadata update for session ${sessionId} (processing active)`)
            }
          } else {
            void this.applyExternalSessionMetadata(managed, header).catch((error) => {
              sessionLog.error(`Failed to apply external metadata for session ${sessionId}:`, error)
            })
          }
        }

      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks, workspaceId)
    watcher.start()
    this.configWatchers.set(workspaceRootPath, watcher)

    this.setupAutomationHost(workspaceRootPath, workspaceId)
  }

  private setupAutomationHost(workspaceRootPath: string, workspaceId: string): void {
    if (!this.automationHosts.has(workspaceId)) {
      const executeWebhook = createAutomationWebhookExecutor({
        resolveSecret: {
          resolve: (reference, secretWorkspaceId) =>
            getCredentialManager().getAutomationSecret(secretWorkspaceId, reference.id),
        },
      })
      try {
        const host = new AutomationWorkspaceHostV3({
          workspaceRootPath,
          workspaceId,
          writerId: `${process.env.MORTISE_BUILD_ID ?? 'mortise'}:${process.pid}:${workspaceId}`,
          callbacks: {
            prompt: (action, context) => this.executeAutomationPromptAction(action, context),
            webhook: executeWebhook,
          },
          validateSession: (sessionId, expectedWorkspaceId) => this.sessions.get(sessionId)?.workspace.id === expectedWorkspaceId,
          getCurrentLocationId: () => this.sessions.values().find(session => session.workspace.id === workspaceId)?.workspace.primaryLocationId,
          onChanged: change => this.broadcastAutomationsChanged(workspaceId, change),
          onError: error => sessionLog.error(`[Automations] ${workspaceId}:`, error),
        })
        host.start()
        this.automationHosts.set(workspaceId, host)
        this.automationHostInitializationErrors.delete(workspaceId)
        sessionLog.info(`Initialized canonical Automations V3 host for workspace ${workspaceId}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.automationHostInitializationErrors.set(workspaceId, message)
        sessionLog.error(`[Automations] Failed to initialize workspace ${workspaceId}:`, error)
      }
    }
  }

  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void {
    const watcher = this.configWatchers.get(workspaceRootPath)
    watcher?.notifyFileChange(relativePath)
  }

  private broadcastAutomationsChanged(
    workspaceId: string,
    change: { revision: number; historyCursor: number },
  ): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting automations changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.automations.CHANGED, { to: 'workspace', workspaceId }, {
      schemaVersion: 1,
      workspaceId,
      ...change,
    })
  }

  private broadcastAppThemeChanged(theme: import('@mortise/shared/config').ThemeOverrides | null): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting app theme changed`)
    this.eventSink(RPC_CHANNELS.theme.APP_CHANGED, { to: 'all' }, theme)
  }

  private broadcastProvidersChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting providers changed')
    this.eventSink(RPC_CHANNELS.pi.GLOBAL_CHANGED, { to: 'all' })
  }

  private broadcastSkillsChanged(workspaceId: string, skills: import('@mortise/shared/skills').LoadedSkill[]): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting skills changed (${skills.length} skills)`)
    this.eventSink(RPC_CHANNELS.skills.CHANGED, { to: 'workspace', workspaceId }, workspaceId, skills)
  }

  /**
   * Reinitialize authentication environment variables.
   * Call this after onboarding or settings changes to pick up new credentials.
   *
   * SECURITY NOTE: These env vars are propagated to the agent subprocess.
   * Bun's automatic .env loading is disabled in the subprocess (--env-file=/dev/null)
   * to prevent a user's project .env from injecting ANTHROPIC_API_KEY and overriding
   * OAuth auth — Anthropic-compatible providers prioritize API key over OAuth token when both are set.
   * See: https://github.com/hrhgit/mortise-oss/issues/39
   */
  /**
   * Reinitialize authentication environment variables.
   *
   * Uses the selected Pi provider to reset managed authentication state.
   *
   * @param provider - Optional provider key to use (overrides default)
   */
  async reinitializeAuth(provider?: string): Promise<void> {
    try {
      const resolution = resolveAuthProviderForReinitialization(
        provider,
        readPiGlobalSettings().defaultProvider,
        readPiGlobalProviders(),
      )

      // Restore managed auth env vars to their baseline before applying this connection.
      resetManagedAnthropicAuthEnvVars()

      if (resolution.status === 'unconfigured') {
        sessionLog.info('No provider configured; managed authentication state cleared')
        return
      }

      if (resolution.status === 'missing') {
        sessionLog.error(`No provider found for key: ${resolution.slug}`)
        return
      }

      sessionLog.info(`Reinitializing auth for provider: ${resolution.slug}`)

      // Pi is the only runtime provider. Credential routing is handled natively
      // by PiAgent via ~/.mortise/agent/auth.json — no env-var injection needed here.
      // This method now only clears stale Claude-specific env vars (above).

    } catch (error) {
      sessionLog.error('Failed to reinitialize auth:', error)
      throw error
    }
  }

  async getPiProjectionSnapshot(sessionId: string): Promise<PiProjectionSnapshotV1 | null> {
    const current = this.piProjectionBySession.get(sessionId)
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    if (current) {
      const snapshot = current.createSnapshot()
      syncPiProjectionComputedMetadata(managed, snapshot)
      this.recoverQueuedProjectionMessages(managed, snapshot)
      return snapshot
    }

    try {
      const raw = await readFile(this.getPiProjectionSnapshotPath(managed), 'utf8')
      const snapshot = JSON.parse(raw) as PiProjectionSnapshotV1
      const projector = new ConversationProjector(sessionId, snapshot.runtimeId, snapshot)
      if (!needsPiProjectionWallClockBackfill(snapshot)) {
        return this.installRestoredPiProjection(managed, projector)
      }
      sessionLog.info(`Rebuilding legacy Pi projection timestamps for ${sessionId}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        sessionLog.warn(`Failed to load Pi projection snapshot for ${sessionId}: ${error instanceof Error ? error.message : error}`)
      }
    }

    try {
      const piProjection = await findPiSessionProjectionById(
        managed.workspace.id,
        requirePrimaryLocalWorkspaceRoot(managed.workspace),
        sessionId,
      )
      if (!piProjection) return null

      const snapshot = buildPiProjectionSnapshotFromHostProjection(
        sessionId,
        `history:${sessionId}`,
        piProjection,
      )
      const projector = new ConversationProjector(sessionId, snapshot.runtimeId, snapshot)
      const rebuilt = this.installRestoredPiProjection(managed, projector)
      this.persistPiProjection(managed, projector.createSnapshot())
      return rebuilt
    } catch (error) {
      sessionLog.warn(`Failed to rebuild Pi projection snapshot for ${sessionId}: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }

  async readPiProjection(
    workspaceId: string,
    workspaceRootPath: string,
    sessionId: string,
  ): Promise<{ leafId: string | null; entries: PiBranchProjectionEntry[] } | null> {
    return findPiSessionProjectionById(workspaceId, workspaceRootPath, sessionId)
  }

  private installRestoredPiProjection(
    managed: ManagedSession,
    projector: ConversationProjector,
  ): PiProjectionSnapshotV1 {
    this.piProjectionBySession.set(managed.id, projector)
    const restored = projector.createSnapshot()
    if (!managed.isProcessing && !managed.agent?.isProcessing()
      && isPiProjectionSnapshotProcessing(restored)) {
      const lastCompleteMessageAt = getLastCompletePiMessageTime(restored)
      const endedAt = lastCompleteMessageAt ?? getLastPersistedPiProjectionTime(restored)
      sessionLog.warn(
        `Recovered stale running Pi projection for ${managed.id}; closing at ${endedAt ?? 'unknown persisted time'}`
          + (lastCompleteMessageAt === undefined && endedAt !== undefined ? ' (no complete message)' : ''),
      )
      this.closeStalePiProjection(managed.id, endedAt ?? null, 'host_restart')
    }

    const reconciled = projector.createSnapshot()
    syncPiProjectionComputedMetadata(managed, reconciled)
    this.recoverQueuedProjectionMessages(managed, reconciled)
    return reconciled
  }

  private recoverQueuedProjectionMessages(
    managed: ManagedSession,
    snapshot: PiProjectionSnapshotV1,
  ): void {
    if (managed.workspaceTopologyAutoResumeBlocked) return

    const queued = snapshot.entities
      .filter(entity => entity.kind === 'user_text' && entity.payload && typeof entity.payload === 'object')
      .sort((a, b) => a.createdSeq - b.createdSeq)
      .flatMap((entity) => {
        const payload = entity.payload as Record<string, unknown>
        const messageId = typeof payload.messageId === 'string' ? payload.messageId : undefined
        const message = typeof payload.text === 'string' ? payload.text : undefined
        return payload.queueStatus === 'queued' && messageId && message
          ? [{ messageId, message }]
          : []
      })
    if (queued.length === 0) return
    managed.activeWorkspaceLocationId ??= managed.workspace.primaryLocationId

    if (!managed.messagesLoaded) this.hydrateMessagesForColdPersist(managed)
    let recovered = 0
    for (const item of queued) {
      if (managed.messageQueue.some(queuedMessage => queuedMessage.messageId === item.messageId)) continue
      const overlay = managed.messages.find(message => message.id === item.messageId)
      const storedAttachments = overlay?.attachments
      const attachments = storedAttachments?.flatMap((attachment) => {
        const restored = readFileAttachment(attachment.storedPath)
        if (!restored) return []
        restored.name = attachment.name
        return [restored]
      })
      managed.messageQueue.push({
        message: item.message,
        messageId: item.messageId,
        optimisticMessageId: item.messageId,
        attachments,
        storedAttachments,
        options: {
          optimisticMessageId: item.messageId,
          badges: overlay?.badges,
        },
      })
      recovered++
    }

    if (recovered > 0) {
      sessionLog.info(`Recovered ${recovered} queued Pi projection message(s) for session ${managed.id}`)
    }
  }

  /**
   * Project Host failures even when Pi agent construction failed before an
   * AgentBackend instance existed. The synthetic Host runtime is seeded from
   * the durable snapshot so a later Pi runtime continues the same sequence.
   */
  private async projectHostRuntimeError(
    managed: ManagedSession,
    error: HostRuntimeErrorProjection,
  ): Promise<void> {
    if (managed.agent?.projectRuntimeError) {
      managed.agent.projectRuntimeError(error)
      return
    }

    try {
      const snapshot = this.piProjectionBySession.get(managed.id)?.createSnapshot()
        ?? await this.getPiProjectionSnapshot(managed.id)
        ?? undefined
      const builder = new PiProjectionBuilder(
        managed.id,
        snapshot?.runtimeId ?? `host:${managed.id}`,
        snapshot,
      )
      for (const event of builder.acceptHostRuntimeError(error)) {
        this.applyPiProjectionEvent(event)
      }
    } catch (projectionError) {
      sessionLog.warn(
        `Failed to project Host runtime error for ${managed.id}: ${projectionError instanceof Error ? projectionError.message : projectionError}`,
      )
    }
  }

  /**
   * Commit one Pi-native projection event and publish only the contiguous
   * events accepted by the host projector. Replacement runtimes continue the
   * durable sequence and entity versions from the latest snapshot.
   */
  applyPiProjectionEvent(event: PiProjectionEventV1): ProjectionApplyResult {
    const managed = this.sessions.get(event.sessionId)
    if (!managed) throw new Error(`Session not found: ${event.sessionId}`)

    let projector = this.piProjectionBySession.get(event.sessionId)
    if (!projector) {
      if (event.seq !== 1) {
        throw new Error(`Initial Pi projection runtime must start at sequence 1: ${event.runtimeId}`)
      }
      projector = new ConversationProjector(event.sessionId, event.runtimeId)
      this.piProjectionBySession.set(event.sessionId, projector)
    } else if (projector.runtimeId !== event.runtimeId) {
      const retired = this.piProjectionRetiredRuntimeIds.get(event.sessionId) ?? new Set<string>()
      if (retired.has(event.runtimeId)) {
        throw new Error(`Rejected event from retired Pi projection runtime: ${event.runtimeId}`)
      }
      if (event.seq !== projector.getExpectedSeq()) {
        throw new Error(
          `Replacement Pi projection runtime must continue at sequence ${projector.getExpectedSeq()}: ${event.runtimeId}`,
        )
      }
      retired.add(projector.runtimeId)
      this.piProjectionRetiredRuntimeIds.set(event.sessionId, retired)
      projector = projector.continueWithRuntime(event.runtimeId)
      this.piProjectionBySession.set(event.sessionId, projector)
    }

    const result = projector.apply(event)
    let overlayChanged = false
    if (result.status === 'applied') {
      for (const applied of result.events) {
        if (applied.kind === 'user_text') {
          managed.lastMessageRole = 'user'
          const payload = applied.payload && typeof applied.payload === 'object'
            ? applied.payload as { messageId?: unknown; queueStatus?: unknown }
            : undefined
          if (typeof payload?.messageId === 'string') {
            const overlay = managed.messages.find(message => message.id === payload.messageId)
            if (overlay) {
              overlay.isPending = false
              overlay.isQueued = payload.queueStatus === 'queued'
              overlayChanged = true
            }
          }
        }
        if (applied.kind === 'assistant_text') {
          managed.lastMessageRole = 'assistant'
          const payload = applied.payload && typeof applied.payload === 'object'
            ? applied.payload as { messageId?: unknown; isIntermediate?: unknown }
            : undefined
          if (payload?.isIntermediate !== true
            && typeof payload?.messageId === 'string' && payload.messageId) {
            managed.lastFinalMessageId = payload.messageId
          }
        }
        if (applied.kind === 'runtime_error') managed.lastMessageRole = 'error'
        if (!managed.publicationState) {
          this.eventSink?.(
            RPC_CHANNELS.sessions.PI_PROJECTION_EVENT,
            { to: 'workspace', workspaceId: managed.workspace.id },
            applied,
          )
        }
      }
      syncPiProjectionComputedMetadata(managed, projector.createSnapshot())
    }
    if (result.status === 'applied' || result.status === 'stale') {
      this.persistPiProjection(managed, projector.createSnapshot())
    }
    if (overlayChanged) this.persistSession(managed)
    return result
  }

  private getPiProjectionSnapshotPath(managed: ManagedSession): string {
    return join(getSessionStoragePath(managed.workspace.id, managed.id), 'pi-projection-v1.json')
  }

  private persistPiProjection(managed: ManagedSession, snapshot: PiProjectionSnapshotV1): void {
    if (managed.publicationState) return
    this.enqueuePiProjectionPersist(managed, snapshot)
  }

  private enqueuePiProjectionPersist(managed: ManagedSession, snapshot: PiProjectionSnapshotV1): void {
    this.piProjectionPendingSnapshots.set(managed.id, snapshot)
    if (this.piProjectionWrites.has(managed.id)) return

    const writeOperation = (async () => {
      while (true) {
        const latest = this.piProjectionPendingSnapshots.get(managed.id)
        if (!latest) break
        this.piProjectionPendingSnapshots.delete(managed.id)
        try {
          const target = this.getPiProjectionSnapshotPath(managed)
          await mkdir(dirname(target), { recursive: true })
          await writePiProjectionSnapshotAtomically(target, JSON.stringify(latest))
        } catch (error) {
          const persistenceError = error instanceof SessionProjectionPersistenceError
            ? error
            : new SessionProjectionPersistenceError(managed.id, error)
          // Preserve the failed snapshot for a later retry unless a newer
          // snapshot is already pending.
          if (!this.piProjectionPendingSnapshots.has(managed.id)) {
            this.piProjectionPendingSnapshots.set(managed.id, latest)
          }
          throw persistenceError
        }
      }
    })()
    const write = writeOperation.then(() => {
      this.piProjectionWriteErrors.delete(managed.id)
    }, (error) => {
      this.piProjectionWriteErrors.set(managed.id, error)
      sessionLog.warn(`Failed to persist Pi projection snapshot for ${managed.id}: ${error instanceof Error ? error.message : error}`)
    }).finally(() => {
      if (this.piProjectionWrites.get(managed.id) === write) this.piProjectionWrites.delete(managed.id)
    })
    this.piProjectionWrites.set(managed.id, write)
  }

  private async flushPiProjectionWrites(managed: ManagedSession): Promise<void> {
    while (true) {
      const write = this.piProjectionWrites.get(managed.id)
      if (write) {
        await write
        const error = this.piProjectionWriteErrors.get(managed.id)
        if (error) throw error
        continue
      }
      const pending = this.piProjectionPendingSnapshots.get(managed.id)
      if (!pending) {
        const error = this.piProjectionWriteErrors.get(managed.id)
        if (error) throw error
        return
      }
      this.persistPiProjection(managed, pending)
    }
  }

  async initialize(): Promise<void> {
    try {
      // Fix provider if it points to a non-existent connection

      // Set up authentication environment variables (critical for SDK to work)
      await this.reinitializeAuth()

      // Eagerly activate the config watcher and canonical Automations V3 host so
      // the scheduler and event handlers start at boot — not lazily on first
      // client connect. This is critical for headless servers where no UI may
      // ever connect, yet scheduled/event-driven automations must still fire.
      const workspaces = getWorkspaces()
      // Global extensions are application-scoped. Project extensions and Pi
      // runtimes are opened only when a Workspace is actually attached by a
      // client, so unopened Workspaces do not execute project code at boot.
      if (typeof (this.extensionRuntime as Partial<BackendExtensionRuntimeRegistry>).openGlobal === 'function') {
        void this.extensionRuntime.openGlobal().catch(error => {
          sessionLog.warn(`Global Extension warmup degraded: ${error instanceof Error ? error.message : error}`)
        })
      }
      for (const workspace of workspaces) {
        try {
          const rootPath = requirePrimaryLocalWorkspaceRoot(workspace)
          this.setupConfigWatcher(rootPath, workspace.id)
        } catch (error) {
          sessionLog.warn(`Workspace infrastructure initialization degraded for ${workspace.id}: ${error instanceof Error ? error.message : error}`)
        }
      }

      // Load existing sessions from disk
      this.loadSessionsFromDisk()
      void this.recoverPendingMessageOutbox()

      // Signal that initialization is complete — IPC handlers waiting on initGate will proceed
      this.initGate.markReady()
    } catch (error) {
      this.initGate.markFailed(error)
      throw error
    }
  }

  // Load all existing sessions from disk into memory (metadata only - messages are lazy-loaded)
  private loadSessionsFromDisk(): void {
    try {
      const workspaces = getWorkspaces()
      let totalSessions = 0

      // Iterate over each workspace and load its sessions
      for (const workspace of workspaces) {
        const workspaceRootPath = requirePrimaryLocalWorkspaceRoot(workspace)
        const sessionMetadata = listStoredSessions(workspace.id, workspaceRootPath)

        for (const meta of sessionMetadata) {
          // Create managed session from metadata only (messages lazy-loaded on demand)
          // This dramatically reduces memory usage at startup - messages are loaded
          // when getSession() is called for a specific session
          const managed = createManagedSession(meta, workspace)

          // Clear persisted overrides that point to a provider removed outside this process.
          if (managed.provider) {
            if (!hasConfiguredPiProvider(managed.provider)) {
              sessionLog.warn(`Session ${meta.mortiseId} has orphaned provider "${managed.provider}", clearing`)
              managed.provider = undefined
              this.setMetadataWriteGuard(managed)
              this.persistSession(managed)
            }
          }

          this.sessions.set(meta.mortiseId, managed)

          totalSessions++
        }
      }

      sessionLog.info(`Loaded ${totalSessions} sessions from disk (metadata only)`)
    } catch (error) {
      sessionLog.error('Failed to load sessions from disk:', error)
    }
  }

  // Suppress fs.watch metadata-revert events for the window in which our own
  // atomic write completes. See onSessionMetadataChange.
  private setMetadataWriteGuard(managed: ManagedSession): void {
    managed._metadataWriteGuardUntil = Date.now() + METADATA_WRITE_GUARD_MS
  }

  /**
   * Persist a session to disk (async, with debouncing in the persistence queue).
   *
   * Cold-session path: if messages haven't been lazy-loaded yet, hydrate them
   * synchronously from the JSONL first — otherwise the snapshot we enqueue
   * would write `messages: []` over the real messages on disk. Hydration
   * deliberately does NOT touch persistent metadata fields (name, provider,
   * etc.) because the caller may have just
   * mutated them; the in-memory mutation must win over what's on disk.
   * `loadStoredSession` is synchronous (sync fs reads), so the entire path
   * stays sync — no microtask race window between the load and the enqueue.
   */
  private persistSession(managed: ManagedSession): void {
    if (managed.publicationState) return
    if (!managed.messagesLoaded) {
      this.hydrateMessagesForColdPersist(managed)
    }
    this.enqueuePersist(managed)
  }

  // Cold-persist hydration. Mirrors the messages/queue-recovery half of
  // loadMessagesFromDisk but skips the metadata field syncs. Sets
  // messagesLoaded=true so subsequent persistSession calls take the fast path.
  // Subsequent ensureMessagesLoaded calls also short-circuit, which is fine —
  // queue recovery has already run here.
  private hydrateMessagesForColdPersist(managed: ManagedSession): void {
    sessionLog.debug(`Cold-load triggered for persistSession on ${managed.id}`)
    const stored = loadStoredSession(managed.workspace.id, managed.id)
    if (stored) {
      managed.messages = (stored.messages || []).map(storedToMessage)
      managed.tokenUsage = stored.tokenUsage
      // Deferred-load fields (intentionally undefined after startup, see
      // loadSessionsFromDisk). Populate from disk only if not already set in memory.
      if (managed.lastReadMessageId === undefined) managed.lastReadMessageId = stored.lastReadMessageId
      if (managed.hasUnread === undefined) managed.hasUnread = stored.hasUnread
      if (managed.sharedUrl === undefined) managed.sharedUrl = stored.sharedUrl
      if (managed.sharedId === undefined) managed.sharedId = stored.sharedId
      if (managed.transferredSessionSummary === undefined) managed.transferredSessionSummary = stored.transferredSessionSummary
      if (managed.transferredSessionSummaryApplied === undefined) managed.transferredSessionSummaryApplied = stored.transferredSessionSummaryApplied
      if (managed.planModeState === undefined) managed.planModeState = stored.planModeState

      sessionLog.debug(`Cold-hydrated ${managed.messages.length} messages for session ${managed.id}`)
    }
    managed.messagesLoaded = true
  }

  // Build the StoredSession snapshot and hand it to the persistence queue.
  // Caller must ensure `managed.messagesLoaded` is true.
  private enqueuePersist(managed: ManagedSession): void {
    // Filter out transient status messages (progress indicators like "Compacting...")
    // Error messages are now persisted with rich fields for diagnostics.
    const persistableMessages = managed.messages.filter(m => m.role !== 'status')

    const storedSession: StoredSession = {
      ...pickMortiseSessionMetadata(managed),
      mortiseId: managed.id,
      workspaceId: managed.workspace.id,
      workspaceRootPath: requirePrimaryLocalWorkspaceRoot(managed.workspace),
      createdAt: managed.createdAt ?? Date.now(),
      lastUsedAt: Date.now(),
      messageCount: managed.messageCount,
      preview: managed.preview,
      lastMessageRole: managed.lastMessageRole,
      lastFinalMessageId: managed.lastFinalMessageId,
      messages: persistableMessages.map(messageToStored),
      tokenUsage: managed.tokenUsage ?? DEFAULT_TOKEN_USAGE,
    } as StoredSession

    // Queue for async persistence with debouncing.
    sessionPersistenceQueue.enqueue(storedSession)
  }

  // Flush a specific session immediately (call on session close/switch).
  // Cold-persist hydration is synchronous, so by the time we reach here the
  // queue already has an entry whenever persistSession was just called.
  async flushSession(sessionId: string): Promise<void> {
    await sessionPersistenceQueue.flush(sessionId)
  }

  // Flush all pending sessions (call on app quit).
  async flushAllSessions(): Promise<void> {
    await sessionPersistenceQueue.flushAll()
  }

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  private removeMessageOutboxBestEffort(clientMutationId: string): void {
    try {
      this.messageOutbox.remove(clientMutationId)
    } catch (error) {
      sessionLog.warn(`Failed to clean acknowledged message outbox ${clientMutationId}: ${error instanceof Error ? error.message : error}`)
    }
  }

  private handlePiUserMessagePersisted(managed: ManagedSession, clientMutationId?: string): boolean {
    if (!clientMutationId) return false
    const pendingAck = managed.pendingInputAcks.get(clientMutationId)
    if (pendingAck) {
      managed.pendingInputAcks.delete(clientMutationId)
      pendingAck.resolve(clientMutationId)
    }
    this.messageOutbox.update(clientMutationId, {
      status: 'pi_persisted',
      updatedAt: Date.now(),
      error: undefined,
    })
    if (!managed.publicationState) this.removeMessageOutboxBestEffort(clientMutationId)
    return pendingAck !== undefined
  }

  private outboxAttempt(clientMutationId: string): number {
    return this.messageOutbox.listPending().find(record => record.clientMutationId === clientMutationId)?.attempt ?? 1
  }

  private async hasPersistedOutboxMutation(record: MessageOutboxRecord, managed: ManagedSession): Promise<boolean> {
    const projection = await findPiSessionProjectionById(
      record.workspaceId,
      requirePrimaryLocalWorkspaceRoot(managed.workspace),
      record.sessionId,
    )
    const entries = (projection as { entries?: unknown[] } | null)?.entries ?? []
    return entries.some(entry => {
      if (!entry || typeof entry !== 'object') return false
      const message = (entry as { message?: unknown }).message
      return Boolean(message && typeof message === 'object'
        && (message as { clientMutationId?: unknown }).clientMutationId === record.clientMutationId)
    })
  }

  /** Reconcile Mortise-accepted messages after a process crash. */
  private async recoverPendingMessageOutbox(): Promise<void> {
    let pending: MessageOutboxRecord[]
    try {
      pending = this.messageOutbox.listPending()
    } catch (error) {
      sessionLog.warn(`Failed to read message outbox during recovery: ${error instanceof Error ? error.message : error}`)
      return
    }
    for (const record of pending) {
      let managed = this.sessions.get(record.sessionId)
      if (!managed && record.provisional) {
        const workspace = this.resolveWorkspaceByNameOrId(record.workspaceId)
        if (!workspace) {
          this.messageOutbox.update(record.clientMutationId, {
            status: 'failed',
            updatedAt: Date.now(),
            error: `Workspace ${record.workspaceId} is unavailable during outbox recovery`,
          })
          continue
        }
        try {
          await this.createSessionInternal(
            record.workspaceId,
            record.sessionOptions as unknown as import('@mortise/shared/protocol').CreateSessionOptions | undefined,
            true,
            record.sessionId,
          )
          managed = this.sessions.get(record.sessionId)
        } catch (error) {
          this.messageOutbox.update(record.clientMutationId, {
            status: 'failed',
            updatedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
          })
          continue
        }
      }
      if (!managed) {
        this.messageOutbox.update(record.clientMutationId, {
          status: 'failed',
          updatedAt: Date.now(),
          error: `Session ${record.sessionId} is unavailable during outbox recovery`,
        })
        continue
      }
      try {
        const persisted = await this.hasPersistedOutboxMutation(record, managed)
        if (persisted) {
          this.messageOutbox.update(record.clientMutationId, { status: 'pi_persisted', updatedAt: Date.now() })
          if (managed.publicationState) {
            try {
              await this.publishProvisionalSessionIfReady(managed)
            } catch (error) {
              const publicationError = error instanceof SessionPublicationDurabilityError
                ? error
                : new SessionPublicationDurabilityError(managed.id, 'runtime', error)
              managed.pendingPublicationFailure = {
                code: publicationError.code,
                message: publicationError.message,
                data: publicationError.data,
              }
              this.messageOutbox.update(record.clientMutationId, {
                status: 'failed',
                updatedAt: Date.now(),
                error: publicationError.message,
              })
              if (record.callerClientId) {
                this.sendEventToClient({
                  type: 'session_failure',
                  sessionId: managed.id,
                  error: managed.pendingPublicationFailure,
                }, record.callerClientId)
              }
              continue
            }
          }
          if (!managed.publicationState) this.removeMessageOutboxBestEffort(record.clientMutationId)
          continue
        }
		sessionLog.info(
		  `Retained Mortise-accepted message ${record.clientMutationId} for explicit retry after restart`,
		)
      } catch (error) {
        this.messageOutbox.update(record.clientMutationId, {
          status: 'failed', updatedAt: Date.now(), error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async openWorkspaceExtensions(workspace: Workspace | WorkspaceInfo): Promise<BackendExtensionWorkspaceSnapshot> {
    return this.extensionRuntime.openWorkspace(
      workspace.id,
      requirePrimaryLocalWorkspaceRoot(workspace as Workspace),
    )
  }

  /**
   * Prepare one independent Pi runtime for an opened Workspace. The runtime
   * owns its own Extension instances, while the shared Pi host can reuse the
   * compiled module/resource caches for later Session runtimes.
   */
  private ensureWorkspaceRuntimeWarmup(workspace: Workspace): Promise<void> {
    const existing = this.workspaceRuntimeWarmups.get(workspace.id)
    if (existing) return existing.ready

    const startedAt = Date.now()
    const state: WorkspaceRuntimeWarmup = {
      workspaceId: workspace.id,
      status: 'warming',
      startedAt,
      ready: Promise.resolve(),
    }
    const warmup = (async () => {
      writeRuntimeLog('info', {
        scope: 'session',
        event: 'workspace.runtime.prepare.begin',
        meta: { workspaceId: workspace.id },
      })
      let agent: AgentBackend | undefined
      try {
        const workspaceRootPath = requirePrimaryLocalWorkspaceRoot(workspace)
        const context = resolveBackendContext({})
        const providerConfig = context.providerConfig
        const forwardExtensionEvent = createExtensionEventForwarder(
          this.eventSink,
          workspace.id,
          undefined,
          this.extensionRuntime.backendType,
        )
        const onExtensionEvent = (event: ExtensionBridgeEvent) => {
          if (event.type === 'extension_frontend_state' || event.type === 'extension_contributions_runtime_reset') {
            const routedEvent = {
              ...event,
              sessionId: '',
              workspaceId: workspace.id,
              backendType: this.extensionRuntime.backendType,
            } as ExtensionFrontendStateEvent | Extract<ExtensionBridgeEvent, { type: 'extension_contributions_runtime_reset' }>
            this.extensionFrontendStates.apply(routedEvent)
            forwardExtensionEvent(routedEvent)
            return
          }
          forwardExtensionEvent(event)
        }
        const coreConfig: CoreBackendConfig = {
          workspace,
          extensionServiceScope: 'session',
          model: context.resolvedModel,
          miniModel: providerConfig?.models?.[0]?.id,
          thinkingLevel: getDefaultThinkingLevel(),
          isHeadless: true,
          skipConfigWatcher: true,
          envOverrides: { MORTISE_WORKSPACE_PATH: workspaceRootPath },
          onExtensionEvent,
        }
        agent = this.createWorkspaceRuntimeBackend({ workspace, context, coreConfig })
        state.agent = agent
        await agent.postInit()
        await agent.prepareRuntime?.()
        state.status = 'ready'
        state.completedAt = Date.now()
        writeRuntimeLog('info', {
          scope: 'session',
          event: 'workspace.runtime.prepare.ready',
          meta: {
            workspaceId: workspace.id,
            durationMs: Date.now() - startedAt,
          },
        })
      } catch (error) {
        state.status = 'degraded'
        state.completedAt = Date.now()
        state.error = error instanceof Error ? error.message : String(error)
        if (agent) {
          try {
            agent.destroy()
          } catch (destroyError) {
            sessionLog.warn(`Failed to dispose degraded Workspace warmup ${workspace.id}: ${destroyError instanceof Error ? destroyError.message : destroyError}`)
          }
        }
        state.agent = undefined
        writeRuntimeLog('warn', {
          scope: 'session',
          event: 'workspace.runtime.prepare.degraded',
          meta: {
            workspaceId: workspace.id,
            durationMs: Date.now() - startedAt,
            error: state.error,
          },
        })
      }
    })()
    state.ready = warmup
    this.workspaceRuntimeWarmups.set(workspace.id, state)
    return warmup
  }

  private async disposeWorkspaceRuntimeWarmup(workspaceId: string, reason: string): Promise<void> {
    const state = this.workspaceRuntimeWarmups.get(workspaceId)
    if (!state) return
    await state.ready.catch(() => undefined)
    this.workspaceRuntimeWarmups.delete(workspaceId)
    if (!state.agent) return
    try {
      if (state.agent.disposeForRestart) await state.agent.disposeForRestart()
      else state.agent.destroy()
    } catch (error) {
      sessionLog.warn(`Failed to dispose Workspace warmup ${workspaceId} (${reason}): ${error instanceof Error ? error.message : error}`)
    }
  }

  private async waitForWorkspaceRuntimeWarmup(workspace: Workspace): Promise<void> {
    await this.ensureWorkspaceRuntimeWarmup(workspace)
  }

  /**
   * Complete the workspace-scoped runtime boundary. Automation failures are
   * retained as feature-scoped diagnostics and do not block extensions or the
   * rest of the application from starting.
   */
  async initializeWorkspace(workspace: Workspace): Promise<void> {
    const canonical = initializeWorkspaceRegistration(workspace)
    this.setupConfigWatcher(requirePrimaryLocalWorkspaceRoot(canonical), canonical.id)
    await this.openWorkspaceExtensions(canonical)
    void this.ensureWorkspaceRuntimeWarmup(canonical).catch(error => {
      sessionLog.warn(`Workspace runtime warmup failed for ${canonical.id}: ${error instanceof Error ? error.message : error}`)
    })
  }

  getWorkspaceExtensionSnapshot(workspaceId: string): BackendExtensionWorkspaceSnapshot | null {
    return this.extensionRuntime.getWorkspaceSnapshot(workspaceId)
  }

  getExtensionRuntimeState(workspaceId?: string): import('@mortise/shared/config').PiExtensionRuntimeState {
    const globalSnapshot = typeof (this.extensionRuntime as Partial<BackendExtensionRuntimeRegistry>).getGlobalSnapshot === 'function'
      ? this.extensionRuntime.getGlobalSnapshot()
      : null
    const snapshots = workspaceId
      ? [this.extensionRuntime.getWorkspaceSnapshot(workspaceId)]
      : getWorkspaces().map(workspace => this.extensionRuntime.getWorkspaceSnapshot(workspace.id))
    const loadedSnapshots = snapshots.filter((snapshot): snapshot is BackendExtensionWorkspaceSnapshot => snapshot !== null)
    const extensionIds = [
      ...(globalSnapshot?.extensions.map(extension => extension.id) ?? []),
      ...loadedSnapshots.flatMap(snapshot => snapshot.extensions.map(extension => extension.id)),
    ]
    const warmup = workspaceId ? this.workspaceRuntimeWarmups.get(workspaceId) : undefined
    return {
      loaded: Boolean(globalSnapshot) || loadedSnapshots.length > 0,
      extensionIds: Array.from(new Set(extensionIds)).sort(),
      ...(warmup ? {
        preparationStatus: warmup.status,
        ...(warmup.error ? { preparationError: warmup.error } : {}),
      } : {}),
    }
  }

  getExtensionFileState(workspaceId: string, extensionId: string): ExtensionFileStateV1 {
    return this.extensionRuntime.readExtensionState(workspaceId, extensionId, validateExtensionFileStateV1)
      ?? { schemaVersion: 1, apps: {} }
  }

  async setExtensionFileState(workspaceId: string, extensionId: string, state: ExtensionFileStateV1): Promise<void> {
    if (!validateExtensionFileStateV1(state)) throw new TypeError('Invalid Extension file state')
    await this.extensionRuntime.writeExtensionState(workspaceId, extensionId, state, validateExtensionFileStateV1)
  }

  getWorkspacesInfo(): WorkspaceInfo[] {
    return getDefaultWorkspaceTopologyStore().listInfo()
  }

  getActiveSessionCount(workspaceId?: string): number {
    let count = 0
    for (const managed of this.sessions.values()) {
      if (managed.publicationState) continue
      if (workspaceId && managed.workspace.id !== workspaceId) continue
      if (managed.isProcessing) count++
    }
    return count
  }

  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean } {
    const workspace = this.resolveWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { automationCount: 0, schedulerRunning: false }

    const host = this.automationHosts.get(workspace.id)
    if (!host) return { automationCount: 0, schedulerRunning: false }
    return { automationCount: host.store.initialize().definitions.length, schedulerRunning: !host.isReadOnly() }
  }

  getAutomationHost(workspaceId: string): AutomationWorkspaceHostV3 | null {
    const workspace = this.resolveWorkspaceByNameOrId(workspaceId)
    return workspace ? this.automationHosts.get(workspace.id) ?? null : null
  }

  getAutomationHostInitializationError(workspaceId: string): string | null {
    const workspace = this.resolveWorkspaceByNameOrId(workspaceId)
    return workspace ? this.automationHostInitializationErrors.get(workspace.id) ?? null : null
  }

  getAutomationHostInitializationFailures(): Array<{ workspaceId: string; message: string }> {
    return Array.from(this.automationHostInitializationErrors, ([workspaceId, message]) => ({ workspaceId, message }))
  }

  getActiveSessionsInfo(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = []
    for (const managed of this.sessions.values()) {
      if (managed.publicationState) continue
      if (!managed.isProcessing) continue

      let status: SessionProcessingStatus = 'processing'
      if (managed.stopRequested) status = 'idle'

      result.push({
        sessionId: managed.id,
        workspaceId: managed.workspace.id,
        workspaceName: managed.workspace.name,
        title: managed.name || undefined,
        status,
        triggeredBy: managed.triggeredBy
          ? { automationName: managed.triggeredBy.automationName ?? 'Unknown', timestamp: managed.triggeredBy.timestamp ?? 0 }
          : undefined,
        createdAt: managed.lastMessageAt,
      })
    }
    return result
  }

  /**
   * Reload all sessions from disk.
   * Used after importing sessions to refresh the in-memory session list.
   */
  reloadSessions(): void {
    this.loadSessionsFromDisk()
  }

  getSessions(workspaceId?: string): Session[] {
    // Returns session metadata only - messages are NOT included to save memory
    // Use getSession(id) to load messages for a specific session
    let sessions = Array.from(this.sessions.values()).filter(session => !session.publicationState)

    // Filter by workspace if specified (used when switching workspaces)
    if (workspaceId) {
      sessions = sessions.filter(m => m.workspace.id === workspaceId)
    }

    return sessions
      .map(m => managedToSession(m, undefined, { includeSessionFolderPath: false }))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }

  /**
   * Aggregate unread and processing state across all workspaces.
   * Excludes hidden sessions from counts/indicators.
   */
  getUnreadSummary(): UnreadSummary {
    const byWorkspace: Record<string, number> = {}
    const hasUnreadByWorkspace: Record<string, boolean> = {}
    const hasProcessingByWorkspace: Record<string, boolean> = {}

    for (const workspace of getWorkspaces()) {
      byWorkspace[workspace.id] = 0
      hasUnreadByWorkspace[workspace.id] = false
      hasProcessingByWorkspace[workspace.id] = false
    }

    for (const session of this.sessions.values()) {
      if (session.hidden || session.publicationState) continue

      const workspaceId = session.workspace.id
      if (session.isProcessing) hasProcessingByWorkspace[workspaceId] = true
      if (!session.hasUnread) continue

      byWorkspace[workspaceId] = (byWorkspace[workspaceId] ?? 0) + 1
      hasUnreadByWorkspace[workspaceId] = true
    }

    const totalUnreadSessions = Object.values(byWorkspace).reduce((sum, count) => sum + count, 0)

    return {
      totalUnreadSessions,
      byWorkspace,
      hasUnreadByWorkspace,
      hasProcessingByWorkspace,
    }
  }

  /**
   * Refresh badge count from current unread state.
   * Called by renderer on mount — ensures badge is set even if the initial
   * emitUnreadSummaryChanged() fired before the renderer was ready.
   */
  refreshBadge(): void {
    const summary = this.getUnreadSummary()
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)
  }

  /** Broadcast global unread and processing summary to all workspace windows. */
  private emitUnreadSummaryChanged(): void {
    const summary = this.getUnreadSummary()

    // Update badge via runtime hook — host decides whether/how to render badges
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions)

    if (!this.eventSink) return

    // Broadcast to renderers for UI updates (session list dots, etc.)
    this.eventSink(RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED, { to: 'all' }, summary)
  }

  /**
   * Get a single session by ID with all messages loaded.
   * Used for lazy loading session messages when session is selected.
   * Messages are loaded from disk on first access to reduce memory usage.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const m = this.sessions.get(sessionId)
    if (!m) return null

    // Lazy-load messages from disk if not yet loaded
    await this.ensureMessagesLoaded(m)

    return managedToSession(m, { messages: m.messages })
  }

  /**
   * Ensure messages are loaded for a managed session.
   * Uses promise deduplication to prevent race conditions when multiple
   * concurrent calls (e.g., rapid session switches + message send) try
   * to load messages simultaneously.
   */
  private async ensureMessagesLoaded(managed: ManagedSession): Promise<void> {
    if (managed.messagesLoaded) return

    // Deduplicate concurrent loads - return existing promise if already loading
    const existingPromise = this.messageLoadingPromises.get(managed.id)
    if (existingPromise) {
      return existingPromise
    }

    const loadPromise = this.loadMessagesFromDisk(managed)
    this.messageLoadingPromises.set(managed.id, loadPromise)

    try {
      await loadPromise
    } finally {
      this.messageLoadingPromises.delete(managed.id)
    }
  }

  /**
   * Internal: Load messages from disk storage into the managed session.
   */
  private async loadMessagesFromDisk(managed: ManagedSession): Promise<void> {
    const storedSession = loadStoredSession(managed.workspace.id, managed.id)
    if (storedSession) {
      managed.messages = (storedSession.messages || []).map(storedToMessage)
      managed.tokenUsage = storedSession.tokenUsage
      managed.lastReadMessageId = storedSession.lastReadMessageId
      managed.hasUnread = storedSession.hasUnread  // Explicit unread flag for NEW badge state machine
      managed.sharedUrl = storedSession.sharedUrl
      managed.sharedId = storedSession.sharedId
      // Sync name from disk - ensures title persistence across lazy loading
      managed.name = storedSession.name
      // Restore Pi provider state - ensures correct provider on resume
      if (storedSession.provider) {
        managed.provider = storedSession.provider
      }
      // Sync transferred session summary state from disk
      managed.transferredSessionSummary = storedSession.transferredSessionSummary
      managed.transferredSessionSummaryApplied = storedSession.transferredSessionSummaryApplied
      sessionLog.debug(`Lazy-loaded ${managed.messages.length} messages for session ${managed.id}`)

    }
    managed.messagesLoaded = true
  }

  /**
   * Get the filesystem path to a session's folder
   */
  getSessionPath(sessionId: string): string | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getSessionStoragePath(managed.workspace.id, sessionId)
  }

  private getSubagentDeliveryLedgerPath(managed: ManagedSession): string {
    return join(getSessionStoragePath(managed.workspace.id, managed.id), 'subagent-deliveries.json')
  }

  private childAttemptKey(managed: ManagedSession, runtimeId: string): string {
    return `${managed.id}:${runtimeId}`
  }

  private getChildAttemptRecord(
    managed: ManagedSession,
    runtimeId: string,
    attemptId?: string,
  ): ChildAttemptRecord | undefined {
    const record = this.childAttempts.get(this.childAttemptKey(managed, runtimeId))
    if (!record || (attemptId && record.attemptId !== attemptId)) return undefined
    return record
  }

  private maybeDeleteChildAttempt(managed: ManagedSession, record: ChildAttemptRecord): void {
    if (
      record.state === 'closed'
      && record.operationIds.size === 0
      && record.pendingTools.size === 0
      && this.childAttempts.get(this.childAttemptKey(managed, record.runtimeId)) === record
    ) {
      this.childAttempts.delete(this.childAttemptKey(managed, record.runtimeId))
    }
  }

  private enqueueChildReceipt(record: ChildAttemptRecord, work: () => Promise<void>): Promise<void> {
    const next = record.receiptChain.catch(() => undefined).then(work)
    record.receiptChain = next
    return next
  }

  private async registerChildAttempt(
    managed: ManagedSession,
    request: ChildAttemptRegistrationRequest,
  ): Promise<ChildAttemptRegistration> {
    if (managed.deleting || this.sessions.get(managed.id) !== managed) {
      throw new Error('The parent Session is unavailable for a child Attempt')
    }

    const key = this.childAttemptKey(managed, request.runtimeId)
    let record = this.childAttempts.get(key)
    let created = false
    if (record) {
      if (
        record.state !== 'open'
        || record.attemptId !== request.attemptId
        || record.childSessionId !== request.childSessionId
      ) {
        throw new Error('The child Attempt is stale or does not belong to this runtime')
      }
    } else {
      record = {
        attemptId: request.attemptId,
        runtimeId: request.runtimeId,
        childSessionId: request.childSessionId,
        sessionPath: request.sessionPath,
        state: 'open',
        operationIds: new Set(),
        pendingTools: new Map(),
        receiptChain: Promise.resolve(),
        operationSettlements: new Map(),
      }
      this.childAttempts.set(key, record)
      created = true
    }

    let operationId: string | undefined
    if (request.background) {
      operationId = randomUUID()
      const operation: ChildTaskBackgroundOperation = {
        operationId,
        attemptId: record.attemptId,
        runtimeId: record.runtimeId,
        childSessionId: record.childSessionId,
        sessionPath: record.sessionPath,
      }
      try {
        await this.recordBackgroundChildOperation(managed, operation)
        record.operationIds.add(operationId)
        this.workspaceLocationActivities.begin({
          workspaceId: managed.workspace.id,
          locationId: managed.activeWorkspaceLocationId ?? managed.workspace.primaryLocationId,
          kind: 'child-task',
          activityId: `${managed.id}:${record.childSessionId}`,
          ownerSessionId: managed.id,
        })
      } catch (error) {
        if (created && this.childAttempts.get(key) === record) this.childAttempts.delete(key)
        throw error
      }
    }

    return { attemptId: record.attemptId, operationId }
  }

  private async abandonChildAttempt(
    managed: ManagedSession,
    runtimeId: string,
    childSessionId: string,
    attemptId: string,
  ): Promise<void> {
    const record = this.getChildAttemptRecord(managed, runtimeId, attemptId)
    if (!record || record.childSessionId !== childSessionId) return
    record.state = 'closed'
    if (!record.revocationSettlement) {
      const task = (async () => {
        await record.normalSettlement?.catch(() => undefined)
        await this.settleChildToolSideEffects(managed, record)
        for (const operationId of [...record.operationIds]) {
          await this.settleChildOperation(managed, record, {
            operationId,
            attemptId,
            runtimeId,
            childSessionId,
            sessionPath: record.sessionPath,
            status: 'failed',
            output: 'Child Attempt registration failed after Pi rejected the request.',
            modified: new Date().toISOString(),
          })
        }
        this.maybeDeleteChildAttempt(managed, record)
      })()
      record.revocationSettlement = task
      void task.catch(() => {
        if (record.revocationSettlement === task) record.revocationSettlement = undefined
      })
    }
    await record.revocationSettlement
  }

  private async settleChildAttempt(
    managed: ManagedSession,
    runtimeId: string,
    childSessionId: string,
    attemptId: string,
  ): Promise<void> {
    const record = this.getChildAttemptRecord(managed, runtimeId, attemptId)
    if (!record || record.childSessionId !== childSessionId) return
    record.state = 'closed'
    if (!record.normalSettlement) {
      const task = (async () => {
        await this.settleChildToolSideEffects(managed, record)
        this.maybeDeleteChildAttempt(managed, record)
      })()
      record.normalSettlement = task
      void task.catch(() => {
        if (record.normalSettlement === task) record.normalSettlement = undefined
      })
    }
    await record.normalSettlement
  }

  private async settleChildToolSideEffects(
    managed: ManagedSession,
    record: ChildAttemptRecord,
  ): Promise<void> {
    await this.enqueueChildReceipt(record, async () => {
      for (const [toolCallId, tool] of [...record.pendingTools]) {
        await this.recordToolSideEffect(managed, {
          attemptId: record.attemptId,
          toolCallId,
          toolName: tool.toolName,
          status: tool.result ? 'completed' : 'outcome-unknown',
          ...(tool.result ? { isError: tool.result.isError } : {}),
        })
        record.pendingTools.delete(toolCallId)
      }
    })
  }

  private async completeChildToolSideEffect(
    managed: ManagedSession,
    result: ChildToolExecutionCompleted,
  ): Promise<void> {
    const record = this.getChildAttemptRecord(managed, result.runtimeId, result.attemptId)
    const tool = record?.pendingTools.get(result.toolCallId)
    if (!record || !tool) return
    tool.result = { isError: result.isError }
    await this.enqueueChildReceipt(record, async () => {
      const current = record.pendingTools.get(result.toolCallId)
      if (!current) return
      await this.recordToolSideEffect(managed, {
        attemptId: record.attemptId,
        toolCallId: result.toolCallId,
        toolName: current.toolName,
        status: 'completed',
        isError: result.isError,
      })
      record.pendingTools.delete(result.toolCallId)
      this.maybeDeleteChildAttempt(managed, record)
    })
  }

  private settleChildOperation(
    managed: ManagedSession,
    record: ChildAttemptRecord,
    operation: ChildTaskSettledOperation,
    options: { deliver?: boolean } = {},
  ): Promise<void> {
    const existing = record.operationSettlements.get(operation.operationId)
    if (existing) return existing
    const task = (async () => {
      await this.settleBackgroundChildOperation(managed, operation, options)
      record.operationIds.delete(operation.operationId)
      if (record.operationIds.size === 0) {
        this.workspaceLocationActivities.end('child-task', `${managed.id}:${operation.childSessionId}`)
      }
      this.maybeDeleteChildAttempt(managed, record)
    })()
    record.operationSettlements.set(operation.operationId, task)
    void task.catch(() => {
      if (record.operationSettlements.get(operation.operationId) === task) {
        record.operationSettlements.delete(operation.operationId)
      }
    })
    return task
  }

  private async closeChildAttempts(
    managed: ManagedSession,
    reason: string,
  ): Promise<void> {
    const records = [...this.childAttempts.entries()]
      .filter(([key]) => key.startsWith(`${managed.id}:`))
      .map(([, record]) => record)
    for (const record of records) {
      record.state = 'closed'
      await record.normalSettlement?.catch(() => undefined)
      await this.settleChildToolSideEffects(managed, record)
      for (const operationId of [...record.operationIds]) {
        await this.settleChildOperation(managed, record, {
          operationId,
          attemptId: record.attemptId,
          runtimeId: record.runtimeId,
          childSessionId: record.childSessionId,
          sessionPath: record.sessionPath,
          status: 'interrupted',
          output: `Child Attempt was interrupted because ${reason}.`,
          modified: new Date().toISOString(),
        }, { deliver: false })
      }
      this.maybeDeleteChildAttempt(managed, record)
    }
  }

  private async readSubagentDeliveryLedger(managed: ManagedSession): Promise<SubagentDeliveryLedger> {
    try {
      const parsed = JSON.parse(await readFile(this.getSubagentDeliveryLedgerPath(managed), 'utf8')) as {
        schemaVersion?: number
        operations?: Record<string, LegacySubagentDeliveryRecord>
      }
      if ((parsed.schemaVersion === 1 || parsed.schemaVersion === 2) && parsed.operations && typeof parsed.operations === 'object') {
        const operations: Record<string, SubagentDeliveryRecord> = {}
        for (const [key, value] of Object.entries(parsed.operations)) {
          const operationId = value.operationId ?? key
          if (!operationId || !value.childSessionId || !value.sessionPath || !value.state || !value.messageId) continue
          operations[operationId] = {
            operationId,
            attemptId: value.attemptId ?? `legacy-execution:${operationId}`,
            runtimeId: value.runtimeId ?? `legacy-runtime:${value.childSessionId}`,
            childSessionId: value.childSessionId,
            sessionPath: value.sessionPath,
            state: value.state,
            status: value.status,
            output: value.output,
            modified: value.modified,
            messageId: value.messageId,
            updatedAt: value.updatedAt ?? new Date().toISOString(),
          }
        }
        return { schemaVersion: 2, operations }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { schemaVersion: 2, operations: {} }
  }

  private mutateSubagentDeliveryLedger(
    managed: ManagedSession,
    mutate: (ledger: SubagentDeliveryLedger) => void,
  ): Promise<void> {
    const previous = this.subagentDeliveryWrites.get(managed.id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const ledger = await this.readSubagentDeliveryLedger(managed)
      mutate(ledger)
      await atomicWriteFile(this.getSubagentDeliveryLedgerPath(managed), `${JSON.stringify(ledger, null, 2)}\n`)
    })
    this.subagentDeliveryWrites.set(managed.id, next)
    void next.then(
      () => {
        if (this.subagentDeliveryWrites.get(managed.id) === next) this.subagentDeliveryWrites.delete(managed.id)
      },
      () => {
        if (this.subagentDeliveryWrites.get(managed.id) === next) this.subagentDeliveryWrites.delete(managed.id)
      },
    )
    return next
  }

  private async recordBackgroundChildOperation(
    managed: ManagedSession,
    operation: ChildTaskBackgroundOperation,
  ): Promise<void> {
    await this.mutateSubagentDeliveryLedger(managed, (ledger) => {
      const existing = ledger.operations[operation.operationId]
      if (existing?.state === 'delivered') return
      ledger.operations[operation.operationId] = {
        ...operation,
        state: existing?.state ?? 'running',
        messageId: existing?.messageId ?? `subagent-completion-${operation.operationId}`,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  private async settleBackgroundChildOperation(
    managed: ManagedSession,
    operation: ChildTaskSettledOperation,
    options: { deliver?: boolean } = {},
  ): Promise<void> {
    await this.mutateSubagentDeliveryLedger(managed, (ledger) => {
      const existing = ledger.operations[operation.operationId]
      if (existing?.state === 'delivered') return
      ledger.operations[operation.operationId] = {
        ...operation,
        state: 'ready',
        messageId: existing?.messageId ?? `subagent-completion-${operation.operationId}`,
        updatedAt: new Date().toISOString(),
      }
    })
    if (options.deliver !== false) {
      await this.deliverBackgroundChildOperation(managed, operation.operationId)
    }
  }

  private deliverBackgroundChildOperation(managed: ManagedSession, operationId: string): Promise<void> {
    const key = `${managed.id}:${operationId}`
    const existing = this.subagentDeliveryTasks.get(key)
    if (existing) return existing
    const task = this.performBackgroundChildDelivery(managed, operationId)
    this.subagentDeliveryTasks.set(key, task)
    void task.then(
      () => {
        if (this.subagentDeliveryTasks.get(key) === task) this.subagentDeliveryTasks.delete(key)
      },
      () => {
        if (this.subagentDeliveryTasks.get(key) === task) this.subagentDeliveryTasks.delete(key)
      },
    )
    return task
  }

  private async performBackgroundChildDelivery(managed: ManagedSession, operationId: string): Promise<void> {
    if (managed.deleting || this.sessions.get(managed.id) !== managed) return
    await this.subagentDeliveryWrites.get(managed.id)?.catch(() => undefined)
    if (managed.deleting || this.sessions.get(managed.id) !== managed) return
    const record = (await this.readSubagentDeliveryLedger(managed)).operations[operationId]
    if (!record || record.state !== 'ready' || !record.status) return

    this.sendEvent({
      type: 'subagent_event',
      sessionId: managed.id,
      taskId: record.childSessionId,
      phase: 'completed',
      status: record.status,
      summary: record.output?.trim().slice(0, 2_000) || undefined,
      timestamp: Date.parse(record.modified ?? record.updatedAt),
    }, managed.workspace.id)

    await this.mutateSubagentDeliveryLedger(managed, (ledger) => {
      const current = ledger.operations[operationId]
      if (!current) return
      ledger.operations[operationId] = {
        ...current,
        state: 'delivered',
        updatedAt: new Date().toISOString(),
      }
    })
  }

  private trackSubagentLifecycleTask(managed: ManagedSession, task: Promise<void>): Promise<void> {
    const tasks = this.subagentLifecycleTasks.get(managed.id) ?? new Set<Promise<void>>()
    tasks.add(task)
    this.subagentLifecycleTasks.set(managed.id, tasks)
    void task.then(
      () => {
        tasks.delete(task)
        if (tasks.size === 0) this.subagentLifecycleTasks.delete(managed.id)
      },
      () => {
        tasks.delete(task)
        if (tasks.size === 0) this.subagentLifecycleTasks.delete(managed.id)
      },
    )
    return task
  }

  private async drainSubagentLifecycle(managed: ManagedSession): Promise<void> {
    while (true) {
      const lifecycle = [...(this.subagentLifecycleTasks.get(managed.id) ?? [])]
      const deliveries = [...this.subagentDeliveryTasks.entries()]
        .filter(([key]) => key.startsWith(`${managed.id}:`))
        .map(([, task]) => task)
      if (lifecycle.length === 0 && deliveries.length === 0) break
      await Promise.all([...lifecycle, ...deliveries])
    }
    await this.subagentDeliveryWrites.get(managed.id)
  }

  private async recoverBackgroundChildOperations(managed: ManagedSession): Promise<void> {
    const ledger = await this.readSubagentDeliveryLedger(managed)
    const pending = Object.values(ledger.operations).filter(operation => operation.state !== 'delivered')
    if (pending.length === 0 || !managed.agent?.listChildSessions) return
    const parentSessionId = managed.agent.getSessionId()
    if (!parentSessionId) return
    const children = await managed.agent.listChildSessions(parentSessionId)

    for (const operation of pending) {
      if (operation.state === 'running') {
        const child = children.find(candidate => candidate.sessionId === operation.childSessionId)
        if (!child || child.status === 'running') continue
        await this.settleBackgroundChildOperation(managed, {
          operationId: operation.operationId,
          attemptId: operation.attemptId,
          runtimeId: operation.runtimeId,
          childSessionId: operation.childSessionId,
          sessionPath: operation.sessionPath,
          status: child.status,
          output: child.lastOutput,
          modified: child.modified,
        })
      } else {
        await this.deliverBackgroundChildOperation(managed, operation.operationId)
      }
    }
  }

  async createAndSendFirstTurn(
    input: CreateAndSendFirstTurnInput,
    prepareProvisional?: (managed: ManagedSession) => void | Promise<void>,
  ): Promise<import('@mortise/shared/protocol').CreateAndSendFirstTurnResult> {
    if (
      input.createOptions?.hidden
      || input.createOptions?.branchFromSessionId
      || input.createOptions?.branchFromMessageId
    ) {
      throw new Error('createAndSendFirstTurn only supports ordinary new conversations')
    }
    if ((input.attachments?.length || input.storedAttachments?.length) && !input.attachmentStagingId) {
      throw new Error('First-turn attachments require a dedicated staging identity')
    }
    const workspace = this.resolveWorkspaceByNameOrId(input.workspaceId)
    if (!workspace) throw new Error(`Workspace ${input.workspaceId} not found`)
    if (input.attachmentStagingId) this.validateFirstTurnAttachmentStagingId(input.attachmentStagingId)

    const requestedSessionId = this.generateProvisionalSessionId(workspace.id)
    let created: Session | null = null
    try {
      created = await this.createSessionInternal(input.workspaceId, input.createOptions, true, requestedSessionId)
      const managed = this.sessions.get(created.id)
      if (!managed) throw new Error(`Session ${created.id} was not created`)
      await prepareProvisional?.(managed)
      await input.beforePublish?.(managedToSession(managed, { messages: managed.messages }))
    } catch (error) {
      const managed = created ? this.sessions.get(created.id) : undefined
      if (managed) await this.discardUnacceptedFirstTurn(managed, error)
      await this.cleanupFirstTurnAttachmentStaging(workspace.id, input.attachmentStagingId)
      throw error
    }
    if (!created) throw new Error('First-turn Session was not created')
    let firstTurnAttachments = input.attachments
    let firstTurnStoredAttachments = input.storedAttachments

    try {
      const adopted = await this.adoptFirstTurnAttachmentStaging(
        created,
        input.attachmentStagingId,
        input.attachments,
        input.storedAttachments,
      )
      firstTurnAttachments = adopted.attachments
      firstTurnStoredAttachments = adopted.storedAttachments
    } catch (error) {
      const managed = this.sessions.get(created.id)
      if (managed) await this.discardUnacceptedFirstTurn(managed, error)
      await this.cleanupFirstTurnAttachmentStaging(workspace.id, input.attachmentStagingId)
      throw error
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let abortListener: (() => void) | undefined
      const removeAbortListener = () => {
        if (abortListener) input.signal?.removeEventListener('abort', abortListener)
        abortListener = undefined
      }
      const rejectAfterAbandon = async (error: unknown) => {
        if (settled) return
        settled = true
        removeAbortListener()
        const managed = this.sessions.get(created.id)
        if (managed) await this.discardUnacceptedFirstTurn(managed, error)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const settleAccepted = (messageId: string) => {
        if (settled) return
        const managed = this.sessions.get(created.id)
        if (!managed) {
          settled = true
          reject(new Error(`Session ${created.id} was acknowledged after removal`))
          return
        }
        settled = true
        removeAbortListener()
        resolve({
          session: managedToSession(managed, { messages: managed.messages }),
          messageId,
          publication: managed.publicationState ? 'pending' : 'published',
        })
      }

      if (input.signal) {
        abortListener = () => {
          void rejectAfterAbandon(input.signal?.reason ?? new Error('First-turn request cancelled'))
        }
        if (input.signal.aborted) {
          abortListener()
          return
        }
        input.signal.addEventListener('abort', abortListener, { once: true })
      }

      void this.sendMessage(
        created.id,
        input.message,
        firstTurnAttachments,
        firstTurnStoredAttachments,
        input.sendOptions,
        undefined,
        undefined,
        undefined,
        { callerClientId: input.callerClientId },
        false,
        settleAccepted,
      ).then(async () => {
        if (settled) return
        await rejectAfterAbandon(new Error('First turn completed without durably accepting its user message'))
      }).catch(async error => {
        if (settled) {
          const managed = this.sessions.get(created.id)
          const failure = managed?.pendingPublicationFailure
          if (failure && input.callerClientId) {
            this.sendEventToClient({
              type: 'session_failure',
              sessionId: created.id,
              error: failure,
            }, input.callerClientId)
          }
          return
        }
        await rejectAfterAbandon(error)
      })
    })
  }

  private async adoptFirstTurnAttachmentStaging(
    session: Session,
    stagingId: string | undefined,
    attachments: FileAttachment[] | undefined,
    storedAttachments: StoredAttachment[] | undefined,
  ): Promise<{ attachments?: FileAttachment[]; storedAttachments?: StoredAttachment[] }> {
    if (!stagingId) return { attachments, storedAttachments }
    this.validateFirstTurnAttachmentStagingId(stagingId)

    const workspace = this.sessions.get(session.id)?.workspace ?? this.resolveWorkspaceByNameOrId(session.workspaceId)
    if (!workspace) throw new Error(`Workspace ${session.workspaceId} not found`)

    const stagingSessionPath = getSessionStoragePath(workspace.id, stagingId)
    const stagingAttachmentsPath = getSessionAttachmentsPath(workspace.id, stagingId)
    const targetAttachmentsPath = getSessionAttachmentsPath(workspace.id, session.id)

    const remapRequiredPath = (value: string | undefined): string | undefined => {
      if (!value) return value
      const relativePath = relative(stagingAttachmentsPath, value)
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error(`Attachment path is outside first-turn staging: ${value}`)
      }
      return join(targetAttachmentsPath, relativePath)
    }

    const adoptedStored = storedAttachments?.map(attachment => ({
      ...attachment,
      storedPath: remapRequiredPath(attachment.storedPath) ?? attachment.storedPath,
      thumbnailPath: remapRequiredPath(attachment.thumbnailPath),
      markdownPath: remapRequiredPath(attachment.markdownPath),
    }))
    const adoptedModelAttachments = attachments?.map((attachment, index) => {
      const adoptedStoredAttachment = adoptedStored?.[index]
      let adoptedPath: string | undefined = attachment.path
      if (attachment.path) {
        const relativePath = relative(stagingAttachmentsPath, attachment.path)
        adoptedPath = relativePath.startsWith('..') || isAbsolute(relativePath)
          ? (adoptedStoredAttachment?.storedPath ?? adoptedStoredAttachment?.markdownPath)
          : join(targetAttachmentsPath, relativePath)
        if (!adoptedPath) {
          throw new Error(`Attachment path is outside first-turn staging: ${attachment.path}`)
        }
      }
      return {
        ...attachment,
        ...(adoptedPath ? { path: adoptedPath } : {}),
        storedPath: remapRequiredPath(attachment.storedPath),
        markdownPath: remapRequiredPath(attachment.markdownPath),
      }
    })

    if (existsSync(stagingAttachmentsPath)) {
      if (existsSync(targetAttachmentsPath)) {
        let targetEntries: string[]
        try {
          targetEntries = await readdir(targetAttachmentsPath)
        } catch (error) {
          throw new Error(`First-turn attachment target is not an empty directory for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (targetEntries.length > 0) {
          throw new Error(`First-turn attachment target already exists for ${session.id}`)
        }
        // createSessionInternal pre-creates the empty attachments directory.
        // Remove only that empty directory so the staging rename remains atomic.
        await rmdir(targetAttachmentsPath)
      }
      await mkdir(dirname(targetAttachmentsPath), { recursive: true })
      await rename(stagingAttachmentsPath, targetAttachmentsPath)
    }

    await rm(stagingSessionPath, { recursive: true, force: true })
    return { attachments: adoptedModelAttachments, storedAttachments: adoptedStored }
  }

  private validateFirstTurnAttachmentStagingId(stagingId: string): void {
    validateSessionId(stagingId)
    if (!/^draft-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stagingId)) {
      throw new Error('Invalid first-turn attachment staging identity')
    }
  }

  private async cleanupFirstTurnAttachmentStaging(
    workspaceId: string,
    stagingId: string | undefined,
  ): Promise<void> {
    if (!stagingId) return
    this.validateFirstTurnAttachmentStagingId(stagingId)
    await rm(getSessionStoragePath(workspaceId, stagingId), { recursive: true, force: true })
  }

  async discardFirstTurnAttachmentStaging(workspaceId: string, stagingId: string): Promise<void> {
    const workspace = this.resolveWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
    await this.cleanupFirstTurnAttachmentStaging(workspace.id, stagingId)
  }

  async createSession(workspaceId: string, options?: import('@mortise/shared/protocol').CreateSessionOptions): Promise<Session> {
    return this.createSessionInternal(workspaceId, options, false)
  }

  private generateProvisionalSessionId(workspaceId: string): string {
    let sessionId = generateSessionId(workspaceId)
    while (this.sessions.has(sessionId)) sessionId = generateSessionId(workspaceId)
    return sessionId
  }

  private async createSessionInternal(
    workspaceId: string,
    options: import('@mortise/shared/protocol').CreateSessionOptions | undefined,
    provisionalFirstTurn: boolean,
    requestedSessionId?: string,
  ): Promise<Session> {
    if (options && Object.prototype.hasOwnProperty.call(options, 'workingDirectory')) {
      throw new RemovedSessionFieldError('workingDirectory')
    }
    const workspace = this.resolveWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    const workspaceRootPath = requirePrimaryLocalWorkspaceRoot(workspace)

    // AI defaults are global. An explicit Session value must already be part of
    // the current contract; retired values never silently fall back to default.
    const defaultThinkingLevel = resolveSessionThinkingLevel(
      options?.thinkingLevel,
      getDefaultThinkingLevel(),
    )
    const requestedProvider = options?.provider
    const sessionProvider = hasConfiguredPiProvider(requestedProvider)
      ? requestedProvider
      : undefined
    if (requestedProvider && !sessionProvider) {
      sessionLog.warn(`Creating session without deleted provider "${requestedProvider}"; using defaults`)
    }

    // Resolve model tier hints ('fast' / 'default') to actual model IDs.
    // EditPopover uses tier hints instead of hardcoded Anthropic model names
    // so the right model is selected regardless of the active LLM provider.
    let resolvedModelOption = options?.model
    if (resolvedModelOption === 'fast' || resolvedModelOption === 'default') {
      const tierProvider = resolveSessionProvider(sessionProvider)
      if (tierProvider) {
        const models = tierProvider.provider.models ?? []
        resolvedModelOption = resolvedModelOption === 'fast'
          ? (models[1]?.id ?? models[0]?.id)
          : models[0]?.id
      } else {
        resolvedModelOption = undefined
      }
    }

    // Resolve backend target early for branching policy checks.
    const targetBackendContext = resolveBackendContext({
      sessionProvider,
      managedModel: resolvedModelOption,
    })
    const targetProviderType = targetBackendContext.providerConfig?.baseUrl ? 'pi_custom' : 'pi'
    const targetPiAuthProvider = targetBackendContext.providerKey

    // Validate branch request up-front so branch metadata is only set for valid branches.
    // This prevents creating sessions that claim to be branched but don't have copied history.
    let validatedBranch: {
      sourceSessionId: string
      sourceMessageId: string
      sourceSession: StoredSession
      sourceProjectionSession: StoredSession
      sourceBranchEntries: PiBranchProjectionEntry[]
      sourceEntryIds: Set<string>
      sourceCanonicalEntryIds: Set<string>
      branchContextStrategy: 'seeded-fresh-session'
      sourceProvider?: 'pi'
    } | undefined

    if (options?.branchFromSessionId || options?.branchFromMessageId) {
      if (!options.branchFromSessionId || !options.branchFromMessageId) {
        sessionLog.warn('Branch validation failed: missing branchFromSessionId or branchFromMessageId', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          branchFromMessageId: options.branchFromMessageId,
        })
        throw new Error('Invalid branch request: both branchFromSessionId and branchFromMessageId are required')
      }

      const sourceManaged = this.sessions.get(options.branchFromSessionId)
      if (sourceManaged) {
        if (sourceManaged.workspace.id !== workspace.id) {
          sessionLog.warn('Branch validation failed: source session belongs to different workspace', {
            workspaceId,
            targetWorkspaceRootPath: workspaceRootPath,
            sourceWorkspaceId: sourceManaged.workspace.id,
            branchFromSessionId: options.branchFromSessionId,
          })
          throw new Error('Invalid branch request: source session belongs to a different workspace')
        }

        // Flush source session to disk to ensure latest message list is available for branch copy.
        this.persistSession(sourceManaged)
        await sessionPersistenceQueue.flush(sourceManaged.id)
      }

      const sourceSession = loadStoredSession(workspace.id, options.branchFromSessionId)
      if (!sourceSession) {
        sessionLog.warn('Branch validation failed: source session not found on disk', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
        })
        throw new Error(`Invalid branch request: source session ${options.branchFromSessionId} not found`)
      }

      const sourceBackendContext = resolveBackendContext({
        sessionProvider: sourceManaged?.provider || sourceSession.provider,
        managedModel: sourceManaged?.model || sourceSession.model,
      })
      const sourceProviderType = sourceBackendContext.providerConfig?.baseUrl ? 'pi_custom' : 'pi'
      const sourcePiAuthProvider = sourceBackendContext.providerKey

      const providerMismatch = sourceBackendContext.provider !== targetBackendContext.provider
      const providerTypeMismatch = sourceProviderType !== targetProviderType
      const piAuthProviderMismatch =
        sourceBackendContext.provider === 'pi' && sourcePiAuthProvider !== targetPiAuthProvider

      if (providerMismatch || providerTypeMismatch || piAuthProviderMismatch) {
        sessionLog.warn('Branch validation failed: source and target providers are incompatible', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          sourceProvider: sourceBackendContext.provider,
          sourceProviderType,
          sourcePiAuthProvider,
          targetProvider: targetBackendContext.provider,
          targetProviderType,
          targetPiAuthProvider,
        })
        throw new Error('Branching is only supported within the same provider/backend. Switch this panel provider and try again.')
      }

      const sourceProjection = await findPiSessionProjectionById(
        workspace.id,
        workspaceRootPath,
        options.branchFromSessionId,
      )
      if (!sourceProjection) {
        throw new Error(`Invalid branch request: Pi projection for source session ${options.branchFromSessionId} not found`)
      }
      const branchTarget = resolvePiBranchTarget(
        sourceProjection as unknown as PiBranchProjection,
        options.branchFromMessageId,
      )
      if (!branchTarget) {
        sessionLog.warn('Branch validation failed: message not found in source session', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
          branchFromMessageId: options.branchFromMessageId,
        })
        throw new Error(`Invalid branch request: message ${options.branchFromMessageId} not found in source session`)
      }

      const sourceProjectionSession = projectTreeSessionProjectionAsStoredSession(
        sourceProjection as never,
        { leafId: branchTarget.targetEntry.id },
      )
      if (!sourceProjectionSession) {
        throw new Error(`Invalid branch request: failed to project source session ${options.branchFromSessionId}`)
      }

      const branchContextStrategy = 'seeded-fresh-session' as const

      validatedBranch = {
        sourceSessionId: options.branchFromSessionId,
        sourceMessageId: options.branchFromMessageId,
        sourceSession,
        sourceProjectionSession,
        sourceBranchEntries: branchTarget.branchEntries,
        sourceEntryIds: branchTarget.overlayMessageIds,
        sourceCanonicalEntryIds: branchTarget.canonicalEntryIds,
        branchContextStrategy,
        sourceProvider: sourceBackendContext.provider,
      }

      sessionLog.info('Branch validation succeeded', {
        workspaceId,
        branchFromSessionId: validatedBranch.sourceSessionId,
        branchFromMessageId: validatedBranch.sourceMessageId,
        branchContextStrategy: validatedBranch.branchContextStrategy,
        copiedMessageCount: validatedBranch.sourceEntryIds.size,
      })
    }

    // Ordinary first turns preallocate only the persistent Session identity.
    // Pi creates the Attempt after it accepts the first Session command.
    const provisional = provisionalFirstTurn && !options?.hidden && !validatedBranch
    const now = Date.now()
    if (provisional && requestedSessionId) validateSessionId(requestedSessionId)
    const storedSession: SessionHeader = provisional
      ? {
          // Crash recovery must recreate the accepted provisional Session under
          // the same preallocated identity recorded by the outbox.
          mortiseId: requestedSessionId ?? this.generateProvisionalSessionId(workspace.id),
          workspaceId: workspace.id,
          workspaceRootPath,
          name: options?.name,
          createdAt: now,
          lastUsedAt: now,
          sdkCwd: workspaceRootPath,
        }
      : await createStoredSession(workspace.id, workspaceRootPath, {
          sessionId: requestedSessionId,
          name: options?.name,
          hidden: options?.hidden,
        })

    if (options?.extensionBootstrap) {
      storedSession.extensionBootstrap = structuredClone(options.extensionBootstrap)
    }

    // Branch: project the active Pi path up to the selected entry, then append
    // only canonical messages through Pi's public SessionManager API. Mortise
    // retains UI-only metadata fields (annotations, attachments, badges).
    if (validatedBranch) {
      try {
        const branchedStored = loadStoredSession(workspace.id, storedSession.mortiseId)
        if (!branchedStored) {
          throw new Error(`Failed to load newly created session ${storedSession.mortiseId} for branch copy`)
        }

        const sourceMessages = validatedBranch.sourceProjectionSession.messages
          .filter(message => validatedBranch.sourceEntryIds.has(message.id))

        // Re-map embedded paths from the source Mortise sidecar to the branch sidecar.
        const sourceDir = normalizePath(getSessionStoragePath(workspace.id, validatedBranch.sourceSessionId))
        const branchDir = normalizePath(getSessionStoragePath(workspace.id, storedSession.mortiseId))
        const remappedMessages = sourceDir !== branchDir
          ? sourceMessages.map(m => {
            const json = JSON.stringify(m)
            if (!json.includes(sourceDir)) return m
            return JSON.parse(json.replaceAll(sourceDir, branchDir)) as StoredMessage
          })
          : sourceMessages

        const branchSessionFile = getSessionFilePath(
          workspace.id,
          storedSession.mortiseId,
          storedSession.createdAt,
        )
        const importedIdMap = await appendPiBranchMessagesViaSessionManager(
          branchSessionFile,
          dirname(branchSessionFile),
          workspaceRootPath,
          validatedBranch.sourceBranchEntries.flatMap(entry => (
            entry.type === 'message' && entry.message && typeof entry.message === 'object'
              ? [{ id: entry.id, message: entry.message }]
              : []
          )),
        )
        branchedStored.messages = remapBranchedMessageIdentities(
          remappedMessages,
          importedIdMap,
          storedSession.mortiseId,
        )

        branchedStored.branchFromMessageId = validatedBranch.sourceMessageId
        delete branchedStored.branchFromSdkSessionId
        delete branchedStored.branchFromSessionPath
        delete branchedStored.branchFromPiSessionFile
        delete branchedStored.branchFromSdkCwd
        delete branchedStored.branchFromSdkTurnId
        await saveStoredSession(branchedStored)
      } catch (error) {
        await deleteStoredSession(workspace.id, storedSession.mortiseId).catch(deleteError => {
          sessionLog.warn(`Failed to roll back branch ${storedSession.mortiseId}: ${deleteError instanceof Error ? deleteError.message : deleteError}`)
        })
        throw new Error(`Could not create branch: ${error instanceof Error ? error.message : String(error)}`)
      }

    }

    // Resolve connection/provider/auth/model using the provider-agnostic backend resolver.
    // Reuse precomputed target context so branch validation and session construction share the same target identity.
    const resolvedContext = targetBackendContext
    const resolvedModel = resolvedContext.resolvedModel

    // Log mini agent session creation
    if (options?.systemPromptPreset === 'mini' || options?.model) {
      sessionLog.info(`🤖 Creating mini agent session: model=${resolvedModel}, systemPromptPreset=${options?.systemPromptPreset}`)
    }

    const isBranch = !!validatedBranch

    const managed = createManagedSession(storedSession, workspace, {
      model: resolvedModel,
      provider: sessionProvider,
      thinkingLevel: defaultThinkingLevel,
      systemPromptPreset: options?.systemPromptPreset,
      branchFromMessageId: validatedBranch?.sourceMessageId,
      branchContextStrategy: validatedBranch?.branchContextStrategy,
      branchSeedApplied: validatedBranch ? true : undefined,
      publicationState: provisional ? 'provisional' : undefined,
      messagesLoaded: provisional || !isBranch,  // Branched sessions: lazy-load messages from JSONL
    })

    // Eagerly load messages for branched sessions so the renderer gets the full
    // conversation immediately (needed for scroll-to-bottom on panel open)
    if (isBranch) {
      await this.ensureMessagesLoaded(managed)

      const requiresBranchPreflight = managed.branchContextStrategy === 'sdk-fork'
      if (requiresBranchPreflight) {
        // Enforce branch correctness at creation time.
        // A branch is only valid if backend context can be established now,
        // not deferred to the first user message.
        try {
          await this.getOrCreateAgent(managed)
          await managed.agent!.ensureBranchReady()
        } catch (error) {
          sessionLog.warn('Branch creation failed during backend preflight handshake', {
            workspaceId,
            sessionId: storedSession.mortiseId,
            branchFromSessionId: validatedBranch?.sourceSessionId,
            branchFromMessageId: validatedBranch?.sourceMessageId,
            branchContextStrategy: managed.branchContextStrategy,
            error: error instanceof Error ? error.message : String(error),
          })

          await rollbackFailedBranchCreation({
            managed,
            workspaceId: workspace.id,
            sessionId: storedSession.mortiseId,
            deleteFromRuntimeSessions: (id) => {
              this.sessions.delete(id)
              this.extensionFrontendStates.clearSession(id)
            },
            deleteStoredSession,
          })

          throw new Error(
            `Could not create branch: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    this.sessions.set(storedSession.mortiseId, managed)

    return managedToSession(managed, isBranch ? { messages: managed.messages } : undefined)
  }

  private async disposeManagedAgentRuntime(
    managed: ManagedSession,
    reason: string,
    options: { propagateFailure?: boolean; expectedAgent?: AgentInstance } = {},
  ): Promise<void> {
    const sessionId = managed.id
    const disposalErrors: unknown[] = []
    let childRevocationFailed = false

    if (options.expectedAgent && managed.agent !== options.expectedAgent) {
      throw new Error(`Refused to dispose a replacement agent for ${sessionId} during ${reason}`)
    }

    if (managed.agent) {
      try {
        if (managed.agent.disposeForRestart) {
          await managed.agent.disposeForRestart()
        } else {
          managed.agent.dispose()
        }
      } catch (error) {
        sessionLog.warn(`Failed to dispose agent for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
        disposalErrors.push(error)
      }
    }

    try {
      await this.closeChildAttempts(managed, reason)
    } catch (error) {
      sessionLog.warn(`Failed to close child Attempts for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      disposalErrors.push(error)
      childRevocationFailed = true
    }

    managed.agent = null
    managed.envOverrides = undefined
    managed.agentReady = undefined
    managed.agentReadyResolve = undefined
    managed.backendRuntimeSignature = undefined
    managed.backendRestartSignature = undefined
    unregisterSessionScopedToolCallbacks(sessionId)
    if (disposalErrors.length > 0 && (options.propagateFailure || childRevocationFailed)) {
      throw new AggregateError(disposalErrors, `Failed to fully dispose Session runtime ${sessionId} during ${reason}`)
    }
  }

  /**
   * Refresh an existing agent's runtime config in place when the session's
   * resolved provider signature has drifted from what the agent was created
   * with. No-ops when the agent doesn't exist, when the signature still
   * matches, or when the agent is mid-stream (the gate is `agent.isProcessing()`
   * — `managed.isProcessing` is not used because `sendMessage` flips it before
   * calling `getOrCreateAgent`, which would make every send-path refresh dead
   * code).
   *
   * Concurrency: per-session serialization via `agentRefreshLocks`. A second
   * caller (e.g. `sendMessage` arriving mid-`SAVE`-refresh) awaits the
   * in-flight refresh, then re-evaluates from the post-refresh state — so the
   * subsequent `agent.chat()` is sent only after the subprocess has applied
   * the runtime update (or the agent has been disposed for recreation).
   *
   * The helper distinguishes two kinds of drift:
   *   - Restart-required (provider/auth/slug/piAuthProvider): goes straight
   *     to dispose + recreate because `update_runtime_config` cannot fully
   *     re-route credential/provider state in a live subprocess.
   *   - In-place safe (model/baseUrl/customEndpoint/customModels): attempts
   *     `agent.updateRuntimeConfig` and falls back to dispose if the backend
   *     can't apply the update.
   */
  private async tryRefreshAgentRuntime(managed: ManagedSession, reason: string): Promise<void> {
    // Serialize against any in-flight refresh on this session. The waiter
    // doesn't propagate the prior call's errors — those are logged at the
    // origin call site.
    const inflight = this.agentRefreshLocks.get(managed.id)
    if (inflight) {
      await inflight.catch(() => undefined)
    }

    if (!managed.agent) return

    const backendContext = resolveBackendContext({
      sessionProvider: managed.provider,
      managedModel: managed.model,
    })
    const providerConfig = backendContext.providerConfig
    const sigInput = {
      providerKey: backendContext.providerKey,
      providerConfig,
      provider: backendContext.provider,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)

    if (!managed.backendRuntimeSignature || !managed.backendRestartSignature) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      return
    }

    const restartRequired = managed.backendRestartSignature !== restartSignature
    const runtimeChanged = managed.backendRuntimeSignature !== runtimeSignature

    if (!restartRequired && !runtimeChanged) return

    if (managed.agent.isProcessing()) {
      sessionLog.info(`Runtime config changed for ${managed.id}; deferring refresh until session is idle (${reason})`)
      return
    }

    const work = this.runAgentRuntimeRefresh(
      managed,
      backendContext,
      runtimeSignature,
      restartSignature,
      restartRequired,
      reason,
    )
    // Track the work so concurrent callers serialize. Swallow errors on the
    // tracked promise — the awaiter shouldn't get someone else's exception;
    // errors are logged inside `runAgentRuntimeRefresh`.
    const tracked = work.then(() => undefined, () => undefined)
    this.agentRefreshLocks.set(managed.id, tracked)
    try {
      await work
    } finally {
      // Concurrent callers awaited `tracked` before reaching this point and
      // each registered their own work serially, so the slot is always ours
      // to clear when our own work resolves.
      if (this.agentRefreshLocks.get(managed.id) === tracked) {
        this.agentRefreshLocks.delete(managed.id)
      }
    }
  }

  private async runAgentRuntimeRefresh(
    managed: ManagedSession,
    backendContext: ReturnType<typeof resolveBackendContext>,
    runtimeSignature: string,
    restartSignature: string,
    restartRequired: boolean,
    reason: string,
  ): Promise<void> {
    if (restartRequired) {
      sessionLog.info(`Restart-required field changed for session ${managed.id}; recreating backend runtime (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'restart-required runtime change')
      return
    }

    const providerConfig = backendContext.providerConfig
    let refreshed = false
    if (managed.agent?.updateRuntimeConfig) {
      try {
        refreshed = await managed.agent.updateRuntimeConfig({
          model: backendContext.resolvedModel,
          providerType: providerConfig?.baseUrl ? 'pi_custom' : 'pi',
          authType: backendContext.authType,
          runtime: providerConfig ? {
            baseUrl: normalizeProviderRuntimeBaseUrl(providerConfig),
            piAuthProvider: backendContext.providerKey,
            customEndpoint: providerConfig.api ? { api: providerConfig.api } : undefined,
            customModels: providerConfig.models?.map(model => ({
              id: model.id,
              ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
              ...(model.input ? { supportsImages: model.input.includes('image') } : {}),
            })),
          } : undefined,
        })
      } catch (error) {
        sessionLog.warn(`Runtime config in-place refresh failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (refreshed) {
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      sessionLog.info(`Refreshed runtime config for session ${managed.id} (${reason})`)
    } else {
      sessionLog.info(`Recreating backend runtime for session ${managed.id} after config change (${reason})`)
      await this.disposeManagedAgentRuntime(managed, 'runtime config refresh')
    }
  }

  /**
   * Push a connection's runtime updates (e.g. `supportsImages` toggle) to every
   * active session that uses it. Called from the `providers.SAVE` handler
   * so capability changes reach live Pi subprocesses immediately instead of
   * waiting for the next send to lazily notice the signature drift.
   */
  async refreshProviderRuntime(provider: string): Promise<void> {
    for (const managed of this.sessions.values()) {
      if (managed.provider !== provider) continue
      try {
        await this.tryRefreshAgentRuntime(managed, 'provider update')
      } catch (error) {
        sessionLog.warn(`refreshProviderRuntime failed for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  /**
   * Get or create agent for a session (lazy loading)
   * Creates the appropriate backend agent based on Pi provider.
   *
   * Provider resolution order:
   * 1. session.provider (explicit per-session selection)
   * 2. global provider
   * 3. fallback: no provider configured
   */
  private async getOrCreateAgent(managed: ManagedSession): Promise<AgentInstance> {
    // A Workspace warmup may still be compiling/loading resources in the
    // shared Pi host. Let Session runtime creation join that same preparation
    // Promise so a concurrent first message does not duplicate the cold path.
    await this.waitForWorkspaceRuntimeWarmup(managed.workspace)

    // Recovery callbacks are synchronous once the agent is constructed. Load
    // the durable Pi projection before the agent starts.
    if (!this.piProjectionBySession.has(managed.id)) {
      await this.getPiProjectionSnapshot(managed.id)
    }

    // Refresh runtime config in-place when the connection has drifted since
    // the agent was created. May null out `managed.agent` if the in-place
    // refresh fails, in which case the create branch below rebuilds it.
    await this.tryRefreshAgentRuntime(managed, 'send-path refresh')

    const backendContext = resolveBackendContext({
      sessionProvider: managed.provider,
      managedModel: managed.model,
    })
    const providerConfig = backendContext.providerConfig
    const sigInput = {
      providerKey: backendContext.providerKey,
      providerConfig,
      provider: backendContext.provider,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)

    if (!managed.agent) {
      const end = perf.start('agent.create', { sessionId: managed.id })

      // Persist the first resolved provider so the renderer and session
      // metadata agree, while still allowing the user to switch providers
      // later from the picker.
      if (backendContext.providerKey && !managed.provider) {
        managed.provider = backendContext.providerKey
        sessionLog.info(`Resolved session ${managed.id} to provider "${backendContext.providerKey}"`)
        this.persistSession(managed)

        // Keep renderer session capabilities in sync when auto-locking the connection.
        this.sendEvent({
          type: 'provider_changed',
          sessionId: managed.id,
          provider: backendContext.providerKey,
          supportsBranching: resolveSupportsBranching(managed),
        }, managed.workspace.id)
      }

      const provider = backendContext.provider
      if (providerConfig) {
        sessionLog.info(`Using provider "${backendContext.providerKey}" for session ${managed.id}`)
      } else {
        sessionLog.warn(`No configured provider found for session ${managed.id}`)
      }

      // Set up agentReady promise so title generation can await agent creation
      managed.agentReady = new Promise<void>(r => { managed.agentReadyResolve = r })

      // ============================================================
      // Common session setup
      // ============================================================

      const sessionPath = getSessionStoragePath(managed.workspace.id, managed.id)
      const workspaceRootPath = requirePrimaryLocalWorkspaceRoot(managed.workspace)
      // Per-session env overrides
      const miniModel = providerConfig?.models?.[1]?.id ?? providerConfig?.models?.[0]?.id
      const envOverrides: Record<string, string> = {
        MORTISE_WORKSPACE_PATH: workspaceRootPath,
      }
      managed.envOverrides = envOverrides

      // ============================================================
      // Common session + callback config (identical for all backends)
      // ============================================================

      const sessionConfig = {
        mortiseId: managed.id,
        workspaceId: managed.workspace.id,
        workspaceRootPath,
        sdkSessionId: managed.sdkSessionId,
        branchFromSdkSessionId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkSessionId : undefined,
        branchFromSessionPath: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSessionPath : undefined,
        branchFromPiSessionFile: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromPiSessionFile : undefined,
        branchFromSdkCwd: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkCwd : undefined,
        branchFromSdkTurnId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkTurnId : undefined,
        branchFromMessageId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromMessageId : undefined,
        createdAt: managed.lastMessageAt,
        lastUsedAt: managed.lastMessageAt,
        sdkCwd: managed.sdkCwd ?? workspaceRootPath,
        model: managed.model,
        provider: managed.provider,
        extensionBootstrap: managed.extensionBootstrap,
      }

      const onSdkSessionIdUpdate = (sdkSessionId: string) => {
        managed.sdkSessionId = sdkSessionId
        // Retire branch-only fork metadata now that child session is established
        if (managed.branchFromSdkSessionId) {
          sessionLog.info(`Branch fork established for ${managed.id}: child=${sdkSessionId}, retiring parent fork metadata (parent=${managed.branchFromSdkSessionId})`)
          managed.branchFromSdkSessionId = undefined
          managed.branchFromPiSessionFile = undefined
          managed.branchFromSdkCwd = undefined
          managed.branchFromSdkTurnId = undefined
        } else {
          sessionLog.info(`SDK session ID captured for ${managed.id}: ${sdkSessionId}`)
        }
        this.persistSession(managed)
        void sessionPersistenceQueue.flush(managed.id).catch(error => {
          sessionLog.error(`Failed to flush session ${managed.id} after SDK session ID update:`, error)
        })
      }

      const onSdkSessionIdCleared = () => {
        managed.sdkSessionId = undefined
        sessionLog.info(`SDK session ID cleared for ${managed.id} (resume recovery)`)
        this.persistSession(managed)
        void sessionPersistenceQueue.flush(managed.id).catch(error => {
          sessionLog.error(`Failed to flush session ${managed.id} after SDK session ID clear:`, error)
        })
      }

      const onBranchForkInvalidated = () => {
        managed.sdkSessionId = undefined
        managed.branchFromSdkSessionId = undefined
        managed.branchFromPiSessionFile = undefined
        managed.branchFromSdkCwd = undefined
        managed.branchFromSdkTurnId = undefined
        sessionLog.info(`Branch fork invalidated for ${managed.id}: cleared all fork metadata`)
        this.persistSession(managed)
        void sessionPersistenceQueue.flush(managed.id).catch(error => {
          sessionLog.error(`Failed to flush session ${managed.id} after branch fork invalidation:`, error)
        })
      }

      // 扩展事件桥接：将 Pi RpcClient的扩展事件转发到渲染进程
      const provisionalAwareEventSink: EventSink | null = this.eventSink
        ? ((channel, target, ...args) => {
            const event = args[0] as { type?: unknown } | undefined
            const frontendState = event?.type === 'extension_frontend_state'
              || event?.type === 'extension_contributions_runtime_reset'
            if (!managed.publicationState || frontendState) this.eventSink?.(channel, target, ...args)
          })
        : null
      const forwardExtensionEvent = createExtensionEventForwarder(
        provisionalAwareEventSink,
        managed.workspace.id,
        managed.id,
        this.extensionRuntime.backendType,
      )
      const onExtensionEvent = (event: ExtensionBridgeEvent) => {
        if (event.type === 'extension_frontend_state' || event.type === 'extension_contributions_runtime_reset') {
          const routedEvent = {
            ...event,
            sessionId: managed.id,
            workspaceId: managed.workspace.id,
            backendType: this.extensionRuntime.backendType,
          } as ExtensionFrontendStateEvent | Extract<ExtensionBridgeEvent, { type: 'extension_contributions_runtime_reset' }>
          this.extensionFrontendStates.apply(routedEvent)
          forwardExtensionEvent(routedEvent)
          return
        }
        forwardExtensionEvent(event)
      }
      const onPiProjectionEvent = (event: PiProjectionEventV1) => {
        try {
          this.applyPiProjectionEvent(event)
        } catch (error) {
          sessionLog.error(`Failed to apply Pi projection event for ${managed.id}:`, error)
        }
      }
      const onAgentEvent = (event: AgentEvent) => {
        managed.agentEventChain = managed.agentEventChain.then(async () => {
          if (this.sessions.get(managed.id) !== managed || managed.deleting) return
          if (event.type === 'pi_user_message_persisted') {
            this.handlePiUserMessagePersisted(managed, event.clientMutationId)
            return
          }
          await this.processEvent(managed, event)
          if (event.type !== 'complete') return
          if (managed.stopRequested) {
            await this.onProcessingStopped(managed.id, 'interrupted')
            return
          }
          if (managed.authRetryInProgress) {
            await this.resumeAfterAuthFailure(managed)
            return
          }
          await this.onProcessingStopped(
            managed.id,
            event.terminalStatus === 'failed' ? 'error' : 'complete',
          )
        }).catch(async error => {
          sessionLog.error(`Failed to consume Pi Session event for ${managed.id}:`, error)
          if (this.sessions.get(managed.id) === managed && managed.isProcessing) {
            await this.onProcessingStopped(managed.id, 'error').catch(settlementError => {
              sessionLog.error(`Failed to settle Session ${managed.id} after event consumer error:`, settlementError)
            })
          }
        })
      }
      const onHostCapabilityRequest = (
        request: import('@mortise/shared/protocol').CapabilityRequestV1,
        onProgress: (event: import('@mortise/shared/protocol').CapabilityProgressV1) => void,
      ) => this.capabilityRouter.invoke(request, onProgress)
      const onHostCapabilityDeclaration = (declaration: import('@mortise/shared/protocol').ExtensionCapabilityDeclarationV1) => {
        this.capabilityRouter.declare(declaration)
      }
      const onHostCapabilityCancel = (requestId: string, runtimeId: string) => {
        this.capabilityRouter.cancel(requestId, runtimeId)
      }
      const onHostCapabilityRuntimeReleased = (runtimeId: string) => {
		this.capabilityRouter.releaseRuntime(runtimeId)
      }
      const getRecoveryMessages = () => {
        const snapshot = this.piProjectionBySession.get(managed.id)?.createSnapshot()
        return getPiProjectionRecoveryMessages(snapshot)
      }

      const getPiProjectionSnapshot = () => (
        this.piProjectionBySession.get(managed.id)?.createSnapshot()
      )
      const onChildAttemptStarted = (request: ChildAttemptRegistrationRequest) => {
        const task = this.registerChildAttempt(managed, request)
        void this.trackSubagentLifecycleTask(managed, task.then(() => undefined))
        return task
      }
      const getChildAttempt = (runtimeId: string, childSessionId: string): ChildAttemptRegistration | undefined => {
        const record = this.getChildAttemptRecord(managed, runtimeId)
        if (!record || record.state !== 'open' || record.childSessionId !== childSessionId) return undefined
        return { attemptId: record.attemptId }
      }
      const onChildAttemptAbandoned = (runtimeId: string, childSessionId: string, attemptId: string) => (
        this.trackSubagentLifecycleTask(
          managed,
          this.abandonChildAttempt(managed, runtimeId, childSessionId, attemptId),
        )
      )
      const onChildAttemptSettled = (runtimeId: string, childSessionId: string, attemptId: string) => (
        this.trackSubagentLifecycleTask(
          managed,
          this.settleChildAttempt(managed, runtimeId, childSessionId, attemptId),
        )
      )
      const onChildTaskSettled = async (operation: ChildTaskSettledOperation) => {
        const record = this.getChildAttemptRecord(managed, operation.runtimeId, operation.attemptId)
        if (!record || !record.operationIds.has(operation.operationId)) {
          writeRuntimeLog('warn', {
            scope: 'session-control',
            event: 'stale_child_settlement_rejected',
            meta: {
              sessionId: managed.id,
              runtimeId: operation.runtimeId,
              attemptId: operation.attemptId,
              operationId: operation.operationId,
            },
          })
          return
        }
        await this.trackSubagentLifecycleTask(
          managed,
          this.settleChildOperation(managed, record, operation, {
            deliver: !managed.deleting && this.sessions.get(managed.id) === managed,
          }),
        )
      }
      const onChildTaskActivity = (event: import('@mortise/shared/agent').ChildTaskActivityEvent) => {
        this.sendEvent({
          type: 'subagent_event',
          sessionId: managed.id,
          taskId: event.childSessionId,
          phase: event.phase,
          status: event.status,
          summary: event.summary,
          timestamp: event.timestamp,
        }, managed.workspace.id)
      }
      const onChildToolExecutionCompleted = (result: ChildToolExecutionCompleted) => (
        this.trackSubagentLifecycleTask(managed, this.completeChildToolSideEffect(managed, result))
      )

      const getBranchFallbackMessages = () => {
        if (!managed.branchFromMessageId) return []
        return getPiProjectionConversationMessages(
          this.piProjectionBySession.get(managed.id)?.createSnapshot(),
        )
      }

      const getBranchSeedMessages = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return []
        if (managed.branchSeedApplied) return []

        return getPiProjectionConversationMessages(
          this.piProjectionBySession.get(managed.id)?.createSnapshot(),
        )
      }

      const markBranchSeedApplied = () => {
        if (managed.branchContextStrategy !== 'seeded-fresh-session') return
        if (managed.branchSeedApplied) return
        managed.branchSeedApplied = true
        sessionLog.info('Branch seed context applied', {
          sessionId: managed.id,
          strategy: managed.branchContextStrategy,
        })
      }

      const getTransferredSessionSummary = () => {
        const summary = managed.transferredSessionSummaryApplied ? null : (managed.transferredSessionSummary ?? null)
        sessionLog.info(`[transfer-context] getTransferredSessionSummary for ${managed.id}: applied=${managed.transferredSessionSummaryApplied}, has_summary=${!!managed.transferredSessionSummary}, returning=${summary ? `${summary.length} chars` : 'null'}`)
        return summary
      }

      const markTransferredSessionSummaryApplied = () => {
        if (managed.transferredSessionSummaryApplied || !managed.transferredSessionSummary) return
        managed.transferredSessionSummaryApplied = true
        this.persistSession(managed)
        sessionLog.info('Transferred session summary applied', {
          sessionId: managed.id,
        })
      }

      // ============================================================
      // Construct backend via factory
      // ============================================================

      const backendCoreConfig: CoreBackendConfig = {
        workspace: managed.workspace,
        miniModel,
        thinkingLevel: managed.thinkingLevel,
        session: sessionConfig,
        onSdkSessionIdUpdate,
        onSdkSessionIdCleared,
        onBranchForkInvalidated,
        getRecoveryMessages,
        getPiProjectionSnapshot,
        getBranchFallbackMessages,
        getBranchSeedMessages,
        markBranchSeedApplied,
        getTransferredSessionSummary,
        markTransferredSessionSummaryApplied,
        envOverrides,
        // Claude-specific
        isHeadless: !AGENT_FLAGS.defaultModesEnabled,
        skipConfigWatcher: true, // Server owns workspace-level ConfigWatcher — don't duplicate in agents
        automationEventSink: async (event, input) => {
          const host = this.automationHosts.get(managed.workspace.id)
          if (!host) return
          const result = await host.acceptEvent({
            specversion: '1.0',
            id: randomUUID(),
            source: `mortise://agent/${managed.id}`,
            type: event,
            time: new Date().toISOString(),
            datacontenttype: 'application/json',
            mortisesessionid: managed.id,
            data: input,
          }, {
            sourceKind: 'agent',
            matchValue: input.tool_name ?? input.source ?? '',
          })
          if (result.status !== 'accepted' && result.status !== 'duplicate') {
            throw new Error(result.error?.message ?? `Automation event rejected: ${result.status}`)
          }
        },
        systemPromptPreset: managed.systemPromptPreset,
        debugMode: _platform?.isDebugMode ? { enabled: true, logFilePath: _platform.getLogFilePath?.() } : undefined,
        // Image resize callback — prevents oversized images from entering conversation history
        onImageResize: async (filePath: string, maxSizeBytes: number): Promise<string | null> => {
          try {
            const buffer = await readFile(filePath)
            const result = await resizeImageForAPI(buffer, { maxSizeBytes })
            if (!result) return null

            // Write to session tmp directory (cleaned up with session)
            const sessionTmpDir = join(sessionPath, 'tmp')
            await mkdir(sessionTmpDir, { recursive: true })
            const ext = result.format === 'jpeg' ? 'jpg' : 'png'
            const outPath = join(sessionTmpDir, `resized-${randomUUID()}.${ext}`)
            await writeFile(outPath, result.buffer)

            sessionLog.info(`Image resized for Read: ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(result.buffer.length / 1024 / 1024).toFixed(1)}MB (→ ${result.width}×${result.height})`)
            return outPath
          } catch (err) {
            sessionLog.error('Image resize failed:', err)
            return null
          }
        },
        // 扩展事件桥接回调：将 Pi RpcClient的扩展事件转发到渲染进程
        onExtensionEvent,
        onPiProjectionEvent,
        onAgentEvent,
        onChildAttemptStarted,
        getChildAttempt,
        onChildAttemptAbandoned,
        onChildAttemptSettled,
        onChildTaskSettled,
        onChildTaskActivity,
        onChildToolExecutionCompleted,
        onHostCapabilityRequest,
        onHostCapabilityDeclaration,
        onHostCapabilityCancel,
		onHostCapabilityRuntimeReleased,
      }
      managed.agent = this.createSessionBackend({
        context: backendContext,
        coreConfig: backendCoreConfig,
        provisional: managed.publicationState === 'provisional',
        createDefaultBackend: () => createBackendFromResolvedContext({
          context: backendContext,
          hostRuntime: buildBackendHostRuntimeContext(),
          coreConfig: backendCoreConfig,
        }),
      }) as AgentInstance

      sessionLog.info(`Created ${provider} agent for session ${managed.id} (model: ${backendContext.resolvedModel})${managed.sdkSessionId ? ' (resuming)' : ''}`)

      // ============================================================
      // Post-construction: debug callback, auth callback, postInit()
      // ============================================================

      managed.agent.onDebug = (msg: string) => sessionLog.info(msg)

      managed.agent.onBeforeToolExecution = async ({ runtimeId, toolCallId, toolName, attemptId }) => {
        if (!attemptId) return { allowed: false, reason: 'Pi Attempt identity is unavailable' }
        try {
          await this.recordToolSideEffect(managed, {
			attemptId,
            toolCallId,
            toolName,
            status: 'started',
          })
          if (runtimeId) this.getChildAttemptRecord(managed, runtimeId, attemptId)?.pendingTools.set(toolCallId, { toolName })
          else managed.pendingToolSideEffects.set(toolCallId, { attemptId, toolName })
          return { allowed: true }
        } catch (error) {
          sessionLog.error(`Failed to establish tool side-effect receipt for ${toolCallId}:`, error)
          return { allowed: false, reason: 'The tool start could not be durably recorded' }
        }
      }

      // Unified auth callback — replaces per-backend onChatGptAuthRequired/onGithubAuthRequired
      managed.agent.onBackendAuthRequired = (reason: string) => {
        sessionLog.warn(`Backend auth required for session ${managed.id}: ${reason}`)
        void this.projectHostRuntimeError(managed, {
          phase: 'startup',
          code: 'backend_auth_required',
          message: `Authentication required: ${reason}`,
          retryable: true,
        })
      }

      // Run post-init (auth injection) — each backend handles its own
      const postInitResult = await managed.agent.postInit()
      if (postInitResult.authWarning) {
        sessionLog.warn(`Auth warning for session ${managed.id}: ${postInitResult.authWarning}`)
        await this.projectHostRuntimeError(managed, {
          phase: 'startup',
          code: 'backend_auth_warning',
          message: postInitResult.authWarning,
          retryable: true,
        })
      }

      // Signal that the agent instance is ready (unblocks title generation)
      managed.agentReadyResolve?.()

      // Extension policy runs inside Pi. The host only supplies the neutral
      // tool execution boundary and generic frontend channel router.

      // Wire up plan review as Host control flow. The plan artifact itself is
      // projected by Pi; this event is only for external messaging consumers
      // and never enters the Mortise transcript.
      managed.agent.onPlanSubmitted = async (planPath) => {
        sessionLog.info(`Plan submitted for session ${managed.id}:`, planPath)
        let planContent = ''
        try {
          planContent = await readFile(planPath, 'utf-8')
        } catch (error) {
          sessionLog.error(`Failed to read plan file:`, error)
        }

        const planMessage = createSubmittedPlanMessage(
          managed.id,
          planPath,
          planContent,
          this.monotonic(),
        )
        managed.lastMessageRole = 'assistant'
        this.sendEvent({
          type: 'plan_submitted',
          sessionId: managed.id,
          message: planMessage,
        }, managed.workspace.id)

        // Interrupt execution - plan presentation is a stopping point.
        if (managed.isProcessing && managed.agent) {
          sessionLog.info(`Interrupting for plan submission in session ${managed.id}`)
          managed.agent.interruptForHandoff(AbortReason.PlanSubmitted)
          this.setProcessing(managed, false)

          await releaseBrowserOwnershipOnForcedStop(
            (sid) => this.getBrowserPaneManagerForSession(sid),
            managed.id,
          )

          this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage }, managed.workspace.id)
          this.persistSession(managed)
        }
      }

      const mapChildRun = (child: import('@mortise/shared/agent').PiChildSessionInfo): AgentRunRecord => ({
        taskId: child.sessionId,
        status: child.status,
        ...(child.spawnConfig?.agent ? { agent: child.spawnConfig.agent } : {}),
        ...(child.lastOutput ? { output: child.lastOutput } : {}),
        ...(child.error ? { error: child.error } : {}),
        ...(child.spawnConfig?.schema ? { schema: child.spawnConfig.schema } : {}),
      })
      const subagentRuns = new AgentRunService({
        resolveAgents: () => resolveSubagentConfigs({ cwd: requirePrimaryLocalWorkspaceRoot(managed.workspace) }),
        adapter: {
          list: async () => {
            const parentSessionId = managed.agent?.getSessionId()
            if (!parentSessionId) return []
            return (await managed.agent?.listChildSessions?.(parentSessionId) ?? []).map(mapChildRun)
          },
          start: async options => {
            const agent = managed.agent
            const parentSessionId = agent?.getSessionId()
            if (!agent?.spawnChildSession || !parentSessionId) throw new Error('Subagent execution is unavailable')
            const result = await agent.spawnChildSession(parentSessionId, {
              prompt: options.prompt,
              connection: managed.provider,
              model: options.model ?? managed.model,
              thinkingLevel: options.thinkingLevel,
              template: options.agent,
              agent: options.agent,
              forkTurns: options.forkTurns,
              systemPrompt: options.systemPrompt,
              tools: options.tools,
              schema: options.schema,
              background: true,
            })
            this.sendEvent({ type: 'subagent_event', sessionId: managed.id, taskId: result.sessionId, phase: 'started', status: result.status }, managed.workspace.id)
            return { taskId: result.sessionId, status: result.status, ...(options.agent ? { agent: options.agent } : {}) }
          },
          message: async (taskId, prompt) => {
            const agent = managed.agent
            const parentSessionId = agent?.getSessionId()
            if (!agent?.sendChildSessionMessage || !parentSessionId) throw new Error('Subagent messaging is unavailable')
            const result = await agent.sendChildSessionMessage(parentSessionId, taskId, prompt, { background: true })
            this.sendEvent({ type: 'subagent_event', sessionId: managed.id, taskId, phase: 'status', status: result.status, summary: 'Subagent received a new message' }, managed.workspace.id)
            return { taskId: result.sessionId, status: result.status, ...(result.output ? { output: result.output } : {}) }
          },
          resume: async taskId => {
            const agent = managed.agent
            const parentSessionId = agent?.getSessionId()
            if (!agent?.resumeChildSession || !parentSessionId) throw new Error('Subagent resume is unavailable')
            const current = (await agent.listChildSessions?.(parentSessionId) ?? []).find(child => child.sessionId === taskId)
            if (!current) throw new Error(`Subagent task not found: ${taskId}`)
            if (current.status !== 'interrupted') throw new Error(`Only interrupted subagent tasks can be resumed: ${taskId}`)
            const result = await agent.resumeChildSession(parentSessionId, taskId, { background: true })
            this.sendEvent({ type: 'subagent_event', sessionId: managed.id, taskId, phase: 'status', status: result.status, summary: 'Subagent resumed' }, managed.workspace.id)
            return { taskId: result.sessionId, status: result.status, ...(result.output ? { output: result.output } : {}) }
          },
          interrupt: async taskId => {
            const agent = managed.agent
            const parentSessionId = agent?.getSessionId()
            if (!agent?.interruptChildSession || !parentSessionId) throw new Error('Subagent interruption is unavailable')
            const result = await agent.interruptChildSession(parentSessionId, taskId)
            this.sendEvent({ type: 'subagent_event', sessionId: managed.id, taskId, phase: 'status', status: result.status, summary: 'Subagent interrupted' }, managed.workspace.id)
            return { taskId: result.sessionId, status: result.status, ...(result.output ? { output: result.output } : {}) }
          },
          persistResult: async (taskId, result) => {
            const dir = join(getSessionStoragePath(managed.workspace.id, managed.id), 'subagent-results')
            await mkdir(dir, { recursive: true })
            const path = join(dir, `${taskId}.json`)
            await atomicWriteFile(path, `${JSON.stringify(result, null, 2)}\n`)
            return path
          },
        },
      })
      managed.agent.onSubagent = async (request) => {
        if (managed.deleting || this.sessions.get(managed.id) !== managed) {
          throw new Error(`Session ${managed.id} is being deleted`)
        }
        sessionLog.info(`Subagent ${request.action} request from Session ${managed.id}:`, request.taskId || request.agent || '(default)')
        return subagentRuns.execute(request)
      }
      void this.recoverBackgroundChildOperations(managed).catch(error => {
        sessionLog.error(`Failed to recover child task deliveries for ${managed.id}:`, error)
      })

      // Wire ordinary Session tools to the shared coordination service.
      mergeSessionScopedToolCallbacks(managed.id, {
        listSessionsFn: options => this.sessionCoordinator.list(managed.workspace.id, options),
        createSessionFn: request => this.sessionCoordinator.create(managed.workspace.id, request),
        readSessionFn: (sessionId, options) => this.sessionCoordinator.read(managed.workspace.id, sessionId, options),
        sendMessageToSessionFn: request => this.sessionCoordinator.send(managed.workspace.id, request),
      })

      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      end()
    }
    return managed.agent
  }

  /**
   * Set the Pi provider for a session.
   * This determines which LLM provider/backend will be used for this session.
   */
  async setSessionProvider(sessionId: string, provider: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`setSessionProvider: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    // Validate provider exists.
    if (!hasConfiguredPiProvider(provider)) {
      sessionLog.warn(`setSessionProvider: provider "${provider}" not found`)
      throw new Error(`Provider "${provider}" not found`)
    }

    managed.provider = provider
    // Persist in-memory state directly to avoid race with pending queue writes
    this.persistSession(managed)
    await this.flushSession(managed.id)
    await this.tryRefreshAgentRuntime(managed, 'session provider changed')
    sessionLog.info(`Set provider for session ${sessionId} to ${provider}`)

    // Notify UI that the provider changed.
    this.sendEvent({
      type: 'provider_changed',
      sessionId,
      provider,
      supportsBranching: resolveSupportsBranching(managed),
    }, managed.workspace.id)
  }

  /**
   * Move future sessions to a Pi host with a fresh models/auth registry and
   * rebuild idle session runtimes. Active turns finish before their rebuild.
   */
  async reloadProviderRuntime(provider?: string): Promise<void> {
    await invalidateBackendRuntimes('provider-config-changed')
    await Promise.all([...this.workspaceRuntimeWarmups.keys()].map(async (workspaceId) => {
      await this.disposeWorkspaceRuntimeWarmup(workspaceId, 'provider registry reload')
      const workspace = getWorkspaces().find(candidate => candidate.id === workspaceId)
      if (workspace) void this.ensureWorkspaceRuntimeWarmup(workspace)
    }))
    for (const managed of this.sessions.values()) {
      const effectiveProvider = resolveBackendContext({
        sessionProvider: managed.provider,
        managedModel: managed.model,
      }).providerKey
      if (provider && effectiveProvider !== provider) continue
      if (!managed.agent) continue
      if (managed.agent.isProcessing()) {
        managed.pendingProviderRuntimeRestart = true
        sessionLog.info(`Deferring provider runtime reload for active session ${managed.id}`)
        continue
      }
      await this.disposeManagedAgentRuntime(managed, 'provider registry reload')
    }
  }

  getExtensionReloadActiveSessions(): PiExtensionReloadActiveSession[] {
    const active: PiExtensionReloadActiveSession[] = []
    for (const managed of this.sessions.values()) {
      if (!managed.isProcessing && !this.isPiProjectionProcessing(managed.id)) continue
      active.push({
        sessionId: managed.id,
        workspaceName: managed.workspace.name,
        title: managed.name || undefined,
      })
    }
    return active
  }

  async requestExtensionReload(interruptRunning: boolean): Promise<PiExtensionReloadResult> {
    if (this.extensionReloadPromise) return await this.extensionReloadPromise
    const activeSessions = this.getExtensionReloadActiveSessions()
    if (activeSessions.length > 0 && !interruptRunning) {
      return { status: 'confirmation_required', activeSessions }
    }

    this.extensionReloadPromise = (async () => {
      const currentActiveSessions = this.getExtensionReloadActiveSessions()
      if (currentActiveSessions.length > 0 && !interruptRunning) {
        return { status: 'confirmation_required', activeSessions: currentActiveSessions }
      }
      if (interruptRunning) {
        await Promise.all(currentActiveSessions.map((session) => this.cancelProcessing(session.sessionId, false)))
      }

      const targets = Array.from(this.sessions.values()).filter(
        (managed) => managed.agent && typeof managed.agent.reloadExtensions === 'function',
      )
      // A warm runtime publishes its agent handle before preparation finishes.
      // Join that promise so reload cannot race extension activation on the
      // same runtime or retain a handle that preparation just disposed.
      await Promise.all([...this.workspaceRuntimeWarmups.values()].map(state => state.ready.catch(() => undefined)))
      const warmupTargets = [...this.workspaceRuntimeWarmups.values()]
        .filter((state): state is WorkspaceRuntimeWarmup & { agent: AgentBackend } => Boolean(state.agent))
      const results = await Promise.allSettled(targets.map(async (managed) => ({
        sessionId: managed.id,
        result: await managed.agent!.reloadExtensions!(),
      })))
      const warmupResults = await Promise.allSettled(warmupTargets.map(async (state) => ({
        workspaceId: state.workspaceId,
        result: state.agent.reloadExtensions ? await state.agent.reloadExtensions() : { reloaded: false, deferred: false },
      })))
      const failures = [
        ...results.flatMap((result, index) => result.status === 'rejected'
          ? [`${targets[index]?.id ?? 'unknown session'}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
          : []),
        ...warmupResults.flatMap((result, index) => result.status === 'rejected'
          ? [`Workspace ${warmupTargets[index]?.workspaceId ?? 'unknown'}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
          : []),
      ]
      if (failures.length > 0) throw new Error(`Failed to reload Pi extensions: ${failures.join('; ')}`)

      let reloadedSessionCount = 0
      let deferredSessionCount = 0
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        if (result.value.result.reloaded) reloadedSessionCount += 1
        if (result.value.result.deferred) deferredSessionCount += 1
      }

      const openWorkspaceIds = typeof (this.extensionRuntime as Partial<BackendExtensionRuntimeRegistry>).getOpenWorkspaceIds === 'function'
        ? this.extensionRuntime.getOpenWorkspaceIds()
        : [...this.workspaceRuntimeWarmups.keys()]
      this.extensionRuntime.clear()
      if (typeof (this.extensionRuntime as Partial<BackendExtensionRuntimeRegistry>).openGlobal === 'function') {
        await this.extensionRuntime.openGlobal()
      }
      await Promise.all(openWorkspaceIds.map(async (workspaceId) => {
        const workspace = getWorkspaces().find(candidate => candidate.id === workspaceId)
        if (workspace) await this.openWorkspaceExtensions(workspace)
      }))
      return {
        status: 'reloaded',
        interruptedSessionCount: interruptRunning ? currentActiveSessions.length : 0,
        reloadedSessionCount,
        deferredSessionCount,
      }
    })()

    try {
      return await this.extensionReloadPromise
    } finally {
      this.extensionReloadPromise = null
    }
  }

  async getAgentRuntimeProfile(): Promise<import('@mortise/shared/config').AgentRuntimeProfile | null> {
    for (const managed of this.sessions.values()) {
      if (!managed.agent?.getAgentProfile) continue
      try {
        return await managed.agent.getAgentProfile()
      } catch (error) {
        sessionLog.warn(
          `Failed to inspect agent runtime for session ${managed.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return null
  }

  async getExtensionServiceCatalog(sessionId?: string): Promise<import('@mortise/shared/protocol').ExtensionServiceCatalogDTO> {
    const candidates = sessionId ? [this.sessions.get(sessionId)] : [...this.sessions.values()]
    for (const managed of candidates) {
      if (managed?.agent?.extensionServicesList) return await managed.agent.extensionServicesList()
    }
    return { protocolVersion: 1, runtimeId: '', scope: 'session', providers: [], consumers: [] }
  }

  async invokeExtensionService(input: { requestId: string; runtimeId?: string; sessionId?: string; capability: string; operation: string; provider?: string; input: unknown; timeoutMs?: number; signal?: AbortSignal }): Promise<import('@mortise/shared/protocol').ExtensionServiceResultDTO> {
    const candidates = input.sessionId ? [this.sessions.get(input.sessionId)] : [...this.sessions.values()]
    for (const managed of candidates) {
      if (!managed) continue
      const agent = managed.agent
      if (agent?.extensionServicesInvoke) {
        if (input.runtimeId && agent.extensionServicesList) {
          const catalog = await agent.extensionServicesList()
          if (catalog.runtimeId !== input.runtimeId) {
            return {
              protocolVersion: 1,
              requestId: input.requestId,
              runtimeId: catalog.runtimeId,
              status: 'runtime_stale',
              error: {
                code: 'extension_service_runtime_stale',
                message: `Extension service runtime is stale: expected ${input.runtimeId}, current ${catalog.runtimeId}`,
              },
            }
          }
        }
        const cancel = () => void agent.extensionServicesCancel?.(input.requestId)
        input.signal?.addEventListener('abort', cancel, { once: true })
        try {
          return await agent.extensionServicesInvoke({ requestId: input.requestId, runtimeId: input.runtimeId, sessionId: input.sessionId, capability: input.capability, operation: input.operation, input: input.input, provider: input.provider, timeoutMs: input.timeoutMs })
        } finally {
          input.signal?.removeEventListener('abort', cancel)
        }
      }
    }
    return {
      protocolVersion: 1,
      requestId: input.requestId,
      runtimeId: '',
      status: 'unavailable',
      error: {
        code: 'extension_service_runtime_unavailable',
        message: 'No active Pi session is available for extension services.',
      },
    }
  }

  /**
   * Clear per-session overrides for a provider that was deleted from Pi global
   * config. The next resolution inherits the global default instead
   * of silently routing through it while retaining the stale key.
   */
  async clearDeletedProviderReferences(provider: string): Promise<void> {
    const affected = [...this.sessions.values()].filter(managed => managed.provider === provider)

    await Promise.all(affected.map(async (managed) => {
      managed.provider = undefined
      this.setMetadataWriteGuard(managed)

      try {
        this.persistSession(managed)
        await this.flushSession(managed.id)
      } catch (error) {
        // Startup repair retries an unsuccessful persistence attempt on the
        // next launch, while this process has already dropped the stale key.
        sessionLog.warn(`Failed to persist cleared provider for ${managed.id}: ${error instanceof Error ? error.message : error}`)
      }

      this.sendEvent({
        type: 'provider_changed',
        sessionId: managed.id,
        provider: undefined,
        supportsBranching: resolveSupportsBranching(managed),
      }, managed.workspace.id)
    }))
  }

  // ============================================
  // Pending Plan Execution (Accept & Compact)
  // ============================================

  /**
   * Read/write compatibility for sessions created before plan-mode became a
   * V2 extension. New plan frontends persist their own state and must not call
   * this host method.
   */
  async setPendingPlanExecution(sessionId: string, target: string | { planPath?: string; artifactId?: string }, draftInputSnapshot?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await setStoredPendingPlanExecution(managed.workspace.id, sessionId, target, draftInputSnapshot)
      const normalizedTarget = typeof target === 'string' ? { planPath: target } : target
      managed.pendingPlanExecution = {
        ...normalizedTarget,
        draftInputSnapshot,
        awaitingCompaction: true,
        executionDispatched: false,
      }
      sessionLog.info('Session pending plan execution set', { sessionId, target })
    }
  }

  /** Legacy pending-plan compatibility; V2 extensions receive compaction events directly. */
  async markCompactionComplete(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredCompactionComplete(managed.workspace.id, sessionId)
      if (managed.pendingPlanExecution) {
        managed.pendingPlanExecution.awaitingCompaction = false
      }
      managed.pendingCompactionCompletion = false
      sessionLog.info(`Session ${sessionId}: compaction marked complete for pending plan`)
    }
  }

  /** Legacy pending-plan compatibility; kept for old RPC clients only. */
  async markPendingPlanExecutionDispatched(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredPendingPlanExecutionDispatched(managed.workspace.id, sessionId)
      sessionLog.info(`Session ${sessionId}: marked pending plan execution as dispatched`)
    }
  }

  /** Legacy pending-plan compatibility cleanup. */
  async clearPendingPlanExecution(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await clearStoredPendingPlanExecution(managed.workspace.id, sessionId)
      managed.pendingPlanExecution = undefined
      sessionLog.info(`Session ${sessionId}: cleared pending plan execution`)
    }
  }

  /** Read-only legacy pending-plan state for one-time extension migration. */
  getPendingPlanExecution(sessionId: string): { planPath?: string; artifactId?: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getStoredPendingPlanExecution(managed.workspace.id, sessionId)
  }

  /**
   * Legacy non-renderer compatibility route. Plan execution is owned by the
   * plan-mode extension; the host only forwards the command.
   */
  async acceptPlan(sessionId: string, planPath?: string): Promise<void> {
    const result = await this.invokeExtensionCommand(
      sessionId,
      'plan-execute',
      JSON.stringify({ ...(planPath ? { planPath } : {}) }),
      'plan-mode',
    )
    if (!result.invoked) throw new Error(result.error ?? 'The plan-mode extension is unavailable.')
  }

  /**
   * Resolve a Mortise-owned annotation overlay by Pi message identity. Runtime
   * Pi messages are intentionally not copied into `managed.messages`; when a
   * newly projected message has no overlay yet, keep only an empty placeholder
   * so persistence writes annotations without introducing transcript content.
   */
  private getProjectionOverlayMessage(
    managed: ManagedSession,
    messageId: string,
    create = false,
  ): Message | undefined {
    if (!managed.messagesLoaded) this.hydrateMessagesForColdPersist(managed)
    const snapshot = this.piProjectionBySession.get(managed.id)?.createSnapshot()
    const ownsMessage = snapshot?.entities.some((entity) => {
      if (entity.entityType !== 'content_block' && entity.entityType !== 'artifact_ref') return false
      if (!entity.payload || typeof entity.payload !== 'object') return false
      const payload = entity.payload as Record<string, unknown>
      return payload.messageId === messageId
        || payload.assistantMessageId === messageId
        || payload.ownerMessageId === messageId
    }) ?? false
    if (!ownsMessage) return undefined

    const existing = managed.messages.find(message => message.id === messageId)
    if (existing || !create) return existing

    const placeholder: Message = {
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: this.monotonic(),
    }
    managed.messages.push(placeholder)
    return placeholder
  }

  private upsertUserMessageOverlay(
    managed: ManagedSession,
    messageId: string,
    attachments: StoredAttachment[] | undefined,
    badges: Message['badges'] | undefined,
    isQueued: boolean,
  ): void {
    const existing = managed.messages.find(message => message.id === messageId)
    if (!existing && !attachments?.length && !badges?.length) return
    const overlay = existing ?? {
      id: messageId,
      role: 'user' as const,
      content: '',
      timestamp: this.monotonic(),
    }
    overlay.attachments = attachments
    overlay.badges = badges
    overlay.isQueued = isQueued
    overlay.isPending = false
    if (!existing) managed.messages.push(overlay)
  }

  /**
   * Set which session the user is actively viewing.
   * Called when user navigates to a session. Used to determine whether to mark
   * new messages as unread - if user is viewing, don't mark unread.
   */
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) {
      this.activeViewingSession.set(workspaceId, sessionId)
      // When user starts viewing a session that's not processing, clear unread
      const managed = this.sessions.get(sessionId)
      if (managed && !managed.isProcessing && managed.hasUnread) {
        this.markSessionRead(sessionId)
      }
    } else {
      this.activeViewingSession.delete(workspaceId)
    }
  }

  /**
   * Clear active viewing session for a workspace.
   * Called when all windows leave a workspace to ensure read/unread state is correct.
   */
  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingSession.delete(workspaceId)
  }

  /**
   * Check if a session is currently being viewed by the user
   */
  private isSessionBeingViewed(sessionId: string, workspaceId: string): boolean {
    return this.activeViewingSession.get(workspaceId) === sessionId
  }

  /**
   * Mark a session as read by setting lastReadMessageId and clearing hasUnread.
   * Called when user navigates to a session (and it's not processing).
   */
  async markSessionRead(
    sessionId: string,
    options: { allowWhileSettling?: boolean } = {},
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    // Only mark as read if not currently processing
    // (user is viewing but we want to wait for processing to complete)
    if (managed.isProcessing && !options.allowWhileSettling) return

    let needsPersist = false
    const updates: { lastReadMessageId?: string; hasUnread?: boolean } = {}

    // Projection is authoritative for transcript identity; Mortise only stores
    // the read cursor as an overlay.
    const lastFinalId = managed.lastFinalMessageId
    if (lastFinalId && managed.lastReadMessageId !== lastFinalId) {
      managed.lastReadMessageId = lastFinalId
      updates.lastReadMessageId = lastFinalId
      needsPersist = true
    }

    // Clear hasUnread flag (primary source of truth for NEW badge)
    if (managed.hasUnread) {
      managed.hasUnread = false
      updates.hasUnread = false
      needsPersist = true
    }

    // Persist changes
    if (needsPersist) {
      await updateSessionMetadata(managed.workspace.id, sessionId, updates)
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark a session as unread by setting hasUnread flag.
   * Called when user manually marks a session as unread via context menu.
   */
  async markSessionUnread(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.hasUnread = true
      managed.lastReadMessageId = undefined
      // Persist to disk
      await updateSessionMetadata(managed.workspace.id, sessionId, { hasUnread: true, lastReadMessageId: undefined })
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark all non-hidden sessions in a workspace as read.
   * Called from "Mark All Read" context menu on "All Sessions".
   */
  async markAllSessionsRead(workspaceId: string): Promise<void> {
    const updates: Promise<void>[] = []
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.hidden) continue
      if (managed.isProcessing) continue
      if (!managed.hasUnread) continue
      managed.hasUnread = false
      updates.push(
        updateSessionMetadata(managed.workspace.id, managed.id, { hasUnread: false })
      )
    }
    if (updates.length > 0) {
      await Promise.all(updates)
      this.emitUnreadSummaryChanged()
    }
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.name = name
      this.persistSession(managed)
      // Notify renderer of the name change
      this.sendEvent({ type: 'title_generated', sessionId, title: name }, managed.workspace.id)
    }
  }

  /**
   * Regenerate the session title based on recent messages.
   * Uses the last few user messages to capture what the session has evolved into.
   * Automatically uses the same provider as the session (Claude or OpenAI).
   */
  async refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }> {
    sessionLog.info(`refreshTitle called for session ${sessionId}`)
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`refreshTitle: Session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    const conversation = getPiProjectionConversationMessages(
      (await this.getPiProjectionSnapshot(sessionId)) ?? undefined,
    )
    const allUserContents = conversation
      .filter(message => message.type === 'user')
      .map(message => message.content)
    const userMessages = selectSpreadMessages(allUserContents)

    sessionLog.info(`refreshTitle: Selected ${userMessages.length} spread messages from ${allUserContents.length} total`)

    if (userMessages.length === 0) {
      sessionLog.warn(`refreshTitle: No user messages found`)
      return { success: false, error: 'No user messages to generate title from' }
    }

    const assistantResponse = conversation.findLast(message => message.type === 'assistant')?.content ?? ''

    // Resolve title language from the explicitly persisted UI language (disk-backed,
    // race-free vs. main-process i18n async hydration); undefined => auto-detect (#885).
    const titleLanguage = resolveTitleLanguageName()
    const titleOptions = { language: titleLanguage }
    sessionLog.info(`[refreshTitle] language at call time`, {
      sessionId,
      persistedUiLanguage: getPersistedUiLanguage() ?? null,
      resolvedLanguage: i18n.resolvedLanguage ?? null,
      titleLanguage: titleLanguage ?? null,
    })

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    if (!agent && managed.provider) {
      try {
        const providerConfig = readPiGlobalProviders()[managed.provider]
        const resolvedMiniModel = providerConfig?.models?.[1]?.id ?? providerConfig?.models?.[0]?.id

        agent = createBackendFromProvider(managed.provider, {
          workspace: managed.workspace,
          miniModel: resolvedMiniModel,
          session: {
            mortiseId: `title-${managed.id}`,
            workspaceId: managed.workspace.id,
            workspaceRootPath: requirePrimaryLocalWorkspaceRoot(managed.workspace),
            provider: managed.provider,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }, buildBackendHostRuntimeContext()) as AgentInstance
        await agent.postInit()
        isTemporary = true
        sessionLog.info(`refreshTitle: Created temporary agent for session ${sessionId}`)
      } catch (error) {
        sessionLog.error(`refreshTitle: Failed to create temporary agent:`, error)
        return { success: false, error: 'Failed to create agent for title generation' }
      }
    }

    if (!agent) {
      sessionLog.warn(`refreshTitle: No agent and no connection for session ${sessionId}`)
      return { success: false, error: 'No agent available' }
    }

    sessionLog.info(`refreshTitle: Calling agent.regenerateTitle...`)


    // Notify renderer that title regeneration has started (for shimmer effect)
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      const title = await agent.regenerateTitle(userMessages, assistantResponse, titleOptions)
      sessionLog.info(`refreshTitle: regenerateTitle returned: ${title ? `"${title}"` : 'null'}`)
      if (title) {
        managed.name = title
        this.persistSession(managed)
        this.sendEvent({ type: 'title_generated', sessionId, title }, managed.workspace.id)
        sessionLog.info(`Refreshed title for session ${sessionId}: "${title}"`)
        return { success: true, title }
      }
      return { success: false, error: 'Failed to generate title' }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      sessionLog.error(`Failed to refresh title for session ${sessionId}:`, error)
      return { success: false, error: message }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        agent.destroy()
      }
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Update the model for a session
   * Pass null to clear the session-specific model (will use global config)
   * @param provider - Optional Pi provider key to apply with the model
   */
  async updateSessionModel(sessionId: string, workspaceId: string, model: string | null, provider?: string): Promise<void> {
    sessionLog.info(`[updateSessionModel] sessionId=${sessionId}, model=${model}, provider=${provider}`)
    const managed = this.sessions.get(sessionId)
    if (managed) {
      if (provider && !readPiGlobalProviders()[provider]) {
        sessionLog.warn(`[updateSessionModel] provider "${provider}" not found`)
        throw new Error(`Pi provider "${provider}" not found`)
      }

      const previousProvider = managed.provider
      managed.model = model ?? undefined
      // Also update connection if provided. Sessions no longer lock provider
      // selection after the first message.
      if (provider) {
        managed.provider = provider
      }
      // Persist to disk (include connection if it was updated)
      const updates: { model?: string; provider?: string } = { model: model ?? undefined }
      if (provider) {
        updates.provider = provider
      }
      await updateSessionMetadata(managed.workspace.id, sessionId, updates)
      if (provider && provider !== previousProvider) {
        await this.tryRefreshAgentRuntime(managed, 'session model provider changed')
        this.sendEvent({
          type: 'provider_changed',
          sessionId,
          provider,
          supportsBranching: resolveSupportsBranching(managed),
        }, managed.workspace.id)
      }
      // Update agent model if it already exists (takes effect on next query)
      if (managed.agent) {
        // Fallback chain: session model > global default.
        const effectiveModel = resolveBackendContext({
          sessionProvider: managed.provider,
          managedModel: model ?? undefined,
        }).resolvedModel
        if (effectiveModel) {
          sessionLog.info(`[updateSessionModel] Calling agent.setModel(${effectiveModel}) [agent exists=${!!managed.agent}]`)
          managed.agent.setModel(effectiveModel)
        }
      } else {
        sessionLog.info(`[updateSessionModel] No agent yet, model will apply on next agent creation`)
      }
      // Notify renderer of the model change
      this.sendEvent({ type: 'session_model_changed', sessionId, model }, managed.workspace.id)
      sessionLog.info(`Session ${sessionId} model updated to: ${model ?? '(global config)'}`)
    }
  }

  /**
   * Add an annotation to a message and persist the session.
   */
  addMessageAnnotation(sessionId: string, messageId: string, annotation: NonNullable<Message['annotations']>[number]): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot add annotation: session ${sessionId} not found`)
      return
    }

    const message = this.getProjectionOverlayMessage(managed, messageId, true)
    if (!message) {
      sessionLog.warn(`Cannot add annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    if (!annotation?.id || !annotation?.target?.selectors?.length) {
      sessionLog.warn(`Cannot add annotation: invalid annotation payload for message ${messageId}`)
      return
    }

    if (annotation.target.source.messageId !== messageId) {
      sessionLog.warn(`Cannot add annotation: target source.messageId mismatch (${annotation.target.source.messageId} !== ${messageId})`)
      return
    }

    const safeAnnotation: NonNullable<Message['annotations']>[number] = {
      ...annotation,
      schemaVersion: 1,
      target: {
        ...annotation.target,
        source: {
          ...annotation.target.source,
          sessionId,
          messageId,
        },
      },
    }

    const annotationBytes = Buffer.byteLength(JSON.stringify(safeAnnotation), 'utf8')
    if (annotationBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(`Cannot add annotation: payload too large (${annotationBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) on message ${messageId}`)
      return
    }

    const existing = message.annotations ?? []
    if (existing.some(a => a.id === safeAnnotation.id)) {
      sessionLog.warn(`Cannot add annotation: duplicate annotation id ${safeAnnotation.id} on message ${messageId}`)
      return
    }

    if (existing.length >= MAX_ANNOTATIONS_PER_MESSAGE) {
      sessionLog.warn(`Cannot add annotation: per-message limit reached (${MAX_ANNOTATIONS_PER_MESSAGE}) on message ${messageId}`)
      return
    }

    message.annotations = [...existing, safeAnnotation]
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  /**
   * Patch an existing annotation on a message.
   */
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<NonNullable<Message['annotations']>[number]>
  ): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot update annotation: session ${sessionId} not found`)
      return
    }

    const message = this.getProjectionOverlayMessage(managed, messageId)
    if (!message) {
      sessionLog.warn(`Cannot update annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    const idx = existing.findIndex(a => a.id === annotationId)
    if (idx === -1) {
      sessionLog.warn(`Cannot update annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    if (patch.target?.source?.messageId && patch.target.source.messageId !== messageId) {
      sessionLog.warn(`Cannot update annotation: target source.messageId mismatch in patch (${patch.target.source.messageId} !== ${messageId})`)
      return
    }

    if (patch.target?.selectors && patch.target.selectors.length === 0) {
      sessionLog.warn(`Cannot update annotation: empty selectors patch for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const current = existing[idx]!
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      schemaVersion: current.schemaVersion,
      target: patch.target
        ? {
            ...current.target,
            ...patch.target,
            source: {
              ...current.target.source,
              ...(patch.target.source ?? {}),
              sessionId,
              messageId,
            },
          }
        : {
            ...current.target,
            source: {
              ...current.target.source,
              sessionId,
              messageId,
            },
          },
      updatedAt: Date.now(),
    }

    const updatedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8')
    if (updatedBytes > MAX_ANNOTATION_JSON_BYTES) {
      sessionLog.warn(`Cannot update annotation: payload too large (${updatedBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const next = [...existing]
    next[idx] = updated
    message.annotations = next
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  /**
   * Remove an annotation from a message and persist the session.
   */
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot remove annotation: session ${sessionId} not found`)
      return
    }

    const message = this.getProjectionOverlayMessage(managed, messageId)
    if (!message) {
      sessionLog.warn(`Cannot remove annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    if (!existing.some(a => a.id === annotationId)) {
      sessionLog.warn(`Cannot remove annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    message.annotations = existing.filter(a => a.id !== annotationId)
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  /**
   * Publish a provisional first turn after Pi has atomically created its tree
   * JSONL. Until this point Mortise keeps metadata, overlays, and projection
   * state in memory and excludes the session from every public list/event.
   */
  private async publishProvisionalSessionIfReady(managed: ManagedSession): Promise<boolean> {
    if (!managed.publicationState) return true
    if (managed.publicationState !== 'provisional' || this.sessions.get(managed.id) !== managed) return false
    if (managed.publicationPromise) return managed.publicationPromise

    const work = (async (): Promise<boolean> => {
      const isCurrentProvisional = () => (
        managed.publicationState === 'provisional' && this.sessions.get(managed.id) === managed
      )
      if (!isCurrentProvisional()) return false
      const sessionFile = tryGetSessionFilePath(managed.workspace.id, managed.id)
      if (!sessionFile || !existsSync(sessionFile)) return false
      const projection = await findPiSessionProjectionById(
        managed.workspace.id,
        requirePrimaryLocalWorkspaceRoot(managed.workspace),
        managed.id,
      )
      if (!isCurrentProvisional()) return false
      const entries = (projection as { entries?: unknown[] } | null)?.entries ?? []
      const hasUser = entries.some(entry => {
        if (!entry || typeof entry !== 'object') return false
        const candidate = entry as { type?: unknown; message?: { role?: unknown } }
        return candidate.type === 'message' && candidate.message?.role === 'user'
      })
      if (!hasUser) return false

      if (!isCurrentProvisional()) return false
      managed.publicationState = 'publishing'
      try {
        // Pi's first-user write is already atomic and contains the header and
        // canonical user entry. Attach Mortise metadata/overlays and
        // the latest projection before making the session publicly discoverable.
        if (this.sessions.get(managed.id) !== managed || managed.publicationState !== 'publishing') return false
        if (!managed.messagesLoaded) managed.messagesLoaded = true
        this.enqueuePersist(managed)
        try {
          await this.flushSession(managed.id)
        } catch (error) {
          throw new SessionPublicationDurabilityError(managed.id, 'metadata', error)
        }
        if (this.sessions.get(managed.id) !== managed || managed.publicationState !== 'publishing') return false

        const snapshot = this.piProjectionBySession.get(managed.id)?.createSnapshot()
        if (snapshot) {
          this.enqueuePiProjectionPersist(managed, snapshot)
          try {
            await this.flushPiProjectionWrites(managed)
          } catch (error) {
            throw new SessionPublicationDurabilityError(managed.id, 'projection', error)
          }
        }
        if (this.sessions.get(managed.id) !== managed || managed.publicationState !== 'publishing') return false

        await managed.beforePublish?.(managedToSession(managed, { messages: managed.messages }))
        managed.beforePublish = undefined
        if (this.sessions.get(managed.id) !== managed || managed.publicationState !== 'publishing') return false

        managed.pendingPublicationFailure = undefined
        managed.publicationState = undefined
        this.sendEvent({ type: 'session_created', sessionId: managed.id }, managed.workspace.id)
        this.emitUnreadSummaryChanged()
        writeRuntimeLog('info', {
          scope: 'session',
          event: 'first_turn.published',
          meta: {
            sessionId: managed.id,
            workspaceId: managed.workspace.id,
            publication: 'published',
          },
        })
        sessionLog.info(`Published provisional session ${managed.id} after first user persistence`)
        return true
      } catch (error) {
        if (managed.publicationState === 'publishing') managed.publicationState = 'provisional'
        throw error
      }
    })()

    managed.publicationPromise = work
    try {
      return await work
    } finally {
      if (managed.publicationPromise === work) managed.publicationPromise = undefined
    }
  }

  /** Remove every runtime and storage artifact for a first turn that failed
   * before canonical user-message acknowledgement. No public deletion event is emitted because
   * the session was never public. */
  private async abandonProvisionalSession(managed: ManagedSession, reason: string): Promise<void> {
    if (!managed.publicationState) return
    if (managed.abandonPromise) return managed.abandonPromise

    const work = (async () => {
      // Mark the runtime terminal before the first await. Late Pi events must
      // never be able to re-enter publication while cleanup is in flight.
      managed.publicationState = 'abandoning'
      if (managed.agent) {
        try {
          await managed.agent.abort(AbortReason.UserStop)
        } catch (error) {
          sessionLog.warn(`Failed to abort provisional agent ${managed.id}: ${error instanceof Error ? error.message : error}`)
        }
      }
      managed.isProcessing = false
      managed.beforePublish = undefined
      managed.pendingTitleUserMessage = undefined
      managed.processingGeneration++
      await this.disposeManagedAgentRuntime(managed, `provisional session abandoned: ${reason}`)
      // Abandonment is destructive cleanup, not a persistence retry. Wait for
      // an in-flight projection writer so it cannot recreate files after
      // deletion, but discard failed/pending snapshots instead of letting the
      // original disk failure prevent provisional cleanup.
      await this.piProjectionWrites.get(managed.id)
      await sessionPersistenceQueue.cancel(managed.id, { preventFutureEnqueue: true })

      this.sessions.delete(managed.id)
      this.extensionFrontendStates.clearSession(managed.id)
      this.piProjectionBySession.delete(managed.id)
      this.piProjectionRetiredRuntimeIds.delete(managed.id)
      this.piProjectionWrites.delete(managed.id)
      this.piProjectionPendingSnapshots.delete(managed.id)
      this.piProjectionWriteErrors.delete(managed.id)
      await deleteStoredSession(managed.workspace.id, managed.id)
      sessionLog.info(`Abandoned unpublished provisional session ${managed.id}: ${reason}`)
    })()
    managed.abandonPromise = work
    return work
  }

  private async discardUnacceptedFirstTurn(managed: ManagedSession, cause: unknown): Promise<void> {
    const reason = cause instanceof Error ? cause.message : String(cause)
    if (managed.agent) await managed.agent.abort(AbortReason.UserStop).catch(() => undefined)
    this.setProcessing(managed, false)
    managed.processingGeneration++
    await this.settleUnknownToolSideEffects(managed)
    await this.disposeManagedAgentRuntime(managed, `unaccepted first turn: ${reason}`)
    await this.piProjectionWrites.get(managed.id)
    await sessionPersistenceQueue.cancel(managed.id, { preventFutureEnqueue: true })
    this.sessions.delete(managed.id)
    this.extensionFrontendStates.clearSession(managed.id)
    this.piProjectionBySession.delete(managed.id)
    this.piProjectionRetiredRuntimeIds.delete(managed.id)
    this.piProjectionWrites.delete(managed.id)
    this.piProjectionPendingSnapshots.delete(managed.id)
    this.piProjectionWriteErrors.delete(managed.id)
    await deleteStoredSession(managed.workspace.id, managed.id)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot delete session: ${sessionId} not found`)
      return
    }

    // Session storage is keyed by stable Workspace identity.
    const workspaceId = managed.workspace.id
    managed.deleting = true
    this.sendEvent({ type: 'session_deletion_changed', sessionId, state: 'deleting' }, workspaceId)

    try {

    const deletionError = new CodedError(
      'SESSION_EXECUTION_TERMINATED',
      'Session was deleted before the execution result settled.',
      { sessionId },
    )
    for (const pending of managed.messageQueue) pending.onReject?.(deletionError)
    managed.messageQueue = []

    // If processing is in progress, force-abort via Query.close() and wait for cleanup
    if (managed.isProcessing && managed.agent) {
      managed.agent.forceAbort(AbortReason.UserStop)
      // Brief wait for the query to finish tearing down before we delete session files.
      // Prevents file corruption from overlapping writes during rapid delete operations.
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Revoke share if session was shared (prevent orphaned viewer copies)
    if (managed.sharedId) {
      try {
        const result = await this.shareTransferService.revoke(sessionId)
        if (!result.success) {
          sessionLog.warn(`Failed to revoke share for ${sessionId}: ${result.error}`)
        } else {
          sessionLog.info(`Revoked share for deleted session ${sessionId}`)
        }
      } catch (error) {
        sessionLog.warn(`Failed to revoke share for ${sessionId}:`, error)
      }
    }


    // Destroy browser instances bound to this session
    const sessionBpm = this.getBrowserPaneManagerForSession(sessionId)
    if (sessionBpm) {
      sessionBpm.destroyForSession(sessionId)
    }
    // Drop the per-session remote bridge + host-client pin on destroy.
    this.remoteBpms.delete(sessionId)
    this.browserHostByCanvas.delete(sessionId)

    // Each child-task type owns its own stop and settlement contract.
    await managed.agent?.prepareChildTasksForParentDeletion?.()

    // Dispose agent, pool server, MCP pool, and session-scoped callbacks via
    // the same runtime teardown path used for config-driven restarts.
    await this.disposeManagedAgentRuntime(managed, 'session deleted', { propagateFailure: true })
    await this.settleUnknownToolSideEffects(managed)
    await this.drainSubagentLifecycle(managed)
    await this.flushPiProjectionWrites(managed)
    // Cancel pending/in-flight persistence only after child completion delivery
    // has drained, then prevent any later Session write from recreating the path.
    await sessionPersistenceQueue.cancel(sessionId, { preventFutureEnqueue: true })

    // Delete from disk too
    if (!await deleteStoredSession(workspaceId, sessionId)) {
      throw new Error(`Failed to delete Session data: ${sessionId}`)
    }

    this.sessions.delete(sessionId)
    this.extensionFrontendStates.clearSession(sessionId)
    this.piProjectionBySession.delete(sessionId)
    this.piProjectionRetiredRuntimeIds.delete(sessionId)
    this.piProjectionWrites.delete(sessionId)
    this.piProjectionPendingSnapshots.delete(sessionId)
    this.piProjectionWriteErrors.delete(sessionId)

    // Notify all windows for this workspace that the session was deleted
    this.sendEvent({ type: 'session_deleted', sessionId }, managed.workspace.id)
    this.emitUnreadSummaryChanged()

    // Clean up attachments directory (handled by deleteStoredSession for workspace-scoped storage)
    sessionLog.info(`Deleted session ${sessionId}`)
    } catch (error) {
      if (this.sessions.get(sessionId) === managed) {
        managed.deleting = true
        this.sendEvent({ type: 'session_deletion_changed', sessionId, state: 'deleting' }, workspaceId)
      }
      throw error
    }
  }

  private submitExtensionSessionMessage(
    sessionId: string,
    message: string,
    operationId: string,
    delivery?: 'steer' | 'followUp',
  ): Promise<void> {
    const desiredBehavior = delivery === 'steer' ? 'steer' : 'queue'
    const midStreamSendIntent = delivery && getMidStreamBehavior() !== desiredBehavior ? 'alternate' : 'default'
    return new Promise<void>((resolve, reject) => {
      void this.sendMessage(
        sessionId,
        message,
        undefined,
        undefined,
        { operationId, optimisticMessageId: operationId, midStreamSendIntent },
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        () => resolve(),
      ).catch(reject)
    })
  }

  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    /** Internal hook fired after Pi confirms the canonical user entry is durable. */
    onAck?: (messageId: string) => void,
    /**
     * Optional transport context. The `sessions.sendMessage` RPC handler passes
     * `{ callerClientId: ctx.clientId }` so the SM can pin the desktop client
     * that should host this session's browser tools. Pass undefined when calling
     * directly (tests, intra-server flows) to leave the existing pin in place.
     */
    rpcContext?: { callerClientId?: string },
    _isQueuedReplay = false,
    /** Hook fired once Mortise has durably accepted the outbox record. */
    onAccepted?: (messageId: string) => void,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }
    if (managed.deleting) throw new Error(`Session ${sessionId} is being deleted`)

    if (_isAuthRetry || _isQueuedReplay) {
      if (managed.workspaceTopologyAutoResumeBlocked) {
        sessionLog.info(`Suppressed automatic Session resume after Workspace topology interruption: ${sessionId}`)
        return
      }
    } else {
      await managed.workspaceTopologyInterruption
      if (managed.workspaceTopologyInterruptionFailure) {
        throw managed.workspaceTopologyInterruptionFailure
      }
      managed.workspaceTopologyAutoResumeBlocked = false
      managed.activeWorkspaceLocationId = managed.workspace.primaryLocationId
    }

    // A backend turn may already be terminal while its Mortise metadata or Pi
    // projection is still pending durability. Recover that accepted turn first;
    // treating this as an ordinary mid-stream send would queue or resend work
    // before the previous turn is safely settled.
    if (managed.pendingSettlementReason || managed.settlementPromise) {
      await this.retryPendingSettlement(sessionId)
    }

    const attachmentSizes = storedAttachments?.length
      ? storedAttachments.map(attachment => ({ name: attachment.name, size: attachment.originalSize ?? attachment.size }))
      : attachments?.map(attachment => ({ name: attachment.name, size: attachment.size })) ?? []
    const oversizedAttachment = attachmentSizes.find(attachment => attachment.size > ATTACHMENT_SINGLE_FILE_LIMIT_BYTES)
    if (oversizedAttachment) {
      throw new Error(`Attachment "${oversizedAttachment.name}" exceeds the ${Math.round(ATTACHMENT_SINGLE_FILE_LIMIT_BYTES / 1024 / 1024)} MiB single-file limit`)
    }
    const totalAttachmentBytes = attachmentSizes.reduce((sum, attachment) => sum + attachment.size, 0)
    if (totalAttachmentBytes > ATTACHMENT_MESSAGE_TOTAL_LIMIT_BYTES) {
      throw new Error(`Attachments exceed the ${Math.round(ATTACHMENT_MESSAGE_TOTAL_LIMIT_BYTES / 1024 / 1024)} MiB per-message limit`)
    }

    this.setLastMessageClientId(sessionId, rpcContext?.callerClientId)

    // Pi owns the Session command queue. Mortise only chooses the product-level
    // steer/follow-up intent and projects the disposition returned by Pi.
    if (managed.isProcessing && !_isQueuedReplay && !_isAuthRetry) {
      const configuredBehavior = getMidStreamBehavior()
      const requestedBehavior = options?.midStreamSendIntent === 'alternate'
        ? alternateMidStreamBehavior(configuredBehavior)
        : configuredBehavior
      const canSteer = managed.isProcessing
      const behavior = canSteer ? requestedBehavior : 'queue'

      const agent = managed.agent
      const messageId = options?.optimisticMessageId ?? generateMessageId()
      const acceptedAt = Date.now()
      const queuedOptions = {
        ...(options ?? {}),
        optimisticMessageId: options?.optimisticMessageId ?? messageId,
      }
      this.messageOutbox.put({
        clientMutationId: messageId,
        sessionId,
        workspaceId: managed.workspace.id,
        callerClientId: rpcContext?.callerClientId,
        message,
        ...(serializeOutboxAttachments(attachments) !== undefined
          ? { attachments: serializeOutboxAttachments(attachments) }
          : {}),
        ...(serializeStoredAttachmentRefs(storedAttachments) !== undefined
          ? { storedAttachments: serializeStoredAttachmentRefs(storedAttachments) }
          : {}),
        options: queuedOptions as unknown as JsonValue,
        sessionOptions: serializeSessionRecoveryOptions(managed),
        provisional: managed.publicationState !== undefined,
        status: 'accepted',
        attempt: this.outboxAttempt(messageId),
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      })
      if (onAck) {
        managed.pendingInputAcks.set(messageId, {
          resolve: persistedMessageId => onAck(persistedMessageId),
          reject: () => undefined,
        })
      }

      let steered = false
      let followedUp = false
      if (behavior === 'steer') {
        steered = await (agent?.redirect(message, messageId, {
          origin: options?.source,
        }) ?? false)
      }
      if (!steered) {
        followedUp = await (agent?.followUp(message, attachments, {
          clientMutationId: messageId,
          origin: options?.source,
          attachmentRefs: storedAttachments?.map(attachment => ({
            id: attachment.id,
            name: attachment.name,
            mediaType: attachment.mimeType,
            size: attachment.size,
          })),
        }) ?? false)
      }

      sessionLog.info('mid-stream send', {
        sessionId,
        behavior,
        sendIntent: options?.midStreamSendIntent ?? 'default',
        steered,
        followedUp,
        backend: agent ? agent.constructor.name : 'none',
        provider: managed.provider,
      })

      if (!steered && !followedUp) {
        managed.pendingInputAcks.delete(messageId)
        this.messageOutbox.remove(messageId)
        throw new CodedError('SESSION_COMMAND_REJECTED', 'Pi Session rejected the message in its current state.', {
          sessionId,
          requestedBehavior: behavior,
        })
      }

      if (behavior === 'steer' && followedUp) {
        this.sendEvent({
          type: 'info',
          sessionId,
          message: 'Steer was not accepted in time and is now pending as a normal next-turn message.',
          level: 'warning',
        }, managed.workspace.id)
      }
      managed.lastMessageRole = 'user'
      this.upsertUserMessageOverlay(managed, messageId, storedAttachments, options?.badges, followedUp)
      if (followedUp) {
        managed.messageQueue.push({
          message,
          attachments,
          storedAttachments,
          options: queuedOptions,
          messageId,
          optimisticMessageId: queuedOptions.optimisticMessageId,
        })
        try {
          managed.agent?.projectQueuedUser?.({
            message,
            clientMutationId: messageId,
            messageId,
            timestamp: acceptedAt,
            attachments: storedAttachments?.map(attachment => ({
              id: attachment.id,
              name: attachment.name,
              mediaType: attachment.mimeType,
              size: attachment.size,
            })),
          })
        } catch (error) {
          sessionLog.warn(`Failed to project queued follow-up ${messageId}: ${error instanceof Error ? error.message : error}`)
        }
      }
      this.persistSession(managed)
      await this.flushSession(managed.id)
      onAccepted?.(messageId)
      return
    }

    await this.ensureMessagesLoaded(managed)

    // Pi owns the canonical user message. Mortise only records the UI overlay
    // needed to reconcile optimistic queue/attachment state.
    const messageId = existingMessageId ?? options?.optimisticMessageId ?? generateMessageId()
    const awaitsCanonicalUserPersistence = Boolean(onAck)
    let acknowledged = false
    let canonicalUserPersisted = !awaitsCanonicalUserPersistence
    const acknowledge = () => {
      if (acknowledged) return
      acknowledged = true
      onAccepted?.(messageId)
      writeRuntimeLog('info', {
        scope: 'session',
        event: 'send_message.accepted',
        meta: {
          sessionId,
          workspaceId: managed.workspace.id,
          messageId,
          optimisticMessageId: options?.optimisticMessageId,
          status: 'mortise_accepted',
          provider: managed.provider,
          model: managed.model,
        },
      })
    }
    try {
      if (!_isAuthRetry) {
        managed.lastMessageRole = 'user'
      this.upsertUserMessageOverlay(
        managed,
        messageId,
        storedAttachments,
        options?.badges,
        false,
      )
      this.persistSession(managed)
      await this.flushSession(managed.id)
      const acceptedAt = Date.now()
      this.messageOutbox.put({
        clientMutationId: messageId,
        sessionId,
        workspaceId: managed.workspace.id,
        callerClientId: rpcContext?.callerClientId,
        message,
        ...(serializeOutboxAttachments(attachments) !== undefined
          ? { attachments: serializeOutboxAttachments(attachments) }
          : {}),
        ...(serializeStoredAttachmentRefs(storedAttachments) !== undefined
          ? { storedAttachments: serializeStoredAttachmentRefs(storedAttachments) }
          : {}),
        ...(options ? { options: options as unknown as JsonValue } : {}),
        sessionOptions: serializeSessionRecoveryOptions(managed),
        provisional: managed.publicationState !== undefined,
        status: 'accepted',
        attempt: this.outboxAttempt(messageId),
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      })
      acknowledge()
      if (!existingMessageId) {
      // If this is the first user message and no title exists, set one immediately
      // AI generation will enhance it later, but we always have a title from the start
      // Automation sessions (triggeredBy set) already have a title and skip AI generation entirely
      const isFirstUserMessage = !managed.name
      if (isFirstUserMessage && !managed.name && !managed.triggeredBy) {
        // Replace bracket mentions with their display labels (e.g. [skill:ws:commit] -> "Commit")
        // so titles show human-readable names instead of raw IDs
        let titleSource = message
        if (options?.badges) {
          for (const badge of options.badges) {
            if (badge.rawText && badge.label) {
              titleSource = titleSource.replace(badge.rawText, badge.label)
            }
          }
        }
        // Sanitize: strip any remaining bracket mentions, XML blocks, tags
        const sanitized = sanitizeForTitle(titleSource)
        const initialTitle = sanitized.slice(0, 50) + (sanitized.length > 50 ? '…' : '')
        managed.name = initialTitle
        this.persistSession(managed)
        // Flush immediately so disk is authoritative before notifying renderer
        await this.flushSession(managed.id)
        this.sendEvent({
          type: 'title_generated',
          sessionId,
          title: initialTitle,
        }, managed.workspace.id)

        // Provisional sessions cannot start detached async work that may outlive
        // abandonment and leak a late title event. Publish first, then generate.
        if (managed.publicationState) {
          managed.pendingTitleUserMessage = message
        } else {
          this.generateTitle(managed, message)
        }
      }
      }
      }

      managed.lastMessageAt = Date.now()
      this.setProcessing(managed, true)
      managed.streamingText = ''
      managed.processingGeneration++
      if (!_isAuthRetry) managed.turnStartFinalMessageId = managed.lastFinalMessageId
    } catch (error) {
      this.setProcessing(managed, false)
      throw error
    }

    // Reset auth retry flag for this new message (allows one retry per message)
    // IMPORTANT: Skip reset if this is an auth retry call - the flag is already true
    // and resetting it would allow infinite retry loops
    // Note: authRetryInProgress is NOT reset here - it's managed by the retry logic
    if (!_isAuthRetry) {
      managed.authRetryAttempted = false
    }

    // Store message/attachments for potential retry after auth refresh
    // (SDK subprocess caches token at startup, so if it expires mid-session,
    // we need to recreate the agent and retry the message)
    managed.lastSentMessage = message
    managed.lastSentAttachments = attachments
    managed.lastSentStoredAttachments = storedAttachments
    managed.lastSentOptions = options
    managed.lastSentMessageId = messageId

    // Capture the generation to detect if a new request supersedes this one.
    // This prevents the finally block from clobbering state when a follow-up message arrives.
    const myGeneration = managed.processingGeneration

    // Start perf span for entire sendMessage flow
    const sendSpan = perf.span('session.sendMessage', { sessionId })

    try {
      const agent = await this.getOrCreateAgent(managed)
      sendSpan.mark('agent.ready')

      sessionLog.info('Starting chat for session:', sessionId)
      sessionLog.info('Workspace:', JSON.stringify(managed.workspace, null, 2))
      sessionLog.info('Message:', message)
      sessionLog.info('Agent model:', agent.getModel())
      sessionLog.info('process.cwd():', process.cwd())

      // Process the message through the agent
      sessionLog.info('Calling agent.chat()...')
      if (attachments?.length) {
        sessionLog.info('Attachments:', attachments.length)
      }

      // Skills mentioned via @mentions are handled by the SDK's Skill tool.
      // The UI layer (extractBadges in mentions.ts) injects fully-qualified names
      // in the rawText, and canUseTool in mortise.ts provides a fallback
      // to qualify short names. No transformation needed here.

      // Pi persists interruption recovery as a hidden custom entry immediately
      // before the canonical user message. Keep the user's text unchanged.
      const interruptedAttempt = managed.wasInterrupted

      const messageBackendContext = resolveBackendContext({
        sessionProvider: managed.provider,
        managedModel: managed.model,
      })
      const modelInputAttachments = filterAttachmentsForModelInput(
        attachments,
        messageBackendContext.providerConfig,
        messageBackendContext.resolvedModel,
      )
      if (modelInputAttachments.omittedImages.length > 0) {
        const omittedNames = modelInputAttachments.omittedImages.map(a => a.name).join(', ')
        sessionLog.info(`Omitting ${modelInputAttachments.omittedImages.length} image attachment(s) from model input for ${messageBackendContext.resolvedModel}: ${omittedNames}`)
        this.sendEvent({
          type: 'info',
          sessionId,
          message: `Image attachment${modelInputAttachments.omittedImages.length === 1 ? '' : 's'} not sent because image input is disabled for ${messageBackendContext.resolvedModel}.`,
          level: 'warning',
        }, managed.workspace.id)
      }

      sendSpan.mark('chat.starting')
      const chatIterator = agent.chat(message, modelInputAttachments.attachments, {
		clientMutationId: messageId,
        origin: options?.source,
        isRetry: _isAuthRetry === true,
        interruptedAttempt,
        attachmentRefs: storedAttachments?.map(attachment => ({
          id: attachment.id,
          name: attachment.name,
          mediaType: attachment.mimeType,
          size: attachment.size,
        })),
      })
      sessionLog.info('Got chat iterator, starting iteration...')

      for await (const event of chatIterator) {
        // Log events (skip noisy text_delta)
        if (event.type !== 'text_delta') {
          if (event.type === 'tool_start') {
            sessionLog.info(`tool_start: ${event.toolName} (${event.toolUseId})`)
          } else if (event.type === 'tool_result') {
            sessionLog.info(`tool_result: ${event.toolUseId} isError=${event.isError}`)
          } else {
            sessionLog.info('Got event:', event.type)
          }
        }

        const published = await this.publishProvisionalSessionIfReady(managed)
        if (managed.publicationState && published) acknowledge()
        if (managed.publicationState) {
          if (managed.publicationState !== 'provisional') {
            throw new Error('First turn was abandoned before publishing a session')
          }
          if (event.type === 'error') throw new Error(event.message)
          if (event.type === 'typed_error') throw new Error(event.error.message || event.error.title)
          if (event.type === 'complete') {
            throw new Error('First turn completed before Pi persisted its user message')
          }
        }

        // Process the event after the publication gate so no session event can
        // outrun session_created for a provisional first turn.
        await this.processEvent(managed, event)

        if (event.type === 'pi_user_message_persisted') {
          const hadPendingAck = this.handlePiUserMessagePersisted(managed, event.clientMutationId ?? messageId)
          writeRuntimeLog('info', {
            scope: 'session',
            event: 'send_message.pi_persisted',
            meta: {
              sessionId,
              workspaceId: managed.workspace.id,
              messageId,
              provider: managed.provider,
              model: managed.model,
            },
          })
          if (!event.clientMutationId || event.clientMutationId === messageId) {
            canonicalUserPersisted = true
            if (interruptedAttempt) managed.wasInterrupted = false
            if (!hadPendingAck) onAck?.(event.clientMutationId ?? messageId)
          }
        }

        // Fallback: Capture SDK session ID if the onSdkSessionIdUpdate callback didn't fire.
        // Primary capture happens in getOrCreateAgent() via onSdkSessionIdUpdate callback,
        // which immediately flushes to disk. This fallback handles edge cases where the
        // callback might not fire (e.g., SDK version mismatch, callback not supported).
        if (!managed.sdkSessionId) {
          const sdkId = agent.getSessionId()
          if (sdkId) {
            managed.sdkSessionId = sdkId
            sessionLog.info(`Captured SDK session ID via fallback: ${sdkId}`)
            // Also flush here since we're in fallback mode
            this.persistSession(managed)
            void sessionPersistenceQueue.flush(managed.id).catch(error => {
              sessionLog.error(`Failed to flush session ${managed.id} after fallback SDK session ID capture:`, error)
            })
          }
        }

        // Handle complete event - SDK always sends this (even after interrupt)
        // This is the central place where processing ends
        if (event.type === 'complete') {
          if (awaitsCanonicalUserPersistence && !canonicalUserPersisted) {
            throw new SessionSendDurabilityError(
              sessionId,
              messageId,
              new Error('Pi completed the turn before confirming the canonical user message write'),
            )
          }
          // Pi can acknowledge an abort by yielding its terminal event. The
          // host stop request is authoritative for settlement in that race.
          if (managed.stopRequested) {
            sendSpan.mark('chat.complete.after_stop')
            sendSpan.end()
            await this.onProcessingStopped(sessionId, 'interrupted')
            return
          }
          if (managed.authRetryInProgress) {
            sendSpan.mark('chat.complete.auth_retry_replacing_execution')
            sendSpan.end()
            await this.resumeAfterAuthFailure(managed)
            return
          }
          if (event.terminalStatus === 'failed') {
            sendSpan.mark('chat.failed')
            sendSpan.end()
            await this.onProcessingStopped(sessionId, 'error')
            return
          }
          // Defensive fallback: Pi should emit pi_user_message_persisted after
          // SessionManager.appendMessage(user), but never leave the caller
          // hanging if an older subprocess misses that bridge event.
          // Auth/plan handoff paths already stopped processing and emitted a complete
          // event to the renderer. Ignore the backend's trailing complete to avoid
          // double cleanup and duplicate UI completion events.
          if (!managed.isProcessing) {
            sessionLog.info('Chat completed after explicit handoff/stop; skipping normal completion handling')
            sendSpan.mark('chat.complete.already_stopped')
            sendSpan.end()
            return
          }

          sessionLog.info('Chat completed via complete event')

          // If the projection did not advance to a new final assistant message,
          // the provider may have failed without emitting a classified error.
          if (managed.lastFinalMessageId === managed.turnStartFinalMessageId) {
            sessionLog.warn(`Session ${sessionId} completed without assistant response - possible context overflow or API issue`)

            // Check if there's a captured API error that explains the silent failure.
            // Pass explicit session path to avoid reading from the wrong session
            // (_sessionDir singleton can be clobbered by concurrent sessions).
            const sessionErrorPath = getSessionStoragePath(managed.workspace.id, managed.id)
            const apiError = getLastApiError(sessionErrorPath)

            if (apiError && apiError.status === 400) {
              const isImageError = apiError.message?.includes('image exceeds')

              await this.projectHostRuntimeError(managed, {
                phase: 'send',
                code: isImageError ? 'image_too_large' : 'invalid_request',
                message: apiError.message,
                retryable: false,
              })
            }
          }

          sendSpan.mark('chat.complete')
          sendSpan.end()
          await this.onProcessingStopped(sessionId, 'complete')
          return  // Exit function, skip finally block (onProcessingStopped handles cleanup)
        }

        // NOTE: We no longer break early on !isProcessing or stopRequested.
        // After soft interrupt (forceAbort), the backend sets turnComplete=true which causes
        // the generator to yield remaining queued events and then complete naturally.
        // This ensures we don't lose in-flight messages.
      }

      // Loop exited - either via complete event (normal) or generator ended after soft interrupt
      if (managed.publicationState) {
        throw new Error('First turn ended before Pi persisted its user message')
      }
      if (awaitsCanonicalUserPersistence && !acknowledged) {
        throw new SessionSendDurabilityError(
          sessionId,
          messageId,
          new Error('Pi ended the chat stream before confirming the canonical user message write'),
        )
      }
      if (!managed.isProcessing) {
        sessionLog.info('Chat loop exited after explicit handoff/stop')
        sendSpan.mark('chat.exit.already_stopped')
        sendSpan.end()
      } else if (canonicalUserPersisted) {
        sessionLog.info('Pi accepted the Session command; remaining events continue on the runtime subscription')
        sendSpan.mark('chat.command_accepted')
        sendSpan.end()
        return
      } else if (managed.stopRequested) {
        sessionLog.info('Chat loop completed after stop request - events drained successfully')
        await this.onProcessingStopped(sessionId, 'interrupted')
      } else {
        sessionLog.info('Chat loop exited unexpectedly')
      }
    } catch (error) {
      if (managed.publicationState && !acknowledged) {
        sendSpan.mark('chat.provisional_abandoned')
        sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error))
        sendSpan.end()
        await this.abandonProvisionalSession(
          managed,
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }

      // An ordinary first turn is already Mortise-accepted at this point, but
      // Pi has not yet crossed the publication boundary. Keep the provisional
      // Session and its original outbox mutation visible and retryable instead
      // of converting it into a generic chat error or deleting it.
      if (managed.publicationState && acknowledged) {
        const publicationError = error instanceof SessionPublicationDurabilityError
          ? error
          : new SessionPublicationDurabilityError(sessionId, 'runtime', error)
        managed.pendingPublicationFailure = {
          code: publicationError.code,
          message: publicationError.message,
          data: publicationError.data,
        }
        this.messageOutbox.update(messageId, {
          status: 'failed',
          updatedAt: Date.now(),
          error: publicationError.message,
        })
        this.setProcessing(managed, false)
        sendSpan.mark('chat.publication_failed')
        sendSpan.setMetadata('error', publicationError.message)
        sendSpan.end()
        throw publicationError
      }


      // Settlement happens after the canonical user message has been accepted.
      // Keep it out of generic chat error projection/cleanup: that path would
      // re-enter settlement and incorrectly describe the accepted message as a
      // failed send.
      if (error instanceof SessionSettlementDurabilityError) {
        sendSpan.mark('chat.settlement_pending')
        sendSpan.setMetadata('error', error.message)
        sendSpan.end()
        throw error
      }

      if (
        managed.authRetryInProgress
        && canonicalUserPersisted
      ) {
        sendSpan.mark('chat.error.auth_retry_replacing_execution')
        sendSpan.end()
        await this.resumeAfterAuthFailure(managed)
        return
      }

      if (managed.publicationState) {
        this.messageOutbox.update(messageId, {
          status: 'failed',
          updatedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        })
        this.setProcessing(managed, false)
      }

      if (awaitsCanonicalUserPersistence && !canonicalUserPersisted) {
        sendSpan.mark('chat.user_message_unaccepted')
        sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error))
        sendSpan.end()
        await this.projectHostRuntimeError(managed, {
          phase: 'send',
          code: 'canonical_user_message_not_persisted',
          message: error instanceof Error ? error.message : 'Pi did not persist the user message',
          retryable: true,
        }).catch(projectionError => {
          sessionLog.warn(`Could not project unaccepted request error for ${sessionId}: ${projectionError instanceof Error ? projectionError.message : projectionError}`)
        })
        this.setProcessing(managed, false)
        managed.stopRequested = false
        managed.turnStartFinalMessageId = undefined
        await this.settleUnknownToolSideEffects(managed)
        throw error instanceof SessionSendDurabilityError
          ? error
          : new SessionSendDurabilityError(sessionId, messageId, error)
      }

      // Check if this is an abort error (expected when interrupted)
      const isAbortError = error instanceof Error && (
        error.name === 'AbortError' ||
        error.message === 'Request was aborted.' ||
        error.message.includes('aborted')
      )

      if (isAbortError) {
        // Extract abort reason if available (safety net for unexpected abort propagation)
        const reason = (error as DOMException).cause as AbortReason | undefined

        sessionLog.info(`Chat aborted (reason: ${reason || 'unknown'})`)
        sendSpan.mark('chat.aborted')
        sendSpan.setMetadata('abort_reason', reason || 'unknown')
        sendSpan.end()

        // UI handoff paths (plan submission, auth request) handle their own cleanup
        // by setting isProcessing = false directly. All other abort reasons route
        // through onProcessingStopped for queue draining.
        if (reason === AbortReason.UserStop || reason === AbortReason.Redirect || reason === undefined) {
          await this.onProcessingStopped(sessionId, 'interrupted')
        }
      } else {
        sessionLog.error('Error in chat:', error)
        sessionLog.error('Error message:', error instanceof Error ? error.message : String(error))
        sessionLog.error('Error stack:', error instanceof Error ? error.stack : 'No stack')
        writeRuntimeLog('error', {
          scope: 'session',
          event: 'chat.error',
          meta: {
            sessionId,
            workspaceId: managed.workspace.id,
            workspaceRootPath: requirePrimaryLocalWorkspaceRoot(managed.workspace),
            provider: managed.provider,
            model: managed.model,
            error,
          },
        })

        // Report chat/SDK errors via runtime hooks (Electron can forward to Sentry)
        sessionRuntimeHooks.captureException(error, { errorSource: 'chat', sessionId })

        sendSpan.mark('chat.error')
        sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error))
        sendSpan.end()
        await this.projectHostRuntimeError(managed, {
          phase: 'send',
          message: error instanceof Error ? error.message : 'Unknown error',
          retryable: true,
        })
        // Handle error via centralized handler
		await this.onProcessingStopped(sessionId, 'error')
      }
    } finally {
      // Only handle cleanup for unexpected exits (loop break without complete event)
      // Normal completion returns early after calling onProcessingStopped
      // Errors are handled in catch block
      if (
        managed.isProcessing
        && managed.processingGeneration === myGeneration
        && !canonicalUserPersisted
        && !managed.pendingSettlementReason
        && !managed.settlementPromise
      ) {
        sessionLog.info('Finally block cleanup - unexpected exit')
        sendSpan.mark('chat.unexpected_exit')
        sendSpan.end()
		await this.onProcessingStopped(sessionId, 'interrupted')
      }
    }
  }

  async cancelProcessing(sessionId: string, silent = false): Promise<void> {
    const managed = this.sessions.get(sessionId)
    const projectionWasProcessing = managed ? this.isPiProjectionProcessing(managed.id) : false
    if (!managed || (!managed.isProcessing && !projectionWasProcessing)) {
      return // Not processing, nothing to cancel
    }

    sessionLog.info('Cancelling processing for session:', sessionId, silent ? '(silent)' : '')

    // Pi owns command acceptance and decides whether abort is valid for the
    // current Session state.
    managed.stopRequested = true

    // Track interruption so the next user message gets a context note
    // telling the LLM the previous response was cut short
    managed.wasInterrupted = true

    // Wait for the backend to acknowledge the abort before reporting success to
    // the renderer. This prevents a stopped Pi turn from leaking late events.
    if (managed.agent) {
      await managed.agent.abort(AbortReason.UserStop)
    }

    // A restored projection can say "running" after its host process is gone.
    // Close that old projection explicitly when Pi has no live turn capable of
    // emitting agent_end itself.
    if (projectionWasProcessing && this.isPiProjectionProcessing(sessionId)) {
      this.closeStalePiProjection(sessionId)
    }

    // Only show "Response interrupted" message when user explicitly clicked Stop
    // Silent mode is used when redirecting (sending new message while processing)
    if (!silent) {
      this.sendEvent({ type: 'interrupted', sessionId }, managed.workspace.id)
    } else {
      // Still send interrupted event but without the message (for UI state update)
      this.sendEvent({
        type: 'interrupted',
        sessionId,
      }, managed.workspace.id)
    }

    // Safety timeout: if event loop doesn't complete within 5 seconds, force cleanup
    // This handles cases where the generator gets stuck
    setTimeout(() => {
      if (managed.stopRequested && managed.isProcessing) {
        sessionLog.warn('Generator did not complete after stop request, forcing cleanup')
		void this.onProcessingStopped(sessionId, 'timeout').catch(error => {
          sessionLog.error(`Failed to settle timed-out session ${sessionId}:`, error)
        })
      }
    }, 5000)

    // NOTE: We don't clear isProcessing or send complete event here anymore.
    // The event loop will drain remaining events and call onProcessingStopped when done.
  }

  /**
   * Attempt auth retry: refresh token, destroy agent, resend last message.
   * Shared by both typed_error and plain error auth-retry paths.
   * Returns true if retry was initiated, false if conditions not met.
   */
  private attemptAuthRetry(
    sessionId: string,
    managed: ManagedSession,
    workspaceId: string,
    failureErrorCode?: string,
  ): boolean {
    if (managed.workspaceTopologyAutoResumeBlocked || managed.authRetryAttempted || !managed.lastSentMessage) return false

    sessionLog.info(`Auth error detected; scheduling execution replacement for session ${sessionId}`)
    managed.authRetryAttempted = true
    managed.authRetryInProgress = true
    managed.authRetryFailureCode = failureErrorCode
    managed.authRetryTopologyGeneration = managed.workspaceTopologyGeneration

    // Emit lightweight info so the user sees progress instead of a scary red error
    this.sendEvent({
      type: 'info',
      sessionId,
      message: 'Token expired, refreshing session…',
      timestamp: this.monotonic(),
    }, workspaceId)

    return true
  }

  private async resumeAfterAuthFailure(managed: ManagedSession): Promise<void> {
    const sessionId = managed.id
    const sourceAgent = managed.agent
    const retryMessage = managed.lastSentMessage
    const retryMessageId = managed.lastSentMessageId
    try {
      if (!managed.authRetryInProgress || !retryMessage || !retryMessageId || !sourceAgent) {
        throw new Error(`Authentication recovery state is incomplete for Session ${sessionId}`)
      }
      if (
        managed.workspaceTopologyAutoResumeBlocked
        || managed.authRetryTopologyGeneration !== managed.workspaceTopologyGeneration
      ) {
        throw new Error(`Authentication recovery was invalidated by a Workspace topology change for Session ${sessionId}`)
      }

      await this.settleUnknownToolSideEffects(managed)
      this.persistSession(managed)
      await this.flushSession(sessionId)
      await this.flushPiProjectionWrites(managed)
      await this.disposeManagedAgentRuntime(managed, 'authentication execution replacement', {
        propagateFailure: true,
        expectedAgent: sourceAgent,
      })
      managed.authRetryInProgress = false
      managed.authRetryTopologyGeneration = undefined

      sessionLog.info(`[auth-retry] Continuing Session ${sessionId} with a replacement execution`)
      await this.sendMessage(
        sessionId,
        retryMessage,
        managed.lastSentAttachments,
        managed.lastSentStoredAttachments,
        managed.lastSentOptions,
        retryMessageId,
        true,
        undefined,
        undefined,
        false,
		undefined,
      )
    } catch (retryError) {
      managed.authRetryInProgress = false
      managed.authRetryTopologyGeneration = undefined
      sessionLog.error(`[auth-retry] Failed to replace execution for session ${sessionId}:`, retryError)
      sessionRuntimeHooks.captureException(retryError, { errorSource: 'auth-retry', sessionId })
      await this.projectHostRuntimeError(managed, {
        phase: 'recovery',
        message: 'Authentication failed. Please check your credentials.',
        code: managed.authRetryFailureCode,
        retryable: true,
      })
      await this.onProcessingStopped(sessionId, 'error')
    } finally {
      managed.authRetryFailureCode = undefined
    }
  }

  /**
   * Central handler for when processing stops (any reason).
   * Single source of truth for cleanup and queue processing.
   *
   * @param sessionId - The session that stopped processing
   * @param reason - Why processing stopped ('complete' | 'interrupted' | 'error')
   */
  private async onProcessingStopped(
    sessionId: string,
	reason: 'complete' | 'interrupted' | 'error' | 'timeout',
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    if (managed.settlementPromise) {
      return managed.settlementPromise
    }

    managed.pendingSettlementReason ??= reason
    // Defer execution until after the shared promise is installed. Otherwise a
    // second synchronous caller can enter before settleProcessing reaches its
    // first await and start a duplicate settlement.
    const settlement = Promise.resolve().then(
	  () => this.settleProcessing(managed, managed.pendingSettlementReason!),
    ).catch(error => {
      throw error instanceof SessionSettlementDurabilityError
        ? error
        : new SessionSettlementDurabilityError(sessionId, error)
    })
    managed.settlementPromise = settlement
    try {
      await settlement
    } finally {
      if (managed.settlementPromise === settlement) {
        managed.settlementPromise = undefined
      }
    }
  }

  /** Retry an accepted turn whose host-owned durability boundary is pending. */
  async retryPendingSettlement(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.pendingSettlementReason && !managed?.settlementPromise) return
	await this.onProcessingStopped(sessionId, managed.pendingSettlementReason ?? 'error')
  }

  /** Retry an accepted first turn without allocating a new client mutation id. */
  async retryAcceptedMessage(sessionId: string, callerClientId?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    const record = this.messageOutbox.listPending().find(candidate => (
      candidate.sessionId === sessionId
      && candidate.provisional === true
      && candidate.status !== 'pi_persisted'
    ))
    if (!record) throw new Error(`No retryable accepted message exists for Session ${sessionId}`)

    managed.pendingPublicationFailure = undefined

    // A Pi write can succeed while Mortise metadata/projection publication
    // fails. Reconcile that durable mutation first; replaying the prompt would
    // otherwise append the same user message and invoke the model twice.
    let alreadyPersisted = false
    try {
      alreadyPersisted = await this.hasPersistedOutboxMutation(record, managed)
    } catch (error) {
      sessionLog.warn(`Could not inspect Pi persistence before retrying ${record.clientMutationId}: ${error instanceof Error ? error.message : error}`)
    }
    if (alreadyPersisted) {
      this.messageOutbox.update(record.clientMutationId, {
        status: 'pi_persisted',
        updatedAt: Date.now(),
        error: undefined,
      })
      try {
        if (managed.publicationState) await this.publishProvisionalSessionIfReady(managed)
        if (!managed.publicationState) this.removeMessageOutboxBestEffort(record.clientMutationId)
        return
      } catch (error) {
        const publicationError = error instanceof SessionPublicationDurabilityError
          ? error
          : new SessionPublicationDurabilityError(sessionId, 'runtime', error)
        const failure: SessionPublicationFailure = {
          code: publicationError.code,
          message: publicationError.message,
          data: publicationError.data,
        }
        managed.pendingPublicationFailure = failure
        this.messageOutbox.update(record.clientMutationId, {
          status: 'failed',
          updatedAt: Date.now(),
          error: publicationError.message,
        })
        if (callerClientId) this.sendEventToClient({ type: 'session_failure', sessionId, error: failure }, callerClientId)
        return
      }
    }

    this.messageOutbox.update(record.clientMutationId, {
      status: 'accepted',
      attempt: record.attempt + 1,
      updatedAt: Date.now(),
      error: undefined,
    })

    await new Promise<void>((resolve, reject) => {
      let accepted = false
      const onAccepted = () => {
        if (accepted) return
        accepted = true
        resolve()
      }
      void this.sendMessage(
        sessionId,
        record.message,
        record.attachments as unknown as FileAttachment[] | undefined,
        record.storedAttachments as unknown as StoredAttachment[] | undefined,
        record.options as unknown as SendMessageOptions | undefined,
        record.clientMutationId,
        false,
        undefined,
        { callerClientId },
        false,
        onAccepted,
      ).then(() => {
        if (!accepted) reject(new Error(`Retry for Session ${sessionId} completed without acceptance`))
      }).catch(error => {
        if (!accepted) {
          reject(error)
          return
        }
        const publicationError = error instanceof SessionPublicationDurabilityError
          ? error
          : new SessionPublicationDurabilityError(sessionId, 'runtime', error)
        const failure: SessionPublicationFailure = {
          code: publicationError.code,
          message: publicationError.message,
          data: publicationError.data,
        }
        managed.pendingPublicationFailure = failure
        if (callerClientId) {
          this.sendEventToClient({ type: 'session_failure', sessionId, error: failure }, callerClientId)
        }
      })
    })
  }

  private async settleProcessing(
    managed: ManagedSession,
    reason: 'complete' | 'interrupted' | 'error' | 'timeout',
  ): Promise<void> {
    const sessionId = managed.id

    sessionLog.info(`Processing stopped for session ${sessionId}: ${reason}`)

    const turnStartFinalMessageId = managed.turnStartFinalMessageId

    // Clear agent control overlay between turns. The session keeps browser
    // ownership (boundSessionId) — only the visual overlay is removed.
    // Full unbind happens below when the queue is empty (session truly done).
    const turnBpm = this.getBrowserPaneManagerForSession(sessionId)
    if (turnBpm) {
      await turnBpm.clearVisualsForSession(sessionId)
    }

    // 2. Handle unread state based on whether user is viewing this session
    //    This is the explicit state machine for NEW badge:
    //    - If user is viewing: mark as read (they saw it complete)
    //    - If user is NOT viewing: mark as unread (they have new content)
    //    IMPORTANT: only apply this when the turn produced a NEW final assistant message.
    const isViewing = this.isSessionBeingViewed(sessionId, managed.workspace.id)
    const currentFinalMessageId = managed.lastFinalMessageId
    const didReceiveNewFinalMessage = !!currentFinalMessageId && currentFinalMessageId !== turnStartFinalMessageId

    if (reason === 'complete' && didReceiveNewFinalMessage) {
      if (isViewing) {
        // User is watching - mark as read immediately
        await this.markSessionRead(sessionId, { allowWhileSettling: true })
      } else {
        // User is not watching - mark as unread for NEW badge
        if (!managed.hasUnread) {
          managed.hasUnread = true
          await updateSessionMetadata(managed.workspace.id, sessionId, { hasUnread: true })
          this.emitUnreadSummaryChanged()
        }
      }
    }

    // 3. Apply deferred external metadata updates captured while processing.
    if (managed.pendingExternalMetadata) {
      const pendingHeader = managed.pendingExternalMetadata
      sessionLog.info(`Applying deferred external metadata for session ${sessionId} after processing stop`)
      await this.applyExternalSessionMetadata(managed, pendingHeader)
    }

    if (managed.pendingProviderRuntimeRestart) {
      await this.disposeManagedAgentRuntime(managed, 'deferred provider registry reload')
    }

    // Legacy sessions written before plan-mode moved to its extension may
    // still carry this sidecar. Keep its durability boundary readable and
    // recoverable, but never create it for V2 extension-owned plans.
    if (managed.pendingCompactionCompletion) {
      await this.markCompactionComplete(sessionId)
    }

    // Any tool without a complete result at the turn boundary is explicitly
    // outcome-unknown. This receipt must be durable before control can move.
    await this.settleUnknownToolSideEffects(managed)

    // 4. Commit the settled state before exposing next-turn readiness. Pi's
    // agent_settled event is the logical completion boundary; Mortise must not
    // emit complete or begin replay while its metadata/projection writes are
    // still pending.
    this.persistSession(managed)
    await this.flushSession(managed.id)
    await this.flushPiProjectionWrites(managed)

    // Only now expose next-turn readiness. Until both stores are durable the
    // accepted turn remains processing, so queue replay and fresh sends cannot
    // overtake settlement.
    this.setProcessing(managed, false)
    managed.stopRequested = false
    managed.turnStartFinalMessageId = undefined
    managed.pendingExternalMetadata = undefined
    managed.pendingProviderRuntimeRestart = false
    for (const [messageId, pending] of managed.pendingInputAcks) {
      pending.reject(new Error(`Steer ${messageId} was not durably accepted before the turn ended`))
    }
	managed.pendingInputAcks.clear()
	managed.pendingSettlementReason = undefined

    // Pi owns follow-up draining. Mortise only publishes the settled product state.
    {
      // Session is truly done — release browser ownership.
      // The window stays alive (hidden) and becomes reusable by future sessions.
      // On the next turn, getOrCreateForSession() will re-bind it.
      const doneBpm = this.getBrowserPaneManagerForSession(sessionId)
      if (doneBpm) {
        doneBpm.unbindAllForSession(sessionId)
      }

      // No queue - emit complete to UI (include tokenUsage and hasUnread for state updates)
      this.sendEvent({
        type: 'complete',
        sessionId,
        tokenUsage: managed.tokenUsage,
        hasUnread: managed.hasUnread,
      }, managed.workspace.id)
      const pendingTitleUserMessage = managed.pendingTitleUserMessage
      managed.pendingTitleUserMessage = undefined
      if (pendingTitleUserMessage) this.generateTitle(managed, pendingTitleUserMessage)
    }

  }

  /**
   * Stop Session-owned work before a Workspace topology mutation. Workspace
   * scope is used for primary changes; location scope is used for detach and
   * endpoint replacement.
   */
  async interruptWorkspaceSessionsForTopologyChange(
    target: WorkspaceSessionInterruptionTarget,
  ): Promise<WorkspaceSessionInterruptionResult> {
    const activeOwners = target.scope === 'location'
      ? new Set(this.workspaceLocationActivities.list({
          workspaceId: target.workspaceId,
          locationId: target.locationId,
        }).flatMap(activity => activity.ownerSessionId ?? (activity.kind === 'session' ? activity.activityId : [])))
      : null
    const selected = Array.from(this.sessions.values()).filter((managed) => {
      if (managed.workspace.id !== target.workspaceId) return false
      if (target.scope === 'location'
        && !activeOwners?.has(managed.id)
        && managed.activeWorkspaceLocationId !== target.locationId) return false
      return this.hasNonTerminalWorkspaceSessionWork(managed)
    })

    const interrupted = await Promise.all(selected.map(managed => (
      this.interruptManagedSessionForTopologyChange(managed)
    )))

    return {
      selectedSessionIds: selected.map(managed => managed.id),
      interruptedSessionIds: selected.filter((_, index) => interrupted[index]).map(managed => managed.id),
    }
  }

  /** Adopt the authoritative Workspace record after a topology command commits. */
  updateWorkspaceTopology(workspace: Workspace): void {
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id === workspace.id) managed.workspace = workspace
    }
  }

  private hasNonTerminalWorkspaceSessionWork(managed: ManagedSession): boolean {
    return Boolean(
      managed.workspaceTopologyInterruption
      || managed.workspaceTopologyInterruptionFailure
      || managed.isProcessing
      || managed.agent?.isProcessing()
      || this.isPiProjectionProcessing(managed.id)
      || managed.messageQueue.length > 0
      || managed.pendingSettlementReason
      || managed.settlementPromise
      || managed.authRetryInProgress
      || managed.stopRequested
      || managed.backgroundShellCommands.size > 0
      || (this.subagentLifecycleTasks.get(managed.id)?.size ?? 0) > 0
      || this.subagentDeliveryWrites.has(managed.id)
      || Array.from(this.subagentDeliveryTasks.keys()).some(key => key.startsWith(`${managed.id}:`))
    )
  }

  private interruptManagedSessionForTopologyChange(managed: ManagedSession): Promise<boolean> {
    const current = managed.workspaceTopologyInterruption
    if (current) return current.then(() => false)
    if (managed.workspaceTopologyInterruptionFailure) {
      return Promise.reject(managed.workspaceTopologyInterruptionFailure)
    }

    const sessionId = managed.id
    const hadProjectionWork = this.isPiProjectionProcessing(sessionId)
      || this.piProjectionBySession.get(sessionId)?.createSnapshot().entities.some((entity) => (
        entity.payload && typeof entity.payload === 'object'
          && (entity.payload as Record<string, unknown>).queueStatus === 'queued'
      )) === true

    // Fence recovery synchronously before waiting on backend or persistence.
    managed.workspaceTopologyAutoResumeBlocked = true
    managed.workspaceTopologyGeneration++
    managed.processingGeneration++
    managed.messageQueue = []
    managed.authRetryAttempted = true
    managed.authRetryInProgress = false
    managed.authRetryFailureCode = undefined
    managed.authRetryTopologyGeneration = undefined
    managed.lastSentMessage = undefined
    managed.lastSentAttachments = undefined
    managed.lastSentStoredAttachments = undefined
    managed.lastSentOptions = undefined
    managed.lastSentMessageId = undefined
    managed.stopRequested = true
    managed.wasInterrupted = true

    const work = (async () => {
      const errors: unknown[] = []
      const agent = managed.agent
      if (agent) {
        try {
          await agent.abort(AbortReason.UserStop)
        } catch (error) {
          errors.push(error)
        }
      }

      try {
        await managed.settlementPromise
      } catch (error) {
        errors.push(error)
      }

      try {
        await this.disposeManagedAgentRuntime(managed, 'Workspace topology interruption', { propagateFailure: true })
      } catch (error) {
        errors.push(error)
      }

      try {
        await this.drainSubagentLifecycle(managed)
      } catch (error) {
        errors.push(error)
      }
      this.interruptQueuedPiProjectionMessages(managed)
      if (hadProjectionWork && this.isPiProjectionProcessing(sessionId)) {
        this.closeStalePiProjection(sessionId)
      }

      this.setProcessing(managed, false)
      managed.stopRequested = false
      managed.turnStartFinalMessageId = undefined
      managed.pendingExternalMetadata = undefined
      managed.pendingProviderRuntimeRestart = false
      managed.pendingSettlementReason = undefined
      managed.backgroundShellCommands.clear()
      this.workspaceLocationActivities.clearSession(sessionId)

      const bpm = this.getBrowserPaneManagerForSession(sessionId)
      bpm?.unbindAllForSession(sessionId)

      if (!managed.publicationState) {
        this.persistSession(managed)
        try {
          await this.flushSession(sessionId)
          await this.flushPiProjectionWrites(managed)
        } catch (error) {
          errors.push(error)
        }
      }

      this.sendEvent({ type: 'interrupted', sessionId }, managed.workspace.id)
      if (errors.length > 0) {
        const failure = new AggregateError(errors, `Failed to fully interrupt Session ${sessionId} for Workspace topology change`)
        managed.workspaceTopologyInterruptionFailure = failure
        throw failure
      }
      managed.workspaceTopologyInterruptionFailure = undefined
    })()

    managed.workspaceTopologyInterruption = work
    return work.then(
      () => true,
      error => { throw error },
    ).finally(() => {
      if (managed.workspaceTopologyInterruption === work) {
        managed.workspaceTopologyInterruption = undefined
      }
    })
  }

  private interruptQueuedPiProjectionMessages(managed: ManagedSession): void {
    const projector = this.piProjectionBySession.get(managed.id)
    if (!projector) return

    const snapshot = projector.createSnapshot()
    let seq = snapshot.lastSeq + 1
    for (const entity of snapshot.entities) {
      if (!entity.payload || typeof entity.payload !== 'object') continue
      const payload = entity.payload as Record<string, unknown>
      if (payload.queueStatus !== 'queued') continue
      this.applyPiProjectionEvent({
        schemaVersion: 1,
        eventId: `${snapshot.runtimeId}:host-queue-interrupted:${seq}`,
        seq,
        sessionId: managed.id,
        runtimeId: snapshot.runtimeId,
        entityId: entity.entityId,
        entityType: entity.entityType,
        entityVersion: entity.entityVersion + 1,
        kind: entity.kind,
        payload: { ...payload, queueStatus: 'interrupted' },
      })
      seq++
    }
  }

  async killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    sessionLog.info(`Killing shell ${shellId} for session: ${sessionId}`)

    // Try to kill the actual process using the stored command
    const command = managed.backgroundShellCommands.get(shellId)
    if (command) {
      try {
        // Use pkill to find and kill processes matching the command
        // The -f flag matches against the full command line
        const { exec } = await import('child_process')
        const { promisify } = await import('util')
        const execAsync = promisify(exec)

        // Escape the command for use in pkill pattern
        // We search for the unique command string in process args
        const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

        sessionLog.info(`Attempting to kill process with command: ${command.slice(0, 100)}...`)

        // Use pgrep first to find the PID, then kill it
        // This is safer than pkill -f which can match too broadly
        try {
          const { stdout } = await execAsync(`pgrep -f "${escapedCommand}"`)
          const pids = stdout.trim().split('\n').filter(Boolean)

          if (pids.length > 0) {
            sessionLog.info(`Found ${pids.length} process(es) to kill: ${pids.join(', ')}`)
            // Kill each process
            for (const pid of pids) {
              try {
                await execAsync(`kill -TERM ${pid}`)
                sessionLog.info(`Sent SIGTERM to process ${pid}`)
              } catch (killErr) {
                // Process may have already exited
                sessionLog.warn(`Failed to kill process ${pid}: ${killErr}`)
              }
            }
          } else {
            sessionLog.info(`No processes found matching command`)
          }
        } catch (pgrepErr) {
          // pgrep returns exit code 1 when no processes found, which is fine
          sessionLog.info(`No matching processes found (pgrep returned no results)`)
        }

        // Clean up the stored command
        managed.backgroundShellCommands.delete(shellId)
        this.workspaceLocationActivities.end('subprocess', `${managed.id}:${shellId}`)
      } catch (err) {
        sessionLog.error(`Error killing shell process: ${err}`)
      }
    } else {
      sessionLog.warn(`No command stored for shell ${shellId}, cannot kill process`)
    }

    // Always emit shell_killed to remove from UI regardless of process kill success
    this.sendEvent({
      type: 'shell_killed',
      sessionId,
      shellId,
    }, managed.workspace.id)

    return { success: true }
  }

  /**
   * Get output from a background task
   *
   * Looks up the output file stored when a task_completed event was received,
   * reads its contents, and returns them. Falls back to the SDK-provided summary
   * if the file cannot be read.
   *
   * @param taskId - The task or shell ID
   * @returns Task output content, or null if task not found
   */
  async getTaskOutput(taskId: string): Promise<string | null> {
    // O(1) lookup via taskOutputIndex
    const sessionId = this.taskOutputIndex.get(taskId)
    if (!sessionId) {
      sessionLog.info(`No output found for task: ${taskId} (task may still be running)`)
      return null
    }

    const managed = this.sessions.get(sessionId)
    const info = managed?.backgroundTaskOutputs.get(taskId)
    if (!info) {
      // Index out of sync — clean up stale entry
      this.taskOutputIndex.delete(taskId)
      return null
    }

    sessionLog.info(`Found output for task ${taskId}: file=${info.outputFile}, status=${info.status}`)
    try {
      const content = await readFile(info.outputFile, 'utf-8')
      // Delete after successful read to prevent memory leak
      managed!.backgroundTaskOutputs.delete(taskId)
      this.taskOutputIndex.delete(taskId)
      return content
    } catch (err) {
      sessionLog.error(`Failed to read task output file: ${info.outputFile}`, err)
      // Fall back to SDK-provided summary
      return info.summary || null
    }
  }

  respondToExtensionInteraction(
    sessionId: string,
    requestId: string,
    response: ExtensionInteractionResponseV1,
  ): boolean {
    const managed = this.sessions.get(sessionId)
    if (managed?.agent) {
      if (typeof managed.agent.respondToExtensionInteraction !== 'function') {
        sessionLog.warn(`Cannot respond to extension interaction for session ${sessionId}: backend does not support it`)
        return false
      }
      sessionLog.info(`Extension interaction response for ${requestId}: outcome=${response.status}`)
      return managed.agent.respondToExtensionInteraction(requestId, response)
    } else {
      sessionLog.warn(`Cannot respond to extension interaction - no agent for session ${sessionId}`)
      return false
    }
  }

  /**
   * 调用 pi 扩展注册的命令（extension_command_invoke）。
   * 仅 Pi 后端实现（PiAgent.sendExtensionCommandInvoke）；其他后端返回 false。
   * 返回 false 时调用方应回退到原生路径。
   */
  async invokeExtensionCommand(sessionId: string, commandId: string, args?: string, ownerExtensionId?: string): Promise<import('@mortise/core/types').ExtensionCommandResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[ExtensionBridge] No session for command invocation: ${sessionId}`)
      return { invoked: false, error: 'Session not found.' }
    }
    try {
      const agent = managed.agent ?? await this.getOrCreateAgent(managed)
      if (typeof agent.sendExtensionCommandInvoke !== 'function') {
        sessionLog.warn(`[ExtensionBridge] Agent does not support sendExtensionCommandInvoke (session: ${sessionId})`)
        return { invoked: false, error: 'The active backend does not support extension commands.' }
      }
      const result = ownerExtensionId === undefined
        ? await agent.sendExtensionCommandInvoke(commandId, args)
        : await agent.sendExtensionCommandInvoke(commandId, args, ownerExtensionId)
      for (const message of result.customMessages ?? []) {
        await this.processEvent(managed, {
          type: 'custom_message',
          id: message.id,
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
          timestamp: message.timestamp,
        })
      }
      sessionLog.info('[ExtensionBridge] command result', { sessionId, commandId, invoked: result.invoked, error: result.error })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(`[ExtensionBridge] Extension command ${commandId} failed for session ${sessionId}: ${message}`)
      return { invoked: false, error: message }
    }
  }

  private isPiProjectionProcessing(sessionId: string): boolean {
    const snapshot = this.piProjectionBySession.get(sessionId)?.createSnapshot()
    return snapshot ? isPiProjectionSnapshotProcessing(snapshot) : false
  }

  private closeStalePiProjection(
    sessionId: string,
    occurredAt: number | null = Date.now(),
    reason?: 'host_restart',
  ): void {
    const snapshot = this.piProjectionBySession.get(sessionId)?.createSnapshot()
    if (!snapshot) return
    const seq = snapshot.lastSeq + 1
    this.applyPiProjectionEvent({
      schemaVersion: 1,
      eventId: `${snapshot.runtimeId}:host-interrupted:${seq}`,
      seq,
      sessionId,
      runtimeId: snapshot.runtimeId,
      entityId: `lifecycle:agent_end:host:${seq}`,
      entityType: 'conversation',
      entityVersion: 1,
      kind: 'agent_end',
      payload: { status: 'interrupted', settlementPending: true, ...(reason ? { reason } : {}) },
      occurredAt: occurredAt ?? undefined,
    })
    this.applyPiProjectionEvent({
      schemaVersion: 1,
      eventId: `${snapshot.runtimeId}:host-settled:${seq + 1}`,
      seq: seq + 1,
      sessionId,
      runtimeId: snapshot.runtimeId,
      entityId: `lifecycle:agent_settled:host:${seq + 1}`,
      entityType: 'conversation',
      entityVersion: 1,
      kind: 'agent_settled',
      payload: { status: 'interrupted', ...(reason ? { reason } : {}) },
      occurredAt: occurredAt ?? undefined,
    })
  }

  /**
   * 查询当前会话已注册的 Pi 扩展 slash commands。
   */
  async listExtensionCommands(sessionId: string): Promise<import('@mortise/shared/agent').PiExtensionCommand[]> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[ExtensionBridge] No session for command listing: ${sessionId}`)
      return []
    }

    let agent = managed.agent
    if (!agent) {
      try {
        agent = await this.getOrCreateAgent(managed)
      } catch (error) {
        sessionLog.warn(`[ExtensionBridge] Failed to prepare command runtime for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }

    if (typeof agent.listExtensionCommands !== 'function') {
      sessionLog.warn(`[ExtensionBridge] Agent does not support listExtensionCommands (session: ${sessionId})`)
      return []
    }
    try {
      return await agent.listExtensionCommands()
    } catch (error) {
      sessionLog.warn(`[ExtensionBridge] Failed to list extension commands for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /**
   * List child sessions in pi's session tree spawned from the given mortise session.
   *
   * Delegates to the backend's listChildSessions (PiAgent) which queries pi's
   * SessionManager.list(cwd) and filters by header.spawnedFrom === piSessionId.
   * Used by the SubagentPanel to render the active branch set instead of the
   * legacy subagent-supervisor active-sessions.json.
   *
   * Returns an empty array when the backend doesn't support listChildSessions.
   * A cold backend receives the Mortise session ID as a startup hint and resolves
   * its authoritative runtime session ID after readiness.
   */
  async listChildSessions(sessionId: string): Promise<import('@mortise/shared/agent').PiChildSessionInfo[]> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[listChildSessions] No session for ${sessionId}`)
      return []
    }
    let agent = managed.agent
    if (!agent) {
      try {
        agent = await this.getOrCreateAgent(managed)
      } catch (error) {
        sessionLog.warn(`[listChildSessions] Failed to prepare runtime for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    }
    if (typeof agent.listChildSessions !== 'function') {
      return []
    }
    const parentSessionId = agent.getSessionId() ?? managed.sdkSessionId ?? sessionId
    try {
      return await agent.listChildSessions(parentSessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(`[listChildSessions] Failed for session ${sessionId}: ${message}`)
      return []
    }
  }

  /**
   * Set the thinking level for a session. See {@link ThinkingLevel} for valid values.
   * This is sticky and persisted across messages.
   */
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      // Update thinking level in managed session
      managed.thinkingLevel = level

      // Update the agent's thinking level if it exists
      if (managed.agent) {
        managed.agent.setThinkingLevel(level)
      }

      sessionLog.info(`Session ${sessionId}: thinking level set to ${level}`)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Generate an AI title for a session from the user's first message.
   * Uses the agent's generateTitle() method which handles provider-specific SDK calls.
   * If no agent exists, creates a temporary one using the session's connection.
   */
  private async generateTitle(managed: ManagedSession, userMessage: string): Promise<void> {
    sessionLog.info(`[generateTitle] Starting for session ${managed.id}`)

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    // Wait briefly for agent to be created (it's created concurrently)
    if (!agent) {
      let attempts = 0
      while (!managed.agent && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }
      agent = managed.agent
    }

    // If still no agent, create a temporary one using the session's connection
    if (!agent && managed.provider) {
      try {
        const providerConfig = readPiGlobalProviders()[managed.provider]

        agent = createBackendFromProvider(managed.provider, {
          workspace: managed.workspace,
          miniModel: providerConfig?.models?.[1]?.id ?? providerConfig?.models?.[0]?.id,
          session: {
            mortiseId: `title-${managed.id}`,
            workspaceId: managed.workspace.id,
            workspaceRootPath: requirePrimaryLocalWorkspaceRoot(managed.workspace),
            provider: managed.provider,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }, buildBackendHostRuntimeContext()) as AgentInstance
        await agent.postInit()
        isTemporary = true
        sessionLog.info(`[generateTitle] Created temporary agent for session ${managed.id}`)
      } catch (error) {
        sessionLog.error(`[generateTitle] Failed to create temporary agent:`, error)
        return
      }
    }

    if (!agent) {
      sessionLog.warn(`[generateTitle] No agent and no connection for session ${managed.id}`)
      return
    }

    try {
      // Race-free language resolution from persisted UI language; undefined => auto-detect (#885).
      const titleLanguage = resolveTitleLanguageName()
      sessionLog.info(`[generateTitle] language at call time`, {
        sessionId: managed.id,
        persistedUiLanguage: getPersistedUiLanguage() ?? null,
        resolvedLanguage: i18n.resolvedLanguage ?? null,
        titleLanguage: titleLanguage ?? null,
      })
      const title = await agent.generateTitle(userMessage, { language: titleLanguage })
      if (title) {
        managed.name = title
        this.persistSession(managed)
        // Flush immediately to ensure disk is up-to-date before notifying renderer.
        // This prevents race condition where lazy loading reads stale disk data
        // (the persistence queue has a 500ms debounce).
        await this.flushSession(managed.id)
        // Now safe to notify renderer - disk is authoritative
        this.sendEvent({ type: 'title_generated', sessionId: managed.id, title }, managed.workspace.id)
        sessionLog.info(`Generated title for session ${managed.id}: "${title}"`)
      } else {
        sessionLog.warn(`Title generation returned null for session ${managed.id}`)
      }
    } catch (error) {
      sessionLog.error(`Failed to generate title for session ${managed.id}:`, error)

      // Surface quota/auth errors to the user — these indicate the main chat call will also fail
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('quota') || errorMsg.includes('429') || errorMsg.includes('401') || errorMsg.includes('insufficient')) {
        await this.projectHostRuntimeError(managed, {
          phase: 'recovery',
          code: 'provider_error',
          message: `API error: ${errorMsg.slice(0, 200)}`,
          retryable: true,
        })
      }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        agent.destroy()
      }
    }
  }

  private async processEvent(
    managed: ManagedSession,
    event: AgentEvent,
  ): Promise<void> {
    const sessionId = managed.id
    const workspaceId = managed.workspace.id

    switch (event.type) {
      case 'pi_user_message_persisted':
        // Internal durability signal used by sendMessage ACK handling.
        break

      case 'text_delta':
        managed.streamingText += event.text
        break

      case 'text_complete': {
        managed.streamingText = ''
        if (!event.isIntermediate) managed.lastMessageRole = 'assistant'
        break
      }

      case 'custom_message': {
        const customId = event.id ?? generateMessageId()
        const planInput = {
          id: customId,
          customType: event.customType,
          content: event.content,
          details: event.details,
          timestamp: event.timestamp ?? this.monotonic(),
        }
        const result = { projection: parsePlanCustomMessage(planInput) }

        if (result.projection.kind === 'state') {
          managed.planModeState = result.projection.state
          sessionLog.info('[PlanMode] state changed', {
            sessionId,
            phase: result.projection.state.phase,
            artifactId: result.projection.state.activeArtifactId,
          })
          this.persistSession(managed)
          break
        }

        if (result.projection.kind === 'artifact') {
          const artifactProjection = result.projection
          sessionLog.info('[PlanMode] artifact bound', {
            sessionId,
            artifactId: artifactProjection.artifact.artifactId,
            state: artifactProjection.artifact.state,
            isUpdate: artifactProjection.isUpdate,
          })
          this.persistSession(managed)
          break
        }

        break
      }

      case 'tool_start': {
        this.workspaceLocationActivities.begin({
          workspaceId: managed.workspace.id,
          locationId: managed.activeWorkspaceLocationId ?? managed.workspace.primaryLocationId,
          kind: 'tool',
          activityId: `${managed.id}:${event.toolUseId}`,
          ownerSessionId: managed.id,
        })
        const formattedToolInput = formatToolInputPaths(event.input)
        const workspaceRootPath = requirePrimaryLocalWorkspaceRoot(managed.workspace)
        let toolDisplayMeta: ToolDisplayMeta | undefined
        if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
          toolDisplayMeta = await resolveToolDisplayMeta(event.toolName, formattedToolInput, workspaceRootPath)
        }
        const shouldActivateOverlay = shouldActivateBrowserOverlay(
          event.toolName,
          formattedToolInput,
        )

        const overlayBpm = this.getBrowserPaneManagerForSession(sessionId)
        if (overlayBpm && shouldActivateOverlay) {
          // Ensure first browser action in a turn gets an instance before overlay activation.
          overlayBpm.getOrCreateForSession(sessionId, { workspaceId })

          const resolvedDisplayName = toolDisplayMeta?.displayName
            ?? event.displayName
            ?? event.toolName
          overlayBpm.setAgentControl(
            sessionId,
            { displayName: resolvedDisplayName, intent: event.intent },
            { workspaceId },
          )
        }
        break
      }

      case 'tool_result': {
        this.workspaceLocationActivities.end('tool', `${managed.id}:${event.toolUseId}`)
        const pending = managed.pendingToolSideEffects.get(event.toolUseId)
        if (pending) {
          await this.recordToolSideEffect(managed, {
            attemptId: pending.attemptId,
            toolCallId: event.toolUseId,
            toolName: pending.toolName,
            status: 'completed',
            isError: event.isError,
          })
          managed.pendingToolSideEffects.delete(event.toolUseId)
        }
        // Pi projection owns tool transcript and completion state.
        break
      }

      case 'queue_overflow':
        // Visible queue warnings are projected by PiProjectionBuilder.
        break

      case 'status':
        // Visible status belongs to the Pi projection timeline.
        break

      case 'info': {
        const isCompactionComplete = event.message.startsWith('Compacted')
        if (isCompactionComplete) {
          // The plan-mode extension owns new handoffs. Only the legacy
          // session header compatibility field uses the host sidecar.
          if (managed.pendingPlanExecution) {
            managed.pendingCompactionCompletion = true
            try {
              await this.markCompactionComplete(sessionId)
            } catch (error) {
              sessionLog.warn(`Session ${sessionId}: legacy compaction compatibility write pending settlement retry`, error)
            }
          }
          if (managed.tokenUsage) {
            // Pi cannot know the new context size until the next model request.
            // Never keep displaying the pre-compaction value as current usage.
            managed.tokenUsage.inputTokens = 0
            managed.tokenUsage.contextTokens = 0
            managed.tokenUsage.totalTokens = managed.tokenUsage.outputTokens
            this.sendEvent({
              type: 'usage_update',
              sessionId,
              tokenUsage: {
                inputTokens: managed.tokenUsage.inputTokens,
                contextWindow: managed.tokenUsage.contextWindow,
              },
            }, workspaceId)
          }
        }

        break
      }

      case 'error': {
        // Skip errors after handoff (plan submission, auth request) — the SDK may emit
        // an error from the interrupted query after we've already stopped processing.
        if (!managed.isProcessing) {
          sessionLog.info('Skipping error event after handoff/stop:', event.message)
          break
        }

        // Skip abort errors - these are expected when force-aborting via Query.close()
        if (event.message.includes('aborted') || event.message.includes('AbortError')) {
          sessionLog.info('Skipping abort error event (expected during interrupt)')
          break
        }

        // Defensive: detect auth-expiry text in plain errors that weren't classified
        // as typed_error (e.g. Pi SDK error path or future provider changes).
        const lowerErr = event.message.toLowerCase()
        const isPlainAuthError =
          lowerErr.includes('token is expired') ||
          lowerErr.includes('authentication token is expired') ||
          lowerErr.includes('please try signing in again') ||
          (lowerErr.includes('401') && (lowerErr.includes('unauthorized') || lowerErr.includes('auth')))

        if (isPlainAuthError && this.attemptAuthRetry(sessionId, managed, workspaceId)) {
          break
        }

        this.sendEvent({ type: 'error', sessionId, error: event.message }, workspaceId)
        break
      }

      case 'typed_error':
        // Skip errors after handoff (plan submission, auth request)
        if (!managed.isProcessing) {
          sessionLog.info('Skipping typed_error event after handoff/stop:', event.error.message || event.error.title)
          break
        }

        // Skip abort errors - these are expected when force-aborting via Query.close()
        const typedErrorMsg = event.error.message || event.error.title || ''
        if (typedErrorMsg.includes('aborted') || typedErrorMsg.includes('AbortError')) {
          sessionLog.info('Skipping typed abort error event (expected during interrupt)')
          break
        }
        // Typed errors have structured information - send both formats for compatibility
        sessionLog.info('typed_error:', JSON.stringify(event.error, null, 2))

        // Check for auth errors that can be retried by refreshing the token
        // The SDK subprocess caches the token at startup, so if it expires mid-session,
        // we get invalid_api_key errors. We can fix this by:
        // 1. Resetting the summarization client cache
        // 2. Destroying the agent (new agent's postInit() refreshes the token)
        // 3. Retrying the message
        const isAuthError = event.error.code === 'invalid_api_key' ||
          event.error.code === 'expired_oauth_token'

        if (isAuthError && this.attemptAuthRetry(sessionId, managed, workspaceId, event.error.code)) {
          // Don't add error message or send to renderer - we're handling it via retry
          break
        }

        this.sendEvent({ type: 'typed_error', sessionId, error: event.error }, workspaceId)
        break

      case 'task_backgrounded':
      case 'task_progress':
        // Forward background task events directly to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'task_completed':
        // Store output for later retrieval via getTaskOutput()
        if (managed) {
          this.workspaceLocationActivities.end('subprocess', `${managed.id}:${event.taskId}`)
          managed.backgroundTaskOutputs.set(event.taskId, {
            outputFile: event.outputFile || '',
            summary: event.summary || '',
            status: event.status,
            completedAt: Date.now(),
          })
          // O(1) index for getTaskOutput() — avoids scanning all sessions
          this.taskOutputIndex.set(event.taskId, sessionId)
          sessionLog.info(`Background task ${event.taskId} completed (status=${event.status})`)

          // Evict stale entries older than 1 hour to bound memory growth
          const ONE_HOUR = 3_600_000
          const now = Date.now()
          for (const [tid, info] of managed.backgroundTaskOutputs) {
            if (now - info.completedAt > ONE_HOUR) {
              managed.backgroundTaskOutputs.delete(tid)
              this.taskOutputIndex.delete(tid)
            }
          }
        }
        // Forward to renderer for UI update
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'shell_backgrounded':
        // Store the command for later process killing
        if (event.command && managed) {
          managed.backgroundShellCommands.set(event.shellId, event.command)
          this.workspaceLocationActivities.begin({
            workspaceId: managed.workspace.id,
            locationId: managed.activeWorkspaceLocationId ?? managed.workspace.primaryLocationId,
            kind: 'subprocess',
            activityId: `${managed.id}:${event.shellId}`,
            ownerSessionId: managed.id,
          })
          sessionLog.info(`Stored command for shell ${event.shellId}: ${event.command.slice(0, 50)}...`)
        }
        // Forward to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'complete':
        // Complete event from MortiseAgent - accumulate usage from this turn
        // Actual 'complete' sent to renderer comes from the finally block in sendMessage
        if (event.usage) {
          // Initialize tokenUsage if not set
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // inputTokens = current context size (full conversation sent this turn), NOT accumulated
          // Each API call sends the full conversation history, so we use the latest value
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          // outputTokens and costUsd are accumulated across all turns (total session usage)
          managed.tokenUsage.outputTokens += event.usage.outputTokens
          managed.tokenUsage.totalTokens = managed.tokenUsage.inputTokens + managed.tokenUsage.outputTokens
          managed.tokenUsage.costUsd += event.usage.costUsd ?? 0
          // Cache tokens reflect current state, not accumulated
          managed.tokenUsage.cacheReadTokens = event.usage.cacheReadTokens ?? 0
          managed.tokenUsage.cacheCreationTokens = event.usage.cacheCreationTokens ?? 0
          // Update context window (use latest value - may change if model switches)
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }
        }
        break

      case 'usage_update':
        // Real-time usage update for context display during processing
        // Update managed session's tokenUsage with latest context size
        if (event.usage) {
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // Update only inputTokens (current context size) - other fields accumulate on complete
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }

          // Send to renderer for immediate UI update
          this.sendEvent({
            type: 'usage_update',
            sessionId: managed.id,
            tokenUsage: {
              inputTokens: event.usage.inputTokens,
              contextWindow: event.usage.contextWindow,
            },
          }, workspaceId)
        }
        break

    }
  }

  private sendEvent(event: SessionEvent, workspaceId?: string): void {
    const managed = 'sessionId' in event && typeof event.sessionId === 'string'
      ? this.sessions.get(event.sessionId)
      : undefined
    if (managed?.publicationState) return

    if (!this.eventSink) {
      sessionLog.warn('Cannot send event - no event sink')
      return
    }

    if (!workspaceId) {
      sessionLog.warn(`Cannot send ${event.type} event - no workspaceId`)
      return
    }

    this.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId }, event)
  }

  private sendEventToClient(event: SessionEvent, clientId: string): void {
    if (!this.eventSink) {
      sessionLog.warn('Cannot send targeted event - no event sink')
      return
    }
    this.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId }, event)
  }

  private async executeNewAutomationSession(input: {
    workspaceId: string
    prompt: string
    provider?: string
    model?: string
    thinkingLevel?: string
    automationName?: string
    eventType?: string
    telegramTopic?: string
    skillSlugs?: string[]
    signal?: AbortSignal
  }): Promise<{ sessionId: string }> {
    const automationProvider = hasConfiguredPiProvider(input.provider) ? input.provider : undefined
    if (input.provider && !automationProvider) {
      sessionLog.warn(`[Automations] provider "${input.provider}" not found, using default`)
    }

    const fallback = `Automation: ${input.prompt.slice(0, 50)}${input.prompt.length > 50 ? '...' : ''}`
    const sessionName = input.automationName || fallback
    const result = await this.createAndSendFirstTurn({
      workspaceId: input.workspaceId,
      message: input.prompt,
      createOptions: {
        name: sessionName,
        provider: automationProvider,
        model: input.model,
        thinkingLevel: normalizeThinkingLevel(input.thinkingLevel),
      },
      sendOptions: input.skillSlugs?.length ? { skillSlugs: input.skillSlugs } : undefined,
      signal: input.signal,
    }, async managed => {
      // This metadata remains memory-only until the first assistant-backed Pi
      // publication transaction flushes the complete Session.
      managed.triggeredBy = {
        automationName: input.automationName,
        event: input.eventType,
        timestamp: Date.now(),
      }
    })

    // Binding writes messaging state, so it happens only after the Session has
    // crossed the assistant-backed publication boundary. It remains best-effort.
    const topicName = input.telegramTopic?.trim()
    if (this.automationBinder && topicName) {
      try {
        await this.automationBinder({
          workspaceId: input.workspaceId,
          sessionId: result.session.id,
          topicName,
        })
      } catch (error) {
        sessionLog.warn('[Automations] automation binder threw', {
          sessionId: result.session.id,
          telegramTopic: input.telegramTopic,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return { sessionId: result.session.id }
  }

  /** Execute the Session-owned portion of a canonical V3 prompt action. */
  async executeAutomationPromptAction(
    action: PromptActionV3,
    context: AutomationExecutionContextV1,
  ): Promise<AutomationActionExecutionResultV1> {
    if (context.event && context.event.workspaceId !== context.workspaceId) {
      return this.automationActionError('blocked', 'event_workspace_mismatch', 'The trusted event belongs to another workspace')
    }
    if (context.signal?.aborted) {
      return this.automationActionError('cancelled', 'action_cancelled', 'The automation action was cancelled')
    }

    const prompt = action.eventData === 'append-json' && context.event
      ? `${action.prompt}\n\nEvent payload:\n${JSON.stringify(context.event.cloudEvent.data).slice(0, 65_536)}`
      : action.prompt
    const target = action.target
    if (target.kind === 'new-session') {
      if (target.provider && !hasConfiguredPiProvider(target.provider)) {
        return this.automationActionError('blocked', 'provider_not_found', `Provider "${target.provider}" is not configured`)
      }
      if (target.thinkingLevel && !normalizeThinkingLevel(target.thinkingLevel)) {
        return this.automationActionError('blocked', 'thinking_level_invalid', `Thinking level "${target.thinkingLevel}" is not supported`)
      }
      try {
        const created = await this.executeNewAutomationSession({
          workspaceId: context.workspaceId,
          prompt,
          provider: target.provider,
          model: target.model,
          thinkingLevel: target.thinkingLevel,
          automationName: context.definition.name,
          eventType: context.event?.cloudEvent.type,
          telegramTopic: target.telegramTopic,
          signal: context.signal,
        })
        return { status: 'succeeded', sessionId: created.sessionId }
      } catch (error) {
        const cancelled = context.signal?.aborted
        return this.automationActionError(
          cancelled ? 'cancelled' : 'failed',
          cancelled ? 'action_cancelled' : 'session_first_turn_failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    {
      const resolved = this.resolveAutomationSessionReference(context, target.session)
      if ('error' in resolved) return resolved.error
      try {
        await this.deliverAutomationSessionPrompt(resolved.managed, prompt, target.delivery, context.signal)
        return { status: 'succeeded', sessionId: resolved.managed.id }
      } catch (error) {
        return this.automationActionError(
          context.signal?.aborted ? 'cancelled' : 'failed',
          context.signal?.aborted ? 'action_cancelled' : 'session_delivery_failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  async sendExtensionFrontendMessage(sessionId: string, extensionId: string, channelId: string, message: unknown, workspaceId?: string | null): Promise<unknown> {
    let agent: AgentBackend | null | undefined
    if (sessionId) {
      const managed = this.sessions.get(sessionId)
      if (!managed) return undefined
      agent = managed.agent ?? await this.getOrCreateAgent(managed)
    } else {
      if (!workspaceId) return undefined
      const workspace = this.resolveWorkspaceByNameOrId(workspaceId)
      if (!workspace) return undefined
      await this.ensureWorkspaceRuntimeWarmup(workspace)
      agent = this.workspaceRuntimeWarmups.get(workspace.id)?.agent
    }
    if (!agent) return undefined
    if (typeof agent.sendExtensionFrontendMessage !== 'function') return undefined
    return await agent.sendExtensionFrontendMessage(extensionId, channelId, message)
  }

  getExtensionFrontendStates(sessionId: string, workspaceId?: string | null): ExtensionFrontendStateEvent[] {
    return sessionId
      ? this.extensionFrontendStates.get(sessionId)
      : workspaceId
        ? this.extensionFrontendStates.getWorkspace(workspaceId)
        : []
  }

  /**
   * Remove one follow-up from the host queue without stopping the active turn.
   * The original send RPC has already returned after Mortise acceptance, so
   * withdrawal removes the durable outbox record before restoring the draft.
   */
  async withdrawQueuedMessage(sessionId: string, messageId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session ${sessionId} not found`)
    const index = managed.messageQueue.findIndex(item =>
      item.messageId === messageId || item.optimisticMessageId === messageId,
    )
    if (index < 0) {
      throw new CodedError('QUEUED_MESSAGE_WITHDRAWN', 'This queued message is no longer waiting to be sent.', {
        sessionId,
        messageId,
        alreadyProcessed: true,
      })
    }

    const [queued] = managed.messageQueue.splice(index, 1)
    const mutationId = queued?.messageId ?? queued?.optimisticMessageId
    if (!mutationId || !await managed.agent?.withdrawQueued?.(mutationId)) {
      if (queued) managed.messageQueue.splice(index, 0, queued)
      throw new CodedError('QUEUED_MESSAGE_WITHDRAWN', 'This queued message is no longer waiting to be sent.', {
        sessionId,
        messageId,
        alreadyProcessed: true,
      })
    }
    if (mutationId) this.messageOutbox.remove(mutationId)
    queued?.onReject?.(new CodedError('QUEUED_MESSAGE_WITHDRAWN', 'Queued message withdrawn for editing.', {
      sessionId,
      messageId: queued.messageId ?? queued.optimisticMessageId ?? messageId,
    }))
    if (queued) {
      queued.onAck = undefined
      queued.onReject = undefined
    }

    const projector = this.piProjectionBySession.get(sessionId)
    if (projector) {
      // Route the cancellation through the agent's sequence-owning builder so
      // the next runtime event cannot collide with the cancellation seq and be
      // dropped as stale (which would interrupt live stream rendering).
      const cancelledByAgent = managed.agent?.projectQueuedCancellation?.({
        clientMutationId: mutationId,
        messageId: queued?.messageId ?? messageId,
      })
      if (!cancelledByAgent) {
        const snapshot = projector.createSnapshot()
        let seq = snapshot.lastSeq + 1
        for (const entity of snapshot.entities) {
          if (!entity.payload || typeof entity.payload !== 'object') continue
          const payload = entity.payload as Record<string, unknown>
          if (payload.queueStatus !== 'queued') continue
          if (payload.messageId !== messageId && payload.clientMutationId !== messageId && payload.ownerMessageId !== messageId) continue
          this.applyPiProjectionEvent({
            schemaVersion: 1,
            eventId: `${snapshot.runtimeId}:host-queue-cancelled:${seq}`,
            seq,
            sessionId,
            runtimeId: snapshot.runtimeId,
            entityId: entity.entityId,
            entityType: entity.entityType,
            entityVersion: entity.entityVersion + 1,
            kind: entity.kind,
            payload: { ...payload, queueStatus: 'cancelled' },
          })
          seq++
        }
      }
    }

    const overlay = managed.messages.find(message => message.id === messageId)
    if (overlay) {
      overlay.isQueued = false
      overlay.isPending = false
    }
    this.persistSession(managed)
    await this.flushSession(sessionId)
    await this.flushPiProjectionWrites(managed)
  }

  private resolveAutomationSessionReference(
    context: AutomationExecutionContextV1,
    reference: SessionReferenceV1,
  ): { managed: ManagedSession } | { error: AutomationActionExecutionResultV1 } {
    const sessionId = reference === 'event-session' ? context.event?.sessionId : reference.id
    if (!sessionId) {
      return { error: this.automationActionError('blocked', 'event_session_unavailable', 'The trusted event has no Session identity') }
    }
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.publicationState) {
      return { error: this.automationActionError('blocked', 'session_not_found', `Session ${sessionId} was not found`) }
    }
    if (managed.workspace.id !== context.workspaceId) {
      return { error: this.automationActionError('blocked', 'session_workspace_mismatch', `Session ${sessionId} belongs to another workspace`) }
    }
    return { managed }
  }

  private async deliverAutomationSessionPrompt(
    managed: ManagedSession,
    prompt: string,
    delivery: 'followUp' | 'steer',
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error('Automation action cancelled')
    const desiredBehavior = delivery === 'followUp' ? 'queue' : 'steer'
    const midStreamSendIntent = getMidStreamBehavior() === desiredBehavior ? 'default' : 'alternate'

    await new Promise<void>((resolve, reject) => {
      let acknowledged = false
      void this.sendMessage(
        managed.id,
        prompt,
        undefined,
        undefined,
        { midStreamSendIntent },
        undefined,
        undefined,
        () => {
          acknowledged = true
          resolve()
        },
      ).then(() => {
        if (!acknowledged) reject(new Error(`Session ${managed.id} did not acknowledge the automation message`))
      }).catch(error => {
        if (!acknowledged) reject(error)
        else sessionLog.warn(`[Automations] Session ${managed.id} failed after accepting an automation message`, error)
      })
    })
  }

  private automationActionError(
    status: 'failed' | 'blocked' | 'cancelled',
    code: string,
    message: string,
  ): AutomationActionExecutionResultV1 {
    return { status, error: { code, message, retryable: false } }
  }

  /**
   * Resolve @mentions in automation prompts to skill slugs
   */
  private resolveAutomationMentions(workspaceRootPath: string, mentions: string[]): { skillSlugs: string[] } | undefined {
    const skills = loadAllSkills(workspaceRootPath)
    const skillSlugs: string[] = []

    for (const mention of mentions) {
      if (skills.some(s => s.slug === mention)) {
        skillSlugs.push(mention)
      } else {
        sessionLog.warn(`[Automations] Unknown mention: @${mention}`)
      }
    }

    return skillSlugs.length > 0 ? { skillSlugs } : undefined
  }

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  private async generateRemoteTransferSummary(managed: ManagedSession): Promise<string | null> {
    const messages = getPiProjectionConversationMessages(
      (await this.getPiProjectionSnapshot(managed.id)) ?? undefined,
    )

    if (messages.length === 0) return null

    const workspaceRootPath = requirePrimaryLocalWorkspaceRoot(managed.workspace)
    const backendContext = resolveBackendContext({
      sessionProvider: managed.provider,
      managedModel: managed.model,
    })

    const miniModel = backendContext.providerConfig?.models?.[1]?.id
      ?? backendContext.providerConfig?.models?.[0]?.id
      ?? getDefaultSummarizationModel()

    const envOverrides: Record<string, string> = {
      MORTISE_WORKSPACE_PATH: workspaceRootPath,
    }

    const agent = createBackendFromResolvedContext({
      context: backendContext,
      hostRuntime: buildBackendHostRuntimeContext(),
      coreConfig: {
        workspace: managed.workspace,
        session: {
          mortiseId: `${managed.id}-remote-transfer-summary`,
          workspaceId: managed.workspace.id,
          workspaceRootPath,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          sdkCwd: managed.sdkCwd ?? workspaceRootPath,
          model: managed.model,
          provider: managed.provider,
        },
        miniModel,
        envOverrides,
        isHeadless: true,
      },
      providerOptions: { piAuthProvider: backendContext.providerKey },
    })

    try {
      return await generateConversationSummary(messages, agent.runMiniCompletion.bind(agent))
    } finally {
      agent.destroy()
    }
  }

  /**
   * Export a session as a portable SessionBundle.
   *
   * Steps:
   * 1. Validate session exists and resolve its workspace
   * 2. If session is processing, refuse (caller must stop it first)
   * 3. Flush pending persistence writes
   * 4. Serialize session directory into a bundle
   */
  async exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`[dispatch] Cannot export session: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      sessionLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      sessionLog.warn(`[dispatch] Cannot export session ${sessionId}: still processing`)
      return null
    }

    // Flush pending writes to ensure JSONL is up to date
    this.persistSession(managed)
    await sessionPersistenceQueue.flush(sessionId)

    const bundle = serializeSession(managed.workspace.id, sessionId)
    if (!bundle) {
      sessionLog.error(`[dispatch] Failed to serialize session ${sessionId}`)
      return null
    }

    return bundle
  }

  /**
   * Import a session bundle into a target workspace.
   *
   * Steps:
   * 1. Validate bundle structure and target workspace
   * 2. Generate new session ID (fork) or use original (move)
   * 3. Create session directory and write JSONL + files
   * 4. Register session in-memory
   * 5. Emit session_created event
   * 6. Return new session ID and compatibility warnings
   */
  async importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }> {
    sessionLog.info(`[import] Starting import: workspaceId=${workspaceId}, mode=${mode}, bundleSessionId=${bundle?.session?.header?.mortiseId ?? 'unknown'}, files=${bundle?.files?.length ?? 0}`)

    if (!validateBundle(bundle)) {
      throw new Error('Invalid session bundle')
    }

    const workspace = this.resolveWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    const warnings: string[] = []
    const workspaceRootPath = requirePrimaryLocalWorkspaceRoot(workspace)
    sessionLog.info(`[import] Target workspace: "${workspace.name}" at ${workspaceRootPath}`)

    // Determine session ID from the canonical bundle header.
    const header = bundle.session.header
    const sessionId = mode === 'move'
      ? header.mortiseId
      : generateSessionId(workspace.id)

    // Check for ID collision on move
    if (mode === 'move' && this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists in target workspace`)
    }

    // Create session directory with all subdirectories
    const sessionDir = ensureSessionDir(workspace.id, sessionId)

    // Build the stored session from bundle data.
    // 用 pickMortiseSessionMetadata(header) 作为基底，让 Mortise metadata 字段自动透传
    //（避免新增字段时手工同步遗漏，如 hasUnread/pendingPlanExecution）。
    // 然后显式覆盖需要重写的字段。
    const storedSession = {
      ...(pickMortiseSessionMetadata(header) as Partial<SessionHeader>),
      // 显式覆盖：目标工作区的身份与路径
      mortiseId: sessionId,
      workspaceId: workspace.id,
      workspaceRootPath,
      // Always regenerate sdkCwd for the target workspace.
      // sdkCwd is the working directory the SDK runs in (where it stores
      // transcript files under ~/.claude/projects/{cwd-hash}/ etc.), NOT the
      // sidecar storage path. Using the sidecar path here would cause the SDK
      // to store transcripts inside the sidecar dir and break session resume.
      sdkCwd: workspaceRootPath,
      // 刷新访问时间
      lastUsedAt: Date.now(),
      // 保留 sdkSessionId（fork 逻辑下方可能清空）
      sdkSessionId: header.sdkSessionId,
      // 非 MORTISE_SESSION_METADATA_FIELDS 字段
      messages: bundle.session.messages,
      tokenUsage: header.tokenUsage ?? DEFAULT_TOKEN_USAGE,
    } as StoredSession

    // Fork-specific: set up SDK branching if branchInfo provided
    if (mode === 'fork' && bundle.branchInfo) {
      storedSession.branchFromSdkSessionId = bundle.branchInfo.sdkSessionId
      storedSession.branchFromSdkTurnId = bundle.branchInfo.sdkTurnId
      storedSession.branchFromSdkCwd = bundle.branchInfo.sdkCwd
    }

    // Fork-specific: clear sharing state and attempt resume-first strategy
    if (mode === 'fork') {
      storedSession.sharedUrl = undefined
      storedSession.sharedId = undefined

      // Resume-first: try to find a compatible Pi provider on the target workspace.
      // If found and the session has an sdkSessionId, preserve it for API-level resume.
      // If not, clear SDK state and fall back to transferred session summary.
      const sourceProviderType = header.provider
        ? (readPiGlobalProviders()[header.provider]?.baseUrl ? 'pi_custom' : 'pi')
        : undefined
      const compatibleConnection = sourceProviderType
        ? this.findCompatibleProvider(sourceProviderType)
        : null

      if (compatibleConnection && storedSession.sdkSessionId) {
        // Resume path: compatible credentials exist — preserve SDK session ID
        sessionLog.info(`[import] Fork: compatible ${sourceProviderType} connection "${compatibleConnection}" found — preserving sdkSessionId for resume`)
        storedSession.provider = compatibleConnection
      } else {
        // Summary path: no compatible connection or no SDK session — clear for fresh start
        if (storedSession.provider) {
          sessionLog.info(`[import] Fork: no compatible ${sourceProviderType ?? 'unknown'} connection — clearing, will use summary context`)
        }
        storedSession.sdkSessionId = undefined
        storedSession.provider = undefined
      }
      // Clear thinking level so the session inherits the global default.
      storedSession.thinkingLevel = undefined
    }

    // Check Pi provider compatibility for move mode (fork already cleared above)
    if (mode === 'move' && storedSession.provider) {
      sessionLog.info(`[import] Checking Pi provider: "${storedSession.provider}"`)
      if (!hasConfiguredPiProvider(storedSession.provider)) {
        sessionLog.warn(`[import] Pi provider "${storedSession.provider}" not found — clearing to use default`)
        warnings.push(`Pi provider "${storedSession.provider}" not found in target — session will use default`)
        storedSession.provider = undefined
      } else {
        sessionLog.info(`[import] Pi provider "${storedSession.provider}" resolved OK`)
      }
    } else if (mode === 'move' && !storedSession.provider) {
      sessionLog.info('[import] No Pi provider in bundle — will use default')
    }

    storedSession.sdkCwd = storedSession.sdkCwd ?? workspaceRootPath

    // Create/update the Pi session header + Mortise metadata first, then import
    // canonical transcript entries through Pi's public SessionManager API.
    const sessionFile = getSessionFilePath(workspace.id, sessionId, storedSession.createdAt)
    sessionLog.info(`[import] Creating Pi canonical session: ${sessionFile} (provider=${storedSession.provider ?? 'default'}, messages=${storedSession.messages.length})`)
    await saveStoredSession(storedSession)
    const importedIdMap = await appendStoredMessagesViaPiSessionManager(
      sessionFile,
      dirname(sessionFile),
      workspaceRootPath,
      storedSession.messages,
    )

    const uiMetadataSession: StoredSession = {
      ...storedSession,
      messages: storedSession.messages.map((message) => {
        const importedId = importedIdMap.get(message.id)
        return importedId ? { ...message, id: importedId } : message
      }),
    }

    // Write all bundle files (attachments, plans, data, downloads, etc.)
    // Uses restoreFiles() for path traversal, size, and base64 validation.
    restoreFiles(sessionDir, bundle.files)
    await writeTreeSessionUiMetadataAsync(sessionFile, uiMetadataSession)

    // Register in-memory — pass session metadata without messages to avoid
    // StoredMessage[] vs Message[] type mismatch, then convert messages separately
    const reloadedStoredSession = loadStoredSession(workspaceRootPath, sessionId) ?? uiMetadataSession
    const { messages: bundleMessages, ...sessionMeta } = reloadedStoredSession
    const managed = createManagedSession(sessionMeta, workspace, {
      messagesLoaded: true,
    })
    managed.messages = bundleMessages.map(storedToMessage)

    this.sessions.set(sessionId, managed)

    // Emit session_created so renderer picks it up
    this.sendEvent({ type: 'session_created', sessionId }, workspaceId)

    sessionLog.info(`[import] Complete: sessionId=${sessionId}, transferredSummary=${managed.transferredSessionSummary ? `${managed.transferredSessionSummary.length} chars` : 'none'}, applied=${managed.transferredSessionSummaryApplied}, warnings=${warnings.length > 0 ? warnings.join('; ') : 'none'}`)
    return { sessionId, warnings: warnings.length > 0 ? warnings : undefined }
  }

  /**
   * Find an Pi provider on this server that matches the given provider type.
   * Checks the global default first, then falls back to any matching connection.
   */
  private findCompatibleProvider(providerType: string): string | null {
    const defaultSlug = readPiGlobalSettings().defaultProvider
    if (defaultSlug) {
      const provider = readPiGlobalProviders()[defaultSlug]
      if (provider && (provider.baseUrl ? 'pi_custom' : 'pi') === providerType) return defaultSlug
    }
    // Fall back: any connection with matching provider type
    const match = Object.entries(readPiGlobalProviders()).find(([, provider]) => (provider.baseUrl ? 'pi_custom' : 'pi') === providerType)
    return match?.[0] ?? null
  }

  /**
   * Clean up all resources held by the SessionManager.
   * Should be called on app shutdown to prevent resource leaks.
   */
  async cleanup(): Promise<void> {
    sessionLog.info('Cleaning up resources...')

    if (this.providerRuntimeReloadTimer) clearTimeout(this.providerRuntimeReloadTimer)
    this.providerRuntimeReloadTimer = undefined

    // Unpublished first turns are terminal drafts during shutdown. Route them
    // through the same abandonment transaction used by runtime failures so a
    // persistent projection error cannot prevent their storage cleanup.
    for (const managed of [...this.sessions.values()]) {
      if (managed.publicationState) {
        await this.abandonProvisionalSession(managed, 'application shutdown')
        continue
      }
      try {
        const shutdownError = new CodedError(
          'SESSION_EXECUTION_TERMINATED',
          'Backend closed before the Session execution result settled.',
          { sessionId: managed.id },
        )
        for (const pending of managed.messageQueue) {
          pending.onReject?.(shutdownError)
        }
        managed.messageQueue = []
        if (managed.isProcessing || managed.agent?.isProcessing()) {
          await this.cancelProcessing(managed.id, true)
          await Promise.race([
            new Promise<void>(resolve => {
              const deadline = Date.now() + 5_500
              const poll = () => {
                if ((!managed.isProcessing && !managed.settlementPromise) || Date.now() >= deadline) resolve()
                else setTimeout(poll, 25)
              }
              poll()
            }),
            new Promise<void>(resolve => setTimeout(resolve, 5_500)),
          ])
        }
        await this.disposeManagedAgentRuntime(managed, 'app quit')
        await this.settleUnknownToolSideEffects(managed)
        for (const pending of managed.pendingInputAcks.values()) {
          pending.reject(new Error('Backend closed before the input was accepted'))
        }
        managed.pendingInputAcks.clear()
      } catch (error) {
        sessionLog.error(`Failed to dispose runtime for ${managed.id} during cleanup:`, error)
      }
    }
    await Promise.all([...this.sessions.values()].map(managed => this.flushPiProjectionWrites(managed)))
    this.sessions.clear()
    this.extensionFrontendStates.clear()
    this.piProjectionBySession.clear()
    this.piProjectionRetiredRuntimeIds.clear()
    this.piProjectionWrites.clear()
    this.piProjectionPendingSnapshots.clear()
    this.piProjectionWriteErrors.clear()

    // Stop all ConfigWatchers (file system watchers)
    for (const [path, watcher] of this.configWatchers) {
      watcher.stop()
      sessionLog.info(`Stopped config watcher for ${path}`)
    }
    this.configWatchers.clear()

    // Stop canonical schedulers and wait for in-flight automation actions.
    for (const [workspacePath, host] of this.automationHosts) {
      try {
        await host.stop()
        sessionLog.info(`Stopped Automations V3 host for ${workspacePath}`)
      } catch (error) {
        sessionLog.error(`Failed to stop Automations V3 host for ${workspacePath}:`, error)
      }
    }
    this.automationHosts.clear()
    this.automationHostInitializationErrors.clear()
    await Promise.all([...this.workspaceRuntimeWarmups.keys()].map(
      workspaceId => this.disposeWorkspaceRuntimeWarmup(workspaceId, 'application shutdown'),
    ))
    this.extensionRuntime.clear()
    this.extensionOperationCoordinator.close()
    sessionLog.info('Cleanup complete')
  }
}
