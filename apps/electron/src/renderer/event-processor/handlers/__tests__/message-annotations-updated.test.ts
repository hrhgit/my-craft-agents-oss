import { describe, expect, it } from 'bun:test'
import { handleMessageAnnotationsUpdated } from '../session'
import type { SessionState, MessageAnnotationsUpdatedEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
    } as any,
    streaming: null,
  }
}

describe('handleMessageAnnotationsUpdated', () => {
  it('updates annotations only on the targeted message', () => {
    const state = makeState([
      { id: 'msg-a', role: 'assistant', content: 'alpha', annotations: [] },
      { id: 'msg-b', role: 'assistant', content: 'beta' },
    ])

    const annotations = [
      {
        id: 'ann-1',
        schemaVersion: 1 as const,
        createdAt: 1700000000000,
        motivation: 'highlighting' as const,
        body: [{ type: 'highlight' as const }],
        target: {
          source: { sessionId: 'session-1', messageId: 'msg-b' },
          selectors: [
            { type: 'text-position' as const, start: 0, end: 4 },
            { type: 'text-quote' as const, exact: 'beta' },
          ],
        },
      },
    ]

    const event: MessageAnnotationsUpdatedEvent = {
      type: 'message_annotations_updated',
      sessionId: 'session-1',
      messageId: 'msg-b',
      annotations,
    }

    const next = handleMessageAnnotationsUpdated(state, event)
    expect((next.state.session.messages[0] as any).annotations).toEqual([])
    expect((next.state.session.messages[1] as any).annotations).toEqual(annotations)
  })

  it('creates an overlay carrier for a projected message not present in Craft messages', () => {
    const state = makeState([])
    const annotations = [{
      id: 'ann-projected',
      schemaVersion: 1 as const,
      createdAt: 1700000000000,
      body: [{ type: 'highlight' as const }],
      target: {
        source: { sessionId: 'session-1', messageId: 'ts-1700000000000' },
        selectors: [{ type: 'text-quote' as const, exact: 'projected' }],
      },
    }]

    const next = handleMessageAnnotationsUpdated(state, {
      type: 'message_annotations_updated',
      sessionId: 'session-1',
      messageId: 'ts-1700000000000',
      annotations,
    })

    expect(next.state.session.messages).toEqual([expect.objectContaining({
      id: 'ts-1700000000000',
      content: '',
      annotations,
    })])
  })
})
