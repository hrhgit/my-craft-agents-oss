import { describe, expect, it } from 'bun:test'
import { handlePlanArtifactChanged, handlePlanModeStateChanged } from '../session'
import type { PlanArtifactChangedEvent, PlanModeStateChangedEvent, SessionState } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: { id: 'session-1', messages, lastMessageAt: 1 } as any,
    streaming: null,
  }
}

const artifact = {
  schemaVersion: 1 as const,
  kind: 'plan' as const,
  artifactId: 'plan-new',
  revision: 2,
  state: 'ready' as const,
  review: { status: 'passed' as const, verdict: 'pass' as const },
  checklist: [],
  createdAt: 2,
}

describe('plan artifact renderer events', () => {
  it('replaces the bound assistant message and supersedes old cards', () => {
    const state = makeState([
      { id: 'old', role: 'assistant', content: '# Old', artifact: { ...artifact, artifactId: 'plan-old', revision: 1 } },
      { id: 'new', role: 'assistant', content: '# New' },
    ])
    const event: PlanArtifactChangedEvent = {
      type: 'plan_artifact_changed',
      sessionId: 'session-1',
      message: { id: 'new', role: 'assistant', content: '# New', timestamp: 2, artifact },
      supersededArtifactIds: ['plan-old'],
    }

    const next = handlePlanArtifactChanged(state, event)
    expect(next.state.session.messages[0]?.artifact?.state).toBe('superseded')
    expect(next.state.session.messages[1]?.artifact?.artifactId).toBe('plan-new')
    expect(next.state.session.lastMessageRole).toBe('assistant')
  })

  it('updates session-authoritative plan mode state', () => {
    const state = makeState([])
    const event: PlanModeStateChangedEvent = {
      type: 'plan_mode_state_changed',
      sessionId: 'session-1',
      state: { schemaVersion: 1, phase: 'reviewing', activeArtifactId: 'plan-new', updatedAt: 3 },
    }
    expect(handlePlanModeStateChanged(state, event).state.session.planModeState).toEqual(event.state)
  })
})
