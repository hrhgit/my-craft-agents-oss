import { parseRouteToNavigationState } from '../../shared/route-parser'
import type { ViewRoute } from '../../shared/routes'
import type { NavigationState } from '../../shared/types'

/**
 * Page surfaces are application or workspace management flows. They own their
 * navigation inside the page and never participate in the workspace dock.
 */
export function isPageSurfaceNavigation(state: NavigationState | null): boolean {
  return state !== null && state.navigator !== 'sessions'
}

export function isPageSurfaceRoute(route: string | null | undefined): route is ViewRoute {
  return Boolean(route && isPageSurfaceNavigation(parseRouteToNavigationState(route)))
}

export function isWorkspacePanelRoute(route: string | null | undefined): route is ViewRoute {
  if (!route) return false
  return parseRouteToNavigationState(route)?.navigator === 'sessions'
}

export function resolveVisibleRoute(
  pageSurfaceRoute: ViewRoute | null,
  focusedPanelRoute: ViewRoute | null,
): ViewRoute | null {
  return pageSurfaceRoute ?? focusedPanelRoute
}

export function shouldEncodePanelStack(panelCount: number, pageSurfaceRoute: ViewRoute | null): boolean {
  return panelCount > 1 || (pageSurfaceRoute !== null && panelCount > 0)
}
