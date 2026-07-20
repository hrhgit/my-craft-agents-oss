import { describe, expect, it } from 'bun:test'
import type { PiProjectionEventV1 } from '@mortise/shared/protocol'
import {
  applyPiProjectionEvent,
  createPiProjectionState,
} from '@/atoms/pi-projection'
import { getPiAgentEndHandoff } from '../pi-projection-handoff'

function event(
  seq: number,
  entityId: string,
  entityType: PiProjectionEventV1['entityType'],
  kind: string,
  payload: unknown,
): PiProjectionEventV1 {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    seq,
    sessionId: 'session-1',
    runtimeId: 'runtime-1',
    entityId,
    entityType,
    entityVersion: entityId === 'conversation' ? 2 : 1,
    kind,
    payload,
  }
}

describe('Pi projection completion handoff', () => {
  it('uses the last visible assistant block as the completion preview', () => {
    let state = createPiProjectionState('session-1')
    state = applyPiProjectionEvent(state, event(1, 'assistant:1', 'content_block', 'assistant_text', {
      role: 'assistant', text: 'Earlier answer', streaming: false,
    }))
    state = applyPiProjectionEvent(state, event(2, 'assistant:intermediate', 'content_block', 'assistant_text', {
      role: 'assistant', text: 'Hidden intermediate', isIntermediate: true, streaming: false,
    }))
    state = applyPiProjectionEvent(state, event(3, 'assistant:2', 'content_block', 'assistant_text', {
      role: 'assistant', text: 'Final **answer**', streaming: false,
    }))

    const end = event(4, 'conversation', 'conversation', 'agent_settled', { status: 'completed' })
    const completed = applyPiProjectionEvent(state, end)

    expect(getPiAgentEndHandoff(state, completed, end)).toEqual({
      sessionId: 'session-1',
      preview: 'Final **answer**',
    })
  })

  it('does not hand off replayed, rejected, or non-terminal events', () => {
    const initial = createPiProjectionState('session-1')
    const start = event(1, 'conversation', 'conversation', 'agent_start', { status: 'running' })
    const running = applyPiProjectionEvent(initial, start)
    expect(getPiAgentEndHandoff(initial, running, start)).toBeNull()

    const end = event(2, 'conversation', 'conversation', 'agent_settled', { status: 'completed' })
    const completed = applyPiProjectionEvent(running, end)
    expect(getPiAgentEndHandoff(completed, completed, end)).toBeNull()

    const gap = event(4, 'conversation', 'conversation', 'agent_settled', { status: 'completed' })
    const desynced = applyPiProjectionEvent(completed, gap)
    expect(getPiAgentEndHandoff(completed, desynced, gap)).toBeNull()
  })

  it('keeps legacy agent_end terminal but ignores new pending attempt ends', () => {
    let state = createPiProjectionState('session-1')
    const legacyEnd = event(1, 'legacy-end', 'conversation', 'agent_end', { status: 'completed' })
    const legacyCompleted = applyPiProjectionEvent(state, legacyEnd)
    expect(getPiAgentEndHandoff(state, legacyCompleted, legacyEnd)).toEqual({ sessionId: 'session-1', preview: undefined })

    state = createPiProjectionState('session-1')
    const attemptEnd = event(1, 'attempt-end', 'conversation', 'agent_end', {
      status: 'failed', willRetry: true, settlementPending: true,
    })
    const retrying = applyPiProjectionEvent(state, attemptEnd)
    expect(getPiAgentEndHandoff(state, retrying, attemptEnd)).toBeNull()
  })
})
