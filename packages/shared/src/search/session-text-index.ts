export const DEFAULT_SESSION_SEARCH_LIMIT = 50
export const MAX_SESSION_SEARCH_LIMIT = 200

export type SessionSearchSegmentKind =
  | 'user-message'
  | 'assistant-message'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'system'
  | 'attachment'
  | 'other'

export type SessionSearchTargetType =
  | 'turn'
  | 'message'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'attachment'
  | 'custom'

export interface SessionSearchTarget {
  type: SessionSearchTargetType
  /** Stable renderer/domain identity used to reveal the matched segment. */
  id: string
}

export interface SessionSearchSegment {
  turnId: string
  segmentId: string
  /** Stable transcript order. Updating a segment may deliberately change it. */
  turnOrder: number
  /** Stable order within the turn. */
  segmentOrder: number
  kind: SessionSearchSegmentKind
  target: SessionSearchTarget
  text: string
}

export interface SessionSearchCursor {
  /** Cursors are only valid for the normalized query that created them. */
  query: string
  turnOrder: number
  segmentOrder: number
  turnId: string
  segmentId: string
  start: number
}

export interface SessionSearchOptions {
  limit?: number
  after?: SessionSearchCursor
}

export interface SessionSearchMatch {
  turnId: string
  segmentId: string
  turnOrder: number
  segmentOrder: number
  kind: SessionSearchSegmentKind
  target: SessionSearchTarget
  /** Exact UTF-16 offsets into the original segment text. */
  start: number
  end: number
}

export interface SessionSearchPage {
  normalizedQuery: string
  matches: SessionSearchMatch[]
  hasMore: boolean
  nextCursor?: SessionSearchCursor
  /** Number of indexed segments selected by the n-gram index for this query. */
  candidateSegmentCount: number
}

interface NormalizedText {
  value: string
  originalStarts: number[]
  originalEnds: number[]
}

interface IndexedSegment {
  key: string
  segment: SessionSearchSegment
  normalized: NormalizedText
  grams: Set<string>
}

export interface SessionTextIndexDiagnostics {
  segmentCount: number
  indexedTurnCount: number
  postingGramCount: number
  deleteTurnCalls: number
  deleteTurnVisitedSegmentKeys: number
}

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })

function normalizeWithOffsets(text: string): NormalizedText {
  let value = ''
  const originalStarts: number[] = []
  const originalEnds: number[] = []
  let previousWasWhitespace = false

  for (const grapheme of graphemeSegmenter.segment(text)) {
    const originalStart = grapheme.index
    const originalEnd = originalStart + grapheme.segment.length
    const normalizedGrapheme = grapheme.segment.normalize('NFKC').toLowerCase()

    for (const normalizedCodePoint of normalizedGrapheme) {
      const isWhitespace = /^\s$/u.test(normalizedCodePoint)
      if (isWhitespace && previousWasWhitespace) continue

      const normalizedPart = isWhitespace ? ' ' : normalizedCodePoint
      previousWasWhitespace = isWhitespace
      value += normalizedPart
      for (let index = 0; index < normalizedPart.length; index += 1) {
        originalStarts.push(originalStart)
        originalEnds.push(originalEnd)
      }
    }
  }

  return { value, originalStarts, originalEnds }
}

/** Normalize search input independently of the host locale. */
export function normalizeSessionSearchQuery(query: string): string {
  return normalizeWithOffsets(query).value.trim()
}

function makeSegmentKey(turnId: string, segmentId: string): string {
  return JSON.stringify([turnId, segmentId])
}

function collectGrams(text: string): Set<string> {
  const codePoints = Array.from(text)
  const grams = new Set<string>()
  for (let index = 0; index < codePoints.length; index += 1) {
    const first = codePoints[index]!
    grams.add(first)
    const second = codePoints[index + 1]
    if (second === undefined) continue
    grams.add(first + second)
    const third = codePoints[index + 2]
    if (third !== undefined) grams.add(first + second + third)
  }
  return grams
}

function queryGrams(query: string): string[] {
  const codePoints = Array.from(query)
  const width = Math.min(3, codePoints.length)
  const grams = new Set<string>()
  for (let index = 0; index + width <= codePoints.length; index += 1) {
    grams.add(codePoints.slice(index, index + width).join(''))
  }
  return [...grams]
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function compareSegments(left: IndexedSegment, right: IndexedSegment): number {
  return left.segment.turnOrder - right.segment.turnOrder
    || left.segment.segmentOrder - right.segment.segmentOrder
    || compareIds(left.segment.turnId, right.segment.turnId)
    || compareIds(left.segment.segmentId, right.segment.segmentId)
}

function compareMatchToCursor(match: SessionSearchMatch, cursor: SessionSearchCursor): number {
  return match.turnOrder - cursor.turnOrder
    || match.segmentOrder - cursor.segmentOrder
    || compareIds(match.turnId, cursor.turnId)
    || compareIds(match.segmentId, cursor.segmentId)
    || match.start - cursor.start
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SESSION_SEARCH_LIMIT
  return Math.min(MAX_SESSION_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)))
}

function assertSegment(segment: SessionSearchSegment): void {
  if (!segment.turnId || !segment.segmentId) {
    throw new TypeError('Session search segments require non-empty turnId and segmentId values')
  }
  if (!segment.target.id) {
    throw new TypeError('Session search segments require a non-empty target id')
  }
  if (!Number.isSafeInteger(segment.turnOrder) || !Number.isSafeInteger(segment.segmentOrder)) {
    throw new TypeError('Session search segment order values must be safe integers')
  }
}

/**
 * Incremental, bounded text index for one session transcript.
 *
 * The index owns immutable snapshots of supplied segment metadata. Upserts replace
 * an existing `(turnId, segmentId)` record and remove its old n-gram postings.
 */
export class SessionTextIndex {
  readonly #segments = new Map<string, IndexedSegment>()
  readonly #segmentKeysByTurn = new Map<string, Set<string>>()
  readonly #postings = new Map<string, Set<string>>()
  #deleteTurnCalls = 0
  #deleteTurnVisitedSegmentKeys = 0

  get size(): number {
    return this.#segments.size
  }

  get diagnostics(): SessionTextIndexDiagnostics {
    return {
      segmentCount: this.#segments.size,
      indexedTurnCount: this.#segmentKeysByTurn.size,
      postingGramCount: this.#postings.size,
      deleteTurnCalls: this.#deleteTurnCalls,
      deleteTurnVisitedSegmentKeys: this.#deleteTurnVisitedSegmentKeys,
    }
  }

  upsert(segment: SessionSearchSegment): void {
    assertSegment(segment)
    const key = makeSegmentKey(segment.turnId, segment.segmentId)
    this.#removeByKey(key)

    const snapshot: SessionSearchSegment = {
      ...segment,
      target: { ...segment.target },
    }
    const normalized = normalizeWithOffsets(snapshot.text)
    const grams = collectGrams(normalized.value)
    const indexed: IndexedSegment = { key, segment: snapshot, normalized, grams }
    this.#segments.set(key, indexed)
    let turnKeys = this.#segmentKeysByTurn.get(snapshot.turnId)
    if (!turnKeys) {
      turnKeys = new Set<string>()
      this.#segmentKeysByTurn.set(snapshot.turnId, turnKeys)
    }
    turnKeys.add(key)

    for (const gram of grams) {
      let keys = this.#postings.get(gram)
      if (!keys) {
        keys = new Set<string>()
        this.#postings.set(gram, keys)
      }
      keys.add(key)
    }
  }

  delete(turnId: string, segmentId: string): boolean {
    return this.#removeByKey(makeSegmentKey(turnId, segmentId))
  }

  deleteTurn(turnId: string): number {
    this.#deleteTurnCalls += 1
    const keys = this.#segmentKeysByTurn.get(turnId)
    if (!keys) return 0
    const deletedCount = keys.size
    for (const key of keys) {
      this.#deleteTurnVisitedSegmentKeys += 1
      this.#removeByKey(key)
    }
    return deletedCount
  }

  clear(): void {
    this.#segments.clear()
    this.#segmentKeysByTurn.clear()
    this.#postings.clear()
    this.#deleteTurnCalls = 0
    this.#deleteTurnVisitedSegmentKeys = 0
  }

  search(query: string, options: SessionSearchOptions = {}): SessionSearchPage {
    const normalizedQuery = normalizeSessionSearchQuery(query)
    if (!normalizedQuery) {
      return { normalizedQuery, matches: [], hasMore: false, candidateSegmentCount: 0 }
    }
    if (options.after && options.after.query !== normalizedQuery) {
      throw new TypeError('Session search cursor query does not match the current normalized query')
    }

    const candidates = this.#candidateSegments(normalizedQuery)
    const limit = boundedLimit(options.limit)
    const matches: SessionSearchMatch[] = []
    let hasMore = false

    outer: for (const entry of candidates) {
      let normalizedStart = 0
      while (normalizedStart <= entry.normalized.value.length - normalizedQuery.length) {
        const found = entry.normalized.value.indexOf(normalizedQuery, normalizedStart)
        if (found < 0) break
        const normalizedEnd = found + normalizedQuery.length
        const start = entry.normalized.originalStarts[found]
        const end = entry.normalized.originalEnds[normalizedEnd - 1]
        if (start === undefined || end === undefined) break

        const match: SessionSearchMatch = {
          turnId: entry.segment.turnId,
          segmentId: entry.segment.segmentId,
          turnOrder: entry.segment.turnOrder,
          segmentOrder: entry.segment.segmentOrder,
          kind: entry.segment.kind,
          target: { ...entry.segment.target },
          start,
          end,
        }
        normalizedStart = normalizedEnd

        if (options.after && compareMatchToCursor(match, options.after) <= 0) continue
        if (matches.length === limit) {
          hasMore = true
          break outer
        }
        matches.push(match)
      }
    }

    const last = matches.at(-1)
    return {
      normalizedQuery,
      matches,
      hasMore,
      candidateSegmentCount: candidates.length,
      ...(hasMore && last
        ? {
            nextCursor: {
              query: normalizedQuery,
              turnOrder: last.turnOrder,
              segmentOrder: last.segmentOrder,
              turnId: last.turnId,
              segmentId: last.segmentId,
              start: last.start,
            },
          }
        : {}),
    }
  }

  #candidateSegments(query: string): IndexedSegment[] {
    const grams = queryGrams(query)
    if (grams.length === 0) return []
    const postings = grams.map((gram) => this.#postings.get(gram))
    if (postings.some((keys) => !keys)) return []

    const orderedPostings = (postings as Set<string>[]).sort((left, right) => left.size - right.size)
    const [smallest, ...rest] = orderedPostings
    if (!smallest) return []

    const candidates: IndexedSegment[] = []
    for (const key of smallest) {
      if (!rest.every((keys) => keys.has(key))) continue
      const segment = this.#segments.get(key)
      if (segment) candidates.push(segment)
    }
    return candidates.sort(compareSegments)
  }

  #removeByKey(key: string): boolean {
    const existing = this.#segments.get(key)
    if (!existing) return false
    this.#segments.delete(key)
    const turnKeys = this.#segmentKeysByTurn.get(existing.segment.turnId)
    turnKeys?.delete(key)
    if (turnKeys?.size === 0) this.#segmentKeysByTurn.delete(existing.segment.turnId)
    for (const gram of existing.grams) {
      const keys = this.#postings.get(gram)
      keys?.delete(key)
      if (keys?.size === 0) this.#postings.delete(gram)
    }
    return true
  }
}
