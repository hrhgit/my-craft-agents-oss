import type { EventSink, RpcServer } from '@craft-agent/server-core/transport'
import { CLIENT_BROWSER_INVOKE } from '@craft-agent/server-core/transport'
import type { ISessionManager, IBrowserPaneManager, ExecutePromptAutomationInput } from '@craft-agent/server-core/handlers'
import { RemoteBrowserPaneManager } from './RemoteBrowserPaneManager'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import { createExtensionEventForwarder } from '../handlers/pi-extension-bridge'
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '@craft-agent/server-core/runtime'
import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import { randomUUID } from 'node:crypto'
import { setPermissionMode, hydratePreviousPermissionMode, getPermissionModeDiagnostics, type PermissionMode, unregisterSessionScopedToolCallbacks, mergeSessionScopedToolCallbacks, AbortReason, type AuthRequest, type AuthResult, type CredentialAuthRequest, type BrowserPaneFns, generateConversationSummary } from '@craft-agent/shared/agent'
import type { AgentEvent, PlanModeStateV1 } from '@craft-agent/core/types'
import {
  resolveSessionProvider,
  createBackendFromProvider,
  resolveBackendContext,
  createBackendFromResolvedContext,
  cleanupSourceRuntimeArtifacts,
  type AgentBackend,
  type BackendHostRuntimeContext,
  type HostRuntimeErrorProjection,
  type PostInitResult,
  buildPiProjectionSnapshotFromHostProjection,
  PiProjectionBuilder,
} from '@craft-agent/shared/agent/backend'
import { alternateMidStreamBehavior, readPiGlobalProviders, readPiGlobalSettings, getDefaultThinkingLevel, getMidStreamBehavior, resetManagedAnthropicAuthEnvVars, getPersistedUiLanguage, resolveTitleLanguageName } from '@craft-agent/shared/config'
import { PrivilegedExecutionBroker, SessionShareTransferService } from '@craft-agent/server-core/services'
import { isValidWorkingDirectory } from '../utils/path-validation'
import { InitGate } from '@craft-agent/server-core/domain'
import { i18n } from '@craft-agent/shared/i18n'
import {
  getWorkspaces,
  getWorkspaceByNameOrId,
  loadConfigDefaults,
  loadPreferences,
  MODEL_REGISTRY,
  type Workspace,
  type WorkspaceInfo,
} from '@craft-agent/shared/config'
import type { ActiveSessionInfo, SessionProcessingStatus } from '@craft-agent/core/types'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
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
  generateSessionId,
  sessionPersistenceQueue,
  getHeaderMetadataSignature,
  findPiSessionProjectionById,
  appendPiBranchMessagesViaSessionManager,
  appendStoredMessagesViaPiSessionManager,
  writeCraftSessionOverlay,
  projectTreeSessionProjectionAsStoredSession,
  serializeSession,
  validateBundle,
  type SessionBundle,
  type DispatchMode,
  type StoredSession,
  type StoredMessage,
  type SessionStatus,
  type SessionHeader,
  pickCraftSessionMetadata,
  parsePlanCustomMessage,
} from '@craft-agent/shared/sessions'
import { loadWorkspaceSources, loadAllSources, getSourcesBySlugs, isSourceUsable, type LoadedSource, type McpServerConfig, getSourcesNeedingAuth, getSourceCredentialManager, getSourceServerBuilder, type SourceWithCredential, isApiOAuthProvider, hasRenewEndpoint, SERVER_BUILD_ERRORS, TokenRefreshManager, createTokenGetter } from '@craft-agent/shared/sources'
import { ConfigWatcher, type ConfigWatcherCallbacks } from '@craft-agent/shared/config'
import { getLastApiError } from '@craft-agent/shared/interceptor'
import { restoreFiles } from '@craft-agent/shared/utils/bundle-files'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { CraftMcpClient, McpClientPool, McpPoolServer } from '@craft-agent/shared/mcp'
import { type Session, type SessionEvent, type FileAttachment, type SendMessageOptions, type UnreadSummary, type PiProjectionEventV1, type PiProjectionSnapshotV1, RPC_CHANNELS, generateMessageId } from '@craft-agent/shared/protocol'
import {
  ConversationProjector,
  resolvePiBranchTarget,
  type PiBranchProjection,
  type PiBranchProjectionEntry,
  type ProjectionApplyResult,
} from '../projection'
import { CapabilityRouter, ELECTRON_CAPABILITY_POLICY_V1, createCapabilityAuthorizationPolicy, type CapabilityProvider } from '../capabilities'
import { messageToStored, storedToMessage, type Message, type StoredAttachment, type ToolDisplayMeta } from '@craft-agent/core/types'
import { ATTACHMENT_MESSAGE_TOTAL_LIMIT_BYTES, ATTACHMENT_SINGLE_FILE_LIMIT_BYTES, formatToolInputPaths, perf, encodeIconToDataUrlAsync, getEmojiIcon, resolveToolIcon, readFileAttachment, selectSpreadMessages, normalizePath, writeRuntimeLog } from '@craft-agent/shared/utils'
import { loadAllSkills, loadSkillBySlug, type LoadedSkill } from '@craft-agent/shared/skills'
import { getToolIconsDir } from '@craft-agent/shared/config'
import { getDefaultSummarizationModel } from '@craft-agent/shared/config/models'
import type { SummarizeCallback } from '@craft-agent/shared/sources'
import { type ThinkingLevel, DEFAULT_THINKING_LEVEL, normalizeThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { evaluateAutoLabels } from '@craft-agent/shared/labels/auto'
import { listLabels, loadLabelConfig } from '@craft-agent/shared/labels/storage'
import { extractLabelId, resolveSessionLabels } from '@craft-agent/shared/labels'
import { ensureLabelsExist } from '@craft-agent/shared/labels/crud'
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage'
import { AutomationSystem, createPromptHistoryEntry, appendAutomationHistoryEntry, type AutomationSystemMetadataSnapshot, type PendingPrompt } from '@craft-agent/shared/automations'
import { FEATURE_FLAGS } from '@craft-agent/shared/feature-flags'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature, filterAttachmentsForModelInput, normalizeProviderRuntimeBaseUrl } from './runtime-config'

// Import from server-core domain utilities
import { sanitizeForTitle, shouldActivateBrowserOverlay, normalizeBrowserToolName, rollbackFailedBranchCreation, releaseBrowserOwnershipOnForcedStop } from '@craft-agent/server-core/domain'
import { resizeImageForAPI, resizeIconBuffer } from '@craft-agent/server-core/services'
export { sanitizeForTitle }

// Module-level platform ref — set once during init via setSessionPlatform()
let _platform: PlatformServices | null = null

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
    isPackaged: _platform.isPackaged,
  }
}

/**
 * Feature flags for agent behavior
 */
export const AGENT_FLAGS = {
  /** Default modes enabled for new sessions */
  defaultModesEnabled: true,
} as const

const MAX_ADMIN_REMEMBER_MINUTES = 60
const MAX_ANNOTATIONS_PER_MESSAGE = 200
const MAX_ANNOTATION_JSON_BYTES = 32 * 1024

// Window during which fs.watch metadata-revert events from our own atomic write
// are ignored, so the watcher does not roll back the in-memory mutation we
// just persisted. See onSessionMetadataChange.
const METADATA_WRITE_GUARD_MS = 5000

/**
 * Text sent to the session when a plan is approved from outside the desktop
 * UI (e.g. Telegram button). Mirrors the English `plan.approved` i18n key
 * used by the desktop flow at `plan-approval-message.ts`. Not localized —
 * the agent reads this, not the end user.
 */
const PLAN_APPROVAL_MESSAGE = 'Plan approved, please execute.'

// validateSpawnAttachmentPath removed — use shared validateFilePath from @craft-agent/server-core/handlers

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
 * Build MCP and API servers from sources using the new unified modules.
 * Handles credential loading and server building in one step.
 * When auth errors occur, updates source configs to reflect actual state.
 *
 * @param sources - Sources to build servers for
 * @param sessionPath - Optional path to session folder for saving large API responses
 * @param tokenRefreshManager - Optional TokenRefreshManager for OAuth token refresh
 */
async function buildServersFromSources(
  sources: LoadedSource[],
  sessionPath?: string,
  tokenRefreshManager?: TokenRefreshManager,
  summarize?: SummarizeCallback
) {
  const span = perf.span('sources.buildServers', { count: sources.length })
  const credManager = getSourceCredentialManager()
  const serverBuilder = getSourceServerBuilder()

  // Load credentials for all sources
  const sourcesWithCreds: SourceWithCredential[] = await Promise.all(
    sources.map(async (source) => ({
      source,
      token: await credManager.getToken(source),
      credential: await credManager.getApiCredential(source),
    }))
  )
  span.mark('credentials.loaded')

  // Build token getter for refreshable sources (OAuth + renew-endpoint)
  // Uses TokenRefreshManager for unified refresh logic (DRY principle)
  const getTokenForSource = (source: LoadedSource) => {
    const provider = source.config.provider
    // Provider-specific OAuth (Google, Slack, Microsoft) or generic OAuth (authType: 'oauth')
    if (isApiOAuthProvider(provider) || source.config.api?.authType === 'oauth') {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sessionLog.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    // API renew endpoint — non-OAuth token refresh
    if (hasRenewEndpoint(source)) {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sessionLog.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    return undefined
  }

  // Per-request credential getter for non-OAuth / non-renew API sources
  // (bearer / header / query / basic auth).
  //
  // Without this, the in-process API tool captures the credential as a static
  // string at build time and keeps using it forever — meaning a fresh JWT
  // entered via source_credential_prompt is ignored until session restart.
  //
  // With this getter, every API call reads the latest credential from the
  // vault, so credential updates take effect on the next call. OAuth and
  // renew-endpoint sources have their own refresh logic via TokenRefreshManager
  // and are skipped here.
  const getCredentialForSource = (source: LoadedSource) => {
    if (source.config.type !== 'api') return undefined
    if (source.config.api?.authType === 'none') return undefined
    if (isApiOAuthProvider(source.config.provider)) return undefined
    if (source.config.api?.authType === 'oauth') return undefined
    if (hasRenewEndpoint(source)) return undefined
    return async () => credManager.getApiCredential(source)
  }

  // Pass sessionPath to enable saving large API responses to session folder
  const result = await serverBuilder.buildAll(
    sourcesWithCreds,
    getTokenForSource,
    sessionPath,
    summarize,
    getCredentialForSource,
  )
  span.mark('servers.built')
  span.setMetadata('mcpCount', Object.keys(result.mcpServers).length)
  span.setMetadata('apiCount', Object.keys(result.apiServers).length)

  // Update source configs for auth errors so UI reflects actual state.
  // Re-classify AUTH_REQUIRED → TOKEN_EXPIRED when the credential is merely
  // expired-but-refreshable; in that case the refresh cycle handles recovery
  // and we must NOT prematurely mark the source as needing re-auth (#710).
  for (const error of result.errors) {
    if (error.error !== SERVER_BUILD_ERRORS.AUTH_REQUIRED) continue
    const source = sources.find(s => s.config.slug === error.sourceSlug)
    if (!source) continue

    const cred = await credManager.load(source)
    const isExpiredRefreshable =
      cred &&
      (credManager.isExpired(cred) || credManager.needsRefresh(cred)) &&
      (cred.refreshToken || hasRenewEndpoint(source))

    if (isExpiredRefreshable) {
      error.error = SERVER_BUILD_ERRORS.TOKEN_EXPIRED
      sessionLog.debug(`Source ${error.sourceSlug}: TOKEN_EXPIRED — refresh cycle will handle`)
      continue
    }

    credManager.markSourceNeedsReauth(source, 'Token missing or expired')
    sessionLog.info(`Marked source ${error.sourceSlug} as needing re-auth`)
  }

  span.end()
  return result
}

/**
 * Result of expired-credential refresh.
 */
interface RefreshExpiredCredentialsResult {
  /** Number of sources whose tokens were successfully refreshed */
  refreshedCount: number
  /** Sources that failed to refresh (for warning display) */
  failedSources: Array<{ slug: string; reason: string }>
}

/**
 * Refresh expired OAuth / renew-endpoint tokens for the given sources.
 *
 * Side effects (carried by `TokenRefreshManager.ensureFreshToken`):
 * - Success: source.config.isAuthenticated = true (in-memory + on disk).
 * - Failure: source.config.isAuthenticated = false + connectionStatus = 'needs_auth'
 *   (in-memory + on disk), so isSourceUsable() returns false and the source is
 *   excluded from intendedSlugs by callers.
 *
 * The caller is responsible for building servers AFTER this returns — that way
 * a single fresh build sees the correct credentials and the correct usable set.
 * Issue #710.
 */
async function refreshExpiredCredentials(
  sources: LoadedSource[],
  tokenRefreshManager: TokenRefreshManager
): Promise<RefreshExpiredCredentialsResult> {
  sessionLog.debug('[OAuth] Checking if any tokens need refresh')

  const needRefresh = await tokenRefreshManager.getSourcesNeedingRefresh(sources)
  if (needRefresh.length === 0) {
    return { refreshedCount: 0, failedSources: [] }
  }

  sessionLog.debug(`[OAuth] Refreshing ${needRefresh.length} source(s): ${needRefresh.map(s => s.config.slug).join(', ')}`)

  const { refreshed, failed } = await tokenRefreshManager.refreshSources(needRefresh)

  const failedSources = failed.map(({ source, reason }) => ({
    slug: source.config.slug,
    reason,
  }))

  return { refreshedCount: refreshed.length, failedSources }
}

/**
 * Apply bridge-mcp-server updates for backends that use it.
 * Delegates to the backend's own applyBridgeUpdates() method.
 * Each backend handles its own strategy via applyBridgeUpdates().
 */
async function applyBridgeUpdates(
  agent: AgentInstance,
  sessionPath: string,
  enabledSources: LoadedSource[],
  mcpServers: Record<string, import('@craft-agent/shared/agent/backend').SdkMcpServerConfig>,
  sessionId: string,
  workspaceRootPath: string,
  context: string,
  poolServerUrl?: string
): Promise<void> {
  await agent.applyBridgeUpdates({
    sessionPath,
    enabledSources,
    mcpServers,
    sessionId,
    workspaceRootPath,
    context,
    poolServerUrl,
  })
}

/**
 * Resolve tool display metadata for a tool call.
 * Returns metadata with base64-encoded icon for viewer compatibility.
 *
 * @param toolName - Tool name from the event (e.g., "Skill", "mcp__linear__list_issues")
 * @param toolInput - Tool input (used for Skill tool to get skill identifier)
 * @param workspaceRootPath - Path to workspace for loading skills/sources
 * @param sources - Loaded sources for the workspace
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
      // Dev fallback (before sync to ~/.craft-agent/tool-icons)
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

async function resolveToolDisplayMeta(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  workspaceRootPath: string,
  sources: LoadedSource[]
): Promise<ToolDisplayMeta | undefined> {
  // Check if it's an MCP tool (format: mcp__<serverSlug>__<toolName>)
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const serverSlug = parts[1]
      const toolSlug = parts.slice(2).join('__')

      // Internal MCP server tools (session, docs)
      const internalMcpServers: Record<string, Record<string, string>> = {
        'session': {
          'config_validate': 'Validate Config',
          'skill_validate': 'Validate Skill',
          'mermaid_validate': 'Validate Mermaid',
          'source_test': 'Test Source',
          'source_oauth_trigger': 'OAuth',
          'source_google_oauth_trigger': 'Google Auth',
          'source_slack_oauth_trigger': 'Slack Auth',
          'source_microsoft_oauth_trigger': 'Microsoft Auth',
          'source_credential_prompt': 'Enter Credentials',
          'transform_data': 'Transform Data',
          'render_template': 'Render Template',
          'update_user_preferences': 'Update Preferences',
          'send_developer_feedback': 'Send Feedback',
          'browser_tool': 'Browser',
        },
        'craft-agents-docs': {
          'SearchCraftAgents': 'Search Docs',
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

      // External source tools
      let sourceSlug = serverSlug

      // Special case: api-bridge server embeds source slug in tool name as "api_{slug}"
      // e.g., mcp__api-bridge__api_stripe → sourceSlug = "stripe"
      if (sourceSlug === 'api-bridge' && toolSlug.startsWith('api_')) {
        sourceSlug = toolSlug.slice(4)
      }

      const source = sources.find(s => s.config.slug === sourceSlug)
      if (source) {
        // Try file-based icon first, fall back to emoji icon from config
        const iconDataUrl = source.iconPath
          ? await encodeIconToDataUrlAsync(source.iconPath, { resize: resizeIconBuffer })
          : getEmojiIcon(source.config.icon)
        return {
          displayName: source.config.name,
          iconDataUrl,
          description: source.config.tagline,
          category: 'source' as const,
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
  // and resolves their brand icon from ~/.craft-agent/tool-icons/
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

interface ManagedSession {
  id: string
  workspace: Workspace
  agent: AgentInstance | null  // Lazy-loaded - null until first message
  messages: Message[]
  isProcessing: boolean
  /** Set when user requests stop - allows event loop to drain before clearing isProcessing */
  stopRequested?: boolean
  lastMessageAt: number
  streamingText: string
  // Incremented each time a new message starts processing.
  // Used to detect if a follow-up message has superseded the current one (stale-request guard).
  processingGeneration: number
  // NOTE: Parent-child tracking state (pendingTools, parentToolStack, toolToParentMap,
  // pendingTextParent) has been removed. CraftAgent now provides parentToolUseId
  // directly on all events using the SDK's authoritative parent_tool_use_id field.
  // See: packages/shared/src/agent/tool-matching.ts
  // Session name (user-defined or AI-generated)
  name?: string
  isFlagged: boolean
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
  /** Permission mode for this session ('safe', 'ask', 'allow-all') */
  permissionMode?: PermissionMode
  /** Previous permission mode (preserved across restarts for session_state modeTransition context) */
  previousPermissionMode?: PermissionMode
  /** Session-authoritative state published by the Pi Plan Mode extension. */
  planModeState?: PlanModeStateV1
  /** Centralized MCP client pool for this session's source connections */
  mcpPool?: McpClientPool
  /** HTTP MCP server exposing pool tools to external SDK subprocesses */
  poolServer?: McpPoolServer
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
  // Session status (user-controlled) - determines open vs closed
  // Dynamic status ID referencing workspace status config
  sessionStatus?: string
  // Read/unread tracking - ID of last message user has read
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  // Per-session source selection (slugs of enabled sources)
  enabledSourceSlugs?: string[]
  // Labels applied to this session (additive tags, many-per-session)
  labels?: string[]
  // Compatibility DTO field. Under complete-unification semantics this always
  // equals workspace.rootPath; callers must not use it for ownership/bucket routing.
  workingDirectory?: string
  // SDK cwd for session storage - set once at creation, never changes.
  // Ensures SDK can find session transcripts regardless of workingDirectory changes.
  sdkCwd?: string
  // Shared viewer URL (if shared via viewer)
  sharedUrl?: string
  // Shared session ID in viewer (for revoke)
  sharedId?: string
  // Model to use for this session (overrides global config if set)
  model?: string
  // Pi provider slug selected for this session.
  provider?: string
  // Thinking level for this session ('off', 'think', 'max')
  thinkingLevel?: ThinkingLevel
  // System prompt preset for mini agents ('default' | 'mini')
  systemPromptPreset?: 'default' | 'mini' | string
  // Role/type of the last message (for badge display without loading messages)
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  // ID of the last final (non-intermediate) assistant message - pre-computed for unread detection
  lastFinalMessageId?: string
  // Turn baseline: last final assistant message ID at turn start (runtime-only, not persisted)
  turnStartFinalMessageId?: string
  // External session metadata updates seen while processing (applied after turn stop)
  pendingExternalMetadata?: SessionHeader
  // Guard: suppress external metadata revert after programmatic writes (setSessionStatus/setSessionLabels).
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
  }>
  // Runtime-only marker for the queued message currently being replayed.
  replayingQueuedMessageId?: string
  // Map of shellId -> command for killing background shells
  backgroundShellCommands: Map<string, string>
  // Map of taskId -> output info for background task results
  backgroundTaskOutputs: Map<string, { outputFile: string; summary: string; status: string; completedAt: number }>
  // Whether messages have been loaded from disk (for lazy loading)
  messagesLoaded: boolean
  // Pending auth request tracking (for unified auth flow)
  pendingAuthRequestId?: string
  pendingAuthRequest?: AuthRequest
  // Auth retry tracking (for mid-session token expiry)
  // Store last sent message/attachments to enable retry after token refresh
  lastSentMessage?: string
  lastSentAttachments?: FileAttachment[]
  lastSentStoredAttachments?: StoredAttachment[]
  lastSentOptions?: SendMessageOptions
  // Flag to prevent infinite retry loops (reset at start of each sendMessage)
  authRetryAttempted?: boolean
  // Flag indicating auth retry is in progress (to prevent complete handler from interfering)
  authRetryInProgress?: boolean
  // Whether this session is hidden from session list (e.g., mini edit sessions)
  hidden?: boolean
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
  // Token refresh manager for OAuth token refresh with rate limiting
  tokenRefreshManager: TokenRefreshManager
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
  // Source-activation auto-retry (craft-agents-oss#804). When a source activates
  // mid-turn, we re-send the original message with a "[<slug> activated]" suffix
  // after a short delay. The pending slot lets `sendMessage` dedup a duplicate
  // RPC from a legacy renderer that still ships the client-side auto_retry.
  autoRetryTimer?: ReturnType<typeof setTimeout>
  autoRetryPending?: {
    content: string
    deadlineMs: number
    /** True after the first matching sendMessage consumes the slot; later matches drop. */
    committed: boolean
  }
}

export interface AutoRetryPendingHost {
  autoRetryPending?: {
    content: string
    deadlineMs: number
    committed: boolean
  }
}

export function claimAutoRetryPending(
  host: AutoRetryPendingHost,
  message: string,
  nowMs = Date.now(),
): 'send' | 'drop' {
  const pending = host.autoRetryPending
  if (pending && message === pending.content) {
    if (nowMs < pending.deadlineMs) {
      if (pending.committed) return 'drop'
      pending.committed = true
      return 'send'
    }
    host.autoRetryPending = undefined
    return 'send'
  }

  if (pending && nowMs >= pending.deadlineMs) {
    host.autoRetryPending = undefined
  }

  return 'send'
}

/**
 * Create a ManagedSession from any session-like source (SessionHeader, StoredSession).
 * Spreads all matching fields from the source so new persistent fields automatically propagate.
 * Runtime-only fields get sensible defaults.
 */
export function createManagedSession(
  source: { craftId: string } & Partial<ManagedSession>,
  workspace: Workspace,
  overrides?: Partial<ManagedSession>,
): ManagedSession {
  const s = source as Record<string, unknown>
  const sourceFields = Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined)
  ) as Partial<ManagedSession>

  if ('thinkingLevel' in sourceFields) {
    // TODO: Remove legacy 'think' normalization after old persisted session
    // headers have realistically aged out across upgrades.
    const normalizedThinkingLevel = normalizeThinkingLevel(sourceFields.thinkingLevel)
    if (normalizedThinkingLevel) {
      sourceFields.thinkingLevel = normalizedThinkingLevel
    } else {
      delete sourceFields.thinkingLevel
    }
  }

  const managed = {
    // Spread all session-like fields from source (name, permissionMode, labels, model, etc.)
    // This ensures new persistent fields automatically flow through without manual copying.
    ...sourceFields,
    // Map craftId → id (ManagedSession 内部用 id 字段，值等于 SessionHeader.craftId)
    id: source.craftId,
    // Runtime-only defaults (not persisted)
    workspace,
    agent: null,
    messages: [],
    isProcessing: false,
    lastMessageAt: (s.lastMessageAt ?? s.lastUsedAt ?? Date.now()) as number,
    streamingText: '',
    processingGeneration: 0,
    isFlagged: (s.isFlagged ?? false) as boolean,
    messageQueue: [],
    backgroundShellCommands: new Map(),
    backgroundTaskOutputs: new Map(),
    messagesLoaded: false,
    tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), {
      log: (msg) => sessionLog.debug(msg),
    }),
    // Caller overrides (permissionMode defaults, thinkingLevel, messagesLoaded, etc.)
    ...overrides,
  } as ManagedSession

  if (managed.branchFromMessageId && !managed.branchContextStrategy) {
    managed.branchContextStrategy = managed.branchFromSdkSessionId
      ? 'sdk-fork'
      : 'seeded-fresh-session'
  }

  if (managed.branchContextStrategy === 'seeded-fresh-session' && managed.branchSeedApplied === undefined) {
    // If an SDK session ID already exists, first turn has already happened.
    managed.branchSeedApplied = !!managed.sdkSessionId
  }

  managed.workingDirectory = workspace.rootPath
  managed.sdkCwd = managed.sdkCwd ?? workspace.rootPath

  return managed
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

    if (entity.kind === 'plan_artifact' || entity.kind === 'plan_artifact_update') {
      messageKeys.add(`plan:${entity.entityId}`)
      updateLastRole(entity.lastSeq, 'plan')
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
 * Uses pickCraftSessionMetadata() for Craft-owned persistent fields so new
 * fields propagate automatically.
 */
function managedToSession(m: ManagedSession, overrides?: Partial<Session>): Session {
  return {
    ...pickCraftSessionMetadata(m),
    // Craft metadata uses craftId, while ManagedSession runtime state uses id.
    // Renderer Session DTO still exposes id, so map it explicitly here.
    id: m.id,
    // Pre-computed fields from header (not in CRAFT_SESSION_METADATA_FIELDS)
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
    sessionFolderPath: getSessionStoragePath(m.workspace.rootPath, m.id),
    supportsBranching: resolveSupportsBranching(m),
    ...overrides,
  } as Session
}

export class SessionManager implements ISessionManager {
  private sessions: Map<string, ManagedSession> = new Map()
  private piProjectionBySession = new Map<string, ConversationProjector>()
  private piProjectionRetiredRuntimeIds = new Map<string, Set<string>>()
  private piProjectionWrites = new Map<string, Promise<void>>()
  private piProjectionPendingSnapshots = new Map<string, PiProjectionSnapshotV1>()
  private capabilityPrompt?: (request: import('@craft-agent/shared/protocol').CapabilityRequestV1) => Promise<boolean>
  private readonly capabilityRouter = new CapabilityRouter({
    requireDeclarations: true,
    authorize: createCapabilityAuthorizationPolicy({
      rules: ELECTRON_CAPABILITY_POLICY_V1,
      sessionExists: (sessionId) => this.sessions.has(sessionId),
      prompt: (request) => this.capabilityPrompt?.(request) ?? Promise.resolve(false),
    }),
    audit: (event) => sessionLog.info('[HostCapability]', event),
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
          workspaceRootPath: managed.workspace.rootPath,
          isProcessing: managed.isProcessing,
          sharedId: managed.sharedId,
          sharedUrl: managed.sharedUrl,
          name: managed.name,
          sessionStatus: managed.sessionStatus,
          labels: managed.labels,
          permissionMode: managed.permissionMode,
        }
      },
      loadStoredSession: session => loadStoredSession(session.workspaceRootPath, session.id),
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
        await updateSessionMetadata(managed.workspace.rootPath, sessionId, metadata)
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
        const session = await this.createSession(workspaceId, {
          name: payload.name,
          permissionMode: payload.permissionMode,
          sessionStatus: payload.sessionStatus,
          labels: payload.labels,
        })
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
  // Config watchers for live updates (sources, etc.) - one per workspace
  private configWatchers: Map<string, ConfigWatcher> = new Map()
  // Automation systems for workspace event automations - one per workspace (includes scheduler, diffing, and handlers)
  private automationSystems: Map<string, AutomationSystem> = new Map()
  // Pending credential request resolvers (keyed by requestId)
  private pendingCredentialResolvers: Map<string, (response: import('@craft-agent/shared/protocol').CredentialResponse) => void> = new Map()
  // Permission request metadata tracking (keyed by requestId)
  private pendingPermissionRequests: Map<string, {
    sessionId: string
    type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval'
    commandHash?: string
  }> = new Map()
  // Privileged approval binding + audit logger
  private privilegedExecutionBroker = new PrivilegedExecutionBroker(sessionLog)
  // Session-local admin remember windows (exact command hash binding)
  private adminRememberApprovals: Map<string, {
    createdAt: number
    expiresAt: number
    sourceRequestId: string
  }> = new Map()
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
  /** Monotonic clock to ensure strictly increasing message timestamps */
  private lastTimestamp = 0

  /**
   * Optional binder installed by the messaging-gateway bootstrap. When set,
   * `executePromptAutomation` calls it after creating a session whose matcher
   * declared `telegramTopic`, so the new session is bound to a Telegram forum
   * topic in the workspace's paired supergroup. Best-effort — failures must
   * not block the session.
   */
  private automationBinder?: (input: {
    workspaceId: string
    sessionId: string
    topicName: string
  }) => Promise<void>

  /**
   * Centralized setter for session processing state.
   * Automatically notifies the power manager on transitions (true→false, false→true)
   * so callers don't need to remember to call onSessionStarted/onSessionStopped.
   */
  private setProcessing(managed: ManagedSession, processing: boolean): void {
    const was = managed.isProcessing
    managed.isProcessing = processing
    if (!was && processing) {
      sessionRuntimeHooks.onSessionStarted()
    } else if (was && !processing) {
      sessionRuntimeHooks.onSessionStopped()
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

  setCapabilityPrompt(prompt: (request: import('@craft-agent/shared/protocol').CapabilityRequestV1) => Promise<boolean>): void {
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

  private getAdminRememberKey(sessionId: string, commandHash: string): string {
    return `${sessionId}:${commandHash}`
  }

  private hasActiveAdminRememberApproval(sessionId: string, commandHash: string): boolean {
    const key = this.getAdminRememberKey(sessionId, commandHash)
    const entry = this.adminRememberApprovals.get(key)
    if (!entry) {
      return false
    }

    if (Date.now() > entry.expiresAt) {
      this.adminRememberApprovals.delete(key)
      this.privilegedExecutionBroker.auditEvent('privileged_remember_window_expired', {
        sessionId,
        commandHash,
        sourceRequestId: entry.sourceRequestId,
        expiresAt: entry.expiresAt,
      })
      return false
    }

    return true
  }

  private storeAdminRememberApproval(sessionId: string, commandHash: string, sourceRequestId: string, rememberForMinutes: number): void {
    const boundedMinutes = Math.min(Math.max(Math.floor(rememberForMinutes), 1), MAX_ADMIN_REMEMBER_MINUTES)
    const now = Date.now()
    const expiresAt = now + boundedMinutes * 60 * 1000

    this.adminRememberApprovals.set(this.getAdminRememberKey(sessionId, commandHash), {
      createdAt: now,
      expiresAt,
      sourceRequestId,
    })

    this.privilegedExecutionBroker.auditEvent('privileged_remember_window_stored', {
      sessionId,
      commandHash,
      sourceRequestId,
      rememberForMinutes: boundedMinutes,
      createdAt: now,
      expiresAt,
    })
  }

  private clearAdminRememberApprovalsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const key of this.adminRememberApprovals.keys()) {
      if (key.startsWith(prefix)) {
        this.adminRememberApprovals.delete(key)
      }
    }
  }

  private clearPendingPermissionRequestsForSession(sessionId: string): void {
    for (const [requestId, metadata] of this.pendingPermissionRequests.entries()) {
      if (metadata.sessionId === sessionId) {
        this.pendingPermissionRequests.delete(requestId)
      }
    }
  }

  /**
   * Apply external session header metadata to in-memory state and emit UI events.
   * Returns true if any in-memory metadata field changed.
   */
  private async applyExternalSessionMetadata(managed: ManagedSession, header: SessionHeader): Promise<boolean> {
    const sessionId = managed.id
    let changed = false

    // Labels
    const oldLabels = JSON.stringify(managed.labels ?? [])
    const newLabels = JSON.stringify(header.labels ?? [])
    if (oldLabels !== newLabels) {
      managed.labels = header.labels
      this.sendEvent({ type: 'labels_changed', sessionId, labels: header.labels ?? [] }, managed.workspace.id)
      changed = true
    }

    // Flagged
    if ((managed.isFlagged ?? false) !== (header.isFlagged ?? false)) {
      managed.isFlagged = header.isFlagged ?? false
      this.sendEvent(
        { type: header.isFlagged ? 'session_flagged' : 'session_unflagged', sessionId },
        managed.workspace.id
      )
      changed = true
    }

    // Session status
    if (managed.sessionStatus !== header.sessionStatus) {
      managed.sessionStatus = header.sessionStatus
      this.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus: header.sessionStatus ?? '' }, managed.workspace.id)
      changed = true
    }

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
   * (sources added/removed, guide.md changes, etc.)
   * Called eagerly at boot for all workspaces (automations/scheduler) and
   * on client connect (GET_WORKSPACE / SWITCH_WORKSPACE).
   * Idempotent — returns immediately if already watching.
   * workspaceId must be the global config ID (what the renderer knows).
   */
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    // Check if already watching this workspace
    if (this.configWatchers.has(workspaceRootPath)) {
      return // Already watching this workspace
    }

    sessionLog.info(`Setting up ConfigWatcher for workspace: ${workspaceId} (${workspaceRootPath})`)

    const callbacks: ConfigWatcherCallbacks = {
      onSourcesListChange: async (sources: LoadedSource[]) => {
        sessionLog.info(`Sources list changed in ${workspaceRootPath} (${sources.length} sources)`)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceChange: async (slug: string, source: LoadedSource | null) => {
        sessionLog.info(`Source '${slug}' changed:`, source ? 'updated' : 'deleted')
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceGuideChange: (sourceSlug: string) => {
        sessionLog.info(`Source guide changed: ${sourceSlug}`)
        // Broadcast the updated sources list so sidebar picks up guide changes
        // Note: Guide changes don't require session source reload (no server changes)
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
      },
      onStatusConfigChange: () => {
        sessionLog.info(`Status config changed in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onStatusIconChange: (_workspaceId: string, iconFilename: string) => {
        sessionLog.info(`Status icon changed: ${iconFilename} in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onLabelConfigChange: () => {
        sessionLog.info(`Label config changed in ${workspaceId}`)
        this.broadcastLabelsChanged(workspaceId)
        // Emit LabelConfigChange event via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          automationSystem.emitLabelConfigChange().catch((error) => {
            sessionLog.error(`[Automations] Failed to emit LabelConfigChange:`, error)
          })
        }
      },
      onAutomationsConfigChange: () => {
        sessionLog.info(`Automations config changed in ${workspaceId}`)
        // Reload automations config via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          const result = automationSystem.reloadConfig()
          if (result.errors.length === 0) {
            sessionLog.info(`Reloaded ${result.automationCount} automations for workspace ${workspaceId}`)
          } else {
            sessionLog.error(`Failed to reload automations for workspace ${workspaceId}:`, result.errors)
          }
        }
        // Notify renderer to re-read automations.json
        this.broadcastAutomationsChanged(workspaceId)
      },
      onProvidersChange: () => {
        sessionLog.info(`Pi providers changed in ${workspaceId}`)
        this.broadcastProvidersChanged()
      },
      onAppThemeChange: (theme) => {
        sessionLog.info(`App theme changed`)
        this.broadcastAppThemeChanged(theme)
      },
      onDefaultPermissionsChange: () => {
        sessionLog.info('Default permissions changed')
        this.broadcastDefaultPermissionsChanged()
      },
      onSkillsListChange: async (skills) => {
        sessionLog.info(`Skills list changed in ${workspaceRootPath} (${skills.length} skills)`)
        this.broadcastSkillsChanged(workspaceId, skills)
      },
      onSkillChange: async (slug, skill) => {
        sessionLog.info(`Skill '${slug}' changed:`, skill ? 'updated' : 'deleted')
        // Broadcast updated list to UI
        const { loadAllSkills } = await import('@craft-agent/shared/skills')
        const skills = loadAllSkills(workspaceRootPath)
        this.broadcastSkillsChanged(workspaceId, skills)
      },

      // Session metadata changes (edits to the Craft metadata in Pi JSONL headers).
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
          // 2. Session was just written programmatically (set_session_status/labels tool)
          //    — fs.watch fires during atomic write (unlink+rename) and can read stale data
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

        // Always notify automation system — it does its own diffing and needs
        // to see both self-writes and external changes for event matching.
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          automationSystem.updateSessionMetadata(sessionId, {
            permissionMode: header.permissionMode,
            labels: header.labels,
            isFlagged: header.isFlagged,
            sessionStatus: header.sessionStatus,
            sessionName: header.name,
          }).catch((error) => {
            sessionLog.error(`[Automations] Failed to update session metadata:`, error)
          })
        }
      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks)
    watcher.start()
    this.configWatchers.set(workspaceRootPath, watcher)

    // Initialize AutomationSystem for this workspace (includes scheduler, handlers, and event logging)
    if (!this.automationSystems.has(workspaceRootPath)) {
      const automationSystem = new AutomationSystem({
        workspaceRootPath,
        workspaceId,
        enableScheduler: true,
        // piExtensions.delegatePromptAutomation：启用后 prompt action 委托给 pi prompt-automation 扩展
        delegatePromptAutomation: FEATURE_FLAGS.delegatePromptAutomation,
        onDelegatePrompts: async (prompts) => {
          sessionLog.info(`[Automations] Delegating ${prompts.length} prompt(s) to pi prompt-automation extension`)
          const delegateSession = this.findActivePiSessionForWorkspace(workspaceRootPath)
          if (delegateSession) {
            try {
              const accepted = await this.invokeExtensionCommand(
                delegateSession,
                'prompt-automation',
                JSON.stringify(prompts),
              )
              if (accepted.invoked) {
                sessionLog.info(`[Automations] Delegated prompt batch to Pi session ${delegateSession}`)
                return
              }
              sessionLog.warn(`[Automations] Pi prompt-automation command was not accepted by session ${delegateSession}, using native fallback`)
            } catch (error) {
              sessionLog.warn(`[Automations] Pi prompt-automation delegate failed, using native fallback: ${error instanceof Error ? error.message : String(error)}`)
            }
          } else {
            sessionLog.warn(`[Automations] No active Pi session for workspace ${workspaceRootPath}, using native fallback`)
          }
          await this.executePromptsNative(workspaceId, workspaceRootPath, prompts)
        },
        onPromptsReady: async (prompts) => {
          // Execute prompt automations by creating new sessions
          const settled = await Promise.allSettled(
            prompts.map((pending) =>
              this.executePromptAutomation({
                workspaceId,
                workspaceRootPath,
                prompt: pending.prompt,
                labels: pending.labels,
                permissionMode: pending.permissionMode,
                mentions: pending.mentions,
                provider: pending.provider,
                model: pending.model,
                thinkingLevel: pending.thinkingLevel,
                automationName: pending.automationName,
                telegramTopic: pending.telegramTopic,
              })
            )
          )

          // Write enriched history entries (with session IDs and prompt summaries)
          for (const [idx, result] of settled.entries()) {
            const pending = prompts[idx]
            if (!pending.matcherId) continue

            const entry = createPromptHistoryEntry({
              matcherId: pending.matcherId,
              ok: result.status === 'fulfilled',
              sessionId: result.status === 'fulfilled' ? result.value.sessionId : undefined,
              prompt: pending.prompt,
              error: result.status === 'rejected' ? String(result.reason) : undefined,
            })

            appendAutomationHistoryEntry(workspaceRootPath, entry).catch(e => sessionLog.warn('[Automations] Failed to write history:', e))

            if (result.status === 'rejected') {
              sessionLog.error(`[Automations] Failed to execute prompt action ${idx + 1}:`, result.reason)
            } else {
              sessionLog.info(`[Automations] Created session ${result.value.sessionId} from prompt action`)
            }
          }
        },
        onError: (event, error) => {
          sessionLog.error(`Automation failed for ${event}:`, error.message)
        },
      })
      this.automationSystems.set(workspaceRootPath, automationSystem)
      sessionLog.info(`Initialized AutomationSystem for workspace ${workspaceId}`)
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

  /**
   * Reload sources for all sessions in a workspace, skipping those currently processing.
   */
  private async reloadSourcesForWorkspace(workspaceRootPath: string): Promise<void> {
    for (const [_, managed] of this.sessions) {
      if (managed.workspace.rootPath === workspaceRootPath) {
        if (managed.isProcessing) {
          sessionLog.info(`Skipping source reload for session ${managed.id} (processing)`)
          continue
        }
        await this.reloadSessionSources(managed)
      }
    }
  }

  private broadcastSourcesChanged(workspaceId: string, sources: LoadedSource[]): void {
    if (!this.eventSink) return
    this.eventSink(RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
  }

  private broadcastStatusesChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting statuses changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.statuses.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastLabelsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting labels changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastAutomationsChanged(workspaceId: string): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting automations changed for ${workspaceId}`)
    this.eventSink(RPC_CHANNELS.automations.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private broadcastAppThemeChanged(theme: import('@craft-agent/shared/config').ThemeOverrides | null): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting app theme changed`)
    this.eventSink(RPC_CHANNELS.theme.APP_CHANGED, { to: 'all' }, theme)
  }

  private broadcastProvidersChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting providers changed')
    this.eventSink(RPC_CHANNELS.pi.GLOBAL_CHANGED, { to: 'all' })
  }

  private broadcastSkillsChanged(workspaceId: string, skills: import('@craft-agent/shared/skills').LoadedSkill[]): void {
    if (!this.eventSink) return
    sessionLog.info(`Broadcasting skills changed (${skills.length} skills)`)
    this.eventSink(RPC_CHANNELS.skills.CHANGED, { to: 'workspace', workspaceId }, workspaceId, skills)
  }

  private broadcastDefaultPermissionsChanged(): void {
    if (!this.eventSink) return
    sessionLog.info('Broadcasting default permissions changed')
    this.eventSink(RPC_CHANNELS.permissions.DEFAULTS_CHANGED, { to: 'all' }, null)
  }

  /**
   * Reload sources for a session with an active agent.
   * Called by ConfigWatcher when source files change on disk.
   * If agent is null (session hasn't sent any messages), skip - fresh build happens on next message.
   */
  private async reloadSessionSources(managed: ManagedSession): Promise<void> {
    if (!managed.agent) return  // No agent = nothing to update (fresh build on next message)

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Reloading sources for session ${managed.id}`)

    // Reload all sources from disk (craft-agents-docs is always available as MCP server)
    const allSources = loadAllSources(workspaceRootPath)
    managed.agent.setAllSources(allSources)

    // Rebuild MCP and API servers for session's enabled sources
    const enabledSlugs = managed.enabledSourceSlugs || []
    const enabledSources = allSources.filter(s =>
      enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
    )
    // Pass session path so large API responses can be saved to session folder
    const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
    const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())
    const intendedSlugs = enabledSources.map(s => s.config.slug)

    // Update bridge-mcp-server config/credentials for backends that need it
    await applyBridgeUpdates(managed.agent, sessionPath, enabledSources, mcpServers, managed.id, workspaceRootPath, 'source reload', managed.poolServer?.url)

    await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

    sessionLog.info(`Sources reloaded for session ${managed.id}: ${Object.keys(mcpServers).length} MCP, ${Object.keys(apiServers).length} API`)
  }

  /**
   * Reinitialize authentication environment variables.
   * Call this after onboarding or settings changes to pick up new credentials.
   *
   * SECURITY NOTE: These env vars are propagated to the agent subprocess.
   * Bun's automatic .env loading is disabled in the subprocess (--env-file=/dev/null)
   * to prevent a user's project .env from injecting ANTHROPIC_API_KEY and overriding
   * OAuth auth — Anthropic-compatible providers prioritize API key over OAuth token when both are set.
   * See: https://github.com/lukilabs/craft-agents-oss/issues/39
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
      // Get the connection to use (explicit parameter or default)
      const slug = provider || readPiGlobalSettings().defaultProvider
      if (!slug) {
        sessionLog.warn('No provider key available for reinitializeAuth')
      }
      const connection = slug ? readPiGlobalProviders()[slug] : null

      // Restore managed auth env vars to their baseline before applying this connection.
      resetManagedAnthropicAuthEnvVars()

      if (!connection) {
        sessionLog.error(`No provider found for key: ${slug}`)
        return
      }

      sessionLog.info(`Reinitializing auth for provider: ${slug}`)

      // Pi is the only runtime provider. Credential routing is handled natively
      // by PiAgent via ~/.pi/agent/auth.json — no env-var injection needed here.
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
      this.piProjectionBySession.set(sessionId, projector)
      const restored = projector.createSnapshot()
      syncPiProjectionComputedMetadata(managed, restored)
      this.recoverQueuedProjectionMessages(managed, restored)
      return restored
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        sessionLog.warn(`Failed to load Pi projection snapshot for ${sessionId}: ${error instanceof Error ? error.message : error}`)
      }
    }

    try {
      const piProjection = await findPiSessionProjectionById(managed.workspace.rootPath, sessionId)
      if (!piProjection) return null

      const snapshot = buildPiProjectionSnapshotFromHostProjection(
        sessionId,
        `history:${sessionId}`,
        piProjection,
      )
      const projector = new ConversationProjector(sessionId, snapshot.runtimeId, snapshot)
      this.piProjectionBySession.set(sessionId, projector)
      this.persistPiProjection(managed, projector.createSnapshot())
      const rebuilt = projector.createSnapshot()
      syncPiProjectionComputedMetadata(managed, rebuilt)
      this.recoverQueuedProjectionMessages(managed, rebuilt)
      return rebuilt
    } catch (error) {
      sessionLog.warn(`Failed to rebuild Pi projection snapshot for ${sessionId}: ${error instanceof Error ? error.message : error}`)
      return null
    }
  }

  private recoverQueuedProjectionMessages(
    managed: ManagedSession,
    snapshot: PiProjectionSnapshotV1,
  ): void {
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

    if (!managed.messagesLoaded) this.hydrateMessagesForColdPersist(managed)
    let recovered = 0
    for (const item of queued) {
      if (managed.messageQueue.some(queuedMessage => queuedMessage.messageId === item.messageId)
        || managed.replayingQueuedMessageId === item.messageId) continue
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
      if (!managed.isProcessing) setImmediate(() => this.processNextQueuedMessage(managed.id))
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
        if (applied.kind === 'plan_artifact' || applied.kind === 'plan_artifact_update') {
          managed.lastMessageRole = 'plan'
        }
        if (applied.kind === 'runtime_error') managed.lastMessageRole = 'error'
        this.eventSink?.(
          RPC_CHANNELS.sessions.PI_PROJECTION_EVENT,
          { to: 'workspace', workspaceId: managed.workspace.id },
          applied,
        )
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
    return join(getSessionStoragePath(managed.workspace.rootPath, managed.id), 'pi-projection-v1.json')
  }

  private persistPiProjection(managed: ManagedSession, snapshot: PiProjectionSnapshotV1): void {
    this.piProjectionPendingSnapshots.set(managed.id, snapshot)
    if (this.piProjectionWrites.has(managed.id)) return

    const write = (async () => {
      while (true) {
        const latest = this.piProjectionPendingSnapshots.get(managed.id)
        if (!latest) break
        this.piProjectionPendingSnapshots.delete(managed.id)
        const target = this.getPiProjectionSnapshotPath(managed)
        await mkdir(dirname(target), { recursive: true })
        const temporary = `${target}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(latest), 'utf8')
        await rename(temporary, target)
      }
    })().catch((error) => {
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
        continue
      }
      const pending = this.piProjectionPendingSnapshots.get(managed.id)
      if (!pending) return
      this.persistPiProjection(managed, pending)
    }
  }

  async initialize(): Promise<void> {
    try {
      // Fix provider if it points to a non-existent connection

      // Set up authentication environment variables (critical for SDK to work)
      await this.reinitializeAuth()

      // Eagerly activate ConfigWatcher + AutomationSystem for every workspace so
      // the scheduler and event handlers start at boot — not lazily on first
      // client connect. This is critical for headless servers where no UI may
      // ever connect, yet scheduled/event-driven automations must still fire.
      const workspaces = getWorkspaces()
      for (const workspace of workspaces) {
        this.setupConfigWatcher(workspace.rootPath, workspace.id)
      }

      // Load existing sessions from disk
      this.loadSessionsFromDisk()

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
        const workspaceRootPath = workspace.rootPath
        const sessionMetadata = listStoredSessions(workspaceRootPath)
        const automationSystem = this.automationSystems.get(workspaceRootPath)

        for (const meta of sessionMetadata) {
          // Create managed session from metadata only (messages lazy-loaded on demand)
          // This dramatically reduces memory usage at startup - messages are loaded
          // when getSession() is called for a specific session
          const managed = createManagedSession(meta, workspace, {
            enabledSourceSlugs: undefined,  // Loaded with messages
            workingDirectory: workspaceRootPath,
          })

          // Clear persisted overrides that point to a provider removed outside this process.
          if (managed.provider) {
            if (!hasConfiguredPiProvider(managed.provider)) {
              sessionLog.warn(`Session ${meta.craftId} has orphaned provider "${managed.provider}", clearing`)
              managed.provider = undefined
              this.setMetadataWriteGuard(managed)
              this.persistSession(managed)
            }
          }

          // Initialize mode-manager state for restored sessions even before agent creation.
          // This keeps diagnostics/effective mode aligned with persisted session metadata.
          setPermissionMode(meta.craftId, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
          if (managed.previousPermissionMode) {
            hydratePreviousPermissionMode(meta.craftId, managed.previousPermissionMode)
          }

          this.sessions.set(meta.craftId, managed)

          // Initialize session metadata in AutomationSystem for diffing
          if (automationSystem) {
            automationSystem.setInitialSessionMetadata(meta.craftId, {
              permissionMode: meta.permissionMode,
              labels: meta.labels,
              isFlagged: meta.isFlagged,
              sessionStatus: meta.sessionStatus,
              sessionName: managed.name,
            })
          }

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
   * deliberately does NOT touch persistent metadata fields (name, labels,
   * sessionStatus, provider, ...) because the caller may have just
   * mutated them; the in-memory mutation must win over what's on disk.
   * `loadStoredSession` is synchronous (sync fs reads), so the entire path
   * stays sync — no microtask race window between the load and the enqueue.
   */
  private persistSession(managed: ManagedSession): void {
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
    const stored = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (stored) {
      managed.messages = (stored.messages || []).map(storedToMessage)
      managed.tokenUsage = stored.tokenUsage
      // Deferred-load fields (intentionally undefined after startup, see
      // loadSessionsFromDisk). Populate from disk only if not already set in
      // memory — a caller may have mutated them via setSessionSources etc.
      if (managed.enabledSourceSlugs === undefined) managed.enabledSourceSlugs = stored.enabledSourceSlugs
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
    try {
      // Filter out transient status messages (progress indicators like "Compacting...")
      // Error messages are now persisted with rich fields for diagnostics
      const persistableMessages = managed.messages.filter(m =>
        m.role !== 'status'
      )

      const storedSession: StoredSession = {
        ...pickCraftSessionMetadata(managed),
        craftId: managed.id,
        workspaceRootPath: managed.workspace.rootPath,
        createdAt: managed.createdAt ?? Date.now(),
        lastUsedAt: Date.now(),
        messageCount: managed.messageCount,
        preview: managed.preview,
        lastMessageRole: managed.lastMessageRole,
        lastFinalMessageId: managed.lastFinalMessageId,
        messages: persistableMessages.map(messageToStored),
        tokenUsage: managed.tokenUsage ?? DEFAULT_TOKEN_USAGE,
      } as StoredSession

      // Queue for async persistence with debouncing
      sessionPersistenceQueue.enqueue(storedSession)
    } catch (error) {
      sessionLog.error(`Failed to queue session ${managed.id} for persistence:`, error)
    }
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

  // ============================================
  // Unified Auth Request Helpers
  // ============================================

  /**
   * Get human-readable description for auth request
   */
  private getAuthRequestDescription(request: AuthRequest): string {
    switch (request.type) {
      case 'credential':
        return `Authentication required for ${request.sourceName}`
      case 'oauth':
        return `OAuth authentication for ${request.sourceName}`
      case 'oauth-google':
        return `Sign in with Google for ${request.sourceName}`
      case 'oauth-slack':
        return `Sign in with Slack for ${request.sourceName}`
      case 'oauth-microsoft':
        return `Sign in with Microsoft for ${request.sourceName}`
    }
  }

  /**
   * Format auth result message to send back to agent
   */
  private formatAuthResultMessage(result: AuthResult): string {
    if (result.success) {
      let msg = `Authentication completed for ${result.sourceSlug}.`
      if (result.email) msg += ` Signed in as ${result.email}.`
      if (result.workspace) msg += ` Connected to workspace: ${result.workspace}.`
      msg += ' Credentials have been saved.'
      return msg
    }
    if (result.cancelled) {
      return `Authentication cancelled for ${result.sourceSlug}.`
    }
    return `Authentication failed for ${result.sourceSlug}: ${result.error || 'Unknown error'}`
  }


  /**
   * Complete an auth request and send result back to agent
   * This updates the auth message status and sends a faked user message
   */
  async completeAuthRequest(sessionId: string, result: AuthResult): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot complete auth request - session ${sessionId} not found`)
      return
    }

    managed.agent?.projectAuthPromptResolution?.(
      result.requestId,
      result.cancelled ? 'cancelled' : result.success ? 'completed' : 'failed',
    )

    // Emit auth_completed event to update UI
    this.sendEvent({
      type: 'auth_completed',
      sessionId,
      requestId: result.requestId,
      success: result.success,
      cancelled: result.cancelled,
      error: result.error,
    }, managed.workspace.id)

    // Create faked user message with result
    const resultContent = this.formatAuthResultMessage(result)

    // Clear pending auth state
    managed.pendingAuthRequestId = undefined
    managed.pendingAuthRequest = undefined

    // Auto-enable the source in the session after successful auth
    if (result.success && result.sourceSlug) {
      const slugSet = new Set(managed.enabledSourceSlugs || [])
      if (!slugSet.has(result.sourceSlug)) {
        slugSet.add(result.sourceSlug)
        managed.enabledSourceSlugs = Array.from(slugSet)
        sessionLog.info(`Auto-enabled source ${result.sourceSlug} in session ${sessionId} after auth`)
      }

      // Clear any refresh cooldown so the source is immediately usable
      managed.tokenRefreshManager.clearCooldown(result.sourceSlug)
    }

    // Persist Host-owned auth state and enabled sources. The auth prompt and
    // its resolution are already represented by Pi projection entities.
    this.persistSession(managed)

    // Update bridge-mcp-server config/credentials for backends that need it
    if (result.success && result.sourceSlug && managed.agent) {
      const workspaceRootPath = managed.workspace.rootPath
      const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(workspaceRootPath)
      const enabledSources = allSources.filter(s =>
        enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
      )
      const { mcpServers } = await buildServersFromSources(
        enabledSources, sessionPath, managed.tokenRefreshManager
      )
      await applyBridgeUpdates(managed.agent, sessionPath, enabledSources, mcpServers, managed.id, workspaceRootPath, 'source auth', managed.poolServer?.url)
    }

    // Send the result as a new message to resume conversation
    // Use empty arrays for attachments since this is a system-generated message
    await this.sendMessage(sessionId, resultContent, [], [], {})

    sessionLog.info(`Auth request completed for ${result.sourceSlug}: ${result.success ? 'success' : 'failed'}`)
  }

  /**
   * Handle credential input from the UI (for non-OAuth auth)
   * Called when user submits credentials via the inline form
   */
  async handleCredentialInput(
    sessionId: string,
    requestId: string,
    response: import('@craft-agent/shared/protocol').CredentialResponse
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.pendingAuthRequest) {
      sessionLog.warn(`Cannot handle credential input - no pending auth request for session ${sessionId}`)
      return
    }

    const request = managed.pendingAuthRequest as CredentialAuthRequest
    if (request.requestId !== requestId) {
      sessionLog.warn(`Credential request ID mismatch: expected ${request.requestId}, got ${requestId}`)
      return
    }

    if (response.cancelled) {
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        cancelled: true,
      })
      return
    }

    try {
      // Store credentials using existing workspace ID extraction pattern
      const credManager = getCredentialManager()
      // Extract workspace ID from root path (last segment of path)
      const wsId = basename(managed.workspace.rootPath) || managed.workspace.id

      if (request.mode === 'basic') {
        // Store value as JSON string {username, password} - credential-manager.ts parses it for basic auth
        await credManager.set(
          { type: 'source_basic', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify({ username: response.username, password: response.password }) }
        )
      } else if (request.mode === 'bearer') {
        await credManager.set(
          { type: 'source_bearer', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      } else if (request.mode === 'multi-header') {
        // Store multi-header credentials as JSON { "DD-API-KEY": "...", "DD-APPLICATION-KEY": "..." }
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify(response.headers) }
        )
      } else {
        // header or query - both use API key storage
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      }

      // Update source config to mark as authenticated
      const { markSourceAuthenticated } = await import('@craft-agent/shared/sources')
      markSourceAuthenticated(managed.workspace.rootPath, request.sourceSlug)

      // Mark source as unseen so fresh guide is injected on next message
      if (managed.agent) {
        managed.agent.markSourceUnseen(request.sourceSlug)
      }

      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: true,
      })
    } catch (error) {
      sessionLog.error(`Failed to save credentials for ${request.sourceSlug}:`, error)
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  getWorkspacesInfo(): WorkspaceInfo[] {
    return getWorkspaces().map(({ rootPath, createdAt, ...info }) => info)
  }

  getActiveSessionCount(workspaceId?: string): number {
    let count = 0
    for (const managed of this.sessions.values()) {
      if (workspaceId && managed.workspace.id !== workspaceId) continue
      if (managed.isProcessing) count++
    }
    return count
  }

  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean } {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { automationCount: 0, schedulerRunning: false }

    const automationSystem = this.automationSystems.get(workspace.rootPath)
    if (!automationSystem) return { automationCount: 0, schedulerRunning: false }

    const config = automationSystem.getConfig()
    let automationCount = 0
    if (config) {
      for (const matchers of Object.values(config.automations)) {
        automationCount += matchers?.length ?? 0
      }
    }

    return {
      automationCount,
      // SchedulerService is running if the system was created with enableScheduler
      schedulerRunning: !automationSystem.isDisposed(),
    }
  }

  getActiveSessionsInfo(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = []
    for (const managed of this.sessions.values()) {
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
    let sessions = Array.from(this.sessions.values())

    // Filter by workspace if specified (used when switching workspaces)
    if (workspaceId) {
      sessions = sessions.filter(m => m.workspace.id === workspaceId)
    }

    return sessions
      .map(m => managedToSession(m))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }

  /**
   * Aggregate unread state across all workspaces.
   * Excludes hidden and archived sessions from counts/indicators.
   */
  getUnreadSummary(): UnreadSummary {
    const byWorkspace: Record<string, number> = {}
    const hasUnreadByWorkspace: Record<string, boolean> = {}

    for (const workspace of getWorkspaces()) {
      byWorkspace[workspace.id] = 0
      hasUnreadByWorkspace[workspace.id] = false
    }

    for (const session of this.sessions.values()) {
      if (session.hidden || session.isArchived) continue
      if (!session.hasUnread) continue

      const workspaceId = session.workspace.id
      byWorkspace[workspaceId] = (byWorkspace[workspaceId] ?? 0) + 1
      hasUnreadByWorkspace[workspaceId] = true
    }

    const totalUnreadSessions = Object.values(byWorkspace).reduce((sum, count) => sum + count, 0)

    return {
      totalUnreadSessions,
      byWorkspace,
      hasUnreadByWorkspace,
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

  /**
   * Broadcast global unread summary to all workspace windows.
   */
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
    const storedSession = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (storedSession) {
      managed.messages = (storedSession.messages || []).map(storedToMessage)
      managed.tokenUsage = storedSession.tokenUsage
      managed.lastReadMessageId = storedSession.lastReadMessageId
      managed.hasUnread = storedSession.hasUnread  // Explicit unread flag for NEW badge state machine
      managed.enabledSourceSlugs = storedSession.enabledSourceSlugs
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
    return getSessionStoragePath(managed.workspace.rootPath, sessionId)
  }

  async createSession(workspaceId: string, options?: import('@craft-agent/shared/protocol').CreateSessionOptions): Promise<Session> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    // Get new session defaults from workspace config (with global fallback)
    // Options.permissionMode overrides the workspace default (used by EditPopover for auto-execute)
    const workspaceRootPath = workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const globalDefaults = loadConfigDefaults()

    // Read permission mode from workspace config, fallback to global defaults
    const defaultPermissionMode = options?.permissionMode
      ?? wsConfig?.defaults?.permissionMode
      ?? globalDefaults.workspaceDefaults.permissionMode

    // Resolve thinking level with caller-first precedence, matching permissionMode above:
    //   caller override → workspace default → global default.
    // normalizeThinkingLevel() tolerates undefined/unknown inputs.
    const defaultThinkingLevel =
      normalizeThinkingLevel(options?.thinkingLevel)
      ?? normalizeThinkingLevel(wsConfig?.defaults?.thinkingLevel)
      ?? getDefaultThinkingLevel()
    // Get default model from workspace config (used when no session-specific model is set)
    const defaultModel = wsConfig?.defaults?.model
    const requestedProvider = options?.provider
    const sessionProvider = hasConfiguredPiProvider(requestedProvider)
      ? requestedProvider
      : undefined
    if (requestedProvider && !sessionProvider) {
      sessionLog.warn(`Creating session without deleted provider "${requestedProvider}"; using defaults`)
    }

    // Get default enabled sources from workspace config
    const defaultEnabledSourceSlugs = options?.enabledSourceSlugs ?? wsConfig?.defaults?.enabledSourceSlugs

    // Resolve model tier hints ('fast' / 'default') to actual model IDs.
    // EditPopover uses tier hints instead of hardcoded Anthropic model names
    // so the right model is selected regardless of the active LLM provider.
    let resolvedModelOption = options?.model || defaultModel
    if (resolvedModelOption === 'fast' || resolvedModelOption === 'default') {
      const tierProvider = resolveSessionProvider(
        sessionProvider,
        wsConfig?.defaults?.provider,
      )
      if (tierProvider) {
        const models = tierProvider.provider.models ?? []
        resolvedModelOption = resolvedModelOption === 'fast'
          ? (models[1]?.id ?? models[0]?.id ?? defaultModel)
          : (models[0]?.id ?? defaultModel)
      } else {
        resolvedModelOption = defaultModel
      }
    }

    // Resolve backend target early for branching policy checks.
    const targetBackendContext = resolveBackendContext({
      sessionProvider,
      workspaceDefaultProvider: wsConfig?.defaults?.provider,
      managedModel: resolvedModelOption,
    })
    const targetProviderType = targetBackendContext.providerConfig?.baseUrl ? 'pi_compat' : 'pi'
    const targetPiAuthProvider = targetBackendContext.providerKey

    const resolvedWorkingDir = workspaceRootPath

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
        if (sourceManaged.workspace.rootPath !== workspaceRootPath) {
          sessionLog.warn('Branch validation failed: source session belongs to different workspace', {
            workspaceId,
            targetWorkspaceRootPath: workspaceRootPath,
            sourceWorkspaceRootPath: sourceManaged.workspace.rootPath,
            branchFromSessionId: options.branchFromSessionId,
          })
          throw new Error('Invalid branch request: source session belongs to a different workspace')
        }

        // Flush source session to disk to ensure latest message list is available for branch copy.
        this.persistSession(sourceManaged)
        await sessionPersistenceQueue.flush(sourceManaged.id)
      }

      const sourceSession = loadStoredSession(workspaceRootPath, options.branchFromSessionId)
      if (!sourceSession) {
        sessionLog.warn('Branch validation failed: source session not found on disk', {
          workspaceId,
          branchFromSessionId: options.branchFromSessionId,
        })
        throw new Error(`Invalid branch request: source session ${options.branchFromSessionId} not found`)
      }

      const sourceBackendContext = resolveBackendContext({
        sessionProvider: sourceManaged?.provider || sourceSession.provider,
        workspaceDefaultProvider: wsConfig?.defaults?.provider,
        managedModel: sourceManaged?.model || sourceSession.model,
      })
      const sourceProviderType = sourceBackendContext.providerConfig?.baseUrl ? 'pi_compat' : 'pi'
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

      const sourceProjection = await findPiSessionProjectionById(workspaceRootPath, options.branchFromSessionId)
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

    // Use storage layer to create and persist the session
    const storedSession = await createStoredSession(workspaceRootPath, {
      name: options?.name,
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      hidden: options?.hidden,
      sessionStatus: options?.sessionStatus,
      labels: options?.labels,
      isFlagged: options?.isFlagged,
    })

    // Branch: project the active Pi path up to the selected entry, then append
    // only canonical messages through Pi's public SessionManager API. Craft
    // retains UI-only overlay fields (annotations, attachments, badges).
    if (validatedBranch) {
      try {
        const branchedStored = loadStoredSession(workspaceRootPath, storedSession.craftId)
        if (!branchedStored) {
          throw new Error(`Failed to load newly created session ${storedSession.craftId} for branch copy`)
        }

        const sourceMessages = validatedBranch.sourceProjectionSession.messages
          .filter(message => validatedBranch.sourceEntryIds.has(message.id))

        // Re-map embedded paths from the source Craft sidecar to the branch sidecar.
        const sourceDir = normalizePath(getSessionStoragePath(workspaceRootPath, validatedBranch.sourceSessionId))
        const branchDir = normalizePath(getSessionStoragePath(workspaceRootPath, storedSession.craftId))
        const remappedMessages = sourceDir !== branchDir
          ? sourceMessages.map(m => {
            const json = JSON.stringify(m)
            if (!json.includes(sourceDir)) return m
            return JSON.parse(json.replaceAll(sourceDir, branchDir)) as StoredMessage
          })
          : sourceMessages

        const branchSessionFile = getSessionFilePath(
          workspaceRootPath,
          storedSession.craftId,
          workspaceRootPath,
          storedSession.createdAt,
        )
        const importedIdMap = appendPiBranchMessagesViaSessionManager(
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
          storedSession.craftId,
        )

        branchedStored.branchFromMessageId = validatedBranch.sourceMessageId
        delete branchedStored.branchFromSdkSessionId
        delete branchedStored.branchFromSessionPath
        delete branchedStored.branchFromPiSessionFile
        delete branchedStored.branchFromSdkCwd
        delete branchedStored.branchFromSdkTurnId
        await saveStoredSession(branchedStored)
      } catch (error) {
        await deleteStoredSession(workspaceRootPath, storedSession.craftId).catch(deleteError => {
          sessionLog.warn(`Failed to roll back branch ${storedSession.craftId}: ${deleteError instanceof Error ? deleteError.message : deleteError}`)
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
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      model: resolvedModel,
      provider: sessionProvider,
      thinkingLevel: defaultThinkingLevel,
      systemPromptPreset: options?.systemPromptPreset,
      enabledSourceSlugs: defaultEnabledSourceSlugs,
      branchFromMessageId: validatedBranch?.sourceMessageId,
      branchContextStrategy: validatedBranch?.branchContextStrategy,
      branchSeedApplied: validatedBranch ? true : undefined,
      messagesLoaded: !isBranch,  // Branched sessions: lazy-load messages from JSONL
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
            sessionId: storedSession.craftId,
            branchFromSessionId: validatedBranch?.sourceSessionId,
            branchFromMessageId: validatedBranch?.sourceMessageId,
            branchContextStrategy: managed.branchContextStrategy,
            error: error instanceof Error ? error.message : String(error),
          })

          await rollbackFailedBranchCreation({
            managed,
            workspaceRootPath,
            sessionId: storedSession.craftId,
            deleteFromRuntimeSessions: (id) => {
              const m = this.sessions.get(id)
              if (m?.autoRetryTimer) {
                clearTimeout(m.autoRetryTimer)
                m.autoRetryTimer = undefined
              }
              if (m) m.autoRetryPending = undefined
              this.sessions.delete(id)
            },
            deleteStoredSession,
          })

          throw new Error(
            `Could not create branch: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    // Initialize mode-manager state immediately to avoid UI/enforcement races
    // before the agent instance is lazily created.
    setPermissionMode(storedSession.craftId, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(storedSession.craftId, managed.previousPermissionMode)
    }

    this.sessions.set(storedSession.craftId, managed)

    // Initialize session metadata in AutomationSystem for diffing
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(storedSession.craftId, {
        permissionMode: storedSession.permissionMode,
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    return managedToSession(managed, isBranch ? { messages: managed.messages } : undefined)
  }

  private async disposeManagedAgentRuntime(managed: ManagedSession, reason: string): Promise<void> {
    const sessionId = managed.id

    if (managed.agent) {
      try {
        if (managed.agent.disposeForRestart) {
          await managed.agent.disposeForRestart()
        } else {
          managed.agent.dispose()
        }
      } catch (error) {
        sessionLog.warn(`Failed to dispose agent for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (managed.poolServer) {
      try {
        await managed.poolServer.stop()
      } catch (error) {
        sessionLog.warn(`Failed to stop pool server for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      }
    }

    if (managed.mcpPool) {
      try {
        await managed.mcpPool.disconnectAll()
      } catch (error) {
        sessionLog.warn(`Failed to disconnect MCP pool for ${sessionId} during ${reason}: ${error instanceof Error ? error.message : error}`)
      }
    }

    managed.agent = null
    managed.poolServer = undefined
    managed.mcpPool = undefined
    managed.envOverrides = undefined
    managed.agentReady = undefined
    managed.agentReadyResolve = undefined
    managed.backendRuntimeSignature = undefined
    managed.backendRestartSignature = undefined
    unregisterSessionScopedToolCallbacks(sessionId)
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

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionProvider: managed.provider,
      workspaceDefaultProvider: workspaceConfig?.defaults?.provider,
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
          providerType: providerConfig?.baseUrl ? 'pi_compat' : 'pi',
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
   * 2. workspace.defaults.provider
   * 3. global provider
   * 4. fallback: no provider configured
   */
  private async getOrCreateAgent(managed: ManagedSession): Promise<AgentInstance> {
    // Recovery callbacks are synchronous once the agent is constructed. Load
    // the durable Pi projection before the agent starts.
    if (!this.piProjectionBySession.has(managed.id)) {
      await this.getPiProjectionSnapshot(managed.id)
    }

    // Refresh runtime config in-place when the connection has drifted since
    // the agent was created. May null out `managed.agent` if the in-place
    // refresh fails, in which case the create branch below rebuilds it.
    await this.tryRefreshAgentRuntime(managed, 'send-path refresh')

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const backendContext = resolveBackendContext({
      sessionProvider: managed.provider,
      workspaceDefaultProvider: workspaceConfig?.defaults?.provider,
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

      // Keep SDK subprocess side-channel files, such as api-error.json,
      // scoped to this session. Tool metadata now travels through typed Pi
      // events and no longer uses tool-metadata.json.
      process.env.CRAFT_SESSION_DIR = getSessionStoragePath(managed.workspace.rootPath, managed.id)

      // Set up agentReady promise so title generation can await agent creation
      managed.agentReady = new Promise<void>(r => { managed.agentReadyResolve = r })

      // ============================================================
      // Common setup: sources, MCP pool, session config
      // ============================================================

      const sessionPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
      const enabledSlugs = managed.enabledSourceSlugs || []
      const allSources = loadAllSources(managed.workspace.rootPath)
      const enabledSources = allSources.filter(s =>
        enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
      )

      // Build server configs for enabled sources
      const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager)

      // Create centralized MCP client pool (all backends use it)
      managed.mcpPool = new McpClientPool({ debug: (msg) => sessionLog.debug(msg), workspaceRootPath: managed.workspace.rootPath, sessionPath })

      // Backends that run as external subprocesses need an HTTP pool server
      let poolServerUrl: string | undefined
      if (backendContext.capabilities.needsHttpPoolServer) {
        managed.poolServer = new McpPoolServer(managed.mcpPool, { debug: (msg) => sessionLog.debug(msg) })
        managed.mcpPool.onToolsChanged = () => managed.poolServer?.notifyToolsChanged()
        poolServerUrl = await managed.poolServer.start()
        await managed.mcpPool.sync(mcpServers) // Ensure pool has tools before SDK connects
      }

      // Per-session env overrides
      const miniModel = providerConfig?.models?.[1]?.id ?? providerConfig?.models?.[0]?.id
      const envOverrides: Record<string, string> = {
        CRAFT_WORKSPACE_PATH: managed.workspace.rootPath,
      }
      managed.envOverrides = envOverrides

      // ============================================================
      // Common session + callback config (identical for all backends)
      // ============================================================

      const sessionConfig = {
        craftId: managed.id,
        workspaceRootPath: managed.workspace.rootPath,
        sdkSessionId: managed.sdkSessionId,
        branchFromSdkSessionId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkSessionId : undefined,
        branchFromSessionPath: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSessionPath : undefined,
        branchFromPiSessionFile: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromPiSessionFile : undefined,
        branchFromSdkCwd: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkCwd : undefined,
        branchFromSdkTurnId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkTurnId : undefined,
        branchFromMessageId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromMessageId : undefined,
        createdAt: managed.lastMessageAt,
        lastUsedAt: managed.lastMessageAt,
        workingDirectory: managed.workspace.rootPath,
        sdkCwd: managed.sdkCwd ?? managed.workspace.rootPath,
        model: managed.model,
        provider: managed.provider,
        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
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
      const onExtensionEvent = createExtensionEventForwarder(this.eventSink, managed.workspace.id, managed.id)
      const onPiProjectionEvent = (event: PiProjectionEventV1) => {
        try {
          this.applyPiProjectionEvent(event)
        } catch (error) {
          sessionLog.error(`Failed to apply Pi projection event for ${managed.id}:`, error)
        }
      }
      const onHostCapabilityRequest = (
        request: import('@craft-agent/shared/protocol').CapabilityRequestV1,
        onProgress: (event: import('@craft-agent/shared/protocol').CapabilityProgressV1) => void,
      ) => this.capabilityRouter.invoke(request, onProgress)
      const onHostCapabilityDeclaration = (declaration: import('@craft-agent/shared/protocol').ExtensionCapabilityDeclarationV1) => {
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

      managed.agent = createBackendFromResolvedContext({
        context: backendContext,
        hostRuntime: buildBackendHostRuntimeContext(),
        coreConfig: {
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
        mcpPool: managed.mcpPool,
        poolServerUrl,
        envOverrides,
        // Claude-specific
        isHeadless: !AGENT_FLAGS.defaultModesEnabled,
        skipConfigWatcher: true, // Server owns workspace-level ConfigWatcher — don't duplicate in agents
        automationSystem: this.automationSystems.get(managed.workspace.rootPath),
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
        // Source configs for postInit() — backends set up their own bridge/config
        initialSources: {
          enabledSources,
          mcpServers,
          apiServers,
          enabledSlugs,
        },
        // 扩展事件桥接回调：将 Pi RpcClient的扩展事件转发到渲染进程
        onExtensionEvent,
        onPiProjectionEvent,
        onHostCapabilityRequest,
        onHostCapabilityDeclaration,
        onHostCapabilityCancel,
        onHostCapabilityRuntimeReleased,
        },
      }) as AgentInstance

      sessionLog.info(`Created ${provider} agent for session ${managed.id} (model: ${backendContext.resolvedModel})${managed.sdkSessionId ? ' (resuming)' : ''}`)

      // ============================================================
      // Post-construction: debug callback, auth callback, postInit()
      // ============================================================

      managed.agent.onDebug = (msg: string) => {
        const marker = '__PERMISSION_BLOCK__'
        if (msg.includes(marker)) {
          const idx = msg.indexOf(marker)
          const payloadRaw = msg.slice(idx + marker.length)
          try {
            const payload = JSON.parse(payloadRaw) as {
              sessionId: string
              toolName: string
              effectiveMode: string
              modeVersion: number
              changedBy: string
              changedAt: string
              reason: string
            }
            sessionLog.info('Tool blocked by permission mode', payload)
            return
          } catch {
            // fall through to plain logging when payload parsing fails
          }
        }

        sessionLog.info(msg)
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

      // Wire up large response handling in the MCP pool (all backends)
      if (managed.mcpPool && managed.agent) {
        managed.mcpPool.setSummarizeCallback(managed.agent.getSummarizeCallback())
      }

      // Signal that the agent instance is ready (unblocks title generation)
      managed.agentReadyResolve?.()

      // Set up permission handler to forward requests to renderer
      managed.agent.onPermissionRequest = (request: {
        requestId: string;
        toolName: string;
        command?: string;
        description: string;
        type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
        appName?: string;
        reason?: string;
        impact?: string;
        requiresSystemPrompt?: boolean;
        rememberForMinutes?: number;
        commandHash?: string;
        approvalTtlSeconds?: number;
      }) => {
        sessionLog.info(`Permission request for session ${managed.id}:`, request.command)
        let brokerMetadata: {
          commandHash?: string
          approvalTtlSeconds?: number
        } = {}

        if (request.type === 'admin_approval' && request.command) {
          const brokerRequest = this.privilegedExecutionBroker.createRequest({
            requestId: request.requestId,
            sessionId: managed.id,
            command: request.command,
            reason: request.reason,
            impact: request.impact,
            approvalTtlSeconds: request.approvalTtlSeconds,
          })

          brokerMetadata = {
            commandHash: brokerRequest.commandHash,
            approvalTtlSeconds: brokerRequest.approvalTtlSeconds,
          }
        }

        const effectiveCommandHash = brokerMetadata.commandHash ?? request.commandHash

        this.pendingPermissionRequests.set(request.requestId, {
          sessionId: managed.id,
          type: request.type,
          commandHash: effectiveCommandHash,
        })

        if (request.type === 'admin_approval' && effectiveCommandHash && this.hasActiveAdminRememberApproval(managed.id, effectiveCommandHash)) {
          const brokerResult = this.privilegedExecutionBroker.resolveApproval(request.requestId, true, {
            expectedCommandHash: effectiveCommandHash,
          })

          this.pendingPermissionRequests.delete(request.requestId)

          if (brokerResult.ok) {
            this.privilegedExecutionBroker.auditEvent('privileged_auto_approved_remember_window', {
              sessionId: managed.id,
              requestId: request.requestId,
              commandHash: effectiveCommandHash,
            })
            const liveAgent = managed.agent
            if (liveAgent) {
              liveAgent.respondToPermission(request.requestId, true, false)
              return
            }
          }

          sessionLog.warn(`Remember-window auto-approval skipped for ${request.requestId}: ${brokerResult.reason}`)
        }

        this.sendEvent({
          type: 'permission_request',
          sessionId: managed.id,
          request: {
            ...request,
            ...brokerMetadata,
            sessionId: managed.id,
          }
        }, managed.workspace.id)
      }

      // Note: Credential requests now flow through onAuthRequest (unified auth flow)
      // The legacy onCredentialRequest callback has been removed from CraftAgent
      // Auth refresh for mid-session token expiry is handled by the error handler in sendMessage
      // which destroys/recreates the agent to get fresh credentials

      // Set up mode change handlers
      managed.agent.onPermissionModeChange = (mode) => {
        if (managed.permissionMode === mode) {
          return
        }

        managed.permissionMode = mode
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        managed.previousPermissionMode = diagnostics.previousPermissionMode
        sessionLog.info('Permission mode changed (agent callback)', {
          sessionId: managed.id,
          permissionMode: mode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
        this.sendEvent({
          type: 'permission_mode_changed',
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
          previousPermissionMode: diagnostics.previousPermissionMode,
          transitionDisplay: diagnostics.transitionDisplay,
        }, managed.workspace.id)
      }

      // Wire up plan review as Host control flow. The plan artifact itself is
      // projected by Pi; this compatibility event is only for external
      // messaging consumers and never enters the Craft transcript.
      managed.agent.onPlanSubmitted = async (planPath) => {
        sessionLog.info(`Plan submitted for session ${managed.id}:`, planPath)
        let planContent = ''
        try {
          planContent = await readFile(planPath, 'utf-8')
        } catch (error) {
          sessionLog.error(`Failed to read plan file:`, error)
        }

        const planMessage = {
          id: `plan-${managed.id}-${Date.now()}`,
          role: 'plan' as const,
          content: planContent,
          timestamp: this.monotonic(),
          planPath,
        }
        managed.lastMessageRole = 'plan'
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

      // Wire up onAuthRequest to add auth message to conversation and pause execution
      managed.agent.onAuthRequest = (request) => {
        sessionLog.info(`Auth request for session ${managed.id}:`, request.type, request.sourceSlug)

        // Store pending auth request for later resolution
        managed.pendingAuthRequestId = request.requestId
        managed.pendingAuthRequest = request

        managed.agent?.projectAuthPromptRequest?.({
          requestId: request.requestId,
          authType: request.type,
          sourceSlug: request.sourceSlug,
          sourceName: request.sourceName,
          ...(request.type === 'credential' ? {
            mode: request.mode,
            labels: request.labels,
            headerNames: request.headerNames,
            passwordRequired: request.passwordRequired,
          } : {}),
          ...('service' in request && typeof request.service === 'string' ? { service: request.service } : {}),
        })

        // Interrupt execution
        if (managed.isProcessing && managed.agent) {
          sessionLog.info(`Interrupting for auth request in session ${managed.id}`)
          managed.agent.interruptForHandoff(AbortReason.AuthRequest)
          this.setProcessing(managed, false)

          // Release browser overlay + session binding because the agent is paused awaiting user auth.
          void releaseBrowserOwnershipOnForcedStop(
            (sid) => this.getBrowserPaneManagerForSession(sid),
            managed.id,
          )

          // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
          this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage }, managed.workspace.id)
        }

        // Persist session state
        this.persistSession(managed)

        // OAuth flow is client-driven via performOAuth() (preload).
        // The UI calls window.electronAPI.performOAuth() when user clicks "Sign in".
      }

      // Wire up onSpawnSession. When the backend exposes spawnChildSession
      // (PiAgent), delegate to pi's session tree as a thin wrapper — pi creates
      // the child session file (header + spawnedFrom + spawnConfig + optional
      // initial prompt/name) and craft no longer instantiates its own
      // SessionManager or writes session files. The SubagentPanel lists these
      // children via listChildSessions(spawnedFrom filter).
      // Backends without spawnChildSession are unsupported — onSpawnSession throws.
      managed.agent.onSpawnSession = async (request) => {
        sessionLog.info(`Spawn session request from session ${managed.id}:`, request.name || '(unnamed)')

        // Thin-wrapper path: delegate to pi's session tree.
        const agent = managed.agent
        if (!agent || !agent.spawnChildSession) {
          throw new Error('spawnChildSession not supported by current agent backend')
        }

        const parentSessionId = agent.getSessionId()
        if (!parentSessionId) {
          throw new Error('Cannot spawn child session: parent pi session ID is not available yet')
        }

        const result = await agent.spawnChildSession(parentSessionId, {
          prompt: request.prompt,
          connection: request.provider,
          model: request.model,
          enabledSources: request.enabledSourceSlugs,
          permissionMode: request.permissionMode,
          thinkingLevel: request.thinkingLevel,
          labels: request.labels,
          name: request.name,
          workingDirectory: managed.workspace.rootPath,
          attachments: request.attachments,
        })

        sessionLog.info(
          `Spawned child session in pi tree: parent=${parentSessionId} child=${result.sessionId} path=${result.sessionPath}`,
        )

        return {
          sessionId: result.sessionId,
          name: request.name || result.sessionId,
          status: 'started' as const,
          connection: request.provider ?? managed.provider,
          model: request.model ?? managed.model,
        }
      }

      // Wire up session self-management tools (set_session_labels, set_session_status, etc.)
      mergeSessionScopedToolCallbacks(managed.id, {
        setSessionLabelsFn: async (sessionId: string | undefined, labels: string[]) => {
          await this.setSessionLabels(sessionId ?? managed.id, labels)
        },
        setSessionStatusFn: async (sessionId: string | undefined, status: string) => {
          await this.setSessionStatus(sessionId ?? managed.id, status as SessionStatus)
        },
        getSessionInfoFn: (sessionId?: string) => {
          const targetId = sessionId ?? managed.id
          const session = this.sessions.get(targetId)
          if (!session) return null
          return {
            id: session.id,
            name: session.name ?? session.id,
            labels: session.labels ?? [],
            status: session.sessionStatus ?? 'todo',
            permissionMode: session.permissionMode ?? 'ask',
            createdAt: session.createdAt ?? 0,
            workingDirectory: session.workingDirectory,
            provider: session.provider,
            model: session.model,
            isActive: session.agent != null,
          }
        },
        listSessionsFn: (options) => {
          const DEFAULT_LIMIT = 20
          const MAX_LIMIT = 100
          const limit = Math.min(options?.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
          const offset = options?.offset ?? 0

          let sessions = this.getSessions(managed.workspace.id)

          // Filter
          if (options?.status) {
            sessions = sessions.filter(s => s.sessionStatus === options.status)
          }
          if (options?.label) {
            sessions = sessions.filter(s => s.labels?.includes(options.label!))
          }
          if (options?.search) {
            const needle = options.search.toLowerCase()
            sessions = sessions.filter(s => s.name?.toLowerCase().includes(needle))
          }

          // Sort
          const sortBy = options?.sortBy ?? 'recent'
          if (sortBy === 'recent') {
            sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
          } else if (sortBy === 'name') {
            sessions.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
          } else if (sortBy === 'status') {
            sessions.sort((a, b) => (a.sessionStatus ?? '').localeCompare(b.sessionStatus ?? ''))
          }

          const total = sessions.length

          // Paginate
          const page = sessions.slice(offset, offset + limit)

          return {
            total,
            returned: page.length,
            sessions: page.map(s => ({
              id: s.id,
              name: s.name ?? s.id,
              labels: s.labels ?? [],
              status: s.sessionStatus ?? 'todo',
              createdAt: s.createdAt ?? 0,
            })),
          }
        },
        resolveLabelsFn: (labels: string[]) => {
          const labelConfig = loadLabelConfig(managed.workspace.rootPath)
          return resolveSessionLabels(labels, labelConfig.labels)
        },
        resolveStatusFn: (status: string) => {
          const statusConfig = loadStatusConfig(managed.workspace.rootPath)
          const allStatuses = statusConfig.statuses
          const available = allStatuses.map(s => s.id)

          // Exact ID match
          const byId = allStatuses.find(s => s.id === status)
          if (byId) return { resolved: byId.id, available }
          // Case-insensitive label → ID
          const byLabel = allStatuses.find(s => s.label.toLowerCase() === status.toLowerCase())
          if (byLabel) return { resolved: byLabel.id, available }

          return { resolved: null, available }
        },
        sendAgentMessageFn: async (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => {
          // Build FileAttachment[] from paths (same pattern as spawn_session)
          let fileAttachments: FileAttachment[] | undefined
          if (attachments?.length) {
            const builtAttachments: FileAttachment[] = []
            for (const a of attachments) {
              try {
                const extraDirs = getWorkspaceAllowedDirs(managed.workspace.id)
                const safePath = await validateFilePath(a.path, extraDirs)
                const attachment = readFileAttachment(safePath)
                if (attachment) {
                  if (a.name) attachment.name = a.name
                  builtAttachments.push(attachment)
                }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                sessionLog.warn(`send_agent_message: blocked attachment path ${a.path}: ${msg}`)
              }
            }
            if (builtAttachments.length > 0) fileAttachments = builtAttachments
          }

          await this.sendMessage(sessionId, message, fileAttachments)
        },
        activateSourceInSessionFn: async (sourceSlug: string) => {
          const cb = managed.agent?.onSourceActivationRequest
          if (!cb) {
            return { ok: false, reason: 'Agent has no activation callback wired' }
          }
          const ok = await cb(sourceSlug)
          if (!ok) {
            return {
              ok: false,
              reason: 'Activation failed — source may be unusable (disabled/unauthenticated) or server build failed. Check session logs.',
            }
          }
          // The current turn must end before new tools are visible:
          // Pi picks up new proxy tool defs on the next handlePrompt
          // (`toolsChanged` flag in Pi RpcClient).
          // Mark a pending restart on the agent — PiAgent consumes it after
          // the next tool_result, yield source_activated, and forceAbort. The
          // `source_activated` handler in this class then schedules a server-side
          // resend of the original user message with a "[{slug} activated]" suffix —
          // landing in a fresh turn with tools live (craft-agents-oss#804).
          const userMessage = managed.agent?.getCurrentTurnUserMessage?.() ?? ''
          if (userMessage) {
            managed.agent?.setPendingSourceActivationRestart({ sourceSlug, userMessage })
          }
          return { ok: true, availability: 'next-turn' as const }
        },
      })

      // Wire up onSourceActivationRequest to auto-enable sources when agent tries to use them
      managed.agent.onSourceActivationRequest = async (sourceSlug: string): Promise<boolean> => {
        sessionLog.info(`Source activation request for session ${managed.id}:`, sourceSlug)

        const workspaceRootPath = managed.workspace.rootPath

        // Check if source is already enabled
        if (managed.enabledSourceSlugs?.includes(sourceSlug)) {
          sessionLog.info(`Source ${sourceSlug} already in enabledSourceSlugs, checking server status`)
          // Source is in the list but server might not be active (e.g., build failed previously)
        }

        // Load the source to check if it exists and is ready
        const sources = getSourcesBySlugs(workspaceRootPath, [sourceSlug])
        if (sources.length === 0) {
          sessionLog.warn(`Source ${sourceSlug} not found in workspace`)
          return false
        }

        const source = sources[0]

        // Check if source is usable (enabled and authenticated if auth is required)
        if (!isSourceUsable(source)) {
          sessionLog.warn(`Source ${sourceSlug} is not usable (disabled or requires authentication)`)
          return false
        }

        // Track whether we added this slug (for rollback on failure)
        const slugSet = new Set(managed.enabledSourceSlugs || [])
        const wasAlreadyEnabled = slugSet.has(sourceSlug)

        // Add to enabled sources if not already there
        if (!wasAlreadyEnabled) {
          slugSet.add(sourceSlug)
          managed.enabledSourceSlugs = Array.from(slugSet)
          sessionLog.info(`Added source ${sourceSlug} to session enabled sources`)
        }

        // Build server configs for all enabled sources
        const allEnabledSources = getSourcesBySlugs(workspaceRootPath, managed.enabledSourceSlugs || [])
        // Pass session path so large API responses can be saved to session folder
        const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
        const { mcpServers, apiServers, errors } = await buildServersFromSources(allEnabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())

        if (errors.length > 0) {
          sessionLog.warn(`Source build errors during auto-enable:`, errors)
        }

        // Check if our target source was built successfully
        const sourceBuilt = sourceSlug in mcpServers || sourceSlug in apiServers
        if (!sourceBuilt) {
          sessionLog.warn(`Source ${sourceSlug} failed to build`)
          // Only remove if WE added it (not if it was already there)
          if (!wasAlreadyEnabled) {
            slugSet.delete(sourceSlug)
            managed.enabledSourceSlugs = Array.from(slugSet)
          }
          return false
        }

        // Apply source servers to the agent
        const intendedSlugs = allEnabledSources
          .filter(isSourceUsable)
          .map(s => s.config.slug)

        // Update bridge-mcp-server config/credentials for backends that need it
        await applyBridgeUpdates(managed.agent!, sessionPath, allEnabledSources, mcpServers, managed.id, workspaceRootPath, 'source enable', managed.poolServer?.url)

        await managed.agent!.setSourceServers(mcpServers, apiServers, intendedSlugs)

        sessionLog.info(`Auto-enabled source ${sourceSlug} for session ${managed.id}`)

        // Persist session with updated enabled sources
        this.persistSession(managed)

        // Notify renderer of source change
        this.sendEvent({
          type: 'sources_changed',
          sessionId: managed.id,
          enabledSourceSlugs: managed.enabledSourceSlugs || [],
        }, managed.workspace.id)

        return true
      }

      // NOTE: Source reloading is now handled by ConfigWatcher callbacks
      // which detect filesystem changes and update all affected sessions.
      // See setupConfigWatcher() for the full reload logic.

      // Apply session-scoped permission mode to the newly created agent
      // This ensures the UI toggle state is reflected in the agent before first message
      if (managed.permissionMode) {
        setPermissionMode(managed.id, managed.permissionMode, { changedBy: 'restore' })
        if (managed.previousPermissionMode) {
          hydratePreviousPermissionMode(managed.id, managed.previousPermissionMode)
        }
        managed.agent!.setPermissionMode(managed.permissionMode)
        const diagnostics = getPermissionModeDiagnostics(managed.id)
        sessionLog.info('Applied permission mode to agent', {
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
          modeVersion: diagnostics.modeVersion,
          changedBy: diagnostics.lastChangedBy,
          changedAt: diagnostics.lastChangedAt,
        })
      }
      managed.backendRuntimeSignature = runtimeSignature
      managed.backendRestartSignature = restartSignature
      end()
    }
    return managed.agent
  }

  async flagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = true
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_flagged', sessionId }, managed.workspace.id)
    }
  }

  async unflagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = false
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unflagged', sessionId }, managed.workspace.id)
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = true
      managed.archivedAt = Date.now()
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_archived', sessionId }, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = false
      managed.archivedAt = undefined
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unarchived', sessionId }, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  async setSessionStatus(sessionId: string, sessionStatus: SessionStatus): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.sessionStatus = sessionStatus
      this.setMetadataWriteGuard(managed)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus }, managed.workspace.id)
    }
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
   * Clear per-session overrides for a provider that was deleted from Pi global
   * config. The next resolution inherits the workspace/global default instead
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
   * Set pending plan execution state.
   * Called when user clicks "Accept & Compact" to persist the plan path
   * so execution can resume after compaction (even if page reloads).
   */
  async setPendingPlanExecution(sessionId: string, target: string | { planPath?: string; artifactId?: string }, draftInputSnapshot?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await setStoredPendingPlanExecution(managed.workspace.rootPath, sessionId, target, draftInputSnapshot)
      sessionLog.info('Session pending plan execution set', { sessionId, target })
    }
  }

  /**
   * Mark compaction as complete for pending plan execution.
   * Called when compaction_complete event fires - allows reload recovery
   * to know that compaction finished and plan can be executed.
   */
  async markCompactionComplete(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: compaction marked complete for pending plan`)
    }
  }

  /**
   * Mark pending plan execution as already dispatched from the UI.
   * This prevents reload recovery from double-submitting the same plan if
   * sending succeeded but cleanup failed due a reconnect/disconnect.
   */
  async markPendingPlanExecutionDispatched(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredPendingPlanExecutionDispatched(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: marked pending plan execution as dispatched`)
    }
  }

  /**
   * Clear pending plan execution state.
   * Called after plan execution is triggered, on new user message,
   * or when the pending execution is no longer relevant.
   */
  async clearPendingPlanExecution(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: cleared pending plan execution`)
    }
  }

  /**
   * Get pending plan execution state for a session.
   * Used on reload/init to check if we need to resume plan execution.
   */
  getPendingPlanExecution(sessionId: string): { planPath?: string; artifactId?: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
  }

  /**
   * Dispatch a plan approval for a session, equivalent to the desktop
   * "Accept plan" button. Switches the session out of Explore mode (safe)
   * into allow-all if needed so the plan can execute without per-tool
   * prompts, then sends the approval message through the normal sendMessage
   * path.
   */
  async acceptPlan(sessionId: string, _planPath?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`acceptPlan: session ${sessionId} not found`)
      return
    }

    if (managed.permissionMode === 'safe') {
      this.setSessionPermissionMode(sessionId, 'allow-all')
    }

    await this.sendMessage(sessionId, PLAN_APPROVAL_MESSAGE)
  }

  // ============================================
  // Session Sources
  // ============================================

  /**
   * Update session's enabled sources
   * If agent exists, builds and applies servers immediately.
   * Otherwise, servers will be built fresh on next message.
   */
  async setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Setting sources for session ${sessionId}:`, sourceSlugs)

    // Clean up credential cache for sources being disabled (security)
    // This removes decrypted tokens from disk when sources are no longer active
    const previousSlugs = new Set(managed.enabledSourceSlugs || [])
    const newSlugs = new Set(sourceSlugs)
    const disabledSlugs = [...previousSlugs].filter(prevSlug => !newSlugs.has(prevSlug))
    if (disabledSlugs.length > 0) {
      try {
        await cleanupSourceRuntimeArtifacts(workspaceRootPath, disabledSlugs)
      } catch (err) {
        sessionLog.warn(`Failed to clean up source runtime artifacts: ${err}`)
      }
    }

    // Store the selection
    managed.enabledSourceSlugs = sourceSlugs

    // If agent exists, build and apply servers immediately
    if (managed.agent) {
      const sources = getSourcesBySlugs(workspaceRootPath, sourceSlugs)
      // Pass session path so large API responses can be saved to session folder
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, managed.agent.getSummarizeCallback())
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      // Set all sources for context (agent sees full list with descriptions, including built-ins)
      const allSources = loadAllSources(workspaceRootPath)
      managed.agent.setAllSources(allSources)

      // Set active source servers (tools are only available from these)
      const intendedSlugs = sources.filter(isSourceUsable).map(s => s.config.slug)

      // Update bridge-mcp-server config/credentials for backends that need it
      const usableSources = sources.filter(isSourceUsable)
      await applyBridgeUpdates(managed.agent, sessionPath, usableSources, mcpServers, managed.id, workspaceRootPath, 'source config change', managed.poolServer?.url)

      await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

      sessionLog.info(`Applied ${Object.keys(mcpServers).length} MCP + ${Object.keys(apiServers).length} API sources to active agent (${allSources.length} total)`)
    }

    // Persist the session with updated sources
    this.persistSession(managed)

    // Notify renderer of the source change
    this.sendEvent({
      type: 'sources_changed',
      sessionId,
      enabledSourceSlugs: sourceSlugs,
    }, managed.workspace.id)

    sessionLog.info(`Session ${sessionId} sources updated: ${sourceSlugs.length} sources`)
  }

  /**
   * Get the enabled source slugs for a session
   */
  getSessionSources(sessionId: string): string[] {
    const managed = this.sessions.get(sessionId)
    return managed?.enabledSourceSlugs ?? []
  }

  /**
   * Resolve a Craft-owned annotation overlay by Pi message identity. Runtime
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
  async markSessionRead(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    // Only mark as read if not currently processing
    // (user is viewing but we want to wait for processing to complete)
    if (managed.isProcessing) return

    let needsPersist = false
    const updates: { lastReadMessageId?: string; hasUnread?: boolean } = {}

    // Projection is authoritative for transcript identity; Craft only stores
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
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, updates)
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
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, { hasUnread: true, lastReadMessageId: undefined })
      this.emitUnreadSummaryChanged()
    }
  }

  /**
   * Mark all non-hidden, non-archived sessions in a workspace as read.
   * Called from "Mark All Read" context menu on "All Sessions".
   */
  async markAllSessionsRead(workspaceId: string): Promise<void> {
    const updates: Promise<void>[] = []
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.hidden || managed.isArchived) continue
      if (managed.isProcessing) continue
      if (!managed.hasUnread) continue
      managed.hasUnread = false
      updates.push(
        updateSessionMetadata(managed.workspace.rootPath, managed.id, { hasUnread: false })
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
            craftId: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
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
   * Compatibility handler for the legacy "change working directory" command.
   *
   * cwd is now workspace identity. To work from another folder, the caller must
   * switch to or create a workspace rooted at that folder.
   */
  updateWorkingDirectory(sessionId: string, path: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      if (path === managed.workspace.rootPath) {
        managed.workingDirectory = managed.workspace.rootPath
        managed.sdkCwd = managed.sdkCwd ?? managed.workspace.rootPath
        this.sendEvent({ type: 'working_directory_changed', sessionId, workingDirectory: managed.workspace.rootPath }, managed.workspace.id)
        return
      }

      const validation = isValidWorkingDirectory(path)
      if (!validation.valid) {
        sessionLog.warn(`Session ${sessionId}: rejected working directory "${path}" — ${validation.reason}`)
        this.sendEvent({
          type: 'working_directory_error',
          sessionId,
          error: validation.reason!,
        }, managed.workspace.id)
        return
      }

      sessionLog.warn(`Session ${sessionId}: rejected working directory change to "${path}" because cwd is workspace identity`)
      this.sendEvent({
        type: 'working_directory_error',
        sessionId,
        error: 'Working directory is the workspace root. Create or switch to a workspace rooted at this folder instead.',
      }, managed.workspace.id)
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
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, updates)
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
        // Fallback chain: session model > workspace default > provider default
        const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
        const sessionConn = resolveSessionProvider(managed.provider, wsConfig?.defaults?.provider)
        const effectiveModel = model ?? wsConfig?.defaults?.model ?? sessionConn?.provider.models?.[0]?.id
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

  async deleteSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot delete session: ${sessionId} not found`)
      return
    }

    // Get workspace slug before deleting
    const workspaceRootPath = managed.workspace.rootPath

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
        const { VIEWER_URL } = await import('@craft-agent/shared/branding')
        const response = await fetch(
          `${VIEWER_URL}/s/api/${managed.sharedId}`,
          { method: 'DELETE', signal: AbortSignal.timeout(5000) }
        )
        if (!response.ok) {
          sessionLog.warn(`Failed to revoke share for ${sessionId}: HTTP ${response.status}`)
        } else {
          sessionLog.info(`Revoked share for deleted session ${sessionId}`)
        }
      } catch (error) {
        sessionLog.warn(`Failed to revoke share for ${sessionId}:`, error)
      }
    }

    this.clearAdminRememberApprovalsForSession(sessionId)
    this.clearPendingPermissionRequestsForSession(sessionId)

    // Cancel pending/in-flight persistence before deleting files so a late
    // metadata write cannot recreate the session after deletion.
    await sessionPersistenceQueue.cancel(sessionId, { preventFutureEnqueue: true })

    // Destroy browser instances bound to this session
    const sessionBpm = this.getBrowserPaneManagerForSession(sessionId)
    if (sessionBpm) {
      sessionBpm.destroyForSession(sessionId)
    }
    // Drop the per-session remote bridge + host-client pin on destroy.
    this.remoteBpms.delete(sessionId)
    this.browserHostByCanvas.delete(sessionId)

    // Dispose agent, pool server, MCP pool, and session-scoped callbacks via
    // the same runtime teardown path used for config-driven restarts.
    await this.disposeManagedAgentRuntime(managed, 'session deleted')
    await this.flushPiProjectionWrites(managed)

    // Cancel any pending source-activation auto-retry timer (craft-agents-oss#804).
    if (managed.autoRetryTimer) {
      clearTimeout(managed.autoRetryTimer)
      managed.autoRetryTimer = undefined
    }
    managed.autoRetryPending = undefined

    this.sessions.delete(sessionId)
    this.piProjectionBySession.delete(sessionId)
    this.piProjectionRetiredRuntimeIds.delete(sessionId)
    this.piProjectionWrites.delete(sessionId)
    this.piProjectionPendingSnapshots.delete(sessionId)

    // Clean up session metadata in AutomationSystem (prevents memory leak)
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.removeSessionMetadata(sessionId)
    }

    // Delete from disk too
    await deleteStoredSession(workspaceRootPath, sessionId)

    // Notify all windows for this workspace that the session was deleted
    this.sendEvent({ type: 'session_deleted', sessionId }, managed.workspace.id)
    this.emitUnreadSummaryChanged()

    // Clean up attachments directory (handled by deleteStoredSession for workspace-scoped storage)
    sessionLog.info(`Deleted session ${sessionId}`)
  }

  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    /**
     * Internal hook fired after the user message identity and any Craft-owned
     * attachment/badge overlay have been durably accepted, but before model
     * streaming begins. The RPC handler uses this to send a synchronous ack;
     * pre-acceptance errors still reject the outer promise.
     */
    onAck?: (messageId: string) => void,
    /**
     * Optional transport context. The `sessions.sendMessage` RPC handler passes
     * `{ callerClientId: ctx.clientId }` so the SM can pin the desktop client
     * that should host this session's browser tools. Pass undefined when calling
     * directly (tests, intra-server flows) to leave the existing pin in place.
     */
    rpcContext?: { callerClientId?: string },
    /**
     * Internal queue replay guard. processNextQueuedMessage pre-claims
     * isProcessing before scheduling replay so newer RPCs queue behind it.
     */
    isQueuedReplay = false,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
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

    // Source-activation auto-retry dedup (craft-agents-oss#804). When the server
    // has just scheduled or committed a "[<slug> activated]" retry, drop a matching
    // duplicate that arrives from a legacy renderer still running the client-side
    // auto_retry. The first matching caller wins (server timer or legacy RPC,
    // whichever arrives first), subsequent matching calls within the deadline drop.
    if (claimAutoRetryPending(managed, message) === 'drop') {
      sessionLog.info(`sendMessage: dropped duplicate source-activation retry for ${sessionId}`)
      return
    }

    // Clear any pending plan execution state when a new user message is sent.
    // This acts as a safety valve - if the user moves on, we don't want to
    // auto-execute an old plan later.
    await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)

    // Ensure messages are loaded before we try to add new ones
    await this.ensureMessagesLoaded(managed)

    // Mid-stream delivery uses the configured Enter behavior. Ctrl/Cmd+Enter
    // selects the opposite behavior, so both actions are always available and
    // changing the setting swaps their shortcuts.
    //
    // - 'steer': try to deliver into the in-flight turn. Pi steers natively;
    //   Claude emulates via PreToolUse hook. If `redirect()` returns false
    //   (Claude with no live query, or backend can't steer), the backend has
    //   already called forceAbort(Redirect) and we queue for replay.
    // - 'queue': hold the message untouched; the current turn keeps running
    //   to natural completion; replay as a new turn afterwards. NO call to
    //   `agent.redirect()`, NO forceAbort, NO interruption.
    if (managed.isProcessing && !isQueuedReplay) {
      const configuredBehavior = getMidStreamBehavior()
      const behavior = options?.midStreamSendIntent === 'alternate'
        ? alternateMidStreamBehavior(configuredBehavior)
        : configuredBehavior

      const agent = managed.agent
      const messageId = options?.optimisticMessageId ?? generateMessageId()
      let steered = false
      if (behavior === 'steer') {
        steered = agent?.redirect(message, messageId) ?? false
      }
      // For 'queue': skip redirect entirely. The current turn is undisturbed.

      sessionLog.info('mid-stream send', {
        sessionId,
        behavior,
        sendIntent: options?.midStreamSendIntent ?? 'default',
        steered,
        queueLengthBefore: managed.messageQueue.length,
        backend: agent ? agent.constructor.name : 'none',
        provider: managed.provider,
      })

      managed.lastMessageRole = 'user'
      this.upsertUserMessageOverlay(
        managed,
        messageId,
        storedAttachments,
        options?.badges,
        !steered,
      )
      this.persistSession(managed)
      await this.flushSession(managed.id)

      if (!steered) {
        const overlayTimestamp = managed.messages.find(item => item.id === messageId)?.timestamp
        managed.agent?.projectQueuedUser?.({
          message,
          clientMutationId: options?.optimisticMessageId ?? messageId,
          messageId,
          timestamp: overlayTimestamp,
          attachments: storedAttachments?.map(attachment => ({
            id: attachment.id,
            name: attachment.name,
            mediaType: attachment.mimeType,
            size: attachment.size,
          })),
        })
        await this.piProjectionWrites.get(managed.id)
        // Push for FIFO replay on next onProcessingStopped tick. Same shape
        // for both queue-direct (current turn still running) and
        // queue-after-abort (backend already aborted) — the replay path in
        // processNextQueuedMessage is identical.
        const queuedOptions = {
          ...(options ?? {}),
          optimisticMessageId: options?.optimisticMessageId ?? messageId,
        }
        managed.messageQueue.push({
          message,
          attachments,
          storedAttachments,
          options: queuedOptions,
          messageId,
          optimisticMessageId: queuedOptions.optimisticMessageId,
        })
        managed.wasInterrupted = true
      }

      onAck?.(messageId)
      writeRuntimeLog('info', {
        scope: 'session',
        event: 'send_message.accepted',
        meta: {
          sessionId,
          workspaceId: managed.workspace.id,
          messageId,
          optimisticMessageId: options?.optimisticMessageId,
          status: steered ? 'accepted' : 'queued',
          provider: managed.provider,
          model: managed.model,
        },
      })
      return
    }

    // Pi owns the canonical user message. Craft only records the UI overlay
    // needed to reconcile optimistic queue/attachment state.
    const messageId = existingMessageId ?? options?.optimisticMessageId ?? generateMessageId()
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
    if (!existingMessageId) {
      onAck?.(messageId)
      writeRuntimeLog('info', {
        scope: 'session',
        event: 'send_message.accepted',
        meta: {
          sessionId,
          workspaceId: managed.workspace.id,
          messageId,
          optimisticMessageId: options?.optimisticMessageId,
          provider: managed.provider,
          model: managed.model,
        },
      })

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

        // Generate AI title asynchronously using agent's SDK
        // (waits briefly for agent creation if needed)
        this.generateTitle(managed, message)
      }
    }

    // Evaluate auto-label rules against the user message (common path for both
    // fresh and queued messages). Scans regex patterns configured on labels,
    // then merges any new matches into the session's label array.
    try {
      const labelTree = listLabels(managed.workspace.rootPath)
      const autoMatches = evaluateAutoLabels(message, labelTree)

      if (autoMatches.length > 0) {
        const existingLabels = managed.labels ?? []
        const newEntries = autoMatches
          .map(m => `${m.labelId}::${m.value}`)
          .filter(entry => !existingLabels.includes(entry))

        if (newEntries.length > 0) {
          managed.labels = [...existingLabels, ...newEntries]
          this.persistSession(managed)
          this.sendEvent({
            type: 'labels_changed',
            sessionId,
            labels: managed.labels,
          }, managed.workspace.id)
        }
      }
    } catch (e) {
      sessionLog.warn(`Auto-label evaluation failed for session ${sessionId}:`, e)
    }

    managed.lastMessageAt = Date.now()
    this.setProcessing(managed, true)
    managed.streamingText = ''
    managed.processingGeneration++
    managed.turnStartFinalMessageId = managed.lastFinalMessageId

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

    // Capture the generation to detect if a new request supersedes this one.
    // This prevents the finally block from clobbering state when a follow-up message arrives.
    const myGeneration = managed.processingGeneration

    // Pre-enable sources required by invoked skills (Issue #249)
    // This eliminates the two-turn penalty where the agent discovers missing sources at runtime.
    // Uses targeted loadSkillBySlug() instead of loadAllSkills() to avoid O(N) filesystem scans.
    if (options?.skillSlugs?.length) {
      try {
        const workspaceRoot = managed.workspace.rootPath

        const requiredSources = new Set<string>()
        for (const slug of options.skillSlugs) {
          const skill = loadSkillBySlug(workspaceRoot, slug, workspaceRoot)
          if (skill?.metadata.requiredSources) {
            for (const src of skill.metadata.requiredSources) {
              requiredSources.add(src)
            }
          }
        }

        if (requiredSources.size > 0) {
          const currentSlugs = new Set(managed.enabledSourceSlugs || [])
          const toEnable: string[] = []
          const skipped: string[] = []
          const candidateSlugs = Array.from(requiredSources)
          const loadedSources = getSourcesBySlugs(workspaceRoot, candidateSlugs)
          const usableSources = new Set(
            loadedSources
              .filter(isSourceUsable)
              .map(source => source.config.slug)
          )

          for (const srcSlug of candidateSlugs) {
            if (currentSlugs.has(srcSlug)) continue
            if (usableSources.has(srcSlug)) {
              toEnable.push(srcSlug)
            } else {
              skipped.push(srcSlug)
            }
          }

          if (skipped.length > 0) {
            sessionLog.warn(`Skill requires sources that are not usable (missing or unauthenticated): ${skipped.join(', ')}`)
          }

          if (toEnable.length > 0) {
            managed.enabledSourceSlugs = [...(managed.enabledSourceSlugs || []), ...toEnable]
            sessionLog.info(`Pre-enabled sources for skill invocation: ${toEnable.join(', ')}`)
            this.persistSession(managed)
            this.sendEvent({
              type: 'sources_changed',
              sessionId,
              enabledSourceSlugs: managed.enabledSourceSlugs,
            }, managed.workspace.id)
          }
        }
      } catch (e) {
        sessionLog.warn(`Failed to pre-enable skill sources for session ${sessionId}:`, e)
      }
    }

    // Start perf span for entire sendMessage flow
    const sendSpan = perf.span('session.sendMessage', { sessionId })

    try {
      const workspaceRootPath = managed.workspace.rootPath
      const enabledSlugs = managed.enabledSourceSlugs ?? []
      const hasSources = enabledSlugs.length > 0

      // Load enabled sources up-front so we can refresh tokens BEFORE getOrCreateAgent
      // runs its internal cold-session build. Otherwise that build sees stale tokens
      // and emits AUTH_REQUIRED, causing a brief "needs_auth" UI flicker before the
      // post-build refresh restores state (#710).
      const sources: LoadedSource[] = hasSources
        ? getSourcesBySlugs(workspaceRootPath, enabledSlugs)
        : []

      if (hasSources && managed.tokenRefreshManager) {
        const refreshResult = await refreshExpiredCredentials(sources, managed.tokenRefreshManager)
        if (refreshResult.failedSources.length > 0) {
          sessionLog.warn('[OAuth] Some sources failed token refresh:', refreshResult.failedSources.map(f => f.slug))
        }
        if (refreshResult.refreshedCount > 0) {
          sendSpan.mark('oauth.refreshed')
        }
      }

      // Get or create the agent (lazy loading). Its internal cold-session build at
      // ~L2956 now sees fresh tokens (or correctly-needs_auth failed sources, since
      // ensureFreshToken mirrors the disk write to source.config in-memory).
      const agent = await this.getOrCreateAgent(managed)
      sendSpan.mark('agent.ready')

      // Always set all sources for context (even if none are enabled), including built-ins
      const allSources = loadAllSources(workspaceRootPath)
      agent.setAllSources(allSources)
      sendSpan.mark('sources.loaded')

      // Apply source servers if any are enabled
      if (hasSources) {
        const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
        // Single fresh build — tokens already refreshed above.
        const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, agent.getSummarizeCallback())
        if (errors.length > 0) {
          sessionLog.warn(`Source build errors:`, errors)
        }

        const mcpCount = Object.keys(mcpServers).length
        const apiCount = Object.keys(apiServers).length
        if (mcpCount > 0 || apiCount > 0 || enabledSlugs.length > 0) {
          const usableSources = sources.filter(isSourceUsable)
          const intendedSlugs = usableSources.map(s => s.config.slug)
          await agent.setSourceServers(mcpServers, apiServers, intendedSlugs)
          await applyBridgeUpdates(agent, sessionPath, usableSources, mcpServers, sessionId, workspaceRootPath, 'send message', managed.poolServer?.url)
          sessionLog.info(`Applied ${mcpCount} MCP + ${apiCount} API sources to session ${sessionId} (${allSources.length} total)`)
        }
        sendSpan.mark('servers.applied')
      }

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
      // in the rawText, and canUseTool in craft-agent.ts provides a fallback
      // to qualify short names. No transformation needed here.

      // Inject interruption context so the LLM knows the previous turn was cut short.
      // Uses <system-reminder> tags so the LLM treats it as transient system guidance
      // rather than part of the user's message content. The original message is stored
      // in session JSONL (line ~3952); this only affects the SDK's in-process context.
      let effectiveMessage = message
      if (managed.wasInterrupted) {
        effectiveMessage = `${message}\n\n<system-reminder>The previous assistant response was interrupted by the user and may be incomplete. Do not repeat or continue the interrupted response unless asked. Focus on the new message above.</system-reminder>`
        managed.wasInterrupted = false
      }

      const messageBackendContext = resolveBackendContext({
        sessionProvider: managed.provider,
        workspaceDefaultProvider: loadWorkspaceConfig(workspaceRootPath)?.defaults?.provider,
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
      const chatIterator = agent.chat(effectiveMessage, modelInputAttachments.attachments, {
        clientMutationId: messageId,
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

        // Process the event first
        await this.processEvent(managed, event)

        if (event.type === 'pi_user_message_persisted') {
          writeRuntimeLog('debug', {
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
          // Defensive fallback: Pi should emit pi_user_message_persisted after
          // SessionManager.appendMessage(user), but never leave the caller
          // hanging if an older subprocess misses that bridge event.
          // Skip normal completion handling if auth retry is in progress
          // The retry will handle its own completion
          if (managed.authRetryInProgress) {
            sessionLog.info('Chat completed but auth retry is in progress, skipping normal completion handling')
            sendSpan.mark('chat.complete.auth_retry_pending')
            sendSpan.end()
            return  // Exit function - retry will handle completion
          }

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
            const sessionErrorPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
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
          this.onProcessingStopped(sessionId, 'complete')
          return  // Exit function, skip finally block (onProcessingStopped handles cleanup)
        }

        // NOTE: We no longer break early on !isProcessing or stopRequested.
        // After soft interrupt (forceAbort), the backend sets turnComplete=true which causes
        // the generator to yield remaining queued events and then complete naturally.
        // This ensures we don't lose in-flight messages.
      }

      // Loop exited - either via complete event (normal) or generator ended after soft interrupt
      if (!managed.isProcessing) {
        sessionLog.info('Chat loop exited after explicit handoff/stop')
        sendSpan.mark('chat.exit.already_stopped')
        sendSpan.end()
      } else if (managed.stopRequested) {
        sessionLog.info('Chat loop completed after stop request - events drained successfully')
        this.onProcessingStopped(sessionId, 'interrupted')
      } else {
        sessionLog.info('Chat loop exited unexpectedly')
      }
    } catch (error) {
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
          this.onProcessingStopped(sessionId, 'interrupted')
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
            workspaceRootPath: managed.workspace.rootPath,
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
        this.onProcessingStopped(sessionId, 'error')
      }
    } finally {
      // Only handle cleanup for unexpected exits (loop break without complete event)
      // Normal completion returns early after calling onProcessingStopped
      // Errors are handled in catch block
      if (managed.isProcessing && managed.processingGeneration === myGeneration) {
        sessionLog.info('Finally block cleanup - unexpected exit')
        sendSpan.mark('chat.unexpected_exit')
        sendSpan.end()
        this.onProcessingStopped(sessionId, 'interrupted')
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

    // Clear queue - user explicitly stopped, don't process queued messages
    managed.messageQueue = []

    // Signal intent to stop - let the event loop drain remaining events before clearing isProcessing
    // This prevents losing in-flight messages after soft interrupt
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
        this.onProcessingStopped(sessionId, 'timeout')
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
    if (managed.authRetryAttempted || !managed.lastSentMessage) return false

    sessionLog.info(`Auth error detected, attempting token refresh and retry for session ${sessionId}`)
    managed.authRetryAttempted = true
    managed.authRetryInProgress = true

    // Emit lightweight info so the user sees progress instead of a scary red error
    this.sendEvent({
      type: 'info',
      sessionId,
      message: 'Token expired, refreshing session…',
      timestamp: this.monotonic(),
    }, workspaceId)

    setImmediate(async () => {
      try {
        // 1. Destroy the agent — the new agent's postInit() will refresh auth
        sessionLog.info(`[auth-retry] Destroying agent for session ${sessionId}`)
        managed.agent = null

        // 2. Retry the message
        const retryMessage = managed.lastSentMessage
        const retryAttachments = managed.lastSentAttachments
        const retryStoredAttachments = managed.lastSentStoredAttachments
        const retryOptions = managed.lastSentOptions

        if (retryMessage) {
          sessionLog.info(`[auth-retry] Retrying message for session ${sessionId}`)
          this.setProcessing(managed, false)

          managed.authRetryInProgress = false

          await this.sendMessage(
            sessionId,
            retryMessage,
            retryAttachments,
            retryStoredAttachments,
            retryOptions,
            undefined,  // existingMessageId
            true        // _isAuthRetry - prevents infinite retry loop
          )
          sessionLog.info(`[auth-retry] Retry completed for session ${sessionId}`)
        } else {
          managed.authRetryInProgress = false
        }
      } catch (retryError) {
        managed.authRetryInProgress = false
        sessionLog.error(`[auth-retry] Failed to retry after auth refresh for session ${sessionId}:`, retryError)
        sessionRuntimeHooks.captureException(retryError, { errorSource: 'auth-retry', sessionId })
        await this.projectHostRuntimeError(managed, {
          phase: 'recovery',
          message: 'Authentication failed. Please check your credentials.',
          code: failureErrorCode,
          retryable: true,
        })
        this.onProcessingStopped(sessionId, 'error')
      }
    })

    return true
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
    reason: 'complete' | 'interrupted' | 'error' | 'timeout'
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    sessionLog.info(`Processing stopped for session ${sessionId}: ${reason}`)

    // 1. Cleanup state
    this.setProcessing(managed, false)
    managed.replayingQueuedMessageId = undefined
    managed.stopRequested = false  // Reset for next turn

    const turnStartFinalMessageId = managed.turnStartFinalMessageId
    managed.turnStartFinalMessageId = undefined

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
        await this.markSessionRead(sessionId)
      } else {
        // User is not watching - mark as unread for NEW badge
        if (!managed.hasUnread) {
          managed.hasUnread = true
          await updateSessionMetadata(managed.workspace.rootPath, sessionId, { hasUnread: true })
          this.emitUnreadSummaryChanged()
        }
      }
    }

    // 3. Auto-complete mini agent sessions to avoid session list clutter
    //    Mini agents are spawned from EditPopovers for quick config edits
    //    and should automatically move to 'done' when finished
    if (reason === 'complete' && managed.systemPromptPreset === 'mini' && managed.sessionStatus !== 'done') {
      sessionLog.info(`Auto-completing mini agent session ${sessionId}`)
      await this.setSessionStatus(sessionId, 'done')
    }

    // 4. Apply deferred external metadata updates captured while processing.
    if (managed.pendingExternalMetadata) {
      const pendingHeader = managed.pendingExternalMetadata
      managed.pendingExternalMetadata = undefined
      sessionLog.info(`Applying deferred external metadata for session ${sessionId} after processing stop`)
      await this.applyExternalSessionMetadata(managed, pendingHeader)
    }

    // 5. Check queue and process or complete
    if (managed.messageQueue.length > 0) {
      // Has queued messages - process next
      this.processNextQueuedMessage(sessionId)
    } else {
      // Session is truly done — release browser ownership.
      // The window stays alive (hidden) and becomes reusable by future sessions.
      // On the next turn, getOrCreateForSession() will re-bind it.
      const doneBpm = this.getBrowserPaneManagerForSession(sessionId)
      if (doneBpm) {
        await doneBpm.clearVisualsForSession(sessionId)
        doneBpm.unbindAllForSession(sessionId)
      }

      // No queue - emit complete to UI (include tokenUsage and hasUnread for state updates)
      this.sendEvent({
        type: 'complete',
        sessionId,
        tokenUsage: managed.tokenUsage,
        hasUnread: managed.hasUnread,
      }, managed.workspace.id)
    }

    // 6. Always persist
    this.persistSession(managed)
  }

  /**
   * Process the next message in the queue.
   * Called by onProcessingStopped when queue has messages.
   */
  private processNextQueuedMessage(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.messageQueue.length === 0) return

    const next = managed.messageQueue.shift()!
    managed.replayingQueuedMessageId = next.messageId
    this.setProcessing(managed, true)
    sessionLog.info('replay queued', {
      sessionId,
      messageId: next.messageId,
      queueLengthAfterShift: managed.messageQueue.length,
    })

    // The projection builder resolves the queued user entity when Pi accepts it.

    // Process message (use setImmediate to allow current stack to clear)
    setImmediate(() => {
      this.sendMessage(
        sessionId,
        next.message,
        next.attachments,
        next.storedAttachments,
        next.options,
        next.messageId,
        undefined,
        undefined,
        undefined,
        true
      ).catch(async err => {
        sessionLog.error('replay failed', {
          sessionId,
          messageId: next.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
        // Report queued message failures via runtime hooks
        sessionRuntimeHooks.captureException(err, { errorSource: 'chat-queue', sessionId })
        // Surface a typed error so the UI can show a clear, actionable banner
        // instead of a generic "Unknown error" (#616).
        await this.projectHostRuntimeError(managed, {
          phase: 'queue',
          code: 'queued_message_replay_failed',
          message: err instanceof Error ? err.message : 'Queued message could not be sent',
          retryable: true,
        })
        // Call onProcessingStopped to handle cleanup and check for more queued messages
        this.onProcessingStopped(sessionId, 'error')
      })
    })
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

  /**
   * Respond to a pending permission request
   * Returns true if the response was delivered, false if agent/session is gone
   */
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('@craft-agent/shared/protocol').PermissionResponseOptions,
  ): boolean {
    const managed = this.sessions.get(sessionId)
    if (managed?.agent) {
      const requestMeta = this.pendingPermissionRequests.get(requestId)
      this.pendingPermissionRequests.delete(requestId)

      if (requestMeta?.type === 'admin_approval') {
        const brokerResult = this.privilegedExecutionBroker.resolveApproval(requestId, allowed, {
          expectedCommandHash: requestMeta.commandHash,
        })
        if (!brokerResult.ok) {
          sessionLog.warn(`Admin approval rejected by broker for ${requestId}: ${brokerResult.reason}`)
          // Broker rejection should fail closed.
          managed.agent.respondToPermission(requestId, false, false)
          return false
        }

        if (allowed && requestMeta.commandHash && options?.rememberForMinutes) {
          this.storeAdminRememberApproval(sessionId, requestMeta.commandHash, requestId, options.rememberForMinutes)
        }
      }

      sessionLog.info(`Permission response for ${requestId}: allowed=${allowed}, alwaysAllow=${alwaysAllow}`)
      managed.agent.respondToPermission(requestId, allowed, alwaysAllow)
      return true
    } else {
      sessionLog.warn(`Cannot respond to permission - no agent for session ${sessionId}`)
      return false
    }
  }

  /**
   * 回复 pi 扩展发起的 remoteui:request。
   * payload=null 表示用户取消，reason 通常为 "cancelled"。
   * 仅 Pi 后端支持；非 Pi 后端或会话已销毁时返回 false。
   */
  sendRemoteUIResponse(
    sessionId: string,
    requestId: string,
    payload: unknown | null,
    reason?: 'cancelled' | 'no_remote' | 'disconnected',
  ): boolean {
    const managed = this.sessions.get(sessionId)
    if (managed?.agent) {
      if (typeof managed.agent.sendRemoteUIResponse !== 'function') {
        sessionLog.warn(`Cannot respond to remoteui - agent does not support sendRemoteUIResponse for session ${sessionId}`)
        return false
      }
      sessionLog.info(`RemoteUI response for ${requestId}: cancelled=${payload === null}`)
      managed.agent.sendRemoteUIResponse(requestId, payload, reason)
      return true
    } else {
      sessionLog.warn(`Cannot respond to remoteui - no agent for session ${sessionId}`)
      return false
    }
  }

  /**
   * 调用 pi 扩展注册的命令（extension_command_invoke）。
   * 仅 Pi 后端实现（PiAgent.sendExtensionCommandInvoke）；其他后端返回 false。
   * 返回 false 时调用方应回退到原生路径。
   */
  async invokeExtensionCommand(sessionId: string, commandId: string, args?: string): Promise<import('@craft-agent/core/types').ExtensionCommandResult> {
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
      const result = await agent.sendExtensionCommandInvoke(commandId, args)
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
    if (!snapshot) return false
    const lifecycle = snapshot.entities
      .filter(entity => entity.kind === 'agent_start' || entity.kind === 'agent_end'
        || entity.kind === 'turn_start' || entity.kind === 'turn_end'
        || entity.kind === 'compaction_start' || entity.kind === 'compaction_end'
        || entity.kind === 'runtime_error')
      .sort((a, b) => b.lastSeq - a.lastSeq)[0]
    return lifecycle?.kind === 'agent_start'
      || lifecycle?.kind === 'turn_start'
      || lifecycle?.kind === 'compaction_start'
  }

  private closeStalePiProjection(sessionId: string): void {
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
      payload: { status: 'interrupted' },
    })
  }

  async reloadExtensions(): Promise<void> {
    const reloads: Promise<unknown>[] = []
    for (const managed of this.sessions.values()) {
      if (managed.agent && typeof managed.agent.reloadExtensions === 'function') {
        reloads.push(managed.agent.reloadExtensions())
      }
    }
    await Promise.allSettled(reloads)
  }

  /**
   * 查询当前会话已注册的 Pi 扩展 slash commands。
   */
  async listExtensionCommands(sessionId: string): Promise<import('@craft-agent/shared/agent').PiExtensionCommand[]> {
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
   * List child sessions in pi's session tree spawned from the given craft session.
   *
   * Delegates to the backend's listChildSessions (PiAgent) which queries pi's
   * SessionManager.list(cwd) and filters by header.spawnedFrom === piSessionId.
   * Used by the SubagentPanel to render the active branch set instead of the
   * legacy subagent-supervisor active-sessions.json.
   *
   * Returns an empty array when the backend doesn't support listChildSessions
   * or the pi session ID isn't available yet.
   */
  async listChildSessions(sessionId: string): Promise<import('@craft-agent/shared/agent').PiChildSessionInfo[]> {
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
    const parentSessionId = agent.getSessionId()
    if (!parentSessionId) {
      sessionLog.warn(`[listChildSessions] No pi session ID for session ${sessionId}`)
      return []
    }
    try {
      return await agent.listChildSessions(parentSessionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sessionLog.warn(`[listChildSessions] Failed for session ${sessionId}: ${message}`)
      return []
    }
  }

  /**
   * 查找 workspace 下首个活跃的 Pi 会话 ID（用于 extension 命令委托载体）。
   * 活跃 = agent 已加载且当前未在处理中。
   */
  private findActivePiSessionForWorkspace(workspaceRootPath: string): string | null {
    for (const [sessionId, managed] of this.sessions) {
      if (
        managed.workspace.rootPath === workspaceRootPath &&
        managed.agent &&
        !managed.isProcessing
      ) {
        return sessionId
      }
    }
    return null
  }

  /**
   * 保底路径：原生执行 prompt automation（从 onPromptsReady 逻辑提取）。
   * 当 delegatePromptAutomation 启用但扩展调用失败/无载体时使用。
   */
  private async executePromptsNative(
    workspaceId: string,
    workspaceRootPath: string,
    prompts: PendingPrompt[],
  ): Promise<void> {
    await Promise.allSettled(
      prompts.map((pending) =>
        this.executePromptAutomation({
          workspaceId,
          workspaceRootPath,
          prompt: pending.prompt,
          labels: pending.labels,
          permissionMode: pending.permissionMode,
          mentions: pending.mentions,
          provider: pending.provider,
          model: pending.model,
          thinkingLevel: pending.thinkingLevel,
          automationName: pending.automationName,
          telegramTopic: pending.telegramTopic,
        }),
      ),
    )
  }

  /**
   * Respond to a pending credential request
   * Returns true if the response was delivered, false if no pending request found
   *
   * Supports both:
   * - New unified auth flow (via handleCredentialInput)
   * - Legacy callback flow (via pendingCredentialResolvers)
   */
  async respondToCredential(sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse): Promise<boolean> {
    // First, check if this is a new unified auth flow request
    const managed = this.sessions.get(sessionId)
    if (managed?.pendingAuthRequest && managed.pendingAuthRequest.requestId === requestId) {
      sessionLog.info(`Credential response (unified flow) for ${requestId}: cancelled=${response.cancelled}`)
      await this.handleCredentialInput(sessionId, requestId, response)
      return true
    }

    // Fall back to legacy callback flow
    const resolver = this.pendingCredentialResolvers.get(requestId)
    if (resolver) {
      sessionLog.info(`Credential response (legacy flow) for ${requestId}: cancelled=${response.cancelled}`)
      resolver(response)
      this.pendingCredentialResolvers.delete(requestId)
      return true
    } else {
      sessionLog.warn(`Cannot respond to credential - no pending request for ${requestId}`)
      return false
    }
  }

  /**
   * Set the permission mode for a session ('safe', 'ask', 'allow-all')
   */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      const previousManagedMode = managed.permissionMode ?? 'ask'
      const diagnosticsBefore = getPermissionModeDiagnostics(sessionId)
      const previousEffectiveMode = diagnosticsBefore.permissionMode

      // No-op only when BOTH managed state and mode-manager state already match.
      // If managed state matches but diagnostics drifted, heal authoritative mode state.
      if (previousManagedMode === mode && previousEffectiveMode === mode) {
        return
      }

      if (previousManagedMode === mode && previousEffectiveMode !== mode) {
        sessionLog.warn('Permission mode drift detected on same-mode update; reconciling authoritative mode state', {
          sessionId,
          managedMode: previousManagedMode,
          diagnosticsMode: previousEffectiveMode,
          targetMode: mode,
          modeVersion: diagnosticsBefore.modeVersion,
          changedBy: diagnosticsBefore.lastChangedBy,
        })
      }

      // Update in-memory managed mode first
      managed.permissionMode = mode

      // Reconcile mode-manager state for this specific session.
      if (previousEffectiveMode !== mode) {
        const changedBy = previousManagedMode === mode ? 'restore' : 'user'
        setPermissionMode(sessionId, mode, { changedBy })
      }

      const diagnostics = getPermissionModeDiagnostics(sessionId)
      managed.previousPermissionMode = diagnostics.previousPermissionMode
      sessionLog.info('Permission mode changed', {
        sessionId,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
      })

      // Forward to the agent instance so backends can propagate mode changes downstream.
      if (managed.agent) {
        managed.agent.setPermissionMode(mode)
      }

      this.sendEvent({
        type: 'permission_mode_changed',
        sessionId: managed.id,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
        previousPermissionMode: diagnostics.previousPermissionMode,
        transitionDisplay: diagnostics.transitionDisplay,
      }, managed.workspace.id)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Get authoritative permission mode diagnostics for a session.
   * Used by renderer to reconcile optimistic/stale mode state.
   */
  getSessionPermissionModeState(sessionId: string): {
    permissionMode: PermissionMode
    previousPermissionMode?: PermissionMode
    transitionDisplay?: string
    modeVersion: number
    changedAt: string
    changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
  } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null

    let diagnostics = getPermissionModeDiagnostics(sessionId)

    // Hydrate persisted transition context when mode-manager has been reset (e.g. app restart).
    if (managed.previousPermissionMode && !diagnostics.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    // Heal restore races where mode-manager still has default state while
    // session metadata already has a persisted non-default mode.
    if (managed.permissionMode && diagnostics.permissionMode !== managed.permissionMode) {
      sessionLog.warn('Permission mode diagnostics mismatch, reconciling to managed session mode', {
        sessionId,
        managedMode: managed.permissionMode,
        diagnosticsMode: diagnostics.permissionMode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
      })
      setPermissionMode(sessionId, managed.permissionMode, { changedBy: 'restore' })
      if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      }
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    managed.previousPermissionMode = diagnostics.previousPermissionMode

    return {
      permissionMode: diagnostics.permissionMode,
      previousPermissionMode: diagnostics.previousPermissionMode,
      transitionDisplay: diagnostics.transitionDisplay,
      modeVersion: diagnostics.modeVersion,
      changedAt: diagnostics.lastChangedAt,
      changedBy: diagnostics.lastChangedBy,
    }
  }

  /**
   * Set labels for a session (additive tags, many-per-session).
   * Labels are IDs referencing workspace labels/config.json.
   */
  async setSessionLabels(sessionId: string, labels: string[]): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.labels = labels
      this.setMetadataWriteGuard(managed)

      this.sendEvent({
        type: 'labels_changed',
        sessionId: managed.id,
        labels: managed.labels,
      }, managed.workspace.id)
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
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
            craftId: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
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

  private async processEvent(managed: ManagedSession, event: AgentEvent): Promise<void> {
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
          if (artifactProjection.artifact.state === 'executing' || artifactProjection.artifact.state === 'completed') {
            await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
          }
          this.persistSession(managed)
          break
        }

        break
      }

      case 'tool_start': {
        const formattedToolInput = formatToolInputPaths(event.input)
        const workspaceRootPath = managed.workspace.rootPath
        let toolDisplayMeta: ToolDisplayMeta | undefined
        if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
          const allSources = loadAllSources(workspaceRootPath)
          toolDisplayMeta = await resolveToolDisplayMeta(event.toolName, formattedToolInput, workspaceRootPath, allSources)
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
          // Mark compaction complete in the session state.
          // This is done here (backend) rather than in the renderer so it's
          // not affected by CMD+R during compaction. The frontend reload
          // recovery will see awaitingCompaction=false and trigger execution.
          void markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
          sessionLog.info(`Session ${sessionId}: compaction complete, marked pending plan ready`)

          // Emit usage_update so the context count badge refreshes immediately
          // after compaction, without waiting for the next message
          if (managed.tokenUsage) {
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

        // PiProjectionBuilder already emits the structured runtime_error entity.
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
          sessionLog.info(`Stored command for shell ${event.shellId}: ${event.command.slice(0, 50)}...`)
        }
        // Forward to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'source_activated': {
        // A source was auto-activated mid-turn. The server schedules a re-send of the
        // original message with a "[<slug> activated]" suffix so headless deployments
        // (WebUI, docker server) chain activations the same way the renderer used to.
        // The renderer still receives the event to render activation feedback, but no
        // longer fires its own auto_retry (see processor.ts).
        sessionLog.info(`Source "${event.sourceSlug}" activated for session ${sessionId}, scheduling auto-retry`)

        this.sendEvent({
          type: 'source_activated',
          sessionId,
          sourceSlug: event.sourceSlug,
          originalMessage: event.originalMessage,
        }, workspaceId)

        if (!managed) break

        const originalMessage = event.originalMessage ?? ''
        if (!originalMessage.trim()) {
          sessionLog.warn(`Source "${event.sourceSlug}" activated for session ${sessionId}, but originalMessage was empty; skipping auto-retry`)
          break
        }

        const messageWithSuffix = `${originalMessage}\n\n[${event.sourceSlug} activated]`
        const userMessageCountAtSchedule = this.piProjectionBySession.get(sessionId)?.createSnapshot().entities
          .filter(entity => entity.kind === 'user_text').length ?? 0

        // Stash the retry payload so a duplicate sendMessage from a legacy renderer
        // (mixed-version rollout: new server + v0.9.5 Electron client) gets deduped.
        // 2s window covers WS latency tail on flaky mobile / proxy links.
        managed.autoRetryPending = {
          content: messageWithSuffix,
          deadlineMs: Date.now() + 2000,
          committed: false,
        }

        if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
        managed.autoRetryTimer = setTimeout(() => {
          const current = this.sessions.get(sessionId)
          if (!current) return
          current.autoRetryTimer = undefined

          // If a user follow-up arrived in the 100ms window, skip — they preempted us.
          const currentUserMessageCount = this.piProjectionBySession.get(sessionId)?.createSnapshot().entities
            .filter(entity => entity.kind === 'user_text').length ?? 0
          if (currentUserMessageCount > userMessageCountAtSchedule) {
            sessionLog.info(`Auto-retry skipped for ${sessionId}: follow-up message arrived first`)
            current.autoRetryPending = undefined
            return
          }

          // Note: do NOT clear autoRetryPending here — sendMessage() needs to see it
          // so a legacy renderer's duplicate RPC arriving ~50ms later gets dropped.
          // The pending slot is cleared by the deadline check in sendMessage, by the
          // next matching sendMessage that drops as a duplicate, or by session deletion.
          this.sendMessage(sessionId, messageWithSuffix).catch(err => {
            sessionLog.error(`Auto-retry sendMessage failed for ${sessionId}:`, err)
          })
        }, 100)
        break
      }

      case 'complete':
        // Complete event from CraftAgent - accumulate usage from this turn
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

      case 'steer_undelivered':
        // Steer message was not delivered (no PreToolUse fired before turn ended).
        // Re-queue it so it's sent as a normal message on the next turn.
        sessionLog.info(`Steer message undelivered, re-queuing for session ${sessionId}`)
        managed.messageQueue.push({ message: event.message })
        managed.wasInterrupted = true
        break

      // Note: working_directory_changed is user-initiated only (via updateWorkingDirectory),
      // the agent no longer has a change_working_directory tool
    }
  }

  private sendEvent(event: SessionEvent, workspaceId?: string): void {
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

  /**
   * Execute a prompt automation by creating a new session and sending the prompt.
   *
   * The options-object form replaced the previous positional-args signature
   * once the param list outgrew readability — `thinkingLevel` was the trigger.
   * When `thinkingLevel` is omitted, `createSession` falls back to the
   * workspace default (then DEFAULT_THINKING_LEVEL).
   */
  async executePromptAutomation(
    input: ExecutePromptAutomationInput,
  ): Promise<{ sessionId: string }> {
    const {
      workspaceId,
      workspaceRootPath,
      prompt,
      labels,
      permissionMode,
      mentions,
      provider,
      model,
      thinkingLevel,
      automationName,
      telegramTopic,
    } = input

    const automationProvider = hasConfiguredPiProvider(provider) ? provider : undefined
    if (provider && !automationProvider) {
      sessionLog.warn(`[Automations] provider "${provider}" not found, using default`)
    }

    // Resolve @mentions to source/skill slugs
    const resolved = mentions ? this.resolveAutomationMentions(workspaceRootPath, mentions) : undefined

    // Ensure labels exist in workspace config before assigning to session
    const resolvedLabels = labels?.length
      ? ensureLabelsExist(workspaceRootPath, labels)
      : labels

    // Use automation name if provided, otherwise fall back to prompt snippet
    const fallback = `Automation: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`
    const sessionName = automationName || fallback

    // Create a new session for this automation
    const session = await this.createSession(workspaceId, {
      name: sessionName,
      labels: resolvedLabels,
      permissionMode: permissionMode || 'safe',
      enabledSourceSlugs: resolved?.sourceSlugs,
      provider: automationProvider,
      model,
      thinkingLevel,
    })

    // Populate triggeredBy metadata so title generation is explicitly skipped
    // and the session is identifiable as automation-initiated after reload
    const managed = this.sessions.get(session.id)
    if (managed) {
      managed.triggeredBy = { automationName, timestamp: Date.now() }
      this.persistSession(managed)
    }

    // Notify renderer to hydrate full session metadata (including title)
    // before streaming events arrive. Without this, the renderer may create
    // a synthetic empty session and temporarily show "New chat".
    this.sendEvent({ type: 'session_created', sessionId: session.id }, workspaceId)

    // Bind the new session to its Telegram forum topic if the matcher
    // declared `telegramTopic`. Done before `sendMessage` so the first
    // assistant tokens already route through the bound topic. Failure
    // is logged inside the binder; the session continues unbound.
    if (this.automationBinder && telegramTopic && telegramTopic.trim().length > 0) {
      try {
        await this.automationBinder({
          workspaceId,
          sessionId: session.id,
          topicName: telegramTopic.trim(),
        })
      } catch (err) {
        sessionLog.warn('[Automations] automation binder threw', {
          sessionId: session.id,
          telegramTopic,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Send the prompt
    await this.sendMessage(session.id, prompt, undefined, undefined, {
      skillSlugs: resolved?.skillSlugs,
    })

    return { sessionId: session.id }
  }

  /**
   * Resolve @mentions in automation prompts to source and skill slugs
   */
  private resolveAutomationMentions(workspaceRootPath: string, mentions: string[]): { sourceSlugs: string[]; skillSlugs: string[] } | undefined {
    const sources = loadWorkspaceSources(workspaceRootPath)
    const skills = loadAllSkills(workspaceRootPath)
    const sourceSlugs: string[] = []
    const skillSlugs: string[] = []

    for (const mention of mentions) {
      if (sources.some(s => s.config.slug === mention)) {
        sourceSlugs.push(mention)
      } else if (skills.some(s => s.slug === mention)) {
        skillSlugs.push(mention)
      } else {
        sessionLog.warn(`[Automations] Unknown mention: @${mention}`)
      }
    }

    return (sourceSlugs.length > 0 || skillSlugs.length > 0) ? { sourceSlugs, skillSlugs } : undefined
  }

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  private async generateRemoteTransferSummary(managed: ManagedSession): Promise<string | null> {
    const messages = getPiProjectionConversationMessages(
      (await this.getPiProjectionSnapshot(managed.id)) ?? undefined,
    )

    if (messages.length === 0) return null

    const workspaceRootPath = managed.workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultModel = wsConfig?.defaults?.model
    const backendContext = resolveBackendContext({
      sessionProvider: managed.provider,
      workspaceDefaultProvider: wsConfig?.defaults?.provider,
      managedModel: managed.model || defaultModel,
    })

    const miniModel = backendContext.providerConfig?.models?.[1]?.id
      ?? backendContext.providerConfig?.models?.[0]?.id
      ?? getDefaultSummarizationModel()

    const envOverrides: Record<string, string> = {
      CRAFT_WORKSPACE_PATH: workspaceRootPath,
    }

    const agent = createBackendFromResolvedContext({
      context: backendContext,
      hostRuntime: buildBackendHostRuntimeContext(),
      coreConfig: {
        workspace: managed.workspace,
        session: {
          craftId: `${managed.id}-remote-transfer-summary`,
          workspaceRootPath,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: workspaceRootPath,
          sdkCwd: managed.sdkCwd ?? workspaceRootPath,
          model: managed.model,
          provider: managed.provider,
          permissionMode: managed.permissionMode,
          previousPermissionMode: managed.previousPermissionMode,
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

    const bundle = serializeSession(managed.workspace.rootPath, sessionId)
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
    sessionLog.info(`[import] Starting import: workspaceId=${workspaceId}, mode=${mode}, bundleSessionId=${bundle?.session?.header?.craftId ?? 'unknown'}, files=${bundle?.files?.length ?? 0}`)

    if (!validateBundle(bundle)) {
      throw new Error('Invalid session bundle')
    }

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    sessionLog.info(`[import] Target workspace: "${workspace.name}" at ${workspace.rootPath}`)

    const warnings: string[] = []
    const workspaceRootPath = workspace.rootPath

    // Determine session ID
    // 兼容旧 bundle：重构前 header 只有 id（无 craftId），validateBundle 接受两者。
    // move 模式优先使用 craftId，缺失时回退到 id（旧 bundle，类型上不存在，用 cast 访问）。
    const header = bundle.session.header
    const legacyId = (header as { id?: string }).id
    const sessionId = mode === 'move'
      ? (header.craftId ?? legacyId)
      : generateSessionId(workspaceRootPath)

    // Check for ID collision on move
    if (mode === 'move' && this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists in target workspace`)
    }

    // Create session directory with all subdirectories
    const sessionDir = ensureSessionDir(workspaceRootPath, sessionId)

    // Build the stored session from bundle data.
    // 用 pickCraftSessionMetadata(header) 作为基底，让 Craft metadata 字段自动透传
    //（避免新增字段时手工同步遗漏，如 isArchived/hasUnread/pendingPlanExecution）。
    // 然后显式覆盖需要重写的字段。
    const storedSession = {
      ...(pickCraftSessionMetadata(header) as Partial<SessionHeader>),
      // 显式覆盖：目标工作区的身份与路径
      craftId: sessionId,
      workspaceRootPath,
      workingDirectory: workspaceRootPath,
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
      // 非 CRAFT_SESSION_METADATA_FIELDS 字段
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
        ? (readPiGlobalProviders()[header.provider]?.baseUrl ? 'pi_compat' : 'pi')
        : undefined
      const compatibleConnection = sourceProviderType
        ? this.findCompatibleProvider(workspaceRootPath, sourceProviderType)
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
      // Clear thinking level so the session inherits the workspace default
      storedSession.thinkingLevel = undefined
      storedSession.workingDirectory = workspaceRootPath
    }

    // Check source compatibility (before writing JSONL so fixes are persisted)
    if (storedSession.enabledSourceSlugs?.length) {
      const availableSources = loadWorkspaceSources(workspaceRootPath)
      const availableSlugs = new Set(availableSources.map(s => s.config.slug))
      const missingSources = storedSession.enabledSourceSlugs.filter(s => !availableSlugs.has(s))
      if (missingSources.length > 0) {
        sessionLog.warn(`[import] Sources not available: ${missingSources.join(', ')}`)
        warnings.push(`Sources not available in target workspace: ${missingSources.join(', ')}`)
      }
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

    storedSession.workingDirectory = workspaceRootPath
    storedSession.sdkCwd = storedSession.sdkCwd ?? workspaceRootPath

    // Create/update the Pi session header + Craft metadata first, then import
    // canonical transcript entries through Pi's public SessionManager API.
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId, workspaceRootPath, storedSession.createdAt)
    sessionLog.info(`[import] Creating Pi canonical session: ${sessionFile} (provider=${storedSession.provider ?? 'default'}, messages=${storedSession.messages.length})`)
    await saveStoredSession(storedSession)
    const importedIdMap = appendStoredMessagesViaPiSessionManager(
      sessionFile,
      dirname(sessionFile),
      workspaceRootPath,
      storedSession.messages,
    )

    const overlaySession: StoredSession = {
      ...storedSession,
      messages: storedSession.messages.map((message) => {
        const importedId = importedIdMap.get(message.id)
        return importedId ? { ...message, id: importedId } : message
      }),
    }

    // Write all bundle files (attachments, plans, data, downloads, etc.)
    // Uses restoreFiles() for path traversal, size, and base64 validation.
    restoreFiles(sessionDir, bundle.files)
    writeCraftSessionOverlay(sessionFile, overlaySession)

    // Register in-memory — pass session metadata without messages to avoid
    // StoredMessage[] vs Message[] type mismatch, then convert messages separately
    const reloadedStoredSession = loadStoredSession(workspaceRootPath, sessionId) ?? overlaySession
    const { messages: bundleMessages, ...sessionMeta } = reloadedStoredSession
    const managed = createManagedSession(sessionMeta, workspace, {
      messagesLoaded: true,
      workingDirectory: workspaceRootPath,
    })
    managed.messages = bundleMessages.map(storedToMessage)

    setPermissionMode(sessionId, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
    }

    this.sessions.set(sessionId, managed)

    // Initialize automation metadata
    const automationSystem = this.automationSystems.get(workspaceRootPath)
    if (automationSystem) {
      automationSystem.setInitialSessionMetadata(sessionId, {
        permissionMode: storedSession.permissionMode,
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        sessionStatus: storedSession.sessionStatus,
        sessionName: managed.name,
      })
    }

    // Emit session_created so renderer picks it up
    this.sendEvent({ type: 'session_created', sessionId }, workspaceId)

    sessionLog.info(`[import] Complete: sessionId=${sessionId}, transferredSummary=${managed.transferredSessionSummary ? `${managed.transferredSessionSummary.length} chars` : 'none'}, applied=${managed.transferredSessionSummaryApplied}, warnings=${warnings.length > 0 ? warnings.join('; ') : 'none'}`)
    return { sessionId, warnings: warnings.length > 0 ? warnings : undefined }
  }

  /**
   * Find an Pi provider on this server that matches the given provider type.
   * Checks workspace default first, then falls back to any matching connection.
   */
  private findCompatibleProvider(workspaceRootPath: string, providerType: string): string | null {
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultSlug = wsConfig?.defaults?.provider
    if (defaultSlug) {
      const provider = readPiGlobalProviders()[defaultSlug]
      if (provider && (provider.baseUrl ? 'pi_compat' : 'pi') === providerType) return defaultSlug
    }
    // Fall back: any connection with matching provider type
    const match = Object.entries(readPiGlobalProviders()).find(([, provider]) => (provider.baseUrl ? 'pi_compat' : 'pi') === providerType)
    return match?.[0] ?? null
  }

  /**
   * Clean up all resources held by the SessionManager.
   * Should be called on app shutdown to prevent resource leaks.
   */
  async cleanup(): Promise<void> {
    sessionLog.info('Cleaning up resources...')

    // Dispose all live backend runtimes before dropping the session map so Pi
    // subprocesses, MCP pool clients, and session HTTP pool servers cannot leak.
    for (const managed of this.sessions.values()) {
      try {
        await this.disposeManagedAgentRuntime(managed, 'app quit')
      } catch (error) {
        sessionLog.error(`Failed to dispose runtime for ${managed.id} during cleanup:`, error)
      }
    }
    await Promise.all([...this.sessions.values()].map(managed => this.flushPiProjectionWrites(managed)))
    this.sessions.clear()
    this.piProjectionBySession.clear()
    this.piProjectionRetiredRuntimeIds.clear()
    this.piProjectionWrites.clear()
    this.piProjectionPendingSnapshots.clear()

    // Stop all ConfigWatchers (file system watchers)
    for (const [path, watcher] of this.configWatchers) {
      watcher.stop()
      sessionLog.info(`Stopped config watcher for ${path}`)
    }
    this.configWatchers.clear()

    // Dispose all AutomationSystems (includes scheduler, handlers, and event loggers)
    for (const [workspacePath, automationSystem] of this.automationSystems) {
      try {
        automationSystem.dispose()
        sessionLog.info(`Disposed AutomationSystem for ${workspacePath}`)
      } catch (error) {
        sessionLog.error(`Failed to dispose AutomationSystem for ${workspacePath}:`, error)
      }
    }
    this.automationSystems.clear()

    // Clear pending credential resolvers (they won't be resolved, but prevents memory leak)
    this.pendingCredentialResolvers.clear()
    this.pendingPermissionRequests.clear()
    this.adminRememberApprovals.clear()

    sessionLog.info('Cleanup complete')
  }
}
