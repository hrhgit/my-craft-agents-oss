import { describe, expect, it } from 'bun:test'

import {
  MAX_SESSION_SEARCH_LIMIT,
  SessionTextIndex,
  normalizeSessionSearchQuery,
  type SessionSearchSegment,
} from './session-text-index'

function segment(overrides: Partial<SessionSearchSegment> = {}): SessionSearchSegment {
  return {
    turnId: 'turn-1',
    segmentId: 'message-1',
    turnOrder: 0,
    segmentOrder: 0,
    kind: 'assistant-message',
    target: { type: 'message', id: 'message-1' },
    text: 'Mortise is ready.',
    ...overrides,
  }
}

describe('SessionTextIndex', () => {
  it('returns every non-overlapping match in one segment with exact original offsets', () => {
    const index = new SessionTextIndex()
    const text = 'Alpha alpha ALPHA'
    index.upsert(segment({ text }))

    const page = index.search('alpha')

    expect(page.matches.map(({ start, end }) => ({ start, end, text: text.slice(start, end) }))).toEqual([
      { start: 0, end: 5, text: 'Alpha' },
      { start: 6, end: 11, text: 'alpha' },
      { start: 12, end: 17, text: 'ALPHA' },
    ])
    expect(page.hasMore).toBe(false)
  })

  it('normalizes Unicode, case, and whitespace while preserving source offsets', () => {
    const index = new SessionTextIndex()
    const text = 'Before ＭＯＲＴＩＳＥ\t\r\n  Ready after'
    index.upsert(segment({ text }))

    expect(normalizeSessionSearchQuery('  mortise   READY  ')).toBe('mortise ready')
    const [match] = index.search('  mortise   READY  ').matches
    expect(match).toBeDefined()
    expect(text.slice(match!.start, match!.end)).toBe('ＭＯＲＴＩＳＥ\t\r\n  Ready')
  })

  it('matches composed and decomposed accents with exact grapheme source offsets', () => {
    const index = new SessionTextIndex()
    const decomposed = 'Before Cafe\u0301 after'
    const composed = 'Before Café after'
    index.upsert(segment({ turnId: 'decomposed', text: decomposed }))
    index.upsert(segment({ turnId: 'composed', turnOrder: 1, text: composed }))

    expect(normalizeSessionSearchQuery('Cafe\u0301')).toBe('café')
    for (const query of ['café', 'cafe\u0301']) {
      const matches = index.search(query).matches
      expect(matches.map(match => ({
        turnId: match.turnId,
        source: (match.turnId === 'decomposed' ? decomposed : composed).slice(match.start, match.end),
      }))).toEqual([
        { turnId: 'decomposed', source: 'Cafe\u0301' },
        { turnId: 'composed', source: 'Café' },
      ])
    }
  })

  it('matches composed Hangul syllables and decomposed Jamo with exact source offsets', () => {
    const index = new SessionTextIndex()
    const jamo = 'Before \u1100\u1161\u11a8 after'
    const syllable = 'Before 각 after'
    index.upsert(segment({ turnId: 'jamo', text: jamo }))
    index.upsert(segment({ turnId: 'syllable', turnOrder: 1, text: syllable }))

    expect(normalizeSessionSearchQuery('\u1100\u1161\u11a8')).toBe('각')
    for (const query of ['각', '\u1100\u1161\u11a8']) {
      const matches = index.search(query).matches
      expect(matches.map(match => ({
        turnId: match.turnId,
        source: (match.turnId === 'jamo' ? jamo : syllable).slice(match.start, match.end),
      }))).toEqual([
        { turnId: 'jamo', source: '\u1100\u1161\u11a8' },
        { turnId: 'syllable', source: '각' },
      ])
    }
  })

  it('upserts and deletes identities without retaining stale postings', () => {
    const index = new SessionTextIndex()
    index.upsert(segment({ text: 'legacy needle' }))
    index.upsert(segment({ text: 'canonical value', target: { type: 'turn', id: 'turn-1' } }))

    expect(index.size).toBe(1)
    expect(index.search('needle').matches).toEqual([])
    expect(index.search('canonical').matches[0]?.target).toEqual({ type: 'turn', id: 'turn-1' })
    expect(index.delete('turn-1', 'message-1')).toBe(true)
    expect(index.delete('turn-1', 'message-1')).toBe(false)
    expect(index.search('canonical').matches).toEqual([])
  })

  it('deletes all segments in a turn without touching another turn', () => {
    const index = new SessionTextIndex()
    index.upsert(segment({ segmentId: 'a', text: 'needle one' }))
    index.upsert(segment({ segmentId: 'b', segmentOrder: 1, text: 'needle two' }))
    index.upsert(segment({ turnId: 'turn-2', segmentId: 'a', turnOrder: 1, text: 'needle three' }))

    expect(index.deleteTurn('turn-1')).toBe(2)
    expect(index.deleteTurn('turn-1')).toBe(0)
    expect(index.search('needle').matches.map((match) => match.turnId)).toEqual(['turn-2'])
  })

  it('keeps turn ownership consistent across replacement, individual deletion, and clear', () => {
    const index = new SessionTextIndex()
    index.upsert(segment({ segmentId: 'a', text: 'old value' }))
    index.upsert(segment({ segmentId: 'a', text: 'replacement value' }))
    index.upsert(segment({ segmentId: 'b', segmentOrder: 1, text: 'sibling value' }))

    expect(index.delete('turn-1', 'a')).toBe(true)
    expect(index.deleteTurn('turn-1')).toBe(1)
    expect(index.size).toBe(0)

    index.upsert(segment({ text: 'after clear' }))
    index.clear()
    expect(index.deleteTurn('turn-1')).toBe(0)
    expect(index.search('after clear').matches).toEqual([])
  })

  it('uses stable transcript ordering independent of insertion order and collision-shaped ids', () => {
    const index = new SessionTextIndex()
    index.upsert(segment({ turnId: 'z', segmentId: '["x","y"]', turnOrder: 2, text: 'needle' }))
    index.upsert(segment({ turnId: 'a', segmentId: 'same', turnOrder: 1, segmentOrder: 2, text: 'needle' }))
    index.upsert(segment({ turnId: 'a', segmentId: 'first', turnOrder: 1, segmentOrder: 1, text: 'needle' }))

    expect(index.search('needle').matches.map((match) => [match.turnId, match.segmentId])).toEqual([
      ['a', 'first'],
      ['a', 'same'],
      ['z', '["x","y"]'],
    ])
  })

  it('caps pages, provides a query-bound cursor, and resumes within the same segment', () => {
    const index = new SessionTextIndex()
    index.upsert(segment({ text: 'hit hit hit hit' }))

    const first = index.search('hit', { limit: 2 })
    expect(first.matches.map((match) => match.start)).toEqual([0, 4])
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBeDefined()

    const second = index.search(' HIT ', { limit: 2, after: first.nextCursor })
    expect(second.matches.map((match) => match.start)).toEqual([8, 12])
    expect(second.hasMore).toBe(false)
    expect(() => index.search('other', { after: first.nextCursor })).toThrow('cursor query')
  })

  it('enforces the hard result bound', () => {
    const index = new SessionTextIndex()
    index.upsert(segment({ text: Array.from({ length: MAX_SESSION_SEARCH_LIMIT + 25 }, () => 'x').join(' ') }))

    const page = index.search('x', { limit: Number.MAX_SAFE_INTEGER })
    expect(page.matches).toHaveLength(MAX_SESSION_SEARCH_LIMIT)
    expect(page.hasMore).toBe(true)
  })

  it('narrows a large deterministic transcript through the index', () => {
    const index = new SessionTextIndex()
    const count = 12_000
    for (let turnOrder = count - 1; turnOrder >= 0; turnOrder -= 1) {
      index.upsert(segment({
        turnId: `turn-${turnOrder}`,
        segmentId: 'body',
        turnOrder,
        text: turnOrder % 4_000 === 0
          ? `ordinary transcript ${turnOrder} rare-index-needle`
          : `ordinary transcript ${turnOrder}`,
      }))
    }

    const page = index.search('rare-index-needle', { limit: 10 })
    expect(index.size).toBe(count)
    expect(page.candidateSegmentCount).toBe(3)
    expect(page.matches.map((match) => match.turnOrder)).toEqual([0, 4_000, 8_000])
  })

  it('deletes a long divergent turn suffix without rescanning the retained prefix', () => {
    const index = new SessionTextIndex()
    const turnCount = 10_000
    const retainedCount = 1_000
    for (let turnOrder = 0; turnOrder < turnCount; turnOrder += 1) {
      index.upsert(segment({
        turnId: `turn-${turnOrder}`,
        segmentId: 'body',
        turnOrder,
        text: turnOrder < retainedCount ? 'retained needle' : 'divergent needle',
      }))
    }

    let deletedCount = 0
    for (let turnOrder = retainedCount; turnOrder < turnCount; turnOrder += 1) {
      deletedCount += index.deleteTurn(`turn-${turnOrder}`)
    }
    expect(deletedCount).toBe(turnCount - retainedCount)
    expect(index.size).toBe(retainedCount)
    expect(index.diagnostics).toMatchObject({
      indexedTurnCount: retainedCount,
      deleteTurnCalls: turnCount - retainedCount,
      deleteTurnVisitedSegmentKeys: turnCount - retainedCount,
    })
    expect(index.search('divergent').matches).toEqual([])
    expect(index.search('retained', { limit: 1 }).candidateSegmentCount).toBe(retainedCount)
  })
})
