import { describe, expect, test } from 'bun:test'
import { createEmptySession } from '../../helpers'
import { processEvent } from '../../processor'

const settlementFailure = {
  code: 'SESSION_SETTLEMENT_FAILED' as const,
  message: 'Host settlement is pending',
  data: {
    sessionId: 'session-1',
    stage: 'turn-settlement' as const,
    retryable: true as const,
    terminal: false as const,
    outcome: 'accepted-pending-settlement' as const,
  },
}

describe('Session settlement failure', () => {
  test('keeps the accepted turn processing without adding a resendable error message', () => {
    const session = createEmptySession('session-1', 'workspace-1')
    session.messages = [{
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolName: 'read',
      toolUseId: 'tool-use-1',
      toolStatus: 'executing',
    }]

    const result = processEvent({
      session,
      streaming: { content: 'complete assistant text' },
    }, {
      type: 'session_failure',
      sessionId: session.id,
      error: settlementFailure,
    })

    expect(result.state.session.isProcessing).toBe(true)
    expect(result.state.session.pendingFailure).toEqual(settlementFailure)
    expect(result.state.session.messages).toEqual(session.messages)
    expect(result.state.session.messages.some(message => message.role === 'error')).toBe(false)
    expect(result.state.streaming).toBeNull()
    expect(result.effects).toEqual([])
  })

  test('clears the pending failure when durable settlement emits complete', () => {
    const session = createEmptySession('session-1', 'workspace-1')
    const failed = processEvent({ session, streaming: null }, {
      type: 'session_failure',
      sessionId: session.id,
      error: settlementFailure,
    })
    const completed = processEvent(failed.state, {
      type: 'complete',
      sessionId: session.id,
    })

    expect(failed.state.session.isProcessing).toBe(true)
    expect(failed.state.session.pendingFailure).toEqual(settlementFailure)
    expect(completed.state.session.isProcessing).toBe(false)
    expect(completed.state.session.pendingFailure).toBeUndefined()
  })
})
