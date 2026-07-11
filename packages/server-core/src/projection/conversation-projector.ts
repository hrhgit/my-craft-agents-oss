import type {
  PiProjectionEntityV1,
  PiProjectionEventV1,
  PiProjectionSnapshotV1,
} from '@craft-agent/shared/protocol'

export type ProjectionApplyResult =
  | { status: 'applied'; events: PiProjectionEventV1[]; lastSeq: number }
  | { status: 'buffered'; expectedSeq: number; receivedSeq: number }
  | { status: 'duplicate'; lastSeq: number }
  | { status: 'stale'; reason: 'sequence' | 'entity_version'; lastSeq: number }

export class ProjectionIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionIdentityError'
  }
}

/**
 * Orders and reduces one Pi runtime's event stream. A sequence gap never leaks a
 * partial projection: later events remain buffered until the gap is filled or a
 * fresh snapshot is installed.
 */
export class ConversationProjector {
  readonly sessionId: string
  readonly runtimeId: string

  private lastSeq = 0
  private readonly entities = new Map<string, PiProjectionEntityV1>()
  private readonly appliedEventIds = new Set<string>()
  private readonly appliedSeqs = new Map<number, string>()
  private readonly pending = new Map<number, PiProjectionEventV1>()
  private readonly pendingEventIds = new Set<string>()

  constructor(sessionId: string, runtimeId: string, snapshot?: PiProjectionSnapshotV1) {
    this.sessionId = sessionId
    this.runtimeId = runtimeId
    if (snapshot) this.installSnapshot(snapshot)
  }

  apply(event: PiProjectionEventV1): ProjectionApplyResult {
    this.assertEvent(event)

    if (this.appliedEventIds.has(event.eventId) || this.pendingEventIds.has(event.eventId)) {
      return { status: 'duplicate', lastSeq: this.lastSeq }
    }

    const eventAtSeq = this.appliedSeqs.get(event.seq) ?? this.pending.get(event.seq)?.eventId
    if (eventAtSeq) {
      if (eventAtSeq === event.eventId) return { status: 'duplicate', lastSeq: this.lastSeq }
      return { status: 'stale', reason: 'sequence', lastSeq: this.lastSeq }
    }
    if (event.seq <= this.lastSeq) {
      return { status: 'stale', reason: 'sequence', lastSeq: this.lastSeq }
    }

    const expectedSeq = this.lastSeq + 1
    if (event.seq > expectedSeq) {
      this.pending.set(event.seq, event)
      this.pendingEventIds.add(event.eventId)
      return { status: 'buffered', expectedSeq, receivedSeq: event.seq }
    }

    const events: PiProjectionEventV1[] = []
    let ignoredStaleEntity = false
    let current: PiProjectionEventV1 | undefined = event
    while (current) {
      const applied = this.reduce(current)
      if (!applied) {
        // The sequence itself is authoritative even when an entity update is
        // obsolete. Consume it as a no-op so one bad version cannot deadlock
        // all later events for this runtime.
        ignoredStaleEntity = true
        this.consumeSequence(current)
      } else {
        events.push(current)
      }
      const next = this.pending.get(this.lastSeq + 1)
      if (next) {
        this.pending.delete(next.seq)
        this.pendingEventIds.delete(next.eventId)
      }
      current = next
    }
    if (events.length === 0 && ignoredStaleEntity) {
      return { status: 'stale', reason: 'entity_version', lastSeq: this.lastSeq }
    }
    return { status: 'applied', events, lastSeq: this.lastSeq }
  }

  hasGap(): boolean {
    return this.pending.size > 0
  }

  getExpectedSeq(): number {
    return this.lastSeq + 1
  }

  getEntity(entityId: string): PiProjectionEntityV1 | undefined {
    const entity = this.entities.get(entityId)
    return entity ? structuredClone(entity) : undefined
  }

  createSnapshot(): PiProjectionSnapshotV1 {
    return structuredClone({
      schemaVersion: 1,
      sessionId: this.sessionId,
      runtimeId: this.runtimeId,
      lastSeq: this.lastSeq,
      entities: [...this.entities.values()].sort((a, b) => a.createdSeq - b.createdSeq),
    })
  }

  installSnapshot(snapshot: PiProjectionSnapshotV1): void {
    this.assertIdentity(snapshot.sessionId, snapshot.runtimeId)
    if (snapshot.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.lastSeq) || snapshot.lastSeq < 0 || !Array.isArray(snapshot.entities)) {
      throw new TypeError('Invalid Pi projection snapshot')
    }
    const entityIds = new Set<string>()
    const eventIds = new Set<string>()
    const sequences = new Set<number>()
    for (const entity of snapshot.entities) {
      if (!entity || typeof entity !== 'object'
        || typeof entity.entityId !== 'string' || !entity.entityId
        || typeof entity.lastEventId !== 'string' || !entity.lastEventId
        || typeof entity.kind !== 'string' || !entity.kind
        || !isEntityType(entity.entityType)
        || !Number.isSafeInteger(entity.entityVersion) || entity.entityVersion < 1
        || !Number.isSafeInteger(entity.createdSeq) || entity.createdSeq < 1 || entity.createdSeq > entity.lastSeq
        || !Number.isSafeInteger(entity.lastSeq) || entity.lastSeq < 1 || entity.lastSeq > snapshot.lastSeq
        || entityIds.has(entity.entityId) || eventIds.has(entity.lastEventId) || sequences.has(entity.lastSeq)) {
        throw new TypeError('Invalid Pi projection snapshot entity')
      }
      entityIds.add(entity.entityId)
      eventIds.add(entity.lastEventId)
      sequences.add(entity.lastSeq)
    }
    this.lastSeq = snapshot.lastSeq
    this.entities.clear()
    this.appliedEventIds.clear()
    this.appliedSeqs.clear()
    this.pending.clear()
    this.pendingEventIds.clear()
    for (const entity of snapshot.entities) {
      this.entities.set(entity.entityId, structuredClone(entity))
      this.appliedEventIds.add(entity.lastEventId)
      this.appliedSeqs.set(entity.lastSeq, entity.lastEventId)
    }
  }

  private reduce(event: PiProjectionEventV1): boolean {
    const existing = this.entities.get(event.entityId)
    if (existing && event.entityVersion <= existing.entityVersion) return false

    this.entities.set(event.entityId, {
      entityId: event.entityId,
      entityType: event.entityType,
      entityVersion: event.entityVersion,
      createdSeq: existing?.createdSeq ?? event.seq,
      turnId: event.turnId,
      kind: event.kind,
      payload: structuredClone(event.payload),
      lastEventId: event.eventId,
      lastSeq: event.seq,
    })
    this.lastSeq = event.seq
    this.appliedEventIds.add(event.eventId)
    this.appliedSeqs.set(event.seq, event.eventId)
    return true
  }

  private consumeSequence(event: PiProjectionEventV1): void {
    this.lastSeq = event.seq
    this.appliedEventIds.add(event.eventId)
    this.appliedSeqs.set(event.seq, event.eventId)
  }

  private assertEvent(event: PiProjectionEventV1): void {
    this.assertIdentity(event.sessionId, event.runtimeId)
    if (event.schemaVersion !== 1) throw new TypeError('Unsupported Pi projection schema version')
    if (!event.eventId || !event.entityId || !event.kind) throw new TypeError('Invalid Pi projection event')
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw new TypeError('Invalid Pi projection sequence')
    if (!Number.isSafeInteger(event.entityVersion) || event.entityVersion < 1) {
      throw new TypeError('Invalid Pi projection entity version')
    }
  }

  private assertIdentity(sessionId: string, runtimeId: string): void {
    if (sessionId !== this.sessionId || runtimeId !== this.runtimeId) {
      throw new ProjectionIdentityError(
        `Projection belongs to ${this.sessionId}/${this.runtimeId}, received ${sessionId}/${runtimeId}`,
      )
    }
  }
}

function isEntityType(value: unknown): value is PiProjectionEntityV1['entityType'] {
  return value === 'conversation' || value === 'turn' || value === 'content_block'
    || value === 'tool_run' || value === 'prompt_request' || value === 'artifact_ref'
}
