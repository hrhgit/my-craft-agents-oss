import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import type {
  PiProjectionEntityV1,
  PiProjectionEventV1,
  PiProjectionSnapshotV1,
} from '@mortise/shared/protocol'

export type PiProjectionSyncState = 'empty' | 'synced' | 'desynced'

export interface PiProjectionGap {
  expectedSeq: number
  receivedSeq: number
  reason: 'sequence_gap' | 'runtime_changed'
  receivedRuntimeId: string
}

/** Renderer-owned normalized view of one Pi-native conversation projection. */
export interface PiProjectionState {
  sessionId: string
  runtimeId: string | null
  lastSeq: number
  syncState: PiProjectionSyncState
  gap: PiProjectionGap | null
  entitiesById: Readonly<Record<string, PiProjectionEntityV1>>
  entityIds: readonly string[]
  seenEventIds: ReadonlySet<string>
}

export function createPiProjectionState(sessionId: string): PiProjectionState {
  return {
    sessionId,
    runtimeId: null,
    lastSeq: 0,
    syncState: 'empty',
    gap: null,
    entitiesById: Object.create(null) as Record<string, PiProjectionEntityV1>,
    entityIds: [],
    seenEventIds: new Set(),
  }
}

/** Adds a renderer-only user block whose identity is also used by Pi confirmation. */
export function insertOptimisticPiUser(
  state: PiProjectionState,
  clientMutationId: string,
  text: string,
  attachments: ReadonlyArray<{ id: string; name: string; mediaType?: string; size?: number }> = [],
): PiProjectionState {
  const entityId = `content:user:${clientMutationId}`
  if (state.entitiesById[entityId]) return state
  const entitiesById = Object.assign(
    Object.create(null) as Record<string, PiProjectionEntityV1>,
    state.entitiesById,
  )
  const occurredAt = Date.now()
  entitiesById[entityId] = {
    entityId,
    entityType: 'content_block',
    entityVersion: 0,
    createdSeq: state.lastSeq + 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    kind: 'user_text',
    payload: {
      role: 'user', messageId: clientMutationId, text, streaming: false,
      clientMutationId, optimistic: true, timestamp: Date.now(),
    },
    lastEventId: `optimistic:${clientMutationId}`,
    lastSeq: state.lastSeq + 1,
  }
  const entityIds = [...state.entityIds, entityId]
  attachments.forEach((attachment, order) => {
    const attachmentEntityId = `artifact:attachment:${clientMutationId}:${attachment.id}`
    entitiesById[attachmentEntityId] = {
      entityId: attachmentEntityId,
      entityType: 'artifact_ref',
      entityVersion: 0,
      createdSeq: state.lastSeq + 2 + order,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      kind: 'user_attachment',
      payload: {
        attachment, clientMutationId, ownerMessageId: clientMutationId,
        contentEntityId: entityId, order, optimistic: true,
      },
      lastEventId: `optimistic:${clientMutationId}:attachment:${attachment.id}`,
      lastSeq: state.lastSeq + 2 + order,
    }
    entityIds.push(attachmentEntityId)
  })
  return { ...state, entitiesById, entityIds }
}

/** Rolls back an optimistic block when the send RPC rejects before Pi accepts it. */
export function removeOptimisticPiUser(
  state: PiProjectionState,
  clientMutationId: string,
): PiProjectionState {
  const entityId = `content:user:${clientMutationId}`
  const entity = state.entitiesById[entityId]
  const payload = entity?.payload as Record<string, unknown> | undefined
  if (!entity || payload?.optimistic !== true) return state
  const entitiesById = Object.assign(
    Object.create(null) as Record<string, PiProjectionEntityV1>,
    state.entitiesById,
  )
  const optimisticIds = state.entityIds.filter(id => {
    const candidate = state.entitiesById[id]
    const candidatePayload = candidate?.payload as Record<string, unknown> | undefined
    return candidatePayload?.optimistic === true && candidatePayload.clientMutationId === clientMutationId
  })
  for (const optimisticId of optimisticIds) delete entitiesById[optimisticId]
  return { ...state, entitiesById, entityIds: state.entityIds.filter(id => !optimisticIds.includes(id)) }
}

function markDesynced(
  state: PiProjectionState,
  receivedSeq: number,
  reason: PiProjectionGap['reason'],
  receivedRuntimeId: string,
): PiProjectionState {
  if (state.syncState === 'desynced') return state
  return {
    ...state,
    syncState: 'desynced',
    gap: { expectedSeq: state.lastSeq + 1, receivedSeq, reason, receivedRuntimeId },
  }
}

/**
 * Applies a live projection event. Once a gap is observed, incremental events
 * are ignored until an authoritative snapshot is installed.
 */
export function applyPiProjectionEvent(
  state: PiProjectionState,
  event: PiProjectionEventV1,
): PiProjectionState {
  if (event.sessionId !== state.sessionId) return state
  if (state.syncState === 'desynced') return state

  if (state.runtimeId !== null && event.runtimeId !== state.runtimeId) {
    return markDesynced(state, event.seq, 'runtime_changed', event.runtimeId)
  }
  if (state.seenEventIds.has(event.eventId) || event.seq <= state.lastSeq) return state

  const expectedSeq = state.lastSeq + 1
  if (event.seq !== expectedSeq) {
    return markDesynced(state, event.seq, 'sequence_gap', event.runtimeId)
  }

  const existing = state.entitiesById[event.entityId]
  const shouldReplace = !existing || event.entityVersion > existing.entityVersion
  let entitiesById = state.entitiesById
  if (shouldReplace) {
    const nextEntities = Object.assign(
      Object.create(null) as Record<string, PiProjectionEntityV1>,
      state.entitiesById,
    )
    nextEntities[event.entityId] = {
      entityId: event.entityId,
      entityType: event.entityType,
      entityVersion: event.entityVersion,
      createdSeq: existing?.createdSeq ?? event.seq,
      createdAt: existing?.createdAt ?? event.occurredAt,
      updatedAt: event.occurredAt ?? existing?.updatedAt,
      turnId: event.turnId,
      kind: event.kind,
      payload: event.payload,
      lastEventId: event.eventId,
      lastSeq: event.seq,
    }
    entitiesById = nextEntities
  }

  return {
    ...state,
    runtimeId: event.runtimeId,
    lastSeq: event.seq,
    syncState: 'synced',
    gap: null,
    entitiesById,
    entityIds: shouldReplace && !existing ? [...state.entityIds, event.entityId] : state.entityIds,
    seenEventIds: new Set(state.seenEventIds).add(event.eventId),
  }
}

/** Replaces all local projection state with a host-authored snapshot. */
export function applyPiProjectionSnapshot(
  state: PiProjectionState,
  snapshot: PiProjectionSnapshotV1,
): PiProjectionState {
  if (snapshot.sessionId !== state.sessionId) return state

  if (state.runtimeId !== null) {
    if (snapshot.runtimeId !== state.runtimeId) {
      if (state.gap?.reason !== 'runtime_changed' || snapshot.runtimeId !== state.gap.receivedRuntimeId) return state
    } else if (snapshot.lastSeq < state.lastSeq) {
      return state
    }
  }
  if (state.syncState === 'desynced'
    && state.gap?.reason === 'sequence_gap'
    && snapshot.runtimeId === state.runtimeId
    && snapshot.lastSeq < state.gap.receivedSeq) {
    return state
  }

  const entitiesById = Object.create(null) as Record<string, PiProjectionEntityV1>
  const entityIds: string[] = []
  for (const entity of [...snapshot.entities].sort((a, b) => a.createdSeq - b.createdSeq)) {
    const current = entitiesById[entity.entityId]
    if (!current) entityIds.push(entity.entityId)
    if (!current || entity.entityVersion > current.entityVersion) {
      entitiesById[entity.entityId] = entity
    }
  }

  // A snapshot may race prompt acceptance. Retain renderer-only pending blocks;
  // the later Pi event replaces the same ID, while an RPC rejection removes it.
  for (const entityId of state.entityIds) {
    if (entitiesById[entityId]) continue
    const entity = state.entitiesById[entityId]
    const payload = entity?.payload as Record<string, unknown> | undefined
    if (!entity || payload?.optimistic !== true) continue
    entitiesById[entityId] = entity
    entityIds.push(entityId)
  }

  return {
    sessionId: snapshot.sessionId,
    runtimeId: snapshot.runtimeId,
    lastSeq: snapshot.lastSeq,
    syncState: 'synced',
    gap: null,
    entitiesById,
    entityIds,
    seenEventIds: new Set(snapshot.entities.map((entity) => entity.lastEventId)),
  }
}

export const piProjectionAtomFamily = atomFamily(
  (sessionId: string) => atom<PiProjectionState>(createPiProjectionState(sessionId)),
  (a, b) => a === b,
)

const PI_PROCESSING_LIFECYCLE_KINDS = new Set([
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'compaction_start',
  'compaction_end',
  'runtime_error',
])

/** Lightweight projection-owned processing state for shell-level actions. */
export function isPiProjectionProcessing(state: PiProjectionState): boolean {
  if (state.syncState !== 'synced') return false

  let latest: PiProjectionEntityV1 | undefined
  for (const entityId of state.entityIds) {
    const entity = state.entitiesById[entityId]
    if (!entity || !PI_PROCESSING_LIFECYCLE_KINDS.has(entity.kind)) continue
    if (!latest || entity.lastSeq > latest.lastSeq) latest = entity
  }

  return latest?.kind === 'agent_start'
    || latest?.kind === 'turn_start'
    || latest?.kind === 'compaction_start'
}

export const piProjectionIsProcessingAtomFamily = atomFamily(
  (sessionId: string) => atom((get) => isPiProjectionProcessing(get(piProjectionAtomFamily(sessionId)))),
  (a, b) => a === b,
)

export const applyPiProjectionEventAtom = atom(
  null,
  (get, set, event: PiProjectionEventV1) => {
    const sessionAtom = piProjectionAtomFamily(event.sessionId)
    set(sessionAtom, applyPiProjectionEvent(get(sessionAtom), event))
  },
)

export const applyPiProjectionSnapshotAtom = atom(
  null,
  (get, set, snapshot: PiProjectionSnapshotV1) => {
    const sessionAtom = piProjectionAtomFamily(snapshot.sessionId)
    set(sessionAtom, applyPiProjectionSnapshot(get(sessionAtom), snapshot))
  },
)
