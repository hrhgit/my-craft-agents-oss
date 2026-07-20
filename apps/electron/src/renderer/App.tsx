import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/hooks/useTheme'
import type { ThemeOverrides } from '@config/theme'
import { useSetAtom, useStore, useAtomValue, useAtom } from 'jotai'
import type { Session, Workspace, SessionEvent, Message, FileAttachment, StoredAttachment, PermissionRequest, SetupNeeds, NewChatActionParams, ContentBadge, PermissionModeState } from '../shared/types'
import type { SessionDraft, DraftAttachmentRef } from '@mortise/shared/config'
import type { MidStreamSendIntent } from '@mortise/shared/protocol'
import type { SessionOptions, SessionOptionUpdates } from './hooks/useSessionOptions'
import { defaultSessionOptions, mergeSessionOptions } from './hooks/useSessionOptions'
import { generateMessageId } from '../shared/types'
import { useEventProcessor } from './event-processor'
import type { AgentEvent, Effect } from './event-processor'
import { normalizeSessionEvent } from './event-processor/normalize-session-event'
import { isProjectionOwnedHostEvent } from './event-processor/projection-ownership'
import { AppShell } from '@/components/app-shell/AppShell'
import type { AppShellContextType } from '@/context/AppShellContext'
import { OnboardingWizard, ReauthScreen } from '@/components/onboarding'
import { WorkspacePicker } from '@/components/workspace'
import { SplashScreen } from '@/components/SplashScreen'
import { TooltipProvider } from '@mortise/ui'
import { FocusProvider } from '@/context/FocusContext'
import { ModalProvider } from '@/context/ModalContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { useWindowCloseHandler } from '@/hooks/useWindowCloseHandler'
import { useOnboarding } from '@/hooks/useOnboarding'
import { usePiGlobalConfig } from '@/hooks/usePiGlobalConfig'
import { useNotifications } from '@/hooks/useNotifications'
import { useSessionSelectionStore } from '@/hooks/useSession'
import { createInitialState } from '@/hooks/useMultiSelect'
import { useUpdateChecker } from '@/hooks/useUpdateChecker'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { navigate, routes } from './lib/navigate'
import { attachmentFromContentRef, hasDraftContent, toDraftRef } from './lib/drafts'
import { stripMarkdown } from './utils/text'
import { coerceInputText } from './lib/input-text'
import { getPiAgentEndHandoff } from './lib/pi-projection-handoff'
import { getSessionsToRefreshAfterStaleReconnect } from './lib/reconnect-recovery'
import { formatSessionLoadFailure, shouldTreatSessionLoadFailureAsTransportFallback } from './lib/session-load'
import {
  assertWorkspaceSessionBatch,
  flushWorkspaceLayoutBeforeTransition,
  LatestTaskQueue,
  resolveWorkspaceTransitionCommit,
  waitForRendererCommit,
  type WorkspaceTransitionState,
} from './lib/workspace-transition'
import { createSplashDismissal } from './lib/splash-readiness'
import {
  removePiUserOverlayCarrier,
  settlePiUserOverlayCarrier,
  upsertPiUserOverlayCarrier,
} from './lib/pi-message-overlay'
import { extractWorkspaceSlugFromPath } from '@mortise/shared/utils/workspace-slug'
import { ATTACHMENT_MESSAGE_TOTAL_LIMIT_BYTES, ATTACHMENT_SINGLE_FILE_LIMIT_BYTES } from '@mortise/shared/utils/attachment-limits'
import { DEFAULT_THINKING_LEVEL } from '@mortise/shared/agent/thinking-levels'
import { initRendererPerf } from './lib/perf'
import {
  initializeSessionsAtom,
  addSessionAtom,
  removeSessionAtom,
  updateSessionAtom,
  replaceLoadedSessionAtom,
  refreshSessionsMetadataAtom,
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  forceSessionMessagesReloadAtom,
  backgroundTasksAtomFamily,
  extractSessionMeta,
  windowWorkspaceIdAtom,
  type SessionMeta,
} from '@/atoms/sessions'
import {
  insertOptimisticPiUser,
  piProjectionAtomFamily,
  removeOptimisticPiUser,
} from '@/atoms/pi-projection'
import { skillsAtom } from '@/atoms/skills'
import { focusedPanelIdAtom, panelStackAtom } from '@/atoms/panel-stack'
import { extractBadges } from '@/lib/mentions'
import { getDefaultStore } from 'jotai'
import {
  ShikiThemeProvider,
  PlatformProvider,
  ImagePreviewOverlay,
  PDFPreviewOverlay,
  CodePreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  JSONPreviewOverlay,
} from '@mortise/ui'
import { useLinkInterceptor, type FilePreviewState } from '@/hooks/useLinkInterceptor'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { useUiValidationStateBridge } from '@/ui-validation/state-bridge'
import { useStaleSessionRecovery } from '@/hooks/useStaleSessionRecovery'
import { usePiProjectionSync, type PiProjectionEventApplied } from '@/hooks/usePiProjectionSync'
import { TransportConnectionBanner, shouldShowTransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner'
import type { WorkspaceSwitchDestination } from '@/components/workspace/useWorkspaceNavigation'
import { getFileManagerName } from '@/lib/platform'
import { rendererLog } from '@/lib/logger'
import { ActionRegistryProvider } from '@/actions'
import { toast } from 'sonner'

type AppState = 'loading' | 'onboarding' | 'reauth' | 'workspace-picker' | 'ready'

/** Type for the Jotai store returned by useStore() */
type JotaiStore = ReturnType<typeof getDefaultStore>

type SessionListRefreshOptions = {
  removeMissing?: boolean
  reason?: string
  selectedSessionId?: string | null
}

const SESSION_REFRESH_LOG_ID_LIMIT = 25

function summarizeIds(ids: Iterable<string>, limit = SESSION_REFRESH_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

function workspaceDistribution(sessions: Iterable<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

/**
 * Helper to handle background task events from the agent.
 * Updates the backgroundTasksAtomFamily based on event type.
 * Extracted to avoid code duplication between streaming and non-streaming paths.
 */
function handleBackgroundTaskEvent(
  store: JotaiStore,
  sessionId: string,
  event: { type: string },
  agentEvent: unknown
): void {
  // Type guard for accessing properties
  const evt = agentEvent as Record<string, unknown>
  const backgroundTasksAtom = backgroundTasksAtomFamily(sessionId)

  if (event.type === 'task_backgrounded' && 'taskId' in evt && 'toolUseId' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    const exists = currentTasks.some(t => t.toolUseId === evt.toolUseId)
    if (!exists) {
      store.set(backgroundTasksAtom, [
        ...currentTasks,
        {
          id: evt.taskId as string,
          type: 'agent' as const,
          toolUseId: evt.toolUseId as string,
          startTime: Date.now(),
          elapsedSeconds: 0,
          intent: evt.intent as string | undefined,
        },
      ])
    }
  } else if (event.type === 'shell_backgrounded' && 'shellId' in evt && 'toolUseId' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    const exists = currentTasks.some(t => t.toolUseId === evt.toolUseId)
    if (!exists) {
      store.set(backgroundTasksAtom, [
        ...currentTasks,
        {
          id: evt.shellId as string,
          type: 'shell' as const,
          toolUseId: evt.toolUseId as string,
          startTime: Date.now(),
          elapsedSeconds: 0,
          intent: evt.intent as string | undefined,
        },
      ])
    }
  } else if (event.type === 'task_progress' && 'toolUseId' in evt && 'elapsedSeconds' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.toolUseId === evt.toolUseId
        ? { ...t, elapsedSeconds: evt.elapsedSeconds as number }
        : t
    ))
  } else if (event.type === 'task_completed' && 'taskId' in evt) {
    // Remove task when background task completes
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.filter(t => t.id !== evt.taskId))
  } else if (event.type === 'shell_killed' && 'shellId' in evt) {
    // Remove shell task when KillShell succeeds
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.filter(t => t.id !== evt.shellId))
  } else if (event.type === 'tool_result' && 'toolUseId' in evt) {
    // Remove task when it completes - but NOT if this is the initial backgrounding result
    // Background tasks return immediately with agentId/shell_id/backgroundTaskId,
    // we should only remove when the task actually completes
    const result = typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result)
    const isBackgroundingResult = result && (
      /agentId:\s*[a-zA-Z0-9_-]+/.test(result) ||
      /shell_id:\s*[a-zA-Z0-9_-]+/.test(result) ||
      /"backgroundTaskId":\s*"[a-zA-Z0-9_-]+"/.test(result)
    )
    if (!isBackgroundingResult) {
      const currentTasks = store.get(backgroundTasksAtom)
      store.set(backgroundTasksAtom, currentTasks.filter(t => t.toolUseId !== evt.toolUseId))
    }
  }
  // Note: We do NOT clear background tasks on complete/error/interrupted
  // Background tasks should persist and keep running after the turn ends
  // They are only removed when:
  // 1. task_completed event arrives (background task finished)
  // 2. Their tool_result comes back (foreground task finished)
  // 3. KillShell succeeds (shell_killed event)
}

function SessionLoadErrorScreen({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-xl border border-border/50 bg-background shadow-minimal p-6 text-center">
        <h2 className="text-lg font-semibold text-foreground">{t("errors.failedToLoadSessions")}</h2>
        <p className="mt-2 text-sm text-foreground/60">
          {t("errors.failedToLoadSessionsDesc")}
        </p>
        <p className="mt-3 rounded-lg bg-foreground/5 px-3 py-2 text-left text-xs text-foreground/70 break-words">
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex h-8 items-center justify-center rounded-[8px] bg-foreground text-background px-3 text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {t("errors.retryLoadingSessions")}
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const { t } = useTranslation()

  // Initialize renderer perf tracking early (debug mode = running from source)
  // Uses useEffect with empty deps to run once on mount before any session switches
  useEffect(() => {
    window.electronAPI.isDebugMode().then((isDebug) => {
      initRendererPerf(isDebug)
    })
  }, [])

  // App state: loading -> check auth -> onboarding or ready
  const [appState, setAppState] = useState<AppState>('loading')
  const [setupNeeds, setSetupNeeds] = useState<SetupNeeds | null>(null)

  // Per-session Jotai atom setters for isolated updates
  // NOTE: No sessionsAtom - we don't store a Session[] array anywhere to prevent memory leaks
  // Instead we use:
  // - sessionMetaMapAtom for lightweight listing
  // - sessionAtomFamily(id) for individual session data
  const initializeSessions = useSetAtom(initializeSessionsAtom)
  const addSession = useSetAtom(addSessionAtom)
  const removeSession = useSetAtom(removeSessionAtom)
  const updateSessionDirect = useSetAtom(updateSessionAtom)
  const replaceLoadedSession = useSetAtom(replaceLoadedSessionAtom)
  const store = useStore()

  // Helper to update a session by ID with partial fields
  // Uses per-session atom directly instead of updating an array
  const updateSessionById = useCallback((
    sessionId: string,
    updates: Partial<Session> | ((session: Session) => Partial<Session>)
  ) => {
    updateSessionDirect(sessionId, (prev) => {
      if (!prev) return prev
      const partialUpdates = typeof updates === 'function' ? updates(prev) : updates
      return { ...prev, ...partialUpdates }
    })
  }, [updateSessionDirect])

  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  // Window's workspace ID — shared atom so Root/ThemeProvider stays in sync on switch
  const [windowWorkspaceId, setWindowWorkspaceId] = useAtom(windowWorkspaceIdAtom)
  const [workspaceSwitchDestination, setWorkspaceSwitchDestination] = useState<WorkspaceSwitchDestination | null>(null)
  const [workspaceTransition, setWorkspaceTransition] = useState<WorkspaceTransitionState | null>(null)
  const windowWorkspaceIdRef = useRef(windowWorkspaceId)
  const transportWorkspaceIdRef = useRef(windowWorkspaceId)
  const workspacesRef = useRef(workspaces)
  const workspaceTransitionQueueRef = useRef<LatestTaskQueue | null>(null)
  const workspaceTransitionRollbackRef = useRef<(() => void) | null>(null)
  const workspaceTransitionBaselineIdRef = useRef<string | null>(null)
  workspaceTransitionQueueRef.current ??= new LatestTaskQueue()
  windowWorkspaceIdRef.current = windowWorkspaceId
  if (!workspaceTransitionQueueRef.current.isRunning) {
    transportWorkspaceIdRef.current = windowWorkspaceId
  }
  workspacesRef.current = workspaces

  // Derive workspace slug for SDK skill qualification
  const windowWorkspaceSlug = useMemo(() => {
    if (!windowWorkspaceId) return null
    const workspace = workspaces.find(w => w.id === windowWorkspaceId)
    return workspace?.slug ?? windowWorkspaceId
  }, [windowWorkspaceId, workspaces])

  // Get initial sessionId and focused mode from URL params (for "Open in New Window" feature)
  const { initialSessionId, isFocusedMode } = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return {
      initialSessionId: params.get('sessionId'),
      isFocusedMode: params.get('focused') === 'true',
    }
  }, [])

  // Derive remote workspace ID for session matching in NavigationContext
  const windowRemoteWorkspaceId = useMemo(() => {
    if (!windowWorkspaceId) return null
    const workspace = workspaces.find(w => w.id === windowWorkspaceId)
    return workspace?.remoteServer?.remoteWorkspaceId ?? null
  }, [windowWorkspaceId, workspaces])

  const {
    providers: piProviders,
    settings: piGlobalSettings,
    refresh: refreshPiGlobalConfig,
  } = usePiGlobalConfig()

  const [menuNewChatTrigger, setMenuNewChatTrigger] = useState(0)
  // Permission requests per session (queue to handle multiple concurrent requests)
  const [pendingPermissions, setPendingPermissions] = useState<Map<string, PermissionRequest[]>>(new Map())
  // Draft composer state per session (text + attachment refs), preserved across mode
  // switches, conversation changes, and app restarts. Using a ref avoids re-renders
  // during typing; attachments are stored as lightweight refs (path + name) and
  // hydrated via readFileAttachment() on session switch.
  const sessionDraftsRef = useRef<Map<string, SessionDraft>>(new Map())
  const draftsLoadStartedRef = useRef(false)
  // Unified session options for all session-scoped settings
  const [sessionOptions, setSessionOptions] = useState<Map<string, SessionOptions>>(new Map())

  // Theme state (app-level only)
  const [appTheme, setAppTheme] = useState<ThemeOverrides | null>(null)

  // Auto-update state
  const updateChecker = useUpdateChecker()

  // Splash screen state - tracks when app is fully ready (all data loaded)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [draftsLoaded, setDraftsLoaded] = useState(false)
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null)
  const sessionLoadGenerationRef = useRef(0)
  const sessionLoadFlightRef = useRef<{ workspaceId: string; promise: Promise<void> } | null>(null)
  const [splashExiting, setSplashExiting] = useState(false)
  const [splashHidden, setSplashHidden] = useState(false)
  const splashDismissalRef = useRef<ReturnType<typeof createSplashDismissal> | null>(null)

  // Notifications enabled state (from app settings)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)

  // Skills for badge extraction
  const skills = useAtomValue(skillsAtom)

  // Compute if app is fully ready (all data loaded)
  const isFullyReady = appState === 'ready' && sessionsLoaded

  // Trigger splash exit animation when fully ready
  useEffect(() => {
    if (!isFullyReady) return

    setSplashExiting(true)
    const dismissal = createSplashDismissal(() => setSplashHidden(true))
    splashDismissalRef.current = dismissal
    return () => {
      dismissal.cancel()
      if (splashDismissalRef.current === dismissal) splashDismissalRef.current = null
    }
  }, [isFullyReady])

  // Handler for when splash exit animation completes
  const handleSplashExitComplete = useCallback(() => {
    if (splashDismissalRef.current) splashDismissalRef.current.complete()
    else setSplashHidden(true)
  }, [])

  // Apply theme via hook (injects CSS variables)
  // shikiTheme is passed to ShikiThemeProvider to ensure correct syntax highlighting
  // theme for dark-only themes in light system mode
  const { shikiTheme, isDark } = useTheme({ appTheme })

  // Ref for sessionOptions to access current value in event handlers without re-registering
  const sessionOptionsRef = useRef(sessionOptions)
  // Keep ref in sync with state
  useEffect(() => {
    sessionOptionsRef.current = sessionOptions
  }, [sessionOptions])

  const applyPermissionModeState = useCallback((sessionId: string, state: PermissionModeState, source: 'event' | 'reconcile') => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(sessionId) ?? defaultSessionOptions
      const currentVersion = current.permissionModeVersion ?? -1

      if (state.modeVersion < currentVersion) {
        window.electronAPI.debugLog(
          '[ModeSync] Ignoring stale permission mode update',
          { sessionId, source, incoming: state.modeVersion, current: currentVersion }
        )
        return prev
      }

      if (
        state.modeVersion === currentVersion &&
        current.permissionMode !== state.permissionMode
      ) {
        window.electronAPI.debugLog(
          '[ModeSync] Equal modeVersion with differing mode detected, applying and requesting reconciliation',
          {
            sessionId,
            source,
            modeVersion: state.modeVersion,
            currentMode: current.permissionMode,
            incomingMode: state.permissionMode,
          }
        )
      }

      next.set(sessionId, {
        ...current,
        permissionMode: state.permissionMode,
        permissionModeVersion: state.modeVersion,
      })
      return next
    })
  }, [])

  const reconcilePermissionModeState = useCallback(async (sessionId: string) => {
    try {
      const state = await window.electronAPI.getSessionPermissionModeState(sessionId)
      if (!state) return
      applyPermissionModeState(sessionId, state, 'reconcile')
    } catch (error) {
      window.electronAPI.debugLog('[ModeSync] Failed to reconcile permission mode', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [applyPermissionModeState])

  // Event processor hook - handles all agent events through pure functions
  const { processAgentEvent, clearStreamingState } = useEventProcessor()

  const syncSessionOptionsFromSession = useCallback((session: Session) => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(session.id)
      const merged = {
        ...defaultSessionOptions,
        ...current,
        permissionMode: session.permissionMode ?? defaultSessionOptions.permissionMode,
        thinkingLevel: session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      }

      const hasNonDefaultMode = merged.permissionMode !== defaultSessionOptions.permissionMode
      const hasNonDefaultThinking = merged.thinkingLevel !== DEFAULT_THINKING_LEVEL

      if (!hasNonDefaultMode && !hasNonDefaultThinking && merged.permissionModeVersion == null) {
        next.delete(session.id)
      } else {
        next.set(session.id, merged)
      }

      return next
    })
  }, [])

  const refreshSessionFromServer = useCallback(async (sessionId: string): Promise<'refreshed' | 'preserved_stale_messages' | 'failed'> => {
    try {
      const fresh = await window.electronAPI.getSessionMessages(sessionId)
      if (!fresh) return 'failed'

      const prevSession = store.get(sessionAtomFamily(sessionId))
      const preservedStaleMessages = !!prevSession && prevSession.messages.length > 0 && (!fresh.messages || fresh.messages.length === 0)
      const nextSession = preservedStaleMessages
        ? { ...fresh, messages: prevSession.messages }
        : fresh

      clearStreamingState(sessionId)
      replaceLoadedSession(nextSession)
      syncSessionOptionsFromSession(nextSession)
      void reconcilePermissionModeState(sessionId)
      return preservedStaleMessages ? 'preserved_stale_messages' : 'refreshed'
    } catch (err) {
      console.error(`[App] Failed to refresh session ${sessionId}:`, err)
      return 'failed'
    }
  }, [clearStreamingState, replaceLoadedSession, syncSessionOptionsFromSession, reconcilePermissionModeState, store])

  const loadSessionsFromServer = useCallback((expectedWorkspaceId = windowWorkspaceIdRef.current): Promise<void> => {
    if (!expectedWorkspaceId) return Promise.resolve()
    const existingFlight = sessionLoadFlightRef.current
    if (existingFlight?.workspaceId === expectedWorkspaceId) return existingFlight.promise

    const generation = ++sessionLoadGenerationRef.current
    setSessionsLoaded(false)
    setSessionLoadError(null)

    let loadPromise!: Promise<void>
    loadPromise = (async () => {
      try {
        const loadedSessions = await window.electronAPI.getSessions()
        if (
          generation !== sessionLoadGenerationRef.current
          || windowWorkspaceIdRef.current !== expectedWorkspaceId
        ) {
          rendererLog.info('[App] Ignoring stale session list response', {
            expectedWorkspaceId,
            currentWorkspaceId: windowWorkspaceIdRef.current,
            generation,
            currentGeneration: sessionLoadGenerationRef.current,
          })
          return
        }

        const expectedWorkspace = workspacesRef.current.find(workspace => workspace.id === expectedWorkspaceId)
        assertWorkspaceSessionBatch(loadedSessions, [
          expectedWorkspaceId,
          expectedWorkspace?.remoteServer?.remoteWorkspaceId,
        ])

        // Initialize per-session atoms and metadata map only after ownership validation.
        initializeSessions(loadedSessions)

        const optionsMap = new Map<string, SessionOptions>()
        for (const s of loadedSessions) {
          const hasNonDefaultMode = s.permissionMode && s.permissionMode !== 'ask'
          const hasNonDefaultThinking = s.thinkingLevel && s.thinkingLevel !== DEFAULT_THINKING_LEVEL
          if (hasNonDefaultMode || hasNonDefaultThinking) {
            optionsMap.set(s.id, {
              permissionMode: s.permissionMode ?? 'ask',
              thinkingLevel: s.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
            })
          }
        }
        setSessionOptions(optionsMap)

        setSessionsLoaded(true)

        if (initialSessionId) {
          const session = loadedSessions.find(s => s.id === initialSessionId)
          if (session) {
            navigate(routes.view.allSessions(session.id))
          }
        }
      } catch (err) {
        if (
          generation !== sessionLoadGenerationRef.current
          || windowWorkspaceIdRef.current !== expectedWorkspaceId
        ) return

        console.error('[App] Failed to load sessions:', err)
        const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

        if (shouldTreatSessionLoadFailureAsTransportFallback(transportState)) {
          console.error('[App] Treating session load failure as transport fallback:', transportState)
          setSessionsLoaded(true)
          setSessionLoadError(null)
          return
        }

        rendererLog.error('[App] Rejected session list for workspace', {
          expectedWorkspaceId,
          error: err instanceof Error ? err.message : String(err),
        })
        setSessionLoadError(formatSessionLoadFailure(err))
        setSessionsLoaded(true)
      } finally {
        if (sessionLoadFlightRef.current?.promise === loadPromise) {
          sessionLoadFlightRef.current = null
        }
      }
    })()

    sessionLoadFlightRef.current = { workspaceId: expectedWorkspaceId, promise: loadPromise }
    return loadPromise
  }, [initializeSessions, initialSessionId])

  const refreshSessionListMetadataFromServer = useCallback(async (options: SessionListRefreshOptions = {}): Promise<Map<string, SessionMeta> | null> => {
    const {
      removeMissing = true,
      reason = 'manual-or-authoritative',
      selectedSessionId = null,
    } = options
    const beforeMetaMap = store.get(sessionMetaMapAtom)
    const beforeIds = new Set(beforeMetaMap.keys())
    const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

    try {
      const sessions = await window.electronAPI.getSessions()
      const returnedIds = new Set(sessions.map(s => s.id))
      const missingIds = Array.from(beforeIds).filter(id => !returnedIds.has(id))
      const addedIds = sessions.map(s => s.id).filter(id => !beforeIds.has(id))
      const logPayload = {
        reason,
        removeMissing,
        windowWorkspaceId,
        windowRemoteWorkspaceId,
        selectedSessionId,
        beforeCount: beforeIds.size,
        returnedCount: sessions.length,
        beforeIds: summarizeIds(beforeIds),
        returnedIds: summarizeIds(returnedIds),
        missingIds: summarizeIds(missingIds),
        addedIds: summarizeIds(addedIds),
        beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
        returnedWorkspaceIds: workspaceDistribution(sessions),
        transportState,
      }

      rendererLog.info('[App] Session list metadata refresh result', logPayload)
      if (!removeMissing && missingIds.length > 0) {
        rendererLog.warn('[App] Non-destructive refresh preserved sessions omitted by getSessions(); this indicates a partial backend response or workspace-context mismatch', logPayload)
      }

      const loadedSessionIds = store.get(loadedSessionsAtom)

      // Single transactional atom write — all cross-atom mutations happen
      // inside one Jotai write function so React subscribers see one
      // consistent update instead of intermediate states.
      const nextMetaMap = store.set(refreshSessionsMetadataAtom, { sessions, loadedSessionIds, removeMissing })

      // Sync app-level state (React hooks / non-atom concerns) after the atom transaction
      for (const session of sessions) {
        syncSessionOptionsFromSession(session)
      }
      return nextMetaMap
    } catch (err) {
      rendererLog.error('[App] Failed to refresh session list metadata after reconnect:', {
        reason,
        removeMissing,
        windowWorkspaceId,
        windowRemoteWorkspaceId,
        selectedSessionId,
        beforeCount: beforeIds.size,
        beforeIds: summarizeIds(beforeIds),
        beforeWorkspaceIds: workspaceDistribution(beforeMetaMap.values()),
        transportState,
        error: err,
      })
      return null
    }
  }, [store, syncSessionOptionsFromSession, windowWorkspaceId, windowRemoteWorkspaceId])

  // Stale session watchdog — catches stuck sessions that the reconnect protocol misses
  const { trackSessionActivity } = useStaleSessionRecovery({
    store,
    refreshSessionFromServer,
  })

  const DRAFT_SAVE_DEBOUNCE_MS = 500

  // Handle onboarding completion
  const handleOnboardingComplete = useCallback(async () => {
    try {
      // Reload workspaces after onboarding
      const ws = await window.electronAPI.getWorkspaces()
      if (ws.length > 0) {
        // Switch to workspace in-place (no window close/reopen)
        await window.electronAPI.switchWorkspace(ws[0].id)
        setWindowWorkspaceId(ws[0].id)
        setWorkspaces(ws)
      } else {
        setWorkspaces(ws)
      }
    } catch (error) {
      console.error('[App] Failed to load workspaces after onboarding:', error)
      // Still transition to ready — the app can recover via reconnect
    }
    setAppState('ready')
  }, [])

  // Keep the provider/model source of truth fresh after onboarding changes.
  const onboarding = useOnboarding({
    onComplete: handleOnboardingComplete,
    onConfigSaved: refreshPiGlobalConfig,
    initialSetupNeeds: setupNeeds || undefined,
  })

  // Reauth login handler - placeholder (reauth is not currently used)
  const handleReauthLogin = useCallback(async () => {
    // Re-check setup needs
    const needs = await window.electronAPI.getSetupNeeds()
    if (needs.isFullyConfigured) {
      setAppState('ready')
    } else {
      setSetupNeeds(needs)
      setAppState('onboarding')
    }
  }, [])

  // Check auth state and get window's workspace ID on mount
  useEffect(() => {
    const initialize = async () => {
      try {
        // Get this window's workspace ID (passed via URL query param from main process)
        const wsId = await window.electronAPI.getWindowWorkspace()
        setWindowWorkspaceId(wsId)

        const needs = await window.electronAPI.getSetupNeeds()
        setSetupNeeds(needs)

        if (needs.isFullyConfigured) {
          // If no workspace is selected (thin client without MORTISE_WORKSPACE_ID),
          // show workspace picker before entering the main app
          if (!wsId) {
            setAppState('workspace-picker')
          } else {
            setAppState('ready')
          }
        } else {
          // New user or needs setup - show onboarding
          setAppState('onboarding')
        }
      } catch (error) {
        console.error('Failed to check auth state:', error)
        // If check fails, show onboarding to be safe
        setAppState('onboarding')
      }
    }

    initialize()
  }, [])

  // Session selection state
  const { state: sessionSelection, setState: setSession } = useSessionSelectionStore()
  const sessionSelectionRef = useRef(sessionSelection)
  sessionSelectionRef.current = sessionSelection

  // Notification system - shows native OS notifications and badge count
  const handleNavigateToSession = useCallback((sessionId: string) => {
    // Navigate to the session via central routing (uses allSessions filter)
    navigate(routes.view.allSessions(sessionId))
  }, [])

  const { isWindowFocused, showSessionNotification } = useNotifications({
    workspaceId: windowWorkspaceId,
    // NOTE: sessions removed - hook now uses sessionMetaMapAtom internally
    // to prevent closures from retaining full message arrays
    onNavigateToSession: handleNavigateToSession,
    enabled: notificationsEnabled,
  })

  const handlePiProjectionEventApplied = useCallback<PiProjectionEventApplied>((event, previous, current) => {
    const handoff = getPiAgentEndHandoff(previous, current, event)
    if (!handoff) return

    const session = store.get(sessionAtomFamily(handoff.sessionId))
    if (!session) return

    trackSessionActivity(handoff.sessionId)
    const updatedSession: Session = {
      ...session,
      isProcessing: false,
      currentStatus: undefined,
    }
    updateSessionDirect(handoff.sessionId, () => updatedSession)

    const metaMap = store.get(sessionMetaMapAtom)
    const nextMetaMap = new Map(metaMap)
    nextMetaMap.set(handoff.sessionId, extractSessionMeta(updatedSession))
    store.set(sessionMetaMapAtom, nextMetaMap)

    setPendingPermissions(previousPermissions => {
      if (!previousPermissions.has(handoff.sessionId)) return previousPermissions
      const next = new Map(previousPermissions)
      next.delete(handoff.sessionId)
      return next
    })

    if (!updatedSession.hidden) {
      const preview = handoff.preview
        ? stripMarkdown(handoff.preview.substring(0, 200)).substring(0, 100) || undefined
        : undefined
      showSessionNotification(updatedSession, preview)
    }
  }, [showSessionNotification, store, trackSessionActivity, updateSessionDirect])

  usePiProjectionSync(sessionSelection.selected, handlePiProjectionEventApplied)

  // Permission diagnostics are only needed for the session the user can act
  // on. Reconciling every sidebar item turns workspace loading into N extra
  // RPCs and can force every transcript to be read from disk.
  useEffect(() => {
    if (sessionSelection.selected) {
      void reconcilePermissionModeState(sessionSelection.selected)
    }
  }, [sessionSelection.selected, reconcilePermissionModeState])

  // Load workspaces, sessions, model, notifications setting, and drafts when app is ready
  useEffect(() => {
    if (appState !== 'ready') return

    window.electronAPI.getWorkspaces().then(setWorkspaces)
    window.electronAPI.getNotificationsEnabled().then(setNotificationsEnabled).catch(() => {})

    // Show actionable toast for missing system dependencies (Windows only)
    window.electronAPI.getSystemWarnings().then((warnings) => {
      if (warnings.vcredistMissing) {
        toast.warning(t('toast.vcRedistNotFound'), {
          description: t('toast.vcRedistNotFoundDesc'),
          duration: Infinity,
          action: {
            label: 'Install',
            onClick: () => window.electronAPI.openUrl(warnings.downloadUrl ?? 'https://aka.ms/vs/17/release/vc_redist.x64.exe'),
          },
        })
      }
      if (warnings.workspaceRuntimeDegraded) {
        toast.warning('Workspace runtime degraded', {
          description: warnings.workspaceRuntimeDegradedReason
            ? `Workspace isolation failed and Mortise is using the embedded runtime. Reason: ${warnings.workspaceRuntimeDegradedReason}`
            : 'Workspace isolation failed and Mortise is using the embedded runtime. Heavy agent work may affect app responsiveness.',
          duration: Infinity,
        })
      }
    }).catch(() => { /* non-fatal startup check */ })
    if (windowWorkspaceId) void loadSessionsFromServer(windowWorkspaceId)
    // Load persisted input drafts into ref (no re-render needed).
    // Attachment files are not read here — hydration happens lazily when the session
    // is opened so app startup isn't delayed by reading potentially large files.
    if (!draftsLoadStartedRef.current) {
      draftsLoadStartedRef.current = true
      window.electronAPI.getAllDrafts()
        .then((drafts) => {
          if (Object.keys(drafts).length > 0) {
            sessionDraftsRef.current = new Map(Object.entries(drafts))
          }
        })
        .catch((error) => {
          console.warn('[App] Failed to load persisted drafts:', error)
        })
        .finally(() => setDraftsLoaded(true))
    }
    // Load app-level theme
    window.electronAPI.getAppTheme().then(setAppTheme)
  }, [appState, loadSessionsFromServer, windowWorkspaceId])

  // Subscribe to theme change events (live updates when theme.json changes)
  useEffect(() => {
    const cleanupApp = window.electronAPI.onAppThemeChange((theme) => {
      setAppTheme(theme)
    })
    return () => {
      cleanupApp()
    }
  }, [])

  // Listen for session events - uses centralized event processor for consistent state transitions
  //
  // SOURCE OF TRUTH LOGIC:
  // - During streaming (atom.isProcessing = true): Atom is source of truth
  //   All events read from and write to atom. This preserves streaming data.
  // - When not streaming: React state is source of truth
  //   Events read/write React state, which syncs to atoms via useEffect.
  // - Handoff events (complete, error, etc.): End streaming, sync atom → React state
  //
  // This is simpler and more robust than checking event types - we just ask
  // "is this session currently streaming?" and route accordingly.
  useEffect(() => {
    // Handoff events signal end of streaming - need to sync back to React state
    // async_operation included so shimmer effect on session titles updates in real-time
    const handoffEventTypes = new Set(['complete', 'error', 'interrupted', 'typed_error', 'name_changed', 'title_generated', 'async_operation'])

    // Helper to handle side effects (same logic for both paths)
    const handleEffects = (effects: Effect[], sessionId: string, eventType: string) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'permission_request': {
            setPendingPermissions(prevPerms => {
              const next = new Map(prevPerms)
              const existingQueue = next.get(sessionId) || []
              next.set(sessionId, [...existingQueue, effect.request])
              return next
            })

            // Native notification for approval-required pauses (same gating as completion notifications)
            const notifySession = store.get(sessionAtomFamily(sessionId))
            if (notifySession && !notifySession.hidden) {
              const isAdminPrompt = effect.request.type === 'admin_approval'
              const promptBody = isAdminPrompt
                ? `Admin approval required: ${effect.request.appName || effect.request.toolName}`
                : `Permission required: ${effect.request.toolName}`
              showSessionNotification(notifySession, promptBody)
            }
            break
          }
          case 'permission_mode_changed': {
            if (typeof effect.modeVersion === 'number' && effect.changedAt && effect.changedBy) {
              applyPermissionModeState(effect.sessionId, {
                permissionMode: effect.permissionMode,
                modeVersion: effect.modeVersion,
                changedAt: effect.changedAt,
                changedBy: effect.changedBy,
              }, 'event')
            } else {
              // Backward compatibility: apply mode optimistically then reconcile authoritative state.
              setSessionOptions(prevOpts => {
                const next = new Map(prevOpts)
                const current = next.get(effect.sessionId) ?? defaultSessionOptions
                next.set(effect.sessionId, { ...current, permissionMode: effect.permissionMode })
                return next
              })
              void reconcilePermissionModeState(effect.sessionId)
            }
            break
          }
          case 'restore_input': {
            // Queued messages were removed from chat on abort — restore their text to the input field.
            // Append to existing draft (user may have started typing) rather than overwrite.
            const existingDraft = sessionDraftsRef.current.get(sessionId)
            const existingText = coerceInputText(existingDraft?.text)
            const restoredText = coerceInputText(effect.text)
            const restored = existingText
              ? `${existingText}\n\n${restoredText}`
              : restoredText
            handleInputChange(sessionId, restored)
            // handleInputChange updates the ref but ChatPage has local state.
            // Dispatch a custom event so ChatPage re-reads the draft.
            window.dispatchEvent(new CustomEvent('mortise:restore-input', {
              detail: { sessionId, text: restored },
            }))
            break
          }
          case 'toast_error': {
            toast.error(effect.message, { duration: 5000 })
            break
          }
        }
      }

      // Clear pending permissions on complete
      if (eventType === 'complete') {
        setPendingPermissions(prevPerms => {
          if (prevPerms.has(sessionId)) {
            const next = new Map(prevPerms)
            next.delete(sessionId)
            return next
          }
          return prevPerms
        })
      }
    }

    const cleanup = window.electronAPI.onSessionEvent((event: SessionEvent) => {
      if (!('sessionId' in event)) return

      const sessionId = event.sessionId
      const workspaceId = windowWorkspaceId ?? ''

      // Session lifecycle events are handled explicitly (not by the agent event processor).
      if (event.type === 'session_created') {
        window.electronAPI.getSessionMessages(sessionId)
          .then((createdSession: Session | null) => {
            if (createdSession) {
              const existingMeta = store.get(sessionMetaMapAtom).has(sessionId)
              if (existingMeta) {
                replaceLoadedSession(createdSession)
              } else {
                addSession(createdSession)
              }
              syncSessionOptionsFromSession(createdSession)
              return
            }
            return window.electronAPI.getSessions().then(initializeSessions)
          })
          .catch((error: unknown) => console.error('Failed to handle session_created event:', error))
        return
      }

      if (event.type === 'session_deleted') {
        removeSession(sessionId)
        return
      }

      if (isProjectionOwnedHostEvent(event.type)) {
        trackSessionActivity(sessionId)
        return
      }

      const agentEvent = normalizeSessionEvent(event)

      // Track activity for stale session watchdog
      trackSessionActivity(sessionId)

      // Dispatch window event when compaction completes
      // This allows FreeFormInput to sequence the plan execution message after compaction
      // Note: markCompactionComplete is called on the backend (sessions.ts) to ensure
      // it happens even if CMD+R occurs during compaction
      if (event.type === 'info' && event.statusType === 'compaction_complete') {
        window.dispatchEvent(new CustomEvent('mortise:compaction-complete', {
          detail: { sessionId }
        }))
      }

      // Check if session is currently streaming (atom is source of truth)
      const atomSession = store.get(sessionAtomFamily(sessionId))
      const isStreaming = atomSession?.isProcessing === true
      const isHandoff = handoffEventTypes.has(event.type)

      // During streaming OR for handoff events: use atom as source of truth
      // This ensures all events during streaming see the complete state
      if (isStreaming || isHandoff) {
        const currentSession = atomSession ?? null

        // Process the event
        const { session: updatedSession, effects } = processAgentEvent(
          agentEvent,
          currentSession,
          workspaceId
        )

        // Update atom directly (UI sees update immediately)
        updateSessionDirect(sessionId, () => updatedSession)

        // Handle side effects
        handleEffects(effects, sessionId, event.type)

        // Handle background task events
        handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

        // For handoff events, update metadata map for list display
        // NOTE: No sessionsAtom to sync - atom and metadata are the source of truth
        if (isHandoff) {
          // Update metadata map
          const metaMap = store.get(sessionMetaMapAtom)
          const newMetaMap = new Map(metaMap)
          newMetaMap.set(sessionId, extractSessionMeta(updatedSession))
          store.set(sessionMetaMapAtom, newMetaMap)

          // Show notification on complete (when window is not focused)
          // Skip hidden sessions (mini-agent sessions) - they shouldn't trigger notifications
          if (event.type === 'complete' && !updatedSession.hidden) {
            // Get the last assistant/plan message as preview
            const lastMessage = updatedSession.messages.findLast(
              m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
            )
            // Strip markdown so OS notifications display clean plain text
            const rawPreview = lastMessage?.content?.substring(0, 200) || undefined
            const preview = rawPreview ? stripMarkdown(rawPreview).substring(0, 100) || undefined : undefined
            showSessionNotification(updatedSession, preview)
          }
        }

        return
      }

      // Not streaming: use per-session atoms directly (no sessionsAtom)
      const currentSession = store.get(sessionAtomFamily(sessionId))

      const { session: updatedSession, effects } = processAgentEvent(
        agentEvent,
        currentSession,
        workspaceId
      )

      // Handle side effects
      handleEffects(effects, sessionId, event.type)

      // Handle background task events
      handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

      // Update per-session atom
      updateSessionDirect(sessionId, () => updatedSession)

      // Update metadata map
      const metaMap = store.get(sessionMetaMapAtom)
      const newMetaMap = new Map(metaMap)
      newMetaMap.set(sessionId, extractSessionMeta(updatedSession))
      store.set(sessionMetaMapAtom, newMetaMap)
    })

    return cleanup
  }, [
    processAgentEvent,
    trackSessionActivity,
    windowWorkspaceId,
    store,
    updateSessionDirect,
    replaceLoadedSession,
    showSessionNotification,
    initializeSessions,
    addSession,
    removeSession,
    syncSessionOptionsFromSession,
    applyPermissionModeState,
    reconcilePermissionModeState,
  ])

  // Transport reconnect recovery — refresh session metadata plus active/processing
  // session content after stale reconnects.
  useEffect(() => {
    const cleanup = window.electronAPI.onReconnected(async (isStale: boolean) => {
      if (!isStale) {
        // Server replayed buffered events — we're caught up, nothing to do
        console.info('[App] Reconnected with event replay — no refresh needed')
        return
      }

      console.warn('[App] Stale reconnect — refreshing session metadata and active/processing sessions')

      const refreshedMetaMap = await refreshSessionListMetadataFromServer({
        removeMissing: false,
        reason: 'stale-reconnect',
        selectedSessionId: sessionSelection.selected,
      })
      const metaMap = refreshedMetaMap ?? store.get(sessionMetaMapAtom)
      const refreshIds = getSessionsToRefreshAfterStaleReconnect(metaMap, sessionSelection.selected)
      let activeSessionRefreshed = false

      console.info(`[App] Stale reconnect — refreshing ${refreshIds.length} session(s):`, refreshIds)

      // Refresh full message content only for the active session plus any
      // session still marked processing after the metadata refresh.
      for (const sessionId of refreshIds) {
        let refreshResult = await refreshSessionFromServer(sessionId)
        if (refreshResult !== 'refreshed') {
          // Server may need time to restart session subprocess after reconnect,
          // or it may still be lazily loading session messages.
          for (const delay of [2000, 4000]) {
            console.warn(`[App] Retrying session refresh for ${sessionId} after ${delay}ms (${refreshResult})`)
            await new Promise(r => setTimeout(r, delay))
            refreshResult = await refreshSessionFromServer(sessionId)
            if (refreshResult === 'refreshed') break
          }
        }
        if (sessionId === sessionSelection.selected) {
          activeSessionRefreshed = refreshResult === 'refreshed'
        }
      }

      // Retry the Mortise-owned overlay when the normal refresh failed. Pi
      // transcript recovery is handled independently by usePiProjectionSync.
      if (sessionSelection.selected && !activeSessionRefreshed) {
        console.warn('[App] Active session overlay refresh failed after stale reconnect — forcing reload')
        await store.set(forceSessionMessagesReloadAtom, sessionSelection.selected)
      }

    })

    return cleanup
  }, [store, sessionSelection.selected, refreshSessionFromServer, refreshSessionListMetadataFromServer])

  // Listen for menu bar events
  useEffect(() => {
    const unsubNewChat = window.electronAPI.onMenuNewChat(() => {
      setMenuNewChatTrigger(n => n + 1)
    })
    const unsubSettings = window.electronAPI.onMenuOpenSettings(() => {
      handleOpenSettings()
    })
    const unsubShortcuts = window.electronAPI.onMenuKeyboardShortcuts(() => {
      navigate(routes.view.settings('shortcuts'))
    })
    return () => {
      unsubNewChat()
      unsubSettings()
      unsubShortcuts()
    }
  }, [])

  const handleCreateSession = useCallback(async (workspaceId: string, options?: import('../shared/types').CreateSessionOptions): Promise<Session> => {
    const session = await window.electronAPI.createSession(workspaceId, options)
    // Add to per-session atom and metadata map (no sessionsAtom)
    addSession(session)
    syncSessionOptionsFromSession(session)

    return session
  }, [addSession, syncSessionOptionsFromSession])

  // Deep link navigation is initialized later after handleInputChange is defined

  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation = false): Promise<boolean> => {
    // Show confirmation dialog before deleting (unless skipped or session is empty)
    if (!skipConfirmation) {
      // Check if session has any messages using session metadata from Jotai store
      // We use store.get() instead of closing over sessions to prevent memory leaks
      // (closures would retain the full sessions array with all messages)
      const metaMap = store.get(sessionMetaMapAtom)
      const meta = metaMap.get(sessionId)
      // Session is empty if it has no lastFinalMessageId (no assistant responses) and no name (set on first user message)
      const isEmpty = !meta || (!meta.lastFinalMessageId && !meta.name)

      if (!isEmpty) {
        const confirmed = await window.electronAPI.showDeleteSessionConfirmation(meta?.name || 'Untitled')
        if (!confirmed) return false
      }
    }

    await window.electronAPI.deleteSession(sessionId)
    // Remove from per-session atom and metadata map (no sessionsAtom)
    removeSession(sessionId)
    return true
  }, [store, removeSession])

  // Auto-delete handler for empty sessions (fire-and-forget, no confirmation)
  const handleAutoDeleteEmptySession = useCallback((sessionId: string) => {
    window.electronAPI.deleteSession(sessionId)
    removeSession(sessionId)
  }, [removeSession])

  /**
   * Set which session user is actively viewing (for unread state machine).
   * Called when user navigates to a session. Main process uses this to determine
   * whether to mark new assistant messages as unread.
   */
  const handleSetActiveViewingSession = useCallback((sessionId: string) => {
    // Optimistic UI update: clear hasUnread immediately
    updateSessionById(sessionId, { hasUnread: false })
    // Tell main process user is viewing this session
    window.electronAPI.sessionCommand(sessionId, { type: 'setActiveViewing', workspaceId: windowWorkspaceId ?? '' })
  }, [updateSessionById, windowWorkspaceId])

  const handleMarkSessionRead = useCallback((sessionId: string) => {
    // Update hasUnread flag (primary source of truth for NEW badge)
    // Also update lastReadMessageId for backwards compatibility
    updateSessionById(sessionId, (s) => {
      const lastFinalId = s.messages.findLast(
        m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
      )?.id
      return {
        hasUnread: false,
        ...(lastFinalId ? { lastReadMessageId: lastFinalId } : {}),
      }
    })
    window.electronAPI.sessionCommand(sessionId, { type: 'markRead' })
  }, [updateSessionById])

  const handleMarkSessionUnread = useCallback((sessionId: string) => {
    // Set hasUnread flag (primary source of truth for NEW badge)
    updateSessionById(sessionId, { hasUnread: true, lastReadMessageId: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'markUnread' })
  }, [updateSessionById])

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    updateSessionById(sessionId, { name })
    window.electronAPI.sessionCommand(sessionId, { type: 'rename', name })
  }, [updateSessionById])

  const prepareMessageAttachments = useCallback(async (
    storageId: string,
    attachments?: FileAttachment[],
  ): Promise<{
    storedAttachments?: StoredAttachment[]
    processedAttachments?: FileAttachment[]
    failedAttachmentNames: string[]
  }> => {
    if (!attachments?.length) return { failedAttachmentNames: [] }

    const totalAttachmentBytes = attachments.reduce((sum, attachment) => sum + (attachment.size || 0), 0)
    if (totalAttachmentBytes > ATTACHMENT_MESSAGE_TOTAL_LIMIT_BYTES) {
      throw new Error(`Attachments exceed the ${Math.round(ATTACHMENT_MESSAGE_TOTAL_LIMIT_BYTES / 1024 / 1024)} MiB per-message limit`)
    }
    const oversized = attachments.find(attachment => (attachment.size || 0) > ATTACHMENT_SINGLE_FILE_LIMIT_BYTES)
    if (oversized) {
      throw new Error(`"${oversized.name}" exceeds the ${Math.round(ATTACHMENT_SINGLE_FILE_LIMIT_BYTES / 1024 / 1024)} MiB single-file limit`)
    }

    const isAbsoluteLocalPath = (path: string) => /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(path)
    const isPathOnlyAttachment = (attachment: FileAttachment) => (
      !attachment.base64
      && !attachment.text
      && typeof attachment.path === 'string'
      && isAbsoluteLocalPath(attachment.path)
    )
    const attachmentsForStorage = windowRemoteWorkspaceId
      ? await Promise.all(attachments.map(async attachment => {
          if (!isPathOnlyAttachment(attachment)) return attachment
          try {
            const materialized = await window.electronAPI.readUserAttachment(attachment.path)
            if (!materialized) return attachment
            return {
              ...materialized,
              type: attachment.type || materialized.type,
              name: attachment.name || materialized.name,
              mimeType: attachment.mimeType || materialized.mimeType,
              size: attachment.size || materialized.size,
              thumbnailBase64: attachment.thumbnailBase64 ?? materialized.thumbnailBase64,
            }
          } catch (error) {
            console.warn(`Failed to materialize local attachment "${attachment.name}" for remote upload:`, error)
            return attachment
          }
        }))
      : attachments

    const storeResults = await Promise.allSettled(
      attachmentsForStorage.map(attachment => window.electronAPI.storeAttachment(storageId, attachment)),
    )
    const storedAttachments: StoredAttachment[] = []
    const successfulAttachments: FileAttachment[] = []
    const failedAttachmentNames: string[] = []
    storeResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        storedAttachments.push(result.value)
        successfulAttachments.push(attachmentsForStorage[index])
      } else {
        failedAttachmentNames.push(attachmentsForStorage[index].name)
        console.warn(`Failed to store attachment "${attachmentsForStorage[index].name}":`, result.reason)
      }
    })

    const processedAttachments = successfulAttachments.map((attachment, index) => {
      const stored = storedAttachments[index]
      return {
        ...attachment,
        storedPath: stored.storedPath,
        markdownPath: stored.markdownPath,
        base64: stored.resizedBase64 ?? attachment.base64,
      }
    })

    return {
      storedAttachments: storedAttachments.length > 0 ? storedAttachments : undefined,
      processedAttachments: processedAttachments.length > 0 ? processedAttachments : undefined,
      failedAttachmentNames,
    }
  }, [windowRemoteWorkspaceId])

  const buildMessageBadges = useCallback((
    message: string,
    externalBadges?: ContentBadge[],
  ): ContentBadge[] => {
    const mentionBadges = windowWorkspaceSlug
      ? extractBadges(message, skills, windowWorkspaceSlug)
      : []
    const badges: ContentBadge[] = [...(externalBadges || []), ...mentionBadges]

    const commandMatch = message.match(/^\/([a-z]+)(\s|$)/i)
    if (commandMatch && commandMatch[1].toLowerCase() === 'compact') {
      const commandText = commandMatch[0].trimEnd()
      badges.unshift({
        type: 'command',
        label: 'Compact',
        rawText: commandText,
        start: 0,
        end: commandText.length,
      })
    }

    const planExecuteMatch = message.match(/^(Read the plan at )(.+?)( and execute it\.?)$/i)
    if (planExecuteMatch) {
      const prefix = planExecuteMatch[1]
      const filePath = planExecuteMatch[2]
      badges.push({
        type: 'file',
        label: filePath.split('/').pop() || 'plan.md',
        rawText: filePath,
        filePath,
        start: prefix.length,
        end: prefix.length + filePath.length,
      })
    }

    return badges
  }, [skills, windowWorkspaceSlug])

  const handleSendMessage = useCallback(async (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], externalBadges?: ContentBadge[], midStreamSendIntent?: MidStreamSendIntent) => {
    let optimisticMessageId: string | null = null
    try {
      // Capture pre-send processing state so we can flag mid-stream sends
      // for the queued badge (#616 follow-up — covers Pi steer path which
      // returns status 'accepted', not 'queued').
      const sendingMidStream = store.get(sessionAtomFamily(sessionId))?.isProcessing === true

      const {
        storedAttachments,
        processedAttachments,
        failedAttachmentNames,
      } = await prepareMessageAttachments(sessionId, attachments)
      if (failedAttachmentNames.length > 0) {
        updateSessionById(sessionId, session => ({
          messages: [...session.messages, {
            id: generateMessageId(),
            role: 'warning' as const,
            content: `${failedAttachmentNames.length} attachment(s) could not be stored and will not be sent: ${failedAttachmentNames.join(', ')}`,
            timestamp: Date.now(),
          }],
        }))
      }
      const badges = buildMessageBadges(message, externalBadges)

      // Step 5: Create a Mortise-owned UI overlay keyed by the projected message.
      // Pi owns text and order; this carrier supplies persistent attachment paths,
      // badges, and optimistic queue state until projection confirmation arrives.
      optimisticMessageId = generateMessageId()
      const projectionAtom = piProjectionAtomFamily(sessionId)
      store.set(projectionAtom, current => insertOptimisticPiUser(current, optimisticMessageId!, message, storedAttachments?.map(attachment => ({
        id: attachment.id,
        name: attachment.name,
        mediaType: attachment.mimeType,
        size: attachment.size,
      }))))
      const userOverlayCarrier: Message = {
        id: optimisticMessageId,
        role: 'user',
        content: '',
        timestamp: Date.now(),
        attachments: storedAttachments,
        badges: badges.length > 0 ? badges : undefined,
        isPending: true,  // Optimistic - will be confirmed by backend
        isQueued: sendingMidStream,
      }

      // Optimistic UI update - upsert the overlay carrier and set processing state
      updateSessionById(sessionId, (s) => ({
        messages: upsertPiUserOverlayCarrier(s.messages, userOverlayCarrier),
        isProcessing: true,
        lastMessageAt: Date.now()
      }))

      // Step 6: Send to Pi with model attachments plus UI metadata for persistence
      await window.electronAPI.sendMessage(sessionId, message, processedAttachments, storedAttachments, {
        skillSlugs,
        badges: badges.length > 0 ? badges : undefined,
        optimisticMessageId,
        midStreamSendIntent,
      })
      updateSessionById(sessionId, (s) => ({
        messages: settlePiUserOverlayCarrier(s.messages, optimisticMessageId!),
      }))
      return true
    } catch (error) {
      console.error('Failed to send message:', error)
      if (optimisticMessageId) {
        const projectionAtom = piProjectionAtomFamily(sessionId)
        store.set(projectionAtom, current => removeOptimisticPiUser(current, optimisticMessageId!))
      }
      updateSessionById(sessionId, (s) => ({
        isProcessing: false,
        messages: optimisticMessageId
          ? removePiUserOverlayCarrier(s.messages, optimisticMessageId)
          : s.messages,
      }))
      return false
    }
  }, [buildMessageBadges, prepareMessageAttachments, store, updateSessionById])

  const handleCreateAndSendFirstTurn: AppShellContextType['onCreateAndSendFirstTurn'] = useCallback(async input => {
    const attachmentStagingId = input.attachments?.length
      ? `draft-${crypto.randomUUID()}`
      : undefined
    const {
      storedAttachments,
      processedAttachments,
      failedAttachmentNames,
    } = await prepareMessageAttachments(attachmentStagingId ?? 'unused-first-turn-staging', input.attachments)
    const badges = buildMessageBadges(input.message, input.sendOptions?.badges)
    let result
    try {
      result = await window.electronAPI.createAndSendFirstTurn({
        ...input,
        attachments: processedAttachments,
        storedAttachments,
        attachmentStagingId,
        sendOptions: {
          ...input.sendOptions,
          badges: badges.length > 0 ? badges : undefined,
        },
      })
    } catch (error) {
      if (attachmentStagingId) {
        await window.electronAPI.discardFirstTurnAttachmentStaging(input.workspaceId, attachmentStagingId).catch(() => undefined)
      }
      throw error
    }

    const session = failedAttachmentNames.length > 0
      ? {
          ...result.session,
          messages: [...result.session.messages, {
            id: generateMessageId(),
            role: 'warning' as const,
            content: `${failedAttachmentNames.length} attachment(s) could not be stored and will not be sent: ${failedAttachmentNames.join(', ')}`,
            timestamp: Date.now(),
          }],
        }
      : result.session
    addSession(session)
    syncSessionOptionsFromSession(session)
    return { ...result, session }
  }, [addSession, buildMessageBadges, prepareMessageAttachments, syncSessionOptionsFromSession])

  /**
   * Unified handler for all session option changes.
   * Handles persistence and backend sync for each option type.
   */
  const handleSessionOptionsChange = useCallback((sessionId: string, updates: SessionOptionUpdates) => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(sessionId) ?? defaultSessionOptions
      next.set(sessionId, mergeSessionOptions(current, updates))
      return next
    })

    // Handle persistence/backend for specific options
    if (updates.permissionMode !== undefined) {
      // Sync permission mode change with backend
      window.electronAPI.sessionCommand(sessionId, { type: 'setPermissionMode', mode: updates.permissionMode })
    }
    if (updates.thinkingLevel !== undefined) {
      // Sync thinking level change with backend (session-level, persisted)
      window.electronAPI.sessionCommand(sessionId, { type: 'setThinkingLevel', level: updates.thinkingLevel })
    }
  }, [sessionOptions])

  // Handle input draft changes per session with debounced persistence
  const draftSaveTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Cleanup draft save timers on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      draftSaveTimeoutRef.current.forEach(clearTimeout)
      draftSaveTimeoutRef.current.clear()
    }
  }, [])

  // Getter for draft text - reads from ref without triggering re-renders
  const getDraft = useCallback((sessionId: string): string => {
    const draft = sessionDraftsRef.current.get(sessionId) as unknown
    const text = draft && typeof draft === 'object'
      ? (draft as { text?: unknown }).text
      : draft
    return coerceInputText(text)
  }, [])

  // Getter for persisted attachment refs (path + name only — not hydrated files).
  // Consumers that need FileAttachment objects should call hydrateDraftAttachments.
  const getDraftAttachmentRefs = useCallback((sessionId: string): DraftAttachmentRef[] => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    return Array.isArray(attachments) ? attachments : []
  }, [])

  const hasDraft = useCallback((sessionId: string): boolean => {
    const draft = sessionDraftsRef.current.get(sessionId)
    return hasDraftContent({
      text: coerceInputText(draft?.text),
      attachments: draft?.attachments,
    })
  }, [])

  // Hydrate persisted attachment refs into full FileAttachment objects.
  //  - Track C (ref.content set): reconstruct directly from the inlined bytes.
  //  - Track P (path-only): re-read from disk via the readUserAttachment RPC.
  // Missing/moved files on Track P are silently dropped with a console warn — same
  // UX as any other editor draft restore when the backing file is gone.
  const hydrateDraftAttachments = useCallback(async (sessionId: string): Promise<FileAttachment[]> => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    const refs = Array.isArray(attachments) ? attachments : []
    if (refs.length === 0) return []
    const results = await Promise.all(
      refs.map(async (ref) => {
        if (ref.content) {
          return attachmentFromContentRef(ref)
        }
        try {
          const attachment = await window.electronAPI.readUserAttachment(ref.path)
          if (!attachment) {
            console.warn('[drafts] Attachment missing on restore, dropping:', ref.path)
            return null
          }
          return attachment
        } catch (err) {
          console.warn('[drafts] Failed to restore attachment, dropping:', ref.path, err)
          return null
        }
      })
    )
    return results.filter((a): a is FileAttachment => a !== null)
  }, [])

  // Write a debounced snapshot of the current ref entry to disk.
  const schedulePersistDraft = useCallback((sessionId: string) => {
    const existingTimeout = draftSaveTimeoutRef.current.get(sessionId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }
    const timeout = setTimeout(() => {
      const draft = sessionDraftsRef.current.get(sessionId) ?? { text: '' }
      window.electronAPI.setDraft(sessionId, draft)
      draftSaveTimeoutRef.current.delete(sessionId)
    }, DRAFT_SAVE_DEBOUNCE_MS)
    draftSaveTimeoutRef.current.set(sessionId, timeout)
  }, [])

  const handleInputChange = useCallback((sessionId: string, value: string) => {
    const text = coerceInputText(value)
    const existing = sessionDraftsRef.current.get(sessionId)
    const existingAttachments = Array.isArray(existing?.attachments) ? existing.attachments : []
    const nextDraft: SessionDraft = {
      text,
      ...(existingAttachments.length > 0
        ? { attachments: existingAttachments }
        : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  const handleAttachmentsChange = useCallback((sessionId: string, attachments: FileAttachment[]) => {
    const existing = sessionDraftsRef.current.get(sessionId)
    const refs: DraftAttachmentRef[] = []
    for (const a of attachments) {
      const ref = toDraftRef(a)
      if (ref) {
        refs.push(ref)
      } else {
        console.warn('[drafts] attachment exceeds per-draft size cap, not persisted:', a.name, a.size)
      }
    }
    const nextDraft: SessionDraft = {
      text: coerceInputText(existing?.text),
      ...(refs.length > 0 ? { attachments: refs } : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  // Open the workspace-scoped draft page. A real session is created only when
  // the first message is submitted from that page.
  const openNewChat = useCallback(async (params: NewChatActionParams = {}) => {
    if (!windowWorkspaceId) {
      console.warn('[App] Cannot open new chat: no workspace ID')
      return
    }

    navigate(routes.action.newSession(params))
  }, [windowWorkspaceId])

  const handleRespondToPermission = useCallback(async (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../shared/types').PermissionResponseOptions,
  ) => {
    const success = await window.electronAPI.respondToPermission(sessionId, requestId, allowed, alwaysAllow, options)

    if (success) {
      // Remove only the first permission from the queue (the one we just responded to)
      setPendingPermissions(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1) // Remove first item
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
      // Note: No need to force session refresh - per-session atoms update automatically
    } else {
      // Response failed (agent/session gone) - clear the permission anyway
      // to avoid UI being stuck with stale permission
      setPendingPermissions(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1)
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
    }
  }, [])

  // Centralized link interceptor: classifies file types and decides whether to
  // show an in-app preview overlay or open externally. Replaces the old
  // handleOpenFile/handleOpenUrl that always opened in external apps.
  const linkInterceptor = useLinkInterceptor({
    openFileExternal: async (path) => {
      try {
        await window.electronAPI.openFile(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open file:', error)
        toast.error(t('toast.failedToOpenFile'), {
          description: message,
        })
      }
    },
    openUrl: async (url) => {
      try {
        await window.electronAPI.openUrl(url)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open URL:', error)
        // The blocked-URL classifier already explains WHY and (for file:)
        // points the user at preview blocks. Don't append the generic
        // "use Open File instead" hint when the message already carries
        // that guidance.
        const hasRichGuidance = /URL blocked/.test(message)
        const tail = hasRichGuidance ? '' : '. If this is a local path, use Open File instead.'
        toast.error(t('toast.failedToOpenLink'), {
          description: `${message}${tail}`,
        })
      }
    },
    showInFolder: async (path) => {
      try {
        await window.electronAPI.showInFolder(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to show in folder:', error)
        toast.error(t("toast.failedToReveal", { fileManager: getFileManagerName() }), {
          description: message,
        })
      }
    },
    readFile: (path) => window.electronAPI.readFile(path),
    readFileDataUrl: (path) => window.electronAPI.readFileDataUrl(path),
    readFileBinary: (path) => window.electronAPI.readFileBinary(path),
  })

  const connectionState = useTransportConnectionState()
  const showTransportConnectionBanner = shouldShowTransportConnectionBanner(connectionState)

  useUiValidationStateBridge({
    appState,
    sessionsLoaded,
    sessionLoadError,
    splashHidden,
    workspaceId: windowWorkspaceId,
    workspaceTransitioning: workspaceTransition !== null,
    transport: connectionState,
  })

  const handleReconnectTransport = useCallback(() => {
    void window.electronAPI.reconnectTransport().catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.reconnectFailed'), { description: message })
    })
  }, [])

  const handleOpenFile = linkInterceptor.handleOpenFile
  const handleOpenUrl = linkInterceptor.handleOpenUrl

  const handleOpenSettings = useCallback(() => {
    navigate(routes.view.settings())
  }, [])

  const handleOpenKeyboardShortcuts = useCallback(() => {
    navigate(routes.view.settings('shortcuts'))
  }, [])

  const handleOpenStoredUserPreferences = useCallback(() => {
    navigate(routes.view.settings('preferences'))
  }, [])

  // Handle workspace selection
  // - Default: switch workspace in same window (in-window switching)
  // - With openInNewWindow=true: open in new window (or focus existing)
  const handleSelectWorkspace = useCallback(async (
    workspaceId: string,
    openInNewWindow = false,
    destination: WorkspaceSwitchDestination = 'restore',
  ) => {
    const transitionQueue = workspaceTransitionQueueRef.current!
    const currentWorkspaceId = windowWorkspaceIdRef.current
    const currentTransportWorkspaceId = transportWorkspaceIdRef.current ?? currentWorkspaceId

    // Selecting the stable current workspace is navigation, not a transport switch.
    if (
      workspaceId === currentWorkspaceId
      && workspaceId === currentTransportWorkspaceId
      && !transitionQueue.isRunning
    ) {
      if (!openInNewWindow) {
        if (destination === 'allSessions') navigate(routes.view.allSessions())
        else if (destination === 'newConversation') navigate(routes.view.newConversation())
        else if (typeof destination === 'object') navigate(routes.view.allSessions(destination.sessionId))
      }
      return
    }

    if (openInNewWindow) {
      // Open (or focus) the window for the selected workspace
      window.electronAPI.openWorkspace(workspaceId)
      return
    }

    return transitionQueue.enqueue(async () => {
      const activeWorkspaceId = windowWorkspaceIdRef.current
      const activeTransportWorkspaceId = transportWorkspaceIdRef.current ?? activeWorkspaceId
      if (workspaceId === activeWorkspaceId && workspaceId === activeTransportWorkspaceId) {
        if (destination === 'allSessions') navigate(routes.view.allSessions())
        else if (destination === 'newConversation') navigate(routes.view.newConversation())
        else if (typeof destination === 'object') navigate(routes.view.allSessions(destination.sessionId))
        return
      }

      // Capture one stable baseline for the entire coalesced transition series.
      // Intermediate transport targets never become renderer workspace state.
      if (!workspaceTransitionRollbackRef.current) {
        setWorkspaceTransition({
          sourceWorkspaceId: activeWorkspaceId,
          targetWorkspaceId: workspaceId,
        })
        await waitForRendererCommit()

        try {
          if (activeWorkspaceId) {
            await flushWorkspaceLayoutBeforeTransition(activeWorkspaceId)
          }
        } catch (error) {
          setWorkspaceTransition(null)
          throw error
        }

        const previousPanelStack = store.get(panelStackAtom)
        const previousFocusedPanelId = store.get(focusedPanelIdAtom)
        const previousSessionMetaMap = store.get(sessionMetaMapAtom)
        const previousSessionIds = store.get(sessionIdsAtom)
        const previousSessionSelection = sessionSelectionRef.current
        workspaceTransitionBaselineIdRef.current = activeWorkspaceId
        workspaceTransitionRollbackRef.current = () => {
          store.set(panelStackAtom, previousPanelStack)
          store.set(focusedPanelIdAtom, previousFocusedPanelId)
          store.set(sessionMetaMapAtom, previousSessionMetaMap)
          store.set(sessionIdsAtom, previousSessionIds)
          setSession(previousSessionSelection)
          setSessionsLoaded(true)
          setWorkspaceSwitchDestination(null)
        }

        // Unmount old session panels before the transport changes workspace.
        setSession(createInitialState())
        store.set(panelStackAtom, [])
        store.set(focusedPanelIdAtom, null)
        store.set(sessionMetaMapAtom, new Map())
        store.set(sessionIdsAtom, [])
        setSessionsLoaded(false)
        setSessionLoadError(null)
        await waitForRendererCommit()
      } else {
        setWorkspaceTransition(previous => previous
          ? { ...previous, targetWorkspaceId: workspaceId }
          : { sourceWorkspaceId: activeWorkspaceId, targetWorkspaceId: workspaceId })
      }

      try {
        if (workspaceId !== (transportWorkspaceIdRef.current ?? windowWorkspaceIdRef.current)) {
          await window.electronAPI.switchWorkspace(workspaceId)
          transportWorkspaceIdRef.current = workspaceId
        }
      } catch (error) {
        const baselineWorkspaceId = workspaceTransitionBaselineIdRef.current
        if (baselineWorkspaceId && transportWorkspaceIdRef.current !== baselineWorkspaceId) {
          try {
            await window.electronAPI.switchWorkspace(baselineWorkspaceId)
            transportWorkspaceIdRef.current = baselineWorkspaceId
          } catch (rollbackError) {
            rendererLog.error('[App] Failed to roll back workspace transport', {
              baselineWorkspaceId,
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            })
          }
        }
        workspaceTransitionRollbackRef.current?.()
        workspaceTransitionRollbackRef.current = null
        workspaceTransitionBaselineIdRef.current = null
        setWorkspaceTransition(null)
        throw error
      }

      // A newer request will continue from the updated transport. Do not expose
      // this intermediate target to React, where it would trigger stale effects.
      if (transitionQueue.hasPending) return

      // Commit renderer state only for the final target.
      const transitionCommit = resolveWorkspaceTransitionCommit(
        workspaceTransitionBaselineIdRef.current,
        windowWorkspaceIdRef.current,
        workspaceId,
      )
      const { rendererWorkspaceChanged } = transitionCommit
      if (transitionCommit.restoreBaseline) {
        workspaceTransitionRollbackRef.current?.()
      }
      setWorkspaceSwitchDestination(destination)
      windowWorkspaceIdRef.current = workspaceId
      setWindowWorkspaceId(workspaceId)

      // Clear workspace-scoped transient state.
      if (rendererWorkspaceChanged) {
        setPendingPermissions(new Map())
        setSessionOptions(new Map())
        store.set(skillsAtom, [])
      }

      // Complete the transition only after the target workspace's session
      // response has passed the ownership check and committed atomically.
      await loadSessionsFromServer(workspaceId)
      if (!rendererWorkspaceChanged) {
        if (destination === 'allSessions') {
          navigate(routes.view.allSessions())
        } else if (destination === 'newConversation') {
          navigate(routes.view.newConversation())
        } else if (typeof destination === 'object') {
          navigate(routes.view.allSessions(destination.sessionId))
        }
        setWorkspaceSwitchDestination(null)
      }
      workspaceTransitionRollbackRef.current = null
      workspaceTransitionBaselineIdRef.current = null
      setWorkspaceTransition(null)

      // Note: NavigationContext detects the workspaceId change and handles
      // panel restoration from the stored workspace URL (or defaults to allSessions).
    })
  }, [loadSessionsFromServer, setWindowWorkspaceId, setSession, store])

  // Handle workspace switch by slug (called by NavigationContext on popstate when ?ws= changes)
  const handleSwitchWorkspaceBySlug = useCallback((slug: string) => {
    const target = workspaces.find(w => w.slug === slug)
    if (target) {
      handleSelectWorkspace(target.id)
    }
  }, [workspaces, handleSelectWorkspace])

  // Handle workspace refresh (e.g., after icon upload)
  const handleRefreshWorkspaces = useCallback(async () => {
    setWorkspaces(await window.electronAPI.getWorkspaces())
  }, [])

  useEffect(() => window.electronAPI.onWorkspaceRemoteServerUpdated(() => {
    void handleRefreshWorkspaces()
  }), [handleRefreshWorkspaces])

  // Handle cancel during onboarding
  const handleOnboardingCancel = useCallback(() => {
    onboarding.handleCancel()
  }, [onboarding])

  // Build context value for AppShell component
  // This is memoized to prevent unnecessary re-renders
  // IMPORTANT: Must be before early returns to maintain consistent hook order
  const appShellContextValue = useMemo<AppShellContextType>(() => ({
    // Data
    // NOTE: sessions is NOT included - use sessionMetaMapAtom for listing
    // and useSession(id) hook for individual sessions. This prevents memory leaks.
    workspaces,
    activeWorkspaceId: windowWorkspaceId,
    workspaceTransition,
    sessionsLoaded,
    activeWorkspaceSlug: windowWorkspaceSlug,
    piProviders,
    piGlobalSettings,
    refreshPiGlobalConfig,
    pendingPermissions,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    sessionOptions,
    // Session callbacks
    onCreateSession: handleCreateSession,
    onCreateAndSendFirstTurn: handleCreateAndSendFirstTurn,
    onSendMessage: handleSendMessage,
    onRenameSession: handleRenameSession,
    onMarkSessionRead: handleMarkSessionRead,
    onMarkSessionUnread: handleMarkSessionUnread,
    onSetActiveViewingSession: handleSetActiveViewingSession,
    onDeleteSession: handleDeleteSession,
    onRespondToPermission: handleRespondToPermission,
    // File/URL handlers
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // Workspace
    onSelectWorkspace: handleSelectWorkspace,
    onRefreshWorkspaces: handleRefreshWorkspaces,
    // App actions
    onOpenSettings: handleOpenSettings,
    onOpenKeyboardShortcuts: handleOpenKeyboardShortcuts,
    onOpenStoredUserPreferences: handleOpenStoredUserPreferences,
    // Session options
    onSessionOptionsChange: handleSessionOptionsChange,
    onInputChange: handleInputChange,
    onAttachmentsChange: handleAttachmentsChange,
    // New chat (via deep link navigation)
    openNewChat,
  }), [
    // NOTE: sessions removed to prevent memory leaks - components use atoms instead
    workspaces,
    windowWorkspaceId,
    workspaceTransition,
    sessionsLoaded,
    windowWorkspaceSlug,
    piProviders,
    piGlobalSettings,
    refreshPiGlobalConfig,
    pendingPermissions,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    sessionOptions,
    handleCreateSession,
    handleCreateAndSendFirstTurn,
    handleSendMessage,
    handleRenameSession,
    handleMarkSessionRead,
    handleMarkSessionUnread,
    handleSetActiveViewingSession,
    handleDeleteSession,
    handleRespondToPermission,
    handleOpenFile,
    handleOpenUrl,
    handleSelectWorkspace,
    handleRefreshWorkspaces,
    handleOpenSettings,
    handleOpenKeyboardShortcuts,
    handleOpenStoredUserPreferences,
    handleSessionOptionsChange,
    handleInputChange,
    handleAttachmentsChange,
    openNewChat,
  ])

  // Platform actions for @mortise/ui components (overlays, etc.)
  // Memoized to prevent re-renders when these callbacks don't change
  // NOTE: Must be defined before early returns to maintain consistent hook order
  const platformActions = useMemo(() => ({
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrl,
    // Bypass link interceptor — opens file directly in system editor.
    // Used by overlay header badges (when already viewing a file, "Open" should launch editor).
    onOpenFileExternal: linkInterceptor.openFileExternal,
    // Read file contents as UTF-8 string (used by datatable/spreadsheet/html-preview src fields)
    onReadFile: (path: string) => window.electronAPI.readFile(path),
    // Read file as data URL (used by image-preview blocks)
    onReadFileDataUrl: (path: string) => window.electronAPI.readFileDataUrl(path),
    // Read file as binary Uint8Array (used by PDF preview blocks)
    onReadFileBinary: (path: string) => window.electronAPI.readFileBinary(path),
    // Reveal a file in the system file manager (Finder on macOS, Explorer on Windows, etc.)
    onRevealInFinder: (path: string) => {
      window.electronAPI.showInFolder(path).catch(() => {})
    },
    // Platform-specific file manager name for UI labels
    fileManagerName: getFileManagerName(),
    // Hide/show macOS traffic lights when fullscreen overlays are open
    onSetTrafficLightsVisible: (visible: boolean) => {
      window.electronAPI.setTrafficLightsVisible(visible)
    },
  }), [handleOpenFile, handleOpenUrl, linkInterceptor.openFileExternal])

  // Loading state - show splash screen
  if (appState === 'loading') {
    return <SplashScreen isExiting={false} />
  }

  // Reauth state - session expired, need to re-login
  // ModalProvider + WindowCloseHandler ensures X button works on Windows
  if (appState === 'reauth') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <ReauthScreen
            onLogin={handleReauthLogin}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Onboarding state
  // ModalProvider + WindowCloseHandler ensures X button works on Windows
  // (without this, the close IPC message has no listener and window stays open)
  if (appState === 'onboarding') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <OnboardingWizard
            state={onboarding.state}
            onContinue={onboarding.handleContinue}
            onBack={onboarding.handleBack}
            onSelectProvider={onboarding.handleSelectProvider}
            onSkipSetup={onboarding.handleSkipSetup}
            onSelectApiSetupMethod={onboarding.handleSelectApiSetupMethod}
            onSubmitCredential={onboarding.handleSubmitCredential}
            onSubmitLocalModel={onboarding.handleSubmitLocalModel}
            onFinish={onboarding.handleFinish}
            onBrowseGitBash={onboarding.handleBrowseGitBash}
            onUseGitBashPath={onboarding.handleUseGitBashPath}
            onRecheckGitBash={onboarding.handleRecheckGitBash}
            onClearError={onboarding.handleClearError}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Workspace picker — thin client with no workspace selected
  if (appState === 'workspace-picker') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <WorkspacePicker
            onSelectWorkspace={async (id) => {
              await window.electronAPI.switchWorkspace(id)
              setWindowWorkspaceId(id)
              setAppState('ready')
            }}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Show splash until exit animation completes
  const showSplash = !splashHidden

  // Ready state - main app with splash overlay during data loading
  return (
    <PlatformProvider actions={platformActions}>
    <ShikiThemeProvider shikiTheme={shikiTheme}>
      <ActionRegistryProvider>
      <FocusProvider>
        <DismissibleLayerProvider>
        <ModalProvider>
        <TooltipProvider delayDuration={0}>
        <NavigationProvider
          workspaceId={windowWorkspaceId}
          workspaceSlug={windowWorkspaceSlug}
          onSwitchWorkspaceBySlug={handleSwitchWorkspaceBySlug}
          onCreateAndSendFirstTurn={handleCreateAndSendFirstTurn}
          onInputChange={handleInputChange}
          getDraft={getDraft}
          hasDraft={hasDraft}
          onAutoDeleteEmptySession={handleAutoDeleteEmptySession}
          isReady={appState === 'ready'}
          isSessionsReady={sessionsLoaded}
          areDraftsReady={draftsLoaded}
          remoteWorkspaceId={windowRemoteWorkspaceId}
          workspaceSwitchDestination={workspaceSwitchDestination}
          onWorkspaceSwitchDestinationConsumed={() => setWorkspaceSwitchDestination(null)}
        >
          {/* Handle window close requests (X button, Cmd+W) - close modal first if open */}
          <WindowCloseHandler />

          {/* Splash screen overlay - fades out when fully ready */}
          {showSplash && (
            <SplashScreen
              isExiting={splashExiting}
              onExitComplete={handleSplashExitComplete}
            />
          )}

          {/* Main UI - always rendered, splash fades away to reveal it */}
          <div
            className="h-full flex flex-col text-foreground"
            style={{ paddingTop: 'var(--topbar-height)' }}
          >
            {showTransportConnectionBanner && connectionState && (
              <TransportConnectionBanner
                state={connectionState}
                onRetry={handleReconnectTransport}
              />
            )}
            <div className="flex-1 min-h-0">
              {sessionLoadError ? (
                <SessionLoadErrorScreen
                  message={sessionLoadError}
                  onRetry={() => { void loadSessionsFromServer() }}
                />
              ) : (
                <AppShell
                  contextValue={appShellContextValue}
                  defaultLayout={[20, 32, 48]}
                  menuNewChatTrigger={menuNewChatTrigger}
                  isFocusedMode={isFocusedMode}
                />
              )}
            </div>
          </div>

          {/* File preview overlay — rendered by the link interceptor when a previewable file is clicked */}
          {linkInterceptor.previewState && (
            <FilePreviewRenderer
              state={linkInterceptor.previewState}
              onClose={linkInterceptor.closePreview}
              loadDataUrl={linkInterceptor.readFileDataUrl}
              loadPdfData={linkInterceptor.readFileBinary}
              isDark={isDark}
            />
          )}
        </NavigationProvider>
        </TooltipProvider>
        </ModalProvider>
        </DismissibleLayerProvider>
      </FocusProvider>
      </ActionRegistryProvider>
    </ShikiThemeProvider>
    </PlatformProvider>
  )
}

/**
 * Component that handles window close requests.
 * Must be inside ModalProvider to access the modal registry.
 */
function WindowCloseHandler() {
  useWindowCloseHandler()
  return null
}

/**
 * FilePreviewRenderer - Routes file preview state to the correct overlay component.
 *
 * Handles all preview types from the link interceptor:
 * - image → ImagePreviewOverlay (binary, loaded via data URL)
 * - pdf → PDFPreviewOverlay (binary, embedded via Chromium viewer)
 * - code/text → CodePreviewOverlay (syntax highlighted)
 * - markdown → DocumentFormattedMarkdownOverlay
 * - json → JSONPreviewOverlay
 *
 * File path badges with "Open" / "Reveal in {file manager}" menus are provided
 * automatically by PlatformContext — no per-overlay callback props needed.
 */
function FilePreviewRenderer({
  state,
  onClose,
  loadDataUrl,
  loadPdfData,
  isDark,
}: {
  state: FilePreviewState
  onClose: () => void
  loadDataUrl: (path: string) => Promise<string>
  loadPdfData: (path: string) => Promise<Uint8Array>
  isDark: boolean
}) {
  const theme = isDark ? 'dark' : 'light' as const

  switch (state.type) {
    case 'image':
      return (
        <ImagePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadDataUrl={loadDataUrl}
          theme={theme}
        />
      )

    case 'pdf':
      return (
        <PDFPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadPdfData={loadPdfData}
          theme={theme}
        />
      )

    case 'code':
    case 'text':
      return (
        <CodePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          content={state.content ?? ''}
          language={state.type === 'code' ? state.language : 'plaintext'}
          mode="read"
          theme={theme}
          error={state.error}
        />
      )

    case 'markdown': {
      // Show PLAN header for .md files in plans folder (handles both absolute and relative paths)
      const isPlanFile =
        (state.filePath.includes('/plans/') || state.filePath.startsWith('plans/')) &&
        state.filePath.endsWith('.md')
      return (
        <DocumentFormattedMarkdownOverlay
          isOpen
          onClose={onClose}
          content={state.content ?? ''}
          filePath={state.filePath}
          variant={isPlanFile ? 'plan' : 'response'}
        />
      )
    }

    case 'json': {
      // JSONPreviewOverlay expects parsed data, not a raw string.
      // @uiw/react-json-view crashes on null value, so guard against it.
      let parsedData: unknown = null
      try {
        if (state.content) parsedData = JSON.parse(state.content)
      } catch {
        // If parsing fails, fall back to showing as code
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      // If read failed and content is empty, show raw code overlay with the read error.
      if ((!state.content || !state.content.trim()) && state.error) {
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      return (
        <JSONPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          title={state.filePath.split('/').pop() ?? 'JSON'}
          data={parsedData}
          theme={theme}
          error={state.error}
        />
      )
    }

    default:
      return null
  }
}
