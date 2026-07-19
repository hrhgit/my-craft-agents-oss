import { describe, expect, it } from 'bun:test'
import type { Message } from '@mortise/core'
import { groupMessagesByTurn } from '../turn-utils'

describe('turn-utils plan artifact projection', () => {
  it('keeps a structured plan as a normal assistant response with artifact metadata', () => {
    const artifact = {
      schemaVersion: 1 as const,
      kind: 'plan' as const,
      artifactId: 'plan-1',
      revision: 1,
      state: 'ready' as const,
      review: { status: 'passed' as const, verdict: 'pass' as const },
      checklist: [],
      createdAt: 2,
    }
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Finalize', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '# Plan', timestamp: 2, artifact },
    ]

    const turns = groupMessagesByTurn(messages, { isSessionProcessing: false })
    const assistant = turns.find(turn => turn.type === 'assistant')
    expect(assistant?.type).toBe('assistant')
    if (assistant?.type !== 'assistant') throw new Error('assistant turn missing')
    expect(assistant.response?.text).toBe('# Plan')
    expect(assistant.response?.artifact).toEqual(artifact)
    expect(assistant.activities.some(activity => activity.type === 'plan')).toBe(false)
  })
})
