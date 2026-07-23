import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn } from '../turn-utils'
import type { Message } from '@mortise/core'

describe('groupMessagesByTurn plan annotations', () => {
  it('keeps canonical plan artifact message id and annotations on the assistant response', () => {
    const annotations: NonNullable<Message['annotations']> = [{
      id: 'ann-plan-1',
      schemaVersion: 1,
      createdAt: 1700000000000,
      intent: 'highlight',
      body: [{ type: 'highlight' }],
      target: {
        source: { sessionId: 'session-1', messageId: 'plan-msg-1' },
        selectors: [
          { type: 'text-position', start: 0, end: 4 },
          { type: 'text-quote', exact: 'Plan', prefix: '', suffix: ' details' },
        ],
      },
      style: { color: 'yellow' },
    }]

    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Create a plan',
        timestamp: 1000,
      },
      {
        id: 'plan-msg-1',
        role: 'assistant',
        content: '# Plan\n- Step 1',
        timestamp: 1200,
        annotations,
        artifact: {
          schemaVersion: 1,
          kind: 'plan',
          artifactId: 'plan-1',
          revision: 1,
          state: 'ready',
          review: { status: 'not_requested' },
          checklist: [],
          createdAt: 1200,
        },
      },
    ]

    const turns = groupMessagesByTurn(messages)
    const assistantTurn = turns.find((turn) => turn.type === 'assistant')

    expect(assistantTurn).toBeDefined()
    if (!assistantTurn || assistantTurn.type !== 'assistant') return

    expect(assistantTurn.response?.messageId).toBe('plan-msg-1')
    expect(assistantTurn.response?.annotations).toEqual(annotations)
    expect(assistantTurn.response?.artifact).toMatchObject({ artifactId: 'plan-1' })
  })
})
