import { describe, expect, it } from 'bun:test'
import { canFinalizePlan, conversationModeFromPlanState } from '../plan-mode-ui-state'

const state = (phase: any) => ({ schemaVersion: 1 as const, phase, updatedAt: 1 })

describe('authoritative plan mode UI state', () => {
  it('maps extension phases to the conversation mode selector', () => {
    expect(conversationModeFromPlanState(state('off'))).toBe('normal')
    expect(conversationModeFromPlanState(state('planning'))).toBe('plan')
    expect(conversationModeFromPlanState(state('reviewing'))).toBe('plan')
    expect(conversationModeFromPlanState(state('discussing'))).toBe('discuss')
    expect(conversationModeFromPlanState(state('executing'))).toBe('normal')
  })

  it('shows Finalize only while planning or discussing', () => {
    expect(canFinalizePlan(state('planning'))).toBe(true)
    expect(canFinalizePlan(state('discussing'))).toBe(true)
    expect(canFinalizePlan(state('finalizing'))).toBe(false)
    expect(canFinalizePlan(state('ready'))).toBe(false)
  })
})
