import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { PiProjectionEventV1, PiProjectionSnapshotV1 } from '@mortise/shared/protocol'
import {
  applyPiProjectionEvent,
  applyPiProjectionEventAtom,
  applyPiProjectionSnapshot,
  applyPiProjectionSnapshotAtom,
  createPiProjectionState,
  insertOptimisticPiUser,
  isPiProjectionProcessing,
  piProjectionAtomFamily,
  piProjectionIsProcessingAtomFamily,
  removeOptimisticPiUser,
} from '../pi-projection'

function event(overrides: Partial<PiProjectionEventV1> = {}): PiProjectionEventV1 {
  return {
    schemaVersion: 1,
    eventId: overrides.eventId ?? 'event-1',
    seq: overrides.seq ?? 1,
    sessionId: overrides.sessionId ?? 'session-1',
    runtimeId: overrides.runtimeId ?? 'runtime-1',
    entityId: overrides.entityId ?? 'content-1',
    entityType: overrides.entityType ?? 'content_block',
    entityVersion: overrides.entityVersion ?? 1,
    kind: overrides.kind ?? 'assistant_text',
    payload: overrides.payload ?? { text: 'hello' },
    turnId: overrides.turnId,
  }
}

function snapshot(overrides: Partial<PiProjectionSnapshotV1> = {}): PiProjectionSnapshotV1 {
  return {
    schemaVersion: 1,
    sessionId: overrides.sessionId ?? 'session-1',
    runtimeId: overrides.runtimeId ?? 'runtime-1',
    lastSeq: overrides.lastSeq ?? 4,
    entities: overrides.entities ?? [{
      entityId: 'content-1',
      entityType: 'content_block',
      entityVersion: 4,
      createdSeq: 1,
      kind: 'assistant_text',
      payload: { text: 'authoritative' },
      lastEventId: 'event-4',
      lastSeq: 4,
    }],
  }
}

describe('Pi projection reducer', () => {
  it('keeps optimistic attachment refs ordered and removes them with a rejected mutation', () => {
    const mutationId = 'mutation-with-file'
    let state = insertOptimisticPiUser(createPiProjectionState('session-1'), mutationId, 'caption', [
      { id: 'att-1', name: 'photo.png', mediaType: 'image/png', size: 10 },
    ])
    expect(state.entityIds).toEqual([
      `content:user:${mutationId}`,
      `artifact:attachment:${mutationId}:att-1`,
    ])
    expect(state.entitiesById[`artifact:attachment:${mutationId}:att-1`]?.payload).toMatchObject({
      ownerMessageId: mutationId,
    })
    state = removeOptimisticPiUser(state, mutationId)
    expect(state.entityIds).toEqual([])
  })

  it('reconciles optimistic user input without replacing its entity key', () => {
    const mutationId = 'mutation-1'
    let state = insertOptimisticPiUser(createPiProjectionState('session-1'), mutationId, 'hello')
    const entityId = `content:user:${mutationId}`
    expect(state.entityIds).toEqual([entityId])
    expect(state.entitiesById[entityId]?.payload).toMatchObject({
      optimistic: true,
      messageId: mutationId,
    })

    state = applyPiProjectionEvent(state, event({
      entityId,
      kind: 'user_text',
      payload: { role: 'user', text: 'hello', clientMutationId: mutationId, streaming: false },
    }))

    expect(state.entityIds).toEqual([entityId])
    expect(state.entitiesById[entityId]?.entityVersion).toBe(1)
    expect(state.entitiesById[entityId]?.payload).not.toHaveProperty('optimistic')
  })

  it('retains optimistic input across a racing snapshot and rolls it back on rejection', () => {
    const mutationId = 'mutation-2'
    let state = insertOptimisticPiUser(createPiProjectionState('session-1'), mutationId, 'pending')
    state = applyPiProjectionSnapshot(state, snapshot())
    expect(state.entityIds).toContain(`content:user:${mutationId}`)
    state = removeOptimisticPiUser(state, mutationId)
    expect(state.entityIds).not.toContain(`content:user:${mutationId}`)
  })

  it('normalizes entities and applies increasing entity versions', () => {
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), event())
    state = applyPiProjectionEvent(state, event({
      eventId: 'event-2',
      seq: 2,
      entityVersion: 2,
      payload: { text: 'hello world' },
    }))

    expect(state.lastSeq).toBe(2)
    expect(state.entityIds).toEqual(['content-1'])
    expect(state.entitiesById['content-1']?.payload).toEqual({ text: 'hello world' })
  })

  it('accepts entity IDs that overlap object prototype names', () => {
    const state = applyPiProjectionEvent(
      createPiProjectionState('session-1'),
      event({ entityId: '__proto__' }),
    )
    expect(state.entityIds).toEqual(['__proto__'])
    expect(state.entitiesById.__proto__.entityId).toBe('__proto__')
  })

  it('ignores duplicate events without changing object identity', () => {
    const state = applyPiProjectionEvent(createPiProjectionState('session-1'), event())
    expect(applyPiProjectionEvent(state, event())).toBe(state)
  })

  it('advances sequence without overwriting a newer entity version', () => {
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), event({ entityVersion: 3 }))
    const originalEntity = state.entitiesById['content-1']
    state = applyPiProjectionEvent(state, event({ eventId: 'event-2', seq: 2, entityVersion: 2 }))

    expect(state.lastSeq).toBe(2)
    expect(state.entitiesById['content-1']).toBe(originalEntity)
  })

  it('stops applying events after a sequence gap', () => {
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), event())
    state = applyPiProjectionEvent(state, event({ eventId: 'event-3', seq: 3 }))

    expect(state.syncState).toBe('desynced')
    expect(state.gap).toEqual({ expectedSeq: 2, receivedSeq: 3, reason: 'sequence_gap', receivedRuntimeId: 'runtime-1' })
    expect(applyPiProjectionEvent(state, event({ eventId: 'event-2', seq: 2 }))).toBe(state)
  })

  it('requires a snapshot when the runtime changes', () => {
    const state = applyPiProjectionEvent(createPiProjectionState('session-1'), event())
    const changed = applyPiProjectionEvent(state, event({ eventId: 'event-2', seq: 2, runtimeId: 'runtime-2' }))
    expect(changed.syncState).toBe('desynced')
    expect(changed.gap?.reason).toBe('runtime_changed')
  })

  it('uses a snapshot to recover and replaces all local entities', () => {
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), event())
    state = applyPiProjectionEvent(state, event({ eventId: 'event-3', seq: 3 }))
    state = applyPiProjectionSnapshot(state, snapshot())

    expect(state.syncState).toBe('synced')
    expect(state.lastSeq).toBe(4)
    expect(state.entitiesById['content-1']?.payload).toEqual({ text: 'authoritative' })
    state = applyPiProjectionEvent(state, event({ eventId: 'event-5', seq: 5, entityVersion: 5 }))
    expect(state.lastSeq).toBe(5)
  })

  it('does not let a delayed snapshot roll back newer live state', () => {
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), event())
    state = applyPiProjectionEvent(state, event({
      eventId: 'event-2', seq: 2, entityVersion: 2, payload: { text: 'live' },
    }))

    const delayed = snapshot({
      lastSeq: 1,
      entities: [{
        entityId: 'content-1', entityType: 'content_block', entityVersion: 1,
        createdSeq: 1, kind: 'assistant_text', payload: { text: 'stale' },
        lastEventId: 'event-1', lastSeq: 1,
      }],
    })
    expect(applyPiProjectionSnapshot(state, delayed)).toBe(state)
  })

  it('keeps a sequence gap desynced until a snapshot covers the observed event', () => {
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), event())
    state = applyPiProjectionEvent(state, event({ eventId: 'event-3', seq: 3, entityId: 'content-2' }))

    const tooEarly = snapshot({
      lastSeq: 2,
      entities: [{
        entityId: 'content-1', entityType: 'content_block', entityVersion: 2,
        createdSeq: 1, kind: 'assistant_text', payload: { text: 'only through two' },
        lastEventId: 'event-2', lastSeq: 2,
      }],
    })
    expect(applyPiProjectionSnapshot(state, tooEarly)).toBe(state)
    expect(state.syncState).toBe('desynced')
  })

  it('accepts only the observed replacement runtime snapshot after a runtime change', () => {
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), event())
    state = applyPiProjectionEvent(state, event({ eventId: 'runtime-2-event-1', seq: 1, runtimeId: 'runtime-2' }))

    expect(applyPiProjectionSnapshot(state, snapshot({ runtimeId: 'runtime-3' }))).toBe(state)
    const replacement = snapshot({ runtimeId: 'runtime-2', lastSeq: 1 })
    expect(applyPiProjectionSnapshot(state, replacement).runtimeId).toBe('runtime-2')
  })

  it('keeps live and snapshot entity order identical across interleaved updates', () => {
    let live = applyPiProjectionEvent(createPiProjectionState('session-1'), event({ entityId: 'text' }))
    live = applyPiProjectionEvent(live, event({
      eventId: 'event-2', seq: 2, entityId: 'tool', entityType: 'tool_run', kind: 'tool_execution_start',
    }))
    live = applyPiProjectionEvent(live, event({
      eventId: 'event-3', seq: 3, entityId: 'text', entityVersion: 2, payload: { text: 'updated' },
    }))

    const reloaded = applyPiProjectionSnapshot(createPiProjectionState('session-1'), {
      schemaVersion: 1, sessionId: 'session-1', runtimeId: 'runtime-1', lastSeq: 3,
      entities: [live.entitiesById.tool!, live.entitiesById.text!],
    })
    expect(reloaded.entityIds).toEqual(live.entityIds)
    expect(reloaded.entityIds).toEqual(['text', 'tool'])
  })

  it('routes events and snapshots to isolated Jotai session atoms', () => {
    const store = createStore()
    store.set(applyPiProjectionEventAtom, event())
    store.set(applyPiProjectionEventAtom, event({ sessionId: 'session-2', eventId: 's2-event-1' }))

    expect(store.get(piProjectionAtomFamily('session-1')).lastSeq).toBe(1)
    expect(store.get(piProjectionAtomFamily('session-2')).lastSeq).toBe(1)

    store.set(applyPiProjectionSnapshotAtom, snapshot({ sessionId: 'session-1', lastSeq: 8 }))
    expect(store.get(piProjectionAtomFamily('session-1')).lastSeq).toBe(8)
    expect(store.get(piProjectionAtomFamily('session-2')).lastSeq).toBe(1)
  })

  it('derives shell processing state only from the latest Pi lifecycle entity', () => {
    const store = createStore()
    store.set(applyPiProjectionSnapshotAtom, snapshot({
      lastSeq: 3,
      entities: [
        {
          entityId: 'lifecycle:start', entityType: 'conversation', entityVersion: 1,
          createdSeq: 1, kind: 'agent_start', payload: { status: 'running' },
          lastEventId: 'event-1', lastSeq: 1,
        },
        {
          entityId: 'content-1', entityType: 'content_block', entityVersion: 1,
          createdSeq: 2, kind: 'assistant_text', payload: { text: 'streaming' },
          lastEventId: 'event-3', lastSeq: 3,
        },
      ],
    }))

    expect(isPiProjectionProcessing(store.get(piProjectionAtomFamily('session-1')))).toBe(true)
    expect(store.get(piProjectionIsProcessingAtomFamily('session-1'))).toBe(true)

    store.set(applyPiProjectionSnapshotAtom, snapshot({
      lastSeq: 4,
      entities: [
        {
          entityId: 'lifecycle:start', entityType: 'conversation', entityVersion: 1,
          createdSeq: 1, kind: 'agent_start', payload: { status: 'running' },
          lastEventId: 'event-1', lastSeq: 1,
        },
        {
          entityId: 'lifecycle:end', entityType: 'conversation', entityVersion: 1,
          createdSeq: 4, kind: 'agent_end', payload: { status: 'interrupted' },
          lastEventId: 'event-4', lastSeq: 4,
        },
      ],
    }))

    expect(store.get(piProjectionIsProcessingAtomFamily('session-1'))).toBe(false)
  })

  it('keeps a retrying agent_end processing until agent_settled', () => {
    const store = createStore()
    store.set(applyPiProjectionSnapshotAtom, snapshot({
      lastSeq: 2,
      entities: [
        {
          entityId: 'lifecycle:start', entityType: 'conversation', entityVersion: 1,
          createdSeq: 1, kind: 'agent_start', payload: { status: 'running' },
          lastEventId: 'event-1', lastSeq: 1,
        },
        {
          entityId: 'lifecycle:attempt-end', entityType: 'conversation', entityVersion: 1,
          createdSeq: 2, kind: 'agent_end',
          payload: { status: 'failed', willRetry: true, settlementPending: true },
          lastEventId: 'event-2', lastSeq: 2,
        },
      ],
    }))
    expect(store.get(piProjectionIsProcessingAtomFamily('session-1'))).toBe(true)

    store.set(applyPiProjectionEventAtom, event({
      eventId: 'event-3', seq: 3, entityId: 'lifecycle:settled',
      entityType: 'conversation', kind: 'agent_settled', payload: { status: 'completed' },
    }))
    expect(store.get(piProjectionIsProcessingAtomFamily('session-1'))).toBe(false)
  })
})
