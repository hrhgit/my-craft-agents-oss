import { describe, expect, it } from 'bun:test'
import type { Turn } from '@mortise/ui'
import {
  buildChatSearchIndex,
  CHAT_SEARCH_CONTEXT_TURNS,
  ChatSearchMatchPager,
  getChatSearchSegments,
  getChatSearchMatchIdentity,
  getChatSearchOccurrenceInTarget,
  getChatSearchWindow,
  IncrementalChatSearchIndex,
  findNormalizedChatSearchRanges,
  planNextChatSearchNavigation,
  preserveChatSearchMatchIndex,
} from '../chat-search-model'

function userTurn(index: number, content = `message ${index}`): Turn {
  return { type: 'user', timestamp: index, message: { id: `message-${index}`, role: 'user', content, timestamp: index } }
}

describe('chat search model', () => {
  it('maps normalized Unicode and collapsed whitespace back to visible source offsets', () => {
    const text = 'Before Ｍｏｒｔｉｓｅ\n\t READY after'
    const [match] = findNormalizedChatSearchRanges(text, 'mortise   ready')

    expect(text.slice(match!.start, match!.end)).toBe('Ｍｏｒｔｉｓｅ\n\t READY')
    expect(match!.occurrence).toBe(0)
  })

  it('selects an occurrence within one semantic search target', () => {
    const text = 'needle first, needle second, needle third'
    expect(findNormalizedChatSearchRanges(text, 'needle', {
      occurrenceStart: 1,
      occurrenceEnd: 1,
    })).toEqual([{ start: 14, end: 20, occurrence: 1 }])
  })
  it('indexes separate stable segments and preserves repeated occurrences', () => {
    const turn = userTurn(0, 'needle and needle')
    const segments = getChatSearchSegments(turn, 0)
    const page = buildChatSearchIndex([turn]).search('needle')

    expect(segments.map(entry => entry.segmentId)).toEqual(['message:message-0'])
    expect(page.matches.map(match => [match.turnId, match.segmentId, match.start])).toEqual([
      ['user-message-0', 'message:message-0', 0],
      ['user-message-0', 'message:message-0', 11],
    ])
  })

  it('indexes structured tool inputs and results as deterministic segment text', () => {
    const turn: Turn = {
      type: 'assistant',
      turnId: 'tool-turn',
      timestamp: 1,
      activities: [{
        id: 'tool-1',
        type: 'tool',
        status: 'completed',
        toolName: 'Search',
        toolInput: { query: 'structured needle' },
        content: '{"matches":["result needle"]}',
        timestamp: 1,
      }],
      isStreaming: false,
      isComplete: true,
    }
    const index = buildChatSearchIndex([turn])

    expect(index.search('structured needle').matches[0]).toMatchObject({
      segmentId: 'activity:tool-1:input',
      target: { type: 'tool-call', id: 'tool-1' },
    })
    expect(index.search('result needle').matches[0]).toMatchObject({
      segmentId: 'activity:tool-1:content',
      target: { type: 'tool-result', id: 'tool-1' },
    })
  })

  it('targets an assistant response message instead of the containing Turn', () => {
    const turn: Turn = {
      type: 'assistant',
      turnId: 'assistant-turn',
      timestamp: 1,
      activities: [],
      response: { messageId: 'assistant-message', text: 'response needle', isStreaming: false },
      isStreaming: false,
      isComplete: true,
    }

    expect(buildChatSearchIndex([turn]).search('needle').matches[0]?.target).toEqual({
      type: 'message',
      id: 'assistant-message',
    })
  })

  it('counts occurrences across segments that share one semantic target', () => {
    const turn: Turn = {
      type: 'assistant',
      turnId: 'tool-turn',
      timestamp: 1,
      activities: [{
        id: 'tool-1',
        type: 'tool',
        status: 'completed',
        displayName: 'needle search',
        toolInput: { query: 'needle' },
        timestamp: 1,
      }],
      isStreaming: false,
      isComplete: true,
    }
    const matches = buildChatSearchIndex([turn]).search('needle').matches

    expect(matches.map(match => match.segmentId)).toEqual([
      'activity:tool-1:display-name',
      'activity:tool-1:input',
    ])
    expect(getChatSearchOccurrenceInTarget(matches, 0)).toBe(0)
    expect(getChatSearchOccurrenceInTarget(matches, 1)).toBe(1)
  })

  it('renders a fixed neighborhood around a deep match', () => {
    const turns = Array.from({ length: 10_000 }, (_, index) => userTurn(index))
    const match = buildChatSearchIndex(turns).search('message 5000').matches[0]
    const window = getChatSearchWindow(turns, match, 4)

    expect(window.startIndex).toBe(4_996)
    expect(window.endIndex).toBe(5_005)
    expect(window.turns).toHaveLength(9)
    expect(window.turns[4]).toEqual(turns[5_000])
  })

  it('keeps the window bounded at transcript edges', () => {
    const turns = Array.from({ length: 20 }, (_, index) => userTurn(index))
    const index = buildChatSearchIndex(turns)

    expect(getChatSearchWindow(turns, index.search('message 0').matches[0], 5).turns).toHaveLength(6)
    expect(getChatSearchWindow(turns, index.search('message 19').matches[0], 5).turns).toHaveLength(6)
  })

  it('updates only the mutable streaming tail of a long transcript', () => {
    const stableTurns = Array.from({ length: 10_000 }, (_, index) => userTurn(index))
    const streamingTurn: Turn = {
      type: 'assistant',
      turnId: 'streaming-turn',
      timestamp: 10_000,
      activities: [],
      response: { text: 'partial response', isStreaming: true },
      isStreaming: true,
      isComplete: false,
    }
    const model = new IncrementalChatSearchIndex()
    const initial = model.reconcile([...stableTurns, streamingTurn])
    const revision = initial.revision

    const updated = model.reconcile([
      ...stableTurns,
      { ...streamingTurn, response: { text: 'partial response with needle', isStreaming: true } },
    ])

    expect(initial.addedTurns).toBe(10_001)
    expect(updated).toMatchObject({
      retainedTurns: 10_000,
      refreshedTurns: 1,
      addedTurns: 0,
      removedTurns: 0,
      upsertedSegments: 1,
      visitedTurns: 4,
      revision: revision + 1,
    })
    expect(model.index.search('needle').matches).toHaveLength(1)
  })

  it('paginates beyond 200 matches without duplicate or missing cursor-boundary results', () => {
    const model = new IncrementalChatSearchIndex()
    model.reconcile([userTurn(0, Array.from({ length: 450 }, () => 'needle').join(' '))])
    const pager = new ChatSearchMatchPager()

    const first = pager.reset(model.index, 'needle')
    const second = pager.loadNext(model.index)
    const third = pager.loadNext(model.index)

    expect(first.matches).toHaveLength(200)
    expect(first.hasMore).toBe(true)
    expect(second.matches).toHaveLength(400)
    expect(second.matches[199]?.start).toBe(first.matches[199]?.start)
    expect(second.matches[200]!.start).toBeGreaterThan(second.matches[199]!.start)
    expect(third.matches).toHaveLength(450)
    expect(third.hasMore).toBe(false)
    expect(new Set(third.matches.map(match => match.start)).size).toBe(450)
  })

  it('keeps the active identity stable while a cursor page is pending and appended', () => {
    const model = new IncrementalChatSearchIndex()
    model.reconcile([userTurn(0, Array.from({ length: 250 }, () => 'needle').join(' '))])
    const pager = new ChatSearchMatchPager()
    const first = pager.reset(model.index, 'needle')
    const activeIdentity = getChatSearchMatchIdentity(first.matches[199]!)

    expect(planNextChatSearchNavigation(199, first.matches.length, first.hasMore)).toEqual({
      index: 199,
      loadNextPage: true,
    })
    expect(preserveChatSearchMatchIndex(first.matches, activeIdentity, 199)).toBe(199)

    const complete = pager.loadNext(model.index)
    expect(preserveChatSearchMatchIndex(complete.matches, activeIdentity, 199)).toBe(199)
    expect(planNextChatSearchNavigation(199, complete.matches.length, complete.hasMore)).toEqual({
      index: 200,
      loadNextPage: false,
    })
  })

  it('yields before initial construction and atomically publishes the completed index', async () => {
    const model = new IncrementalChatSearchIndex()
    let release!: () => void
    const yielded = new Promise<void>(resolve => { release = resolve })
    const construction = model.reconcileAsync(
      [userTurn(0, 'first needle'), userTurn(1, 'second needle')],
      { yieldEvery: 1_000, yieldToHost: () => yielded },
    )

    expect(model.index.size).toBe(0)
    release()
    const result = await construction

    expect(result?.addedTurns).toBe(2)
    expect(model.index.search('needle').matches).toHaveLength(2)
  })

  it('keeps the committed index intact when asynchronous reconstruction is cancelled', async () => {
    const model = new IncrementalChatSearchIndex()
    model.reconcile([userTurn(0, 'committed needle')])
    const controller = new AbortController()

    const result = await model.reconcileAsync(
      [userTurn(10, 'replacement')],
      {
        signal: controller.signal,
        yieldToHost: async () => controller.abort(),
      },
    )

    expect(result).toBeNull()
    expect(model.index.search('committed needle').matches).toHaveLength(1)
    expect(model.index.search('replacement').matches).toHaveLength(0)
  })

  it('indexes appended Turns without rebuilding the sealed prefix', () => {
    const model = new IncrementalChatSearchIndex()
    const turns = Array.from({ length: 1_000 }, (_, index) => userTurn(index))
    model.reconcile(turns)

    const appended = model.reconcile([...turns, userTurn(1_000, 'appended needle')])

    expect(appended).toMatchObject({
      retainedTurns: 999,
      refreshedTurns: 1,
      addedTurns: 1,
      removedTurns: 0,
      upsertedSegments: 2,
    })
    expect(model.index.search('appended needle').matches[0]?.turnOrder).toBe(1_000)
  })

  it('drops stale suffix postings when transcript order diverges', () => {
    const model = new IncrementalChatSearchIndex()
    model.reconcile([
      userTurn(0, 'stable'),
      userTurn(1, 'obsolete needle'),
      userTurn(2, 'old tail'),
    ])

    const changed = model.reconcile([
      userTurn(0, 'stable'),
      userTurn(20, 'replacement'),
    ])

    expect(changed).toMatchObject({ retainedTurns: 1, addedTurns: 1, removedTurns: 2 })
    expect(model.index.search('obsolete needle').matches).toEqual([])
    expect(model.index.search('replacement').matches).toHaveLength(1)
  })

  it('rebuilds a same-length reorder outside the mutable tail', async () => {
    const model = new IncrementalChatSearchIndex()
    const turns = Array.from({ length: 10 }, (_, index) => userTurn(index))
    model.reconcile(turns)
    const reordered = [...turns]
    ;[reordered[6], reordered[7]] = [reordered[7]!, reordered[6]!]
    let yields = 0

    await model.reconcileAsync(reordered, {
      yieldToHost: async () => { yields += 1 },
    })

    expect(yields).toBeGreaterThan(0)
    expect(model.index.search('message 6').matches[0]?.turnOrder).toBe(7)
    expect(model.index.search('message 7').matches[0]?.turnOrder).toBe(6)
  })

  it('rebuilds sealed searchable content replaced under the same Turn identity', async () => {
    const model = new IncrementalChatSearchIndex()
    const turns = Array.from({ length: 10 }, (_, index) => userTurn(index))
    model.reconcile(turns)
    const replaced = [...turns]
    replaced[6] = userTurn(6, 'replacement needle')
    let yields = 0

    await model.reconcileAsync(replaced, {
      yieldToHost: async () => { yields += 1 },
    })

    expect(yields).toBeGreaterThan(0)
    expect(model.index.search('message 6').matches).toEqual([])
    expect(model.index.search('replacement needle').matches[0]?.turnOrder).toBe(6)
  })

  it('hard-bounds the mounted search neighborhood independent of transcript size', () => {
    const turns = Array.from({ length: 100_000 }, (_, index) => userTurn(index))
    const activeMatch = buildChatSearchIndex([userTurn(50_000, 'needle')]).search('needle').matches[0]
    if (!activeMatch) throw new Error('expected active match')
    activeMatch.turnOrder = 50_000

    const window = getChatSearchWindow(turns, activeMatch)

    expect(window.turns.length).toBe(CHAT_SEARCH_CONTEXT_TURNS * 2 + 1)
    expect(window.startIndex).toBe(50_000 - CHAT_SEARCH_CONTEXT_TURNS)
    expect(window.endIndex).toBe(50_000 + CHAT_SEARCH_CONTEXT_TURNS + 1)
  })
})
