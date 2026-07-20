/**
 * NavigationContext
 *
 * Provides a global `navigate()` function that decouples components from
 * direct session/action imports. All navigation goes through typed routes.
 *
 * ROOT PAGE + WORKSPACE DOCK MODEL:
 * Session routes belong to the workspace dock. Management routes belong to a
 * root page surface and leave the focused dock tab unchanged underneath.
 *
 * URL-DRIVEN HISTORY:
 * The URL is the source of truth. Every meaningful navigation pushes a
 * browser history entry via pushState. Back/forward uses the browser's
 * native popstate, with smart panel reconciliation to preserve React keys
 * (and thus scroll position, streaming state, etc.).
 *
 * Usage:
 *   import { useNavigation, useNavigationState } from '@/contexts/NavigationContext'
 *   import { routes } from '@/shared/routes'
 *
 *   const { navigate } = useNavigation()
 *   const navState = useNavigationState()
 *
 *   navigate(routes.view.allSessions())
 *   navigate(routes.action.newChat())
 */

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { useSessionSelectionStore } from '@/hooks/useSession'
import { createInitialState, singleSelect } from '@/hooks/useMultiSelect'
import {
  parseRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
  type ParsedRoute,
} from '../../shared/route-parser'
import { routes, type Route, type ViewRoute } from '../../shared/routes'
import { parsePermissionMode } from '@mortise/shared/agent/mode-types'
import { NAVIGATE_EVENT, type NavigateOptions } from '../lib/navigate'
import { waitForRendererCommit } from '../lib/workspace-transition'
import {
  createNewConversationDraftId,
  getNewConversationDraftStorageKey,
} from '../lib/new-conversation'
import { normalizePanelRouteForReconcile } from './navigation-reconcile'
import { buildSemanticHistoryKey, canRunInitialRestore, resolveWorkspaceSwitchSearch, shouldAutoSelectSessionOnLoad, shouldNavigateToInitialDefault, type WorkspaceSwitchDestination } from './navigation-history'
import {
  isPageSurfaceNavigation,
  isPageSurfaceRoute,
  isWorkspacePanelRoute,
  resolveVisibleRoute,
  shouldEncodePanelStack,
} from './navigation-surface'
import * as storage from '@/lib/local-storage'
import type {
  DeepLinkNavigation,
  NavigationState,
  SessionFilter,
  ContentBadge,
} from '../../shared/types'
import {
  isSessionsNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
  DEFAULT_NAVIGATION_STATE,
} from '../../shared/types'
import { sessionMetaMapAtom, updateSessionMetaAtom, type SessionMeta } from '@/atoms/sessions'
import { skillsAtom } from '@/atoms/skills'
import {
  panelStackAtom,
  pushPanelAtom,
  reconcilePanelStackAtom,
  focusedPanelIdAtom,
  focusedPanelRouteAtom,
  focusedPanelIndexAtom,
  updateFocusedPanelRouteAtom,
  parseSessionIdFromRoute,
} from '@/atoms/panel-stack'

// Re-export routes for convenience
export { routes }
export type { Route }

// Re-export navigation state types for consumers
export type { NavigationState, SessionFilter }
export { isSessionsNavigation, isSettingsNavigation, isSkillsNavigation, isAutomationsNavigation }

// =============================================================================
// Context
// =============================================================================

interface NavigationContextValue {
  /** Navigate to a route */
  navigate: (route: Route, options?: NavigateOptions) => void | Promise<void>
  /** Check if navigation is ready */
  isReady: boolean
  /** Visible root-page or focused workspace navigation state. */
  navigationState: NavigationState
  /** Whether we can go back in history */
  canGoBack: boolean
  /** Whether we can go forward in history */
  canGoForward: boolean
  /** Go back in history */
  goBack: () => void
  /** Go forward in history */
  goForward: () => void
  /** Navigate to a session, preserving the current filter type */
  navigateToSession: (sessionId: string) => void
}

export const NavigationContext = createContext<NavigationContextValue | null>(null)

interface NavigationProviderProps {
  children: ReactNode
  /** Current workspace ID */
  workspaceId: string | null
  /** Current workspace slug (used for URL ?ws= param and localStorage) */
  workspaceSlug: string | null
  /** Switch to a workspace by slug (called on popstate when ?ws= changes) */
  onSwitchWorkspaceBySlug?: (slug: string) => void
  /** Ordinary first turn transaction; resolves only after the Session is published. */
  onCreateAndSendFirstTurn: (
    input: import('@mortise/shared/protocol').CreateAndSendFirstTurnRequest,
  ) => Promise<import('@mortise/shared/protocol').CreateAndSendFirstTurnResult>
  /** Input change handler for pre-filling chat input */
  onInputChange?: (sessionId: string, value: string) => void
  /** Get draft input text for a session (reads from ref, no re-render) */
  getDraft?: (sessionId: string) => string
  /** Whether a draft has text or attachments. */
  hasDraft?: (sessionId: string) => boolean
  /** Auto-delete an empty session (no confirmation needed) */
  onAutoDeleteEmptySession?: (sessionId: string) => void
  /** Whether the app is ready to navigate */
  isReady?: boolean
  /** Whether session metadata has been initialized (required for deterministic route restoration) */
  isSessionsReady?: boolean
  /** Whether persisted drafts are available for deferred-session cleanup decisions. */
  areDraftsReady?: boolean
  /** Remote workspace ID — when set, sessions with this ID are also considered part of the workspace */
  remoteWorkspaceId?: string | null
  /** One-shot destination for an explicit workspace list selection. */
  workspaceSwitchDestination?: WorkspaceSwitchDestination | null
  onWorkspaceSwitchDestinationConsumed?: () => void
}

export function NavigationProvider({
  children,
  workspaceId,
  workspaceSlug,
  onSwitchWorkspaceBySlug,
  onCreateAndSendFirstTurn,
  onInputChange,
  getDraft,
  hasDraft,
  onAutoDeleteEmptySession,
  isReady = true,
  isSessionsReady = true,
  areDraftsReady = true,
  remoteWorkspaceId,
  workspaceSwitchDestination,
  onWorkspaceSwitchDestinationConsumed,
}: NavigationProviderProps) {
  const { t } = useTranslation()
  const { setState: setSession } = useSessionSelectionStore()

  // Read session metadata directly from atom (reactive to session changes)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMetas = useMemo(() => Array.from(sessionMetaMap.values()), [sessionMetaMap])
  const updateSessionMeta = useSetAtom(updateSessionMetaAtom)

  const pushPanel = useSetAtom(pushPanelAtom)

  // Store reference for reading fresh atom values in callbacks (avoids stale closures)
  const store = useStore()

  // Read skills from atom (populated by AppShell)
  const skills = useAtomValue(skillsAtom)

  // =========================================================================
  // DERIVED NAVIGATION STATE
  // =========================================================================

  const focusedRoute = useAtomValue(focusedPanelRouteAtom)
  const [pageSurfaceRoute, setPageSurfaceRouteState] = useState<ViewRoute | null>(null)
  const pageSurfaceRouteRef = useRef<ViewRoute | null>(null)
  const setPageSurfaceRoute = useCallback((route: ViewRoute | null) => {
    pageSurfaceRouteRef.current = route
    setPageSurfaceRouteState(route)
  }, [])

  // Management modules own a root page surface. The focused dock route stays
  // intact underneath it and becomes active again when the page closes.
  const navigationState: NavigationState = useMemo(() => {
    const visibleRoute = resolveVisibleRoute(pageSurfaceRoute, focusedRoute)
    return visibleRoute
      ? parseRouteToNavigationState(visibleRoute) ?? DEFAULT_NAVIGATION_STATE
      : DEFAULT_NAVIGATION_STATE
  }, [focusedRoute, pageSurfaceRoute])

  // =========================================================================
  // BROWSER HISTORY TRACKING
  // =========================================================================

  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  // Sequence numbers stored in history.state for tracking position
  const historySeqRef = useRef(0)                // Current history position
  const historyMaxSeqRef = useRef(0)              // Highest pushed seq (for canGoForward)
  const nextHistorySeqRef = useRef(1)             // Next seq to assign on pushState

  // Suppress pushState in atom subscriptions during restore/reconciliation
  const suppressPushRef = useRef(false)

  // Coalesce compound atom writes (e.g. pushPanelAtom sets both panelStackAtom
  // and focusedPanelIdAtom) into a single pushState via microtask debounce
  const pendingPushRef = useRef(false)

  // Flag: workspace switch was triggered by popstate (URL already correct)
  const isPopstateSwitchRef = useRef(false)

  // Queue navigation if not ready yet
  const pendingNavigationRef = useRef<Route | null>(null)

  // Suppress auto-select for one cycle (used by skipAutoSelect to prevent the effect from re-selecting)
  const suppressAutoSelectRef = useRef(false)

  // Track whether initial route restoration has been attempted
  const initialRouteRestoredRef = useRef(false)

  // Semantic key for the last history entry we intentionally pushed/reconciled.
  // Excludes layout-only values (like panel proportions) so resize does not create history entries.
  const lastSemanticHistoryKeyRef = useRef('')
  const suppressPushReleaseGenerationRef = useRef(0)

  const updateCanGoBackForward = useCallback(() => {
    setCanGoBack(historySeqRef.current > 0)
    setCanGoForward(historySeqRef.current < historyMaxSeqRef.current)
  }, [])

  const getSemanticHistoryKey = useCallback(() => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    return buildSemanticHistoryKey({
      workspaceSlug,
      pageSurfaceRoute: pageSurfaceRouteRef.current,
      panelRoutes: panels.map(p => p.route),
      focusedPanelIndex: focusedIdx,
    })
  }, [store, workspaceSlug])

  const releaseSuppressPushAfterCommit = useCallback(() => {
    const generation = ++suppressPushReleaseGenerationRef.current
    void waitForRendererCommit().then(() => {
      if (generation !== suppressPushReleaseGenerationRef.current) return
      suppressPushRef.current = false
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    })
  }, [getSemanticHistoryKey])

  // =========================================================================
  // URL SYNC (builds URL from current state, push or replace)
  // =========================================================================

  /**
   * Build the current URL from atom state and either push or replace.
   *
   * push=true: creates a new browser history entry (meaningful navigation)
   * push=false: updates the current entry (resize, auto-select, etc.)
   *
   * Also persists the URL per-workspace in localStorage for workspace switch restoration.
   */
  const syncUrl = useCallback((push: boolean = false) => {
    const panels = store.get(panelStackAtom)
    const focusedIdx = store.get(focusedPanelIndexAtom)
    const focusedPanel = panels[focusedIdx] ?? panels[0] ?? null
    const visibleRoute = resolveVisibleRoute(pageSurfaceRouteRef.current, focusedPanel?.route ?? null)
    if (!visibleRoute) return
    const url = new URL(window.location.href)

    // ?ws= workspace slug
    if (workspaceSlug) {
      url.searchParams.set('ws', workspaceSlug)
    }

    // ?route= is the visible page route. While a management page is open,
    // ?panels= preserves the hidden workspace dock without making it visible.
    url.searchParams.set('route', visibleRoute)

    // ?panels= encodes ALL panels in stack order
    if (shouldEncodePanelStack(panels.length, pageSurfaceRouteRef.current)) {
      const encoded = panels.map(p => `${p.route}:${p.proportion.toFixed(4)}`).join(',')
      url.searchParams.set('panels', encoded)
    } else {
      url.searchParams.delete('panels')
    }

    // ?fi= is focused panel index (for multi-panel layouts)
    if (panels.length > 1) {
      url.searchParams.set('fi', String(focusedIdx))
    } else {
      url.searchParams.delete('fi')
    }

    // Drop the retired sidebar query parameter while normalizing old saved URLs.
    url.searchParams.delete('sidebar')

    const urlStr = url.toString()

    if (push) {
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', urlStr)
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq // Forward history discarded by browser
      updateCanGoBackForward()
    } else {
      history.replaceState({ ...history.state, seq: historySeqRef.current }, '', urlStr)
    }

    // Persist per-workspace URL for workspace switch restoration
    if (workspaceSlug) {
      storage.set(storage.KEYS.workspaceUrl, url.search, workspaceSlug)
    }
  }, [store, workspaceSlug, updateCanGoBackForward])

  const syncUrlRef = useRef(syncUrl)
  useEffect(() => { syncUrlRef.current = syncUrl }, [syncUrl])

  const maybePushHistoryForSemanticChange = useCallback(() => {
    const currentSemanticKey = getSemanticHistoryKey()
    if (currentSemanticKey === lastSemanticHistoryKeyRef.current) return

    syncUrlRef.current?.(true)
    lastSemanticHistoryKeyRef.current = currentSemanticKey
  }, [getSemanticHistoryKey])

  // replaceState sync when panel stack or focus changes (catches resize, etc.)
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  useEffect(() => {
    if (!initialRouteRestoredRef.current) return
    syncUrlRef.current(false)
  }, [panelStack, focusedPanelId])

  // =========================================================================
  // ATOM SUBSCRIPTIONS FOR pushState (meaningful navigation)
  // =========================================================================

  // Panel stack changes: push history on add/remove/route change (NOT resize)
  useEffect(() => {
    let prevRoutes = store.get(panelStackAtom).map(p => p.route)
    const unsub = store.sub(panelStackAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const currRoutes = store.get(panelStackAtom).map(p => p.route)
      if (currRoutes.length !== prevRoutes.length || !currRoutes.every((r, i) => r === prevRoutes[i])) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
      }
      prevRoutes = currRoutes
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

  // Root page changes are meaningful navigation even though the dock model is
  // deliberately untouched.
  const previousPageSurfaceRouteRef = useRef(pageSurfaceRoute)
  useEffect(() => {
    if (previousPageSurfaceRouteRef.current === pageSurfaceRoute) return
    previousPageSurfaceRouteRef.current = pageSurfaceRoute
    if (suppressPushRef.current || !initialRouteRestoredRef.current) return
    if (pendingPushRef.current) return
    pendingPushRef.current = true
    queueMicrotask(() => {
      pendingPushRef.current = false
      maybePushHistoryForSemanticChange()
    })
  }, [maybePushHistoryForSemanticChange, pageSurfaceRoute])

  // Focus changes: push history when active panel changes
  useEffect(() => {
    let prevFocusId = store.get(focusedPanelIdAtom)
    const unsub = store.sub(focusedPanelIdAtom, () => {
      if (suppressPushRef.current || !initialRouteRestoredRef.current) return
      const newFocusId = store.get(focusedPanelIdAtom)
      if (newFocusId !== prevFocusId) {
        if (!pendingPushRef.current) {
          pendingPushRef.current = true
          queueMicrotask(() => { pendingPushRef.current = false; maybePushHistoryForSemanticChange() })
        }
        prevFocusId = newFocusId
      }
    })
    return unsub
  }, [store, maybePushHistoryForSemanticChange])

  // =========================================================================
  // RECONCILE PANELS FROM URL PARAMS
  // =========================================================================

  /**
   * Parse URL search params and reconcile the panel stack.
   * Uses reconcilePanelStackAtom for smart matching (preserves React keys).
   */
  const reconcileFromUrlParams = useCallback(
    (params: URLSearchParams) => {
      const initialRoute = params.get('route')
      const panelsParam = params.get('panels')
      const focusedIndexParam = params.get('fi')
      const initialNavState = initialRoute ? parseRouteToNavigationState(initialRoute) : null
      let nextPageSurfaceRoute: ViewRoute | null = null

      if (initialRoute && isPageSurfaceNavigation(initialNavState)) {
        const resolved = resolveAutoSelectionRef.current(initialNavState!)
        nextPageSurfaceRoute = buildRouteFromNavigationState(resolved) as ViewRoute
      }

      // Parse panel entries from URL
      let entries: { route: ViewRoute; proportion: number }[] = []
      let focusedIndex = 0

      if (panelsParam) {
        // Canonical format: ?panels= contains ALL panels, ?fi= is focused index.
        // We intentionally no longer support older mixed route/panels formats.
        entries = panelsParam.split(',').filter(Boolean).map(entry => {
          const colonIdx = entry.lastIndexOf(':')
          if (colonIdx > 0) {
            const proportion = parseFloat(entry.slice(colonIdx + 1))
            if (!isNaN(proportion) && proportion > 0 && proportion <= 1) {
              const rawRoute = entry.slice(0, colonIdx) as ViewRoute
              const route = normalizePanelRouteForReconcile(rawRoute, (state) => resolveAutoSelectionRef.current(state))
              return { route, proportion }
            }
          }
          const rawRoute = entry as ViewRoute
          const route = normalizePanelRouteForReconcile(rawRoute, (state) => resolveAutoSelectionRef.current(state))
          return { route, proportion: 0 }
        })

        const hasProportions = entries.some(e => e.proportion > 0)
        if (!hasProportions) {
          const equal = 1 / entries.length
          entries.forEach(e => { e.proportion = equal })
        } else {
          const total = entries.reduce((s, e) => s + e.proportion, 0)
          if (total > 0 && Math.abs(total - 1) > 0.001) {
            entries.forEach(e => { e.proportion = e.proportion / total })
          }
        }

        focusedIndex = focusedIndexParam != null ? (parseInt(focusedIndexParam, 10) || 0) : 0
      } else if (initialRoute && !isPageSurfaceRoute(initialRoute)) {
        // Single panel from ?route=
        const navState = parseRouteToNavigationState(initialRoute)
        if (navState) {
          const finalRoute = ('details' in navState && navState.details)
            ? (initialRoute as ViewRoute)
            : (buildRouteFromNavigationState(resolveAutoSelectionRef.current(navState)) as ViewRoute)
          entries = [{ route: finalRoute, proportion: 1 }]
        }
      }

      if (nextPageSurfaceRoute && !entries.some(entry => isWorkspacePanelRoute(entry.route))) {
        const fallbackState = resolveAutoSelectionRef.current(DEFAULT_NAVIGATION_STATE)
        entries = [{
          route: buildRouteFromNavigationState(fallbackState) as ViewRoute,
          proportion: 1,
        }]
      }

      setPageSurfaceRoute(nextPageSurfaceRoute)

      if (entries.length > 0) {
        store.set(reconcilePanelStackAtom, { entries, focusedIndex })
      }
    },
    [setPageSurfaceRoute, store]
  )

  // Keep ref fresh for use in event handlers / effects that capture stale closures
  const reconcileFromUrlParamsRef = useRef(reconcileFromUrlParams)
  useEffect(() => { reconcileFromUrlParamsRef.current = reconcileFromUrlParams }, [reconcileFromUrlParams])

  // =========================================================================
  // EMPTY SESSION CLEANUP (reactive — covers navigate, close tab, etc.)
  // =========================================================================

  // Track which session IDs are visible across all panels. When a session ID
  // disappears (navigate away, close tab, Cmd+W), check if it was empty and
  // auto-delete it. This is the single codepath for all navigate-away cleanup.
  const prevVisibleSessionIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const currentPanelStack = store.get(panelStackAtom)
    const currentIds = new Set<string>()
    for (const entry of currentPanelStack) {
      const sessionId = parseSessionIdFromRoute(entry.route)
      if (sessionId) currentIds.add(sessionId)
    }

    if (!isSessionsReady || !areDraftsReady) {
      prevVisibleSessionIdsRef.current = currentIds
      return
    }

    const draftHasContent = (sessionId: string) => (
      hasDraft?.(sessionId) ?? Boolean(getDraft?.(sessionId)?.trim())
    )

    // Only check after we've seen at least one set of IDs
    // (skip first render to avoid false positives during initialization)
    if (onAutoDeleteEmptySession && prevVisibleSessionIdsRef.current.size > 0) {
      for (const prevId of prevVisibleSessionIdsRef.current) {
        if (!currentIds.has(prevId)) {
          const meta = store.get(sessionMetaMapAtom).get(prevId)
          const isEmpty = meta && !meta.lastFinalMessageId && !meta.name && !meta.isProcessing
          if (isEmpty && !draftHasContent(prevId)) {
            onAutoDeleteEmptySession(prevId)
          }
        }
      }
    }

    prevVisibleSessionIdsRef.current = currentIds
  }, [areDraftsReady, getDraft, hasDraft, isSessionsReady, onAutoDeleteEmptySession, panelStack, sessionMetas, store, workspaceId])

  // =========================================================================
  // SESSION SELECTION SYNC
  // =========================================================================

  // Keep the global session selection in sync with the focused panel
  useEffect(() => {
    if (isSessionsNavigation(navigationState) && navigationState.details?.type === 'session') {
      setSession(singleSelect(navigationState.details.sessionId, -1))
      if (workspaceId) {
        // Only persist if the session belongs to this workspace (prevents cross-workspace
        // pollution during workspace switch, when workspaceId changed but navigationState
        // still reflects the old workspace's focused panel)
        const meta = store.get(sessionMetaMapAtom).get(navigationState.details.sessionId)
        if (meta && meta.workspaceId === workspaceId) {
          storage.set(storage.KEYS.lastSelectedSessionId, navigationState.details.sessionId, workspaceId)
        }
      }
    } else if (isSessionsNavigation(navigationState) && navigationState.details?.type === 'new') {
      setSession(createInitialState())
    }
  }, [navigationState, setSession, workspaceId, store])

  // =========================================================================
  // HELPERS
  // =========================================================================

  // Helper: Filter sessions by SessionFilter
  // Always excludes hidden sessions - they should never appear in navigation
  const filterSessionsByFilter = useCallback(
    (filter: SessionFilter): SessionMeta[] => {
      // First filter out hidden sessions - they should never appear in any view
      const visibleSessions = sessionMetas.filter(
        s => !s.hidden && (!workspaceId || s.workspaceId === workspaceId)
      )

      return visibleSessions
    },
    [sessionMetas, workspaceId]
  )

  const getFirstSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      const filtered = filterSessionsByFilter(filter)
      return filtered[0]?.id ?? null
    },
    [filterSessionsByFilter]
  )

  const getLastSelectedSessionId = useCallback(
    (filter: SessionFilter): string | null => {
      if (!workspaceId) return null
      const storedId = storage.get<string | null>(
        storage.KEYS.lastSelectedSessionId,
        null,
        workspaceId
      )
      if (!storedId) return null
      const filtered = filterSessionsByFilter(filter)
      return filtered.some(session => session.id === storedId) ? storedId : null
    },
    [workspaceId, filterSessionsByFilter]
  )

  const getFirstSkillSlug = useCallback(
    (): string | null => {
      return skills[0]?.slug ?? null
    },
    [skills]
  )

  // =========================================================================
  // AUTO-SELECTION (pure computation, no side effects)
  // =========================================================================

  /**
   * Resolve auto-selection for a NavigationState.
   * When navigating to a filter without explicit details, auto-select the
   * first available item. Returns the final state (no side effects).
   */
  const resolveAutoSelection = useCallback(
    (newState: NavigationState, options?: { skipAutoSelect?: boolean }): NavigationState => {
      let nextState = newState

      // Validate session exists in current workspace (local or remote ID)
      if (isSessionsNavigation(nextState) && nextState.details?.type === 'session') {
        const freshMetaMap = store.get(sessionMetaMapAtom)
        const meta = freshMetaMap.get(nextState.details.sessionId)
        const matchesWorkspace = !workspaceId
          || meta?.workspaceId === workspaceId
          || (remoteWorkspaceId && meta?.workspaceId === remoteWorkspaceId)
        if (meta && !matchesWorkspace) {
          nextState = { ...nextState, details: null }
        }
      }

      // Sessions: auto-select last/first session
      if (isSessionsNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
        const lastSelectedSessionId = getLastSelectedSessionId(nextState.filter)
        const fallbackSessionId = lastSelectedSessionId ?? getFirstSessionId(nextState.filter)
        if (fallbackSessionId) {
          return { ...nextState, details: { type: 'session', sessionId: fallbackSessionId } }
        }
        return nextState
      }

      // Skills: auto-select first skill
      if (isSkillsNavigation(nextState) && !nextState.details && !options?.skipAutoSelect) {
        const firstSkillSlug = getFirstSkillSlug()
        if (firstSkillSlug) {
          return { ...nextState, details: { type: 'skill', skillSlug: firstSkillSlug } }
        }
        return nextState
      }

      return nextState
    },
    [store, workspaceId, remoteWorkspaceId, getLastSelectedSessionId, getFirstSessionId, getFirstSkillSlug]
  )

  // Ref keeps resolveAutoSelection fresh for reconcileFromUrlParams (defined earlier in the file)
  const resolveAutoSelectionRef = useRef(resolveAutoSelection)
  useEffect(() => { resolveAutoSelectionRef.current = resolveAutoSelection }, [resolveAutoSelection])

  // =========================================================================
  // ACTION NAVIGATION
  // =========================================================================

  const handleActionNavigation = useCallback(
    async (parsed: ParsedRoute, options?: { newPanel?: boolean; targetLaneId?: 'main' }) => {
      if (!workspaceId) return

      switch (parsed.name) {
        case 'new-session': {
          const draftId = options?.newPanel ? createNewConversationDraftId() : 'default'
          const draftRoute = routes.view.newConversation(draftId) as ViewRoute
          setPageSurfaceRoute(null)

          if (options?.newPanel) {
            pushPanel({
              route: draftRoute,
              intent: 'explicit',
            })
          } else {
            store.set(updateFocusedPanelRouteAtom, draftRoute)
          }

          const draftStorageKey = getNewConversationDraftStorageKey(workspaceId, draftId)

          // Parse badges from params
          let badges: ContentBadge[] | undefined
          if (parsed.params.badges) {
            try {
              badges = JSON.parse(parsed.params.badges) as ContentBadge[]
            } catch (e) {
              console.warn('[Navigation] Failed to parse badges param:', e)
            }
          }

          // Explicit programmatic send remains supported. Ordinary UI actions
          // stop here and do not create a Session.
          if (parsed.params.input) {
            const shouldSend = parsed.params.send === 'true'
            if (shouldSend) {
              const createOptions: import('../../shared/types').CreateSessionOptions = {
                name: parsed.params.name,
              }
              const parsedMode = parsed.params.mode ? parsePermissionMode(parsed.params.mode) : undefined
              if (parsedMode) createOptions.permissionMode = parsedMode
              if (parsed.params.workdir) createOptions.workingDirectory = parsed.params.workdir
              if (parsed.params.model) createOptions.model = parsed.params.model
              if (parsed.params.systemPrompt) createOptions.systemPromptPreset = parsed.params.systemPrompt
              onInputChange?.(draftStorageKey, parsed.params.input)
              try {
                const { session } = await onCreateAndSendFirstTurn({
                  workspaceId,
                  message: parsed.params.input,
                  createOptions,
                  sendOptions: badges ? { badges } : undefined,
                })
                onInputChange?.(draftStorageKey, '')
                store.set(updateFocusedPanelRouteAtom, routes.view.allSessions(session.id) as ViewRoute)
              } catch (error) {
                console.error('[Navigation] Failed to create and send programmatic session:', error)
                toast.error(t('toast.failedToCreateSession', 'Failed to create session'))
              }
            } else if (onInputChange) {
              onInputChange(draftStorageKey, parsed.params.input)
            }
          }
          break
        }

        case 'rename-session':
          if (parsed.id && parsed.params.name) {
            await window.electronAPI.sessionCommand(parsed.id, { type: 'rename', name: parsed.params.name })
          }
          break

        case 'delete-session':
          if (parsed.id) {
            await window.electronAPI.deleteSession(parsed.id)
          }
          break

        case 'set-mode':
          if (parsed.id && parsed.params.mode) {
            const parsedMode = parsePermissionMode(parsed.params.mode)
            if (!parsedMode) {
              console.warn('[Navigation] Invalid permission mode:', parsed.params.mode)
              break
            }
            await window.electronAPI.sessionCommand(
              parsed.id,
              { type: 'setPermissionMode', mode: parsedMode }
            )
          }
          break

        case 'copy':
          if (parsed.params.text) {
            await navigator.clipboard.writeText(parsed.params.text)
          }
          break

        default:
          console.warn('[Navigation] Unknown action:', parsed.name)
      }
    },
    [workspaceId, onCreateAndSendFirstTurn, onInputChange, pushPanel, setPageSurfaceRoute, store, t, updateSessionMeta]
  )

  // =========================================================================
  // NAVIGATE
  // =========================================================================

  const navigate = useCallback(
    async (route: Route, options?: NavigateOptions) => {
      // Reset auto-select suppression on any normal navigation
      if (!options?.skipAutoSelect) {
        suppressAutoSelectRef.current = false
      }

      const parsed = parseRoute(route)
      if (!parsed) {
        console.warn('[Navigation] Invalid route:', route)
        return
      }

      if (!isReady) {
        pendingNavigationRef.current = route
        return
      }

      // Handle actions (side effects)
      if (parsed.type === 'action') {
        await handleActionNavigation(parsed, options)
        return
      }

      // Parse route to NavigationState. Bare `settings` produces `subpage: null` —
      // navigator-only view in compact mode, App-page fallback on desktop. We
      // intentionally do NOT auto-redirect to the last-visited subpage; doing so
      // would defeat the compact-mode drill-in UX.
      const newNavState = parseRouteToNavigationState(route)

      // Suppress auto-select effect
      if (options?.skipAutoSelect) {
        suppressAutoSelectRef.current = true
      }

      if (newNavState) {
        // Resolve auto-selection (pure — no side effects)
        const resolvedState = resolveAutoSelection(newNavState, options)
        const finalRoute = buildRouteFromNavigationState(resolvedState) as ViewRoute

        // Persist last selected session for auto-select on next visit
        if (isSessionsNavigation(resolvedState) && resolvedState.details?.type === 'session' && workspaceId) {
          storage.set(storage.KEYS.lastSelectedSessionId, resolvedState.details.sessionId, workspaceId)
        }

        if (isPageSurfaceNavigation(resolvedState)) {
          setPageSurfaceRoute(finalRoute)
          return
        }

        // Returning to workspace content restores the existing dock. Explicit
        // new-panel opens are meaningful only for workspace-owned content.
        setPageSurfaceRoute(null)
        if (options?.newPanel) {
          pushPanel({ route: finalRoute, intent: 'explicit' })
        } else {
          store.set(updateFocusedPanelRouteAtom, finalRoute)
        }
      }
    },
    [isReady, handleActionNavigation, resolveAutoSelection, setPageSurfaceRoute, store, pushPanel, workspaceId]
  )

  // =========================================================================
  // BACK / FORWARD (browser history)
  // =========================================================================

  const goBack = useCallback(() => {
    history.back()
  }, [])

  const goForward = useCallback(() => {
    history.forward()
  }, [])

  // =========================================================================
  // POPSTATE HANDLER (browser back/forward)
  // =========================================================================

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      // Update sequence tracking
      const eventSeq = event.state?.seq ?? 0
      historySeqRef.current = eventSeq
      updateCanGoBackForward()

      // Read state from URL (the browser already navigated to it)
      const params = new URLSearchParams(window.location.search)
      const wsSlug = params.get('ws')

      // Check if workspace changed
      if (wsSlug && wsSlug !== workspaceSlug && onSwitchWorkspaceBySlug) {
        // Workspace boundary crossed — trigger workspace switch
        // The workspace switch effect will handle reconciliation
        isPopstateSwitchRef.current = true
        onSwitchWorkspaceBySlug(wsSlug)
        return
      }

      if (!isSessionsReady) {
        // Session metadata is not initialized yet; initial restore will reconcile
        // current URL state once metadata is available.
        return
      }

      // Same workspace — reconcile panels from the URL
      suppressPushRef.current = true
      reconcileFromUrlParamsRef.current(params)
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
      releaseSuppressPushAfterCommit()
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [workspaceSlug, onSwitchWorkspaceBySlug, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady, releaseSuppressPushAfterCommit])

  // =========================================================================
  // WORKSPACE SWITCH
  // =========================================================================

  const previousWorkspaceSlugRef = useRef<string | null>(null)

  useEffect(() => {
    if (!workspaceId || !workspaceSlug || !isSessionsReady) return

    if (previousWorkspaceSlugRef.current === null) {
      // First mount — initial route restoration handles it
      previousWorkspaceSlugRef.current = workspaceSlug
      return
    }

    if (previousWorkspaceSlugRef.current === workspaceSlug) return
    previousWorkspaceSlugRef.current = workspaceSlug

    // Suppress pushState during reconciliation
    suppressPushRef.current = true

    if (isPopstateSwitchRef.current) {
      // Popstate-triggered: URL is already correct, just reconcile from it
      isPopstateSwitchRef.current = false
      reconcileFromUrlParamsRef.current(new URLSearchParams(window.location.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    } else {
      // UI-triggered: load stored URL for the new workspace, push history entry
      const savedSearch = storage.get<string>(storage.KEYS.workspaceUrl, '', workspaceSlug)

      const url = new URL(window.location.href)
      url.search = resolveWorkspaceSwitchSearch({
        destination: workspaceSwitchDestination,
        savedSearch,
        workspaceSlug,
      })

      // Push a new history entry for the workspace switch
      const seq = nextHistorySeqRef.current++
      history.pushState({ seq }, '', url.toString())
      historySeqRef.current = seq
      historyMaxSeqRef.current = seq
      updateCanGoBackForward()

      // Reconcile panels from the new URL
      reconcileFromUrlParamsRef.current(new URLSearchParams(url.search))
      lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()
    }
    onWorkspaceSwitchDestinationConsumed?.()

    initialRouteRestoredRef.current = true

    releaseSuppressPushAfterCommit()
  }, [workspaceId, workspaceSlug, store, updateCanGoBackForward, getSemanticHistoryKey, isSessionsReady, workspaceSwitchDestination, onWorkspaceSwitchDestinationConsumed, releaseSuppressPushAfterCommit])

  // =========================================================================
  // INITIAL ROUTE RESTORATION (CMD+R reload)
  // =========================================================================

  useEffect(() => {
    if (!canRunInitialRestore({
      isReady,
      isSessionsReady,
      workspaceId,
      initialRouteRestored: initialRouteRestoredRef.current,
    })) return
    initialRouteRestoredRef.current = true

    // Suppress pushState during initial restoration
    suppressPushRef.current = true

    const params = new URLSearchParams(window.location.search)

    // Reconcile panels + sidebar from current URL
    reconcileFromUrlParamsRef.current(params)
    lastSemanticHistoryKeyRef.current = getSemanticHistoryKey()

    // If nothing was in the URL, navigate to default
    if (shouldNavigateToInitialDefault(params)) {
      navigate(routes.view.newConversation())
    }

    // Initialize history with seq=0 (replaceState so we don't create an extra entry)
    history.replaceState({ seq: 0 }, '', window.location.href)
    historySeqRef.current = 0
    historyMaxSeqRef.current = 0

    releaseSuppressPushAfterCommit()
  }, [isReady, isSessionsReady, workspaceId, navigate, store, getSemanticHistoryKey, releaseSuppressPushAfterCommit])

  // =========================================================================
  // PENDING NAVIGATION
  // =========================================================================

  useEffect(() => {
    if (isReady && pendingNavigationRef.current) {
      const pending = pendingNavigationRef.current
      pendingNavigationRef.current = null
      void navigate(pending)
    }
  }, [isReady, navigate])

  // =========================================================================
  // DEEP LINK LISTENER
  // =========================================================================

  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onDeepLinkNavigate((nav: DeepLinkNavigation) => {
      let route: string | null = null

      if (nav.view) {
        route = nav.view
      } else if (nav.action) {
        route = `action/${nav.action}`
        if (nav.actionParams?.id) {
          route += `/${nav.actionParams.id}`
        }
        const otherParams = { ...nav.actionParams }
        delete otherParams.id
        if (Object.keys(otherParams).length > 0) {
          const params = new URLSearchParams(otherParams)
          route += `?${params.toString()}`
        }
      }

      if (route) {
        const navState = parseRouteToNavigationState(route)
        if (!navState && !route.startsWith('action/')) {
          toast.error(t('toast.invalidLink'), {
            description: t('toast.invalidLinkDesc'),
          })
          return
        }
        navigate(route as Route)
      }
    })

    return cleanup
  }, [workspaceId, navigate])

  // =========================================================================
  // INTERNAL NAVIGATION EVENT LISTENER
  // =========================================================================

  useEffect(() => {
    const handleNavigateEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ route: Route; newPanel?: boolean; targetLaneId?: 'main' }>
      if (customEvent.detail?.route) {
        const { route: r, newPanel, targetLaneId } = customEvent.detail
        navigate(r, newPanel ? { newPanel, targetLaneId } : undefined)
      }
    }

    window.addEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    return () => {
      window.removeEventListener(NAVIGATE_EVENT, handleNavigateEvent)
    }
  }, [navigate])

  // =========================================================================
  // PRESERVE-FILTER NAVIGATION HELPERS
  // =========================================================================

  const navigateToSession = useCallback((sessionId: string) => {
    if (!isSessionsNavigation(navigationState)) {
      navigate(routes.view.allSessions(sessionId))
      return
    }

    navigate(routes.view.allSessions(sessionId))
  }, [navigationState, navigate])

  // =========================================================================
  // AUTO-SELECT ON SESSION LOAD
  // =========================================================================

  useEffect(() => {
    if (pageSurfaceRouteRef.current) return
    const liveRoute = store.get(focusedPanelRouteAtom)
    const liveNavigationState = liveRoute ? parseRouteToNavigationState(liveRoute) : navigationState
    if (!liveNavigationState || !isSessionsNavigation(liveNavigationState)) return
    if (!shouldAutoSelectSessionOnLoad({
      suppressed: suppressAutoSelectRef.current,
      isReady,
      workspaceId,
      panelCount: store.get(panelStackAtom).length,
      state: liveNavigationState,
    })) return

    const lastSelectedSessionId = getLastSelectedSessionId(liveNavigationState.filter)
    const fallbackSessionId = lastSelectedSessionId ?? getFirstSessionId(liveNavigationState.filter)
    if (!fallbackSessionId) return

    navigateToSession(fallbackSessionId)
  }, [
    isReady,
    workspaceId,
    navigationState,
    getLastSelectedSessionId,
    getFirstSessionId,
    navigateToSession,
  ])

  // =========================================================================
  // CONTEXT VALUE
  // =========================================================================

  return (
    <NavigationContext.Provider
      value={{
        navigate,
        isReady,
        navigationState,
        canGoBack,
        canGoForward,
        goBack,
        goForward,
        navigateToSession,
      }}
    >
      {children}
    </NavigationContext.Provider>
  )
}

/**
 * Hook to access navigation functions
 */
export function useNavigation() {
  const context = useContext(NavigationContext)
  if (!context) {
    throw new Error('useNavigation must be used within NavigationProvider')
  }
  return context
}

/**
 * Hook to access just the navigation state
 */
export function useNavigationState(): NavigationState {
  const { navigationState } = useNavigation()
  return navigationState
}
