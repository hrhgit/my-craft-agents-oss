import { describe, expect, test } from 'bun:test'
import { createEmptySession } from '../helpers'
import { processEvent } from '../processor'

describe('subagent process events', () => {
  test('records completion only as process info without creating user or final Agent messages', () => {
    const session = createEmptySession('session-1', 'workspace-1')
    const beforeConversationMessages = session.messages.filter(message =>
      message.role === 'user' || message.role === 'assistant')

    const result = processEvent({ session, streaming: null }, {
      type: 'subagent_event',
      sessionId: 'session-1',
      taskId: 'task-1',
      phase: 'completed',
      status: 'completed',
      summary: 'Review complete',
      timestamp: 123,
    })

    expect(result.state.session.messages).toEqual([
      expect.objectContaining({
        role: 'info',
        content: 'Subagent task-1 completed: Review complete',
        infoLevel: 'success',
        timestamp: 123,
      }),
    ])
    expect(result.state.session.messages.filter(message =>
      message.role === 'user' || message.role === 'assistant')).toEqual(beforeConversationMessages)
    expect(result.state.streaming).toBeNull()
    expect(result.effects).toEqual([])
  })
})
