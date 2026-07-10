import type { PlanModeStateV1 } from '@craft-agent/core/types'
import type { ConversationMode } from '../ConversationModeSelector'

export function conversationModeFromPlanState(state?: PlanModeStateV1): ConversationMode {
  if (state?.phase === 'discussing') return 'discuss'
  if (state && !['off', 'executing', 'completed'].includes(state.phase)) return 'plan'
  return 'normal'
}

export function canFinalizePlan(state?: PlanModeStateV1): boolean {
  return state?.phase === 'planning' || state?.phase === 'discussing'
}
