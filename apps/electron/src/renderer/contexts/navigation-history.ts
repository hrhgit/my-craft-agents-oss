import type { SessionsNavigationState } from '../../shared/types'

interface SemanticHistoryKeyInput {
  workspaceSlug: string | null
  panelRoutes: string[]
  focusedPanelIndex: number
  pageSurfaceRoute?: string | null
}

interface InitialRestoreGateInput {
  isReady: boolean
  isSessionsReady: boolean
  workspaceId: string | null
  initialRouteRestored: boolean
}

export type WorkspaceSwitchDestination = 'restore' | 'allSessions' | 'newConversation' | { sessionId: string }

interface WorkspaceSwitchSearchInput {
  destination: WorkspaceSwitchDestination | null | undefined
  savedSearch: string
  workspaceSlug: string
}

/**
 * Builds a semantic history key used to dedupe pushState entries.
 *
 * Includes focused panel index so states with duplicate routes remain distinct
 * when focus moves between panels.
 */
export function buildSemanticHistoryKey({
  workspaceSlug,
  panelRoutes,
  focusedPanelIndex,
  pageSurfaceRoute = null,
}: SemanticHistoryKeyInput): string {
  return [
    workspaceSlug ?? '',
    pageSurfaceRoute ?? '',
    panelRoutes.join('|'),
    String(focusedPanelIndex),
  ].join('::')
}

/**
 * Returns whether initial route restoration is allowed to run.
 */
export function canRunInitialRestore({
  isReady,
  isSessionsReady,
  workspaceId,
  initialRouteRestored,
}: InitialRestoreGateInput): boolean {
  return isReady && isSessionsReady && !!workspaceId && !initialRouteRestored
}

export function shouldAutoSelectSessionOnLoad({
  suppressed,
  isReady,
  workspaceId,
  panelCount,
  state,
}: {
  suppressed: boolean
  isReady: boolean
  workspaceId: string | null
  panelCount: number
  state: SessionsNavigationState
}): boolean {
  return !suppressed && isReady && !!workspaceId && panelCount > 0 && !state.details
}

export function shouldNavigateToInitialDefault(params: URLSearchParams): boolean {
  if (params.has('route') || params.has('panels')) return false
  const layoutWindowId = params.get('layoutWindowId')
  const isCoordinatedAuxiliary = layoutWindowId !== null
    && layoutWindowId !== 'primary'
    && params.get('layoutReadOnly') !== '1'
  return !isCoordinatedAuxiliary
}

export function resolveWorkspaceSwitchSearch({
  destination,
  savedSearch,
  workspaceSlug,
}: WorkspaceSwitchSearchInput): string {
  if (destination && typeof destination === 'object' && destination.sessionId) {
    const params = new URLSearchParams({
      ws: workspaceSlug,
      route: `allSessions/session/${destination.sessionId}`,
    })
    return `?${params.toString()}`
  }
  if (destination === 'newConversation') {
    const params = new URLSearchParams({ ws: workspaceSlug, route: 'allSessions/new/default' })
    return `?${params.toString()}`
  }
  if (destination !== 'allSessions' && savedSearch) return savedSearch
  const params = new URLSearchParams({ ws: workspaceSlug, route: 'allSessions' })
  return `?${params.toString()}`
}
