import { describe, expect, it } from 'bun:test'
import {
  getActivePiBranchEntries,
  getPiEntryMessageId,
  resolvePiBranchTarget,
  type PiBranchProjection,
} from '@mortise/server-core/projection'

function projection(): PiBranchProjection {
  return {
    leafId: 'assistant-latest',
    entries: [
      {
        id: 'user-root',
        parentId: null,
        type: 'message',
        timestamp: '2026-07-12T00:00:00.000Z',
        message: {
          role: 'user',
          clientMutationId: 'optimistic-user-1',
          content: [{ type: 'text', text: 'first' }],
          timestamp: 1000,
        },
      },
      {
        id: 'assistant-old',
        parentId: 'user-root',
        type: 'message',
        timestamp: '2026-07-12T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'old answer' }],
          timestamp: 2000,
        },
      },
      {
        id: 'user-latest',
        parentId: 'assistant-old',
        type: 'message',
        timestamp: '2026-07-12T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'latest' }], timestamp: 3000 },
      },
      {
        id: 'assistant-latest',
        parentId: 'user-latest',
        type: 'message',
        timestamp: '2026-07-12T00:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'latest answer' }], timestamp: 4000 },
      },
      {
        id: 'abandoned-branch',
        parentId: 'user-root',
        type: 'message',
        timestamp: '2026-07-12T00:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'not active' }], timestamp: 5000 },
      },
    ],
  }
}

describe('Pi projection branch identity', () => {
  it('walks only the active Pi leaf', () => {
    expect(getActivePiBranchEntries(projection()).map(entry => entry.id)).toEqual([
      'user-root',
      'assistant-old',
      'user-latest',
      'assistant-latest',
    ])
  })

  it('uses client mutation identity for users and stable timestamp identity for assistants', () => {
    const entries = projection().entries
    expect(getPiEntryMessageId(entries[0]!)).toBe('optimistic-user-1')
    expect(getPiEntryMessageId(entries[1]!)).toBe('ts-2000')
  })

  it('resolves an older projected response and truncates the branch at its Pi entry', () => {
    const result = resolvePiBranchTarget(projection(), 'ts-2000')
    expect(result?.targetEntry.id).toBe('assistant-old')
    expect(result?.branchEntries.map(entry => entry.id)).toEqual(['user-root', 'assistant-old'])
    expect([...result!.canonicalEntryIds]).toEqual(['user-root', 'assistant-old'])
    expect(result?.overlayMessageIds.has('optimistic-user-1')).toBe(true)
    expect(result?.overlayMessageIds.has('ts-2000')).toBe(true)
    expect(result?.overlayMessageIds.has('user-latest')).toBe(false)
  })

  it('accepts a canonical Pi entry id and rejects inactive or unknown targets', () => {
    expect(resolvePiBranchTarget(projection(), 'assistant-old')?.targetEntry.id).toBe('assistant-old')
    expect(resolvePiBranchTarget(projection(), 'ts-5000')).toBeNull()
    expect(resolvePiBranchTarget(projection(), 'missing')).toBeNull()
  })

  it('rejects cyclic active branches', () => {
    expect(() => getActivePiBranchEntries({
      leafId: 'a',
      entries: [
        { id: 'a', parentId: 'b', type: 'message', timestamp: '2026-07-12T00:00:00.000Z' },
        { id: 'b', parentId: 'a', type: 'message', timestamp: '2026-07-12T00:00:01.000Z' },
      ],
    })).toThrow('cyclic Pi session projection')
  })
})
