/**
 * Navigation helpers
 *
 * Small pure helpers over `NavigationState`. Keep these stateless and free of
 * React/Jotai imports — they're consumed both inside hooks (PanelStackContainer)
 * and in synchronous callbacks (CompactBackButton).
 */

import type { NavigationState } from '../../shared/types'

/**
 * Desktop conversations use the workspace-first primary sidebar, so they do
 * not need a duplicate session-list navigator. Management modules retain
 * their list/category navigator beside the selected detail content.
 */
export function resolveNavigatorWidth(
  navState: NavigationState,
  isCompact: boolean,
  configuredWidth: number,
): number {
  if (isCompact) return configuredWidth
  return navState.navigator === 'sessions' ? 0 : configuredWidth
}

/**
 * Returns true when the focused panel's nav state is in "detail" mode —
 * i.e. the user has drilled past the navigator into a specific item.
 *
 * Used by compact-mode logic to flip the layout from navigator-only to
 * content-only with a back-button overlay.
 *
 * Per-navigator semantics:
 * - sessions: a session is selected
 * - settings: a subpage is selected (bare `settings` route → false)
 * - sources / skills / automations: a detail item is selected
 */
export function isDetailNavState(navState: NavigationState | null): boolean {
  if (!navState) return false
  switch (navState.navigator) {
    case 'sessions':
      return navState.details !== null
    case 'settings':
      return navState.subpage !== null
    case 'sources':
    case 'skills':
    case 'automations':
      return navState.details !== null
  }
}
