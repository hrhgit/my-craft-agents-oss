import {
  normalizeSessionSearchQuery,
  SessionTextIndex,
  type SessionSearchCursor,
  type SessionSearchMatch,
  type SessionSearchSegment,
} from '@mortise/shared/search'
import type { Turn } from '@mortise/ui'

export const CHAT_SEARCH_CONTEXT_TURNS = 5
export const CHAT_SEARCH_PAGE_SIZE = 200

export interface ChatSearchReconcileStats {
  retainedTurns: number
  refreshedTurns: number
  addedTurns: number
  removedTurns: number
  upsertedSegments: number
  visitedTurns: number
  revision: number
}

export interface ChatSearchReconcileOptions {
  signal?: AbortSignal
  yieldEvery?: number
  yieldToHost?: () => Promise<void>
}

export interface ChatSearchPageSnapshot {
  query: string
  matches: SessionSearchMatch[]
  hasMore: boolean
  nextCursor?: SessionSearchCursor
}

export interface ChatSearchNavigationStep {
  index: number
  loadNextPage: boolean
}

export interface ChatSearchSourceRange {
  start: number
  end: number
  occurrence: number
}

export function findNormalizedChatSearchRanges(
  text: string,
  query: string,
  options: { occurrenceStart?: number; occurrenceEnd?: number } = {},
): ChatSearchSourceRange[] {
  const normalizedQuery = normalizeSessionSearchQuery(query)
  if (!normalizedQuery) return []

  let normalized = ''
  const sourceStarts: number[] = []
  const sourceEnds: number[] = []
  let sourceOffset = 0
  let inWhitespace = false
  for (const sourcePart of Array.from(text)) {
    const start = sourceOffset
    sourceOffset += sourcePart.length
    const isWhitespace = /\s/u.test(sourcePart)
    if (isWhitespace) {
      if (!inWhitespace) {
        normalized += ' '
        sourceStarts.push(start)
        sourceEnds.push(sourceOffset)
      } else {
        sourceEnds[sourceEnds.length - 1] = sourceOffset
      }
      inWhitespace = true
      continue
    }
    inWhitespace = false
    const normalizedPart = sourcePart.normalize('NFKC').toLowerCase()
    normalized += normalizedPart
    for (let index = 0; index < normalizedPart.length; index += 1) {
      sourceStarts.push(start)
      sourceEnds.push(sourceOffset)
    }
  }

  const occurrenceStart = Math.max(0, options.occurrenceStart ?? 0)
  const occurrenceEnd = Math.max(occurrenceStart, options.occurrenceEnd ?? Number.MAX_SAFE_INTEGER)
  const ranges: ChatSearchSourceRange[] = []
  let normalizedOffset = 0
  let occurrence = 0
  while (normalizedOffset <= normalized.length - normalizedQuery.length && occurrence <= occurrenceEnd) {
    const found = normalized.indexOf(normalizedQuery, normalizedOffset)
    if (found < 0) break
    const normalizedEnd = found + normalizedQuery.length
    if (occurrence >= occurrenceStart) {
      ranges.push({
        start: sourceStarts[found]!,
        end: sourceEnds[normalizedEnd - 1]!,
        occurrence,
      })
    }
    occurrence += 1
    normalizedOffset = normalizedEnd
  }
  return ranges
}

export function getChatSearchMatchIdentity(match: SessionSearchMatch): string {
  return `${match.turnId}\u0000${match.segmentId}\u0000${match.start}`
}

export function preserveChatSearchMatchIndex(
  matches: readonly SessionSearchMatch[],
  activeIdentity: string | null,
  fallbackIndex: number,
): number {
  if (activeIdentity) {
    const preserved = matches.findIndex(match => getChatSearchMatchIdentity(match) === activeIdentity)
    if (preserved >= 0) return preserved
  }
  return Math.min(fallbackIndex, Math.max(0, matches.length - 1))
}

export function getChatSearchOccurrenceInTarget(
  matches: readonly SessionSearchMatch[],
  activeIndex: number,
): number {
  const activeMatch = matches[activeIndex]
  if (!activeMatch) return 0
  return matches.slice(0, activeIndex).filter(match => (
    match.turnId === activeMatch.turnId
    && match.target.type === activeMatch.target.type
    && match.target.id === activeMatch.target.id
  )).length
}

export function planNextChatSearchNavigation(
  currentIndex: number,
  loadedCount: number,
  hasMore: boolean,
): ChatSearchNavigationStep {
  if (loadedCount <= 0) return { index: 0, loadNextPage: false }
  if (currentIndex < loadedCount - 1) return { index: currentIndex + 1, loadNextPage: false }
  return { index: loadedCount - 1, loadNextPage: hasMore }
}

interface IndexedTurnSnapshot {
  turnId: string
  turnType: Turn['type']
  identity: string
  timestamp: number
  sealed: boolean
  fingerprint: string
  source: Turn
}

export function getChatSearchTurnId(turn: Turn): string {
  if (turn.type === 'user') return `user-${turn.message.id}`
  if (turn.type === 'system') return `system-${turn.message.id}`
  return `turn-${turn.turnId}-${turn.timestamp}`
}

function segment(
  turn: Turn,
  turnOrder: number,
  segmentId: string,
  segmentOrder: number,
  text: unknown,
  kind: SessionSearchSegment['kind'],
  target: SessionSearchSegment['target'],
): SessionSearchSegment | null {
  const searchableText = toSearchableText(text)
  if (!searchableText) return null
  return {
    turnId: getChatSearchTurnId(turn),
    segmentId,
    turnOrder,
    segmentOrder,
    kind,
    target,
    text: searchableText,
  }
}

function toSearchableText(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (value === undefined || value === null) return null
  try {
    const serialized = JSON.stringify(value, null, 2)
    return serialized && serialized.length > 0 ? serialized : null
  } catch {
    const fallback = String(value)
    return fallback.length > 0 ? fallback : null
  }
}

export function getChatSearchSegments(turn: Turn, turnOrder: number): SessionSearchSegment[] {
  if (turn.type === 'user') {
    return [
      segment(turn, turnOrder, `message:${turn.message.id}`, 0, turn.message.content, 'user-message', { type: 'message', id: turn.message.id }),
      ...((turn.message.attachments ?? []).map((attachment, index) =>
        segment(turn, turnOrder, `attachment:${attachment.id ?? index}`, index + 1, attachment.name, 'attachment', { type: 'attachment', id: attachment.id ?? `${turn.message.id}:${index}` }))
      ),
    ].filter((entry): entry is SessionSearchSegment => entry !== null)
  }

  if (turn.type === 'system') {
    const entry = segment(turn, turnOrder, `message:${turn.message.id}`, 0, turn.message.content, 'system', { type: 'message', id: turn.message.id })
    return entry ? [entry] : []
  }

  const segments: SessionSearchSegment[] = []
  const responseTarget = turn.response?.messageId
    ? { type: 'message' as const, id: turn.response.messageId }
    : { type: 'turn' as const, id: turn.turnId }
  const response = segment(turn, turnOrder, `response:${turn.turnId}`, 0, turn.response?.text, 'assistant-message', responseTarget)
  if (response) segments.push(response)

  let segmentOrder = 1
  for (const activity of turn.activities) {
    const fields: Array<[string, unknown]> = [
      ['display-name', activity.displayName],
      ['tool-name', activity.toolName],
      ['intent', activity.intent],
      ['input', activity.toolInput],
      ['content', activity.content],
      ['error', activity.error],
    ]
    for (const [field, value] of fields) {
      const entry = segment(
        turn,
        turnOrder,
        `activity:${activity.id}:${field}`,
        segmentOrder++,
        value,
        field === 'content' || field === 'error' ? 'tool-result' : 'tool-call',
        { type: field === 'content' || field === 'error' ? 'tool-result' : 'tool-call', id: activity.id },
      )
      if (entry) segments.push(entry)
    }
  }
  return segments
}

const turnSearchFingerprintCache = new WeakMap<Turn, string>()

function getChatSearchFingerprint(turn: Turn): string {
  const cached = turnSearchFingerprintCache.get(turn)
  if (cached !== undefined) return cached
  let fingerprint: string
  if (turn.type === 'user') {
    const attachments = turn.message.attachments ?? []
    fingerprint = attachments.length === 0
      ? turn.message.content
      : JSON.stringify([
          turn.message.content,
          attachments.map((attachment, index) => [attachment.id ?? index, attachment.name]),
        ])
  } else if (turn.type === 'system') {
    fingerprint = turn.message.content
  } else {
    fingerprint = JSON.stringify([
      turn.response?.messageId ?? null,
      turn.response?.text ?? null,
      turn.activities.map(activity => [
        activity.id,
        activity.displayName ?? null,
        activity.toolName ?? null,
        activity.intent ?? null,
        toSearchableText(activity.toolInput),
        toSearchableText(activity.content),
        toSearchableText(activity.error),
      ]),
    ])
  }
  turnSearchFingerprintCache.set(turn, fingerprint)
  return fingerprint
}

function snapshotIndexedTurn(
  turn: Turn,
  sealed: boolean,
): IndexedTurnSnapshot {
  return {
    turnId: getChatSearchTurnId(turn),
    turnType: turn.type,
    identity: turn.type === 'assistant' ? turn.turnId : turn.message.id,
    timestamp: turn.timestamp,
    sealed,
    fingerprint: getChatSearchFingerprint(turn),
    source: turn,
  }
}

function hasSameTurnIdentity(snapshot: IndexedTurnSnapshot, turn: Turn): boolean {
  if (snapshot.source === turn) return true
  if (snapshot.turnType !== turn.type || snapshot.timestamp !== turn.timestamp) return false
  return snapshot.identity === (turn.type === 'assistant' ? turn.turnId : turn.message.id)
}

export function buildChatSearchIndex(turns: Turn[]): SessionTextIndex {
  const index = new SessionTextIndex()
  turns.forEach((turn, turnOrder) => {
    for (const entry of getChatSearchSegments(turn, turnOrder)) index.upsert(entry)
  })
  return index
}

function isSealedSearchTurn(turn: Turn, turnOrder: number, turnCount: number): boolean {
  if (turn.type === 'assistant') return turn.isComplete && !turn.isStreaming
  // The newest user/system entry can still be replaced by projection settlement.
  // Once another Turn follows it, its searchable payload is immutable.
  return turnOrder < turnCount - 1
}

/**
 * Session-scoped renderer cache over the shared text index.
 *
 * Pi projections are append-oriented: completed assistant Turns and non-tail
 * user/system Turns have immutable searchable content. Keeping that boundary
 * here lets streaming replace only the mutable tail while a branch/reorder
 * rebuilds the first changed suffix.
 */
export class IncrementalChatSearchIndex {
  #index = new SessionTextIndex()
  #turns: IndexedTurnSnapshot[] = []
  #revision = 0
  #generation = 0
  #mutableStart = 0

  get index(): SessionTextIndex {
    return this.#index
  }

  get revision(): number {
    return this.#revision
  }

  clear(): void {
    this.#generation += 1
    if (this.#turns.length === 0) return
    this.#index = new SessionTextIndex()
    this.#turns = []
    this.#mutableStart = 0
    this.#revision += 1
  }

  reconcile(turns: readonly Turn[]): ChatSearchReconcileStats {
    this.#generation += 1
    const fastPrefix = this.#appendOnlyPrefix(turns)
    return this.#reconcileFrom(turns, fastPrefix ?? this.#commonPrefix(turns), fastPrefix !== null)
  }

  async reconcileAsync(
    turns: readonly Turn[],
    options: ChatSearchReconcileOptions = {},
  ): Promise<ChatSearchReconcileStats | null> {
    const fastPrefix = this.#appendOnlyPrefix(turns)
    if (fastPrefix !== null) return this.reconcile(turns)

    const generation = ++this.#generation
    const yieldEvery = Math.max(1, Math.trunc(options.yieldEvery ?? 250))
    const yieldToHost = options.yieldToHost ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)))
    const stagedIndex = new SessionTextIndex()
    const stagedTurns: IndexedTurnSnapshot[] = []
    let upsertedSegments = 0
    let mutableStart = turns.length

    // Always yield once before initial/divergent construction so indexing never
    // occupies the render or layout critical path.
    await yieldToHost()
    if (options.signal?.aborted || generation !== this.#generation) return null

    for (let turnOrder = 0; turnOrder < turns.length; turnOrder += 1) {
      const turn = turns[turnOrder]
      if (!turn) continue
      const sealed = isSealedSearchTurn(turn, turnOrder, turns.length)
      if (!sealed && mutableStart === turns.length) mutableStart = turnOrder
      const segments = getChatSearchSegments(turn, turnOrder)
      for (const entry of segments) {
        stagedIndex.upsert(entry)
        upsertedSegments += 1
      }
      stagedTurns.push(snapshotIndexedTurn(turn, sealed))

      if ((turnOrder + 1) % yieldEvery === 0 && turnOrder + 1 < turns.length) {
        await yieldToHost()
        if (options.signal?.aborted || generation !== this.#generation) return null
      }
    }

    if (options.signal?.aborted || generation !== this.#generation) return null
    const removedTurns = this.#turns.length
    this.#index = stagedIndex
    this.#turns = stagedTurns
    this.#mutableStart = mutableStart
    this.#revision += 1
    return {
      retainedTurns: 0,
      refreshedTurns: 0,
      addedTurns: turns.length,
      removedTurns,
      upsertedSegments,
      visitedTurns: turns.length,
      revision: this.#revision,
    }
  }

  #appendOnlyPrefix(turns: readonly Turn[]): number | null {
    const previousLength = this.#turns.length
    if (previousLength === 0 || turns.length < previousLength) return null
    for (let index = 0; index < previousLength; index += 1) {
      const previous = this.#turns[index]
      const next = turns[index]
      if (!previous || !next || !hasSameTurnIdentity(previous, next)) return null
      if (index < this.#mutableStart) {
        const sealed = isSealedSearchTurn(next, index, turns.length)
        if (!sealed || (previous.source !== next && previous.fingerprint !== getChatSearchFingerprint(next))) return null
      }
    }
    return previousLength
  }

  #commonPrefix(turns: readonly Turn[]): number {
    let commonPrefix = 0
    while (
      commonPrefix < this.#turns.length
      && commonPrefix < turns.length
      && hasSameTurnIdentity(this.#turns[commonPrefix]!, turns[commonPrefix]!)
      && this.#turns[commonPrefix]?.sealed === isSealedSearchTurn(turns[commonPrefix]!, commonPrefix, turns.length)
      && (
        this.#turns[commonPrefix]?.source === turns[commonPrefix]
        || this.#turns[commonPrefix]?.fingerprint === getChatSearchFingerprint(turns[commonPrefix]!)
      )
    ) {
      commonPrefix += 1
    }
    return commonPrefix
  }

  #reconcileFrom(turns: readonly Turn[], commonPrefix: number, appendOnly: boolean): ChatSearchReconcileStats {
    const previousLength = this.#turns.length
    const refreshStart = appendOnly ? Math.min(this.#mutableStart, commonPrefix) : 0

    let removedTurns = 0
    for (let index = commonPrefix; index < this.#turns.length; index += 1) {
      const previous = this.#turns[index]
      if (!previous) continue
      this.#index.deleteTurn(previous.turnId)
      removedTurns += 1
    }

    let retainedTurns = appendOnly ? refreshStart : 0
    let refreshedTurns = 0
    let addedTurns = 0
    let upsertedSegments = 0
    let mutableStart = turns.length
    const previousMutable = appendOnly
      ? this.#turns.slice(refreshStart, commonPrefix)
      : []
    const nextSnapshots = appendOnly ? this.#turns : []
    if (appendOnly) nextSnapshots.length = refreshStart

    for (let turnOrder = refreshStart; turnOrder < turns.length; turnOrder += 1) {
      const turn = turns[turnOrder]
      if (!turn) continue
      const turnId = getChatSearchTurnId(turn)
      const sealed = isSealedSearchTurn(turn, turnOrder, turns.length)
      const previous = turnOrder < commonPrefix
        ? appendOnly
          ? previousMutable[turnOrder - refreshStart]
          : this.#turns[turnOrder]
        : undefined
      const shouldRefresh = !previous || !previous.sealed || !sealed

      if (shouldRefresh) {
        if (previous) {
          this.#index.deleteTurn(turnId)
          refreshedTurns += 1
        } else {
          addedTurns += 1
        }
        const indexedSegments = getChatSearchSegments(turn, turnOrder)
        for (const entry of indexedSegments) this.#index.upsert(entry)
        upsertedSegments += indexedSegments.length
      } else if (!appendOnly) {
        retainedTurns += 1
      }
      if (!sealed && mutableStart === turns.length) mutableStart = turnOrder
      nextSnapshots.push(snapshotIndexedTurn(turn, sealed))
    }

    const changed = removedTurns > 0 || refreshedTurns > 0 || addedTurns > 0
    if (changed) this.#revision += 1
    this.#turns = nextSnapshots
    this.#mutableStart = mutableStart
    return {
      retainedTurns,
      refreshedTurns,
      addedTurns,
      removedTurns,
      upsertedSegments,
      visitedTurns: turns.length - refreshStart + (appendOnly ? Math.min(3, previousLength) : 0),
      revision: this.#revision,
    }
  }
}

export class ChatSearchMatchPager {
  #snapshot: ChatSearchPageSnapshot = { query: '', matches: [], hasMore: false }

  get snapshot(): ChatSearchPageSnapshot {
    return this.#snapshot
  }

  clear(): ChatSearchPageSnapshot {
    this.#snapshot = { query: '', matches: [], hasMore: false }
    return this.#snapshot
  }

  reset(index: SessionTextIndex, query: string): ChatSearchPageSnapshot {
    const page = index.search(query, { limit: CHAT_SEARCH_PAGE_SIZE })
    this.#snapshot = {
      query,
      matches: page.matches,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    }
    return this.#snapshot
  }

  loadNext(index: SessionTextIndex): ChatSearchPageSnapshot {
    const { query, hasMore, nextCursor } = this.#snapshot
    if (!hasMore || !nextCursor) return this.#snapshot
    const page = index.search(query, { limit: CHAT_SEARCH_PAGE_SIZE, after: nextCursor })
    this.#snapshot = {
      query,
      matches: [...this.#snapshot.matches, ...page.matches],
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    }
    return this.#snapshot
  }
}

export function getChatSearchWindow(
  turns: Turn[],
  activeMatch: SessionSearchMatch | undefined,
  contextTurns = CHAT_SEARCH_CONTEXT_TURNS,
): { turns: Turn[]; startIndex: number; endIndex: number } {
  if (!activeMatch) return { turns: [], startIndex: turns.length, endIndex: turns.length }
  const startIndex = Math.max(0, activeMatch.turnOrder - contextTurns)
  const endIndex = Math.min(turns.length, activeMatch.turnOrder + contextTurns + 1)
  return { turns: turns.slice(startIndex, endIndex), startIndex, endIndex }
}
