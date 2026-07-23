import { describe, expect, test } from 'bun:test'
import { createEmptySession } from '../helpers'
import { processEvent } from '../processor'

describe('current host-only session events', () => {
  test.each([
    { type: 'shell_killed' as const, sessionId: 'session-1', shellId: 'shell-1' },
    {
      type: 'auth_completed' as const,
      sessionId: 'session-1',
      requestId: 'request-1',
      success: true,
    },
  ])('keeps conversation state unchanged for $type', event => {
    const session = createEmptySession('session-1', 'workspace-1')
    const result = processEvent({ session, streaming: null }, event)

    expect(result.state.session).toEqual(session)
    expect(result.state.session).not.toBe(session)
    expect(result.effects).toEqual([])
  })
})
