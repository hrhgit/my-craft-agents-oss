import { Actions, Model, TabNode, type Action } from 'flexlayout-react'
import type { CompactDockViewIntent } from '@/atoms/panel-stack'

export function resolveCompactDockDetailActive(input: {
  isCompact: boolean
  routeHasDetail: boolean
  intent: CompactDockViewIntent
}): boolean {
  if (!input.isCompact) return false
  if (input.intent === 'detail') return true
  if (input.intent === 'navigator') return false
  return input.routeHasDetail
}

export function compactDockIntentAfterRouteChange(
  routeHasDetail: boolean,
): CompactDockViewIntent {
  return routeHasDetail ? null : 'navigator'
}

/** Only direct tab-selection actions represent a user asking to see the dock. */
export function actionEntersCompactDockDetail(model: Model, action: Action): boolean {
  if (action.type !== Actions.SELECT_TAB) return false
  const tabId = action.data.tabNode
  return typeof tabId === 'string' && model.getNodeById(tabId) instanceof TabNode
}
