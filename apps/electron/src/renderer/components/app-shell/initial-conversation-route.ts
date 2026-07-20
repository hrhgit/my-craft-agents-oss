import { parseRouteToNavigationState } from '../../../shared/route-parser'
import type { PanelStackEntry } from '@/atoms/panel-stack'

export interface InitialConversationRouteConsumer {
  consume: () => PanelStackEntry['route'] | null
}

export function createInitialConversationRouteConsumer(search: string): InitialConversationRouteConsumer {
  const route = new URLSearchParams(search).get('route')
  const state = route ? parseRouteToNavigationState(route) : null
  let pending = state?.navigator === 'sessions' && state.details?.type === 'new'
    ? route as PanelStackEntry['route']
    : null

  return {
    consume: () => {
      const current = pending
      pending = null
      return current
    },
  }
}

export function resolveLivePanelRoute(
  entries: readonly PanelStackEntry[],
  activeDockTabId: string | null,
  focusedPanelId: string | null,
): PanelStackEntry['route'] | null {
  const liveFocusedId = activeDockTabId ?? focusedPanelId
  if (liveFocusedId) return entries.find(entry => entry.id === liveFocusedId)?.route ?? null
  return entries[0]?.route ?? null
}
