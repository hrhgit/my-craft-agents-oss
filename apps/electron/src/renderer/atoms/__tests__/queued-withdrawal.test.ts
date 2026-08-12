import { describe, expect, it } from 'bun:test'
import type { PiProjectionEventV1 } from '@mortise/shared/protocol'
import {
  applyPiProjectionEvent,
  createPiProjectionState,
  insertOptimisticPiUser,
  removeQueuedPiUser,
} from '../pi-projection'
import { buildPiTurns } from '../../components/app-shell/pi-turn-model'

function runtimeEvent(seq: number, overrides: Partial<PiProjectionEventV1> = {}): PiProjectionEventV1 {
  return {
    schemaVersion: 1,
    eventId: `runtime:${seq}`,
    seq,
    sessionId: 'session-1',
    runtimeId: 'runtime-1',
    entityId: overrides.entityId ?? `content:assistant:${seq}`,
    entityType: 'content_block',
    entityVersion: 1,
    kind: 'assistant_text',
    payload: { role: 'assistant', text: `stream ${seq}`, streaming: true, isIntermediate: true },
    ...overrides,
  }
}

function hostQueuedEvent(seq: number, mutationId: string, version = 1): PiProjectionEventV1 {
  return {
    schemaVersion: 1,
    eventId: `host:queued:${seq}`,
    seq,
    sessionId: 'session-1',
    runtimeId: 'runtime-1',
    entityId: `content:user:${mutationId}`,
    entityType: 'content_block',
    entityVersion: version,
    kind: 'user_text',
    payload: {
      role: 'user', text: 'later instruction', streaming: false,
      messageId: mutationId, clientMutationId: mutationId,
      queueStatus: 'queued', source: 'host', timestamp: Date.now(),
    },
  }
}

function cancelledEvent(seq: number, mutationId: string, version: number): PiProjectionEventV1 {
  return {
    schemaVersion: 1,
    eventId: `host:cancelled:${seq}`,
    seq,
    sessionId: 'session-1',
    runtimeId: 'runtime-1',
    entityId: `content:user:${mutationId}`,
    entityType: 'content_block',
    entityVersion: version,
    kind: 'user_text',
    payload: {
      role: 'user', text: 'later instruction', streaming: false,
      messageId: mutationId, clientMutationId: mutationId,
      queueStatus: 'cancelled', source: 'host', timestamp: Date.now(),
    },
  }
}

function queuedIds(turns: ReturnType<typeof buildPiTurns>): string[] {
  return turns
    .filter((turn): turn is Extract<typeof turn, { type: 'user' }> => turn.type === 'user' && turn.message.isQueued === true)
    .map(turn => turn.message.id)
}

describe('queued message edit/withdraw projection flow', () => {
  it('removes the authoritative host-projected queued entity on local withdrawal', () => {
    const mutationId = 'mutation-1'
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), runtimeEvent(1))
    state = applyPiProjectionEvent(state, runtimeEvent(2))

    // Renderer optimistic insert (mid-stream queue)
    state = insertOptimisticPiUser(state, mutationId, 'later instruction', [], true)
    expect(queuedIds(buildPiTurns(Object.values(state.entitiesById)))).toEqual([mutationId])

    // Backend acceptHostQueuedUser event lands: replaces the optimistic entity
    // with the authoritative host entity (no `optimistic` flag)
    state = applyPiProjectionEvent(state, hostQueuedEvent(3, mutationId, 1))
    expect(state.entitiesById[`content:user:${mutationId}`]?.payload).toMatchObject({ queueStatus: 'queued' })
    expect(state.entitiesById[`content:user:${mutationId}`]?.payload).not.toHaveProperty('optimistic')

    // Local withdrawal clear: must remove the host entity even though it is
    // not optimistic (regression: removeOptimisticPiUser was a no-op here and
    // the queued strip stayed visible)
    state = removeQueuedPiUser(state, mutationId)
    expect(state.entitiesById[`content:user:${mutationId}`]).toBeUndefined()
    expect(queuedIds(buildPiTurns(Object.values(state.entitiesById)))).toEqual([])
  })

  it('still removes the optimistic entity when the host event has not landed yet', () => {
    const mutationId = 'mutation-2'
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), runtimeEvent(1))
    state = insertOptimisticPiUser(state, mutationId, 'later instruction', [], true)

    state = removeQueuedPiUser(state, mutationId)
    expect(queuedIds(buildPiTurns(Object.values(state.entitiesById)))).toEqual([])
  })

  it('leaves accepted (non-queued) user entities untouched', () => {
    const mutationId = 'mutation-3'
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), runtimeEvent(1))
    state = applyPiProjectionEvent(state, {
      ...hostQueuedEvent(2, mutationId, 1),
      payload: {
        role: 'user', text: 'later instruction', streaming: false,
        messageId: mutationId, clientMutationId: mutationId,
        queueStatus: 'accepted', source: 'pi', timestamp: Date.now(),
      },
    })

    state = removeQueuedPiUser(state, mutationId)
    expect(state.entitiesById[`content:user:${mutationId}`]?.payload).toMatchObject({ queueStatus: 'accepted' })
  })

  it('applies the backend cancel event and clears the queued list', () => {
    const mutationId = 'mutation-4'
    let state = applyPiProjectionEvent(createPiProjectionState('session-1'), runtimeEvent(1))
    state = applyPiProjectionEvent(state, hostQueuedEvent(2, mutationId, 1))
    state = applyPiProjectionEvent(state, cancelledEvent(3, mutationId, 2))

    const turns = buildPiTurns(Object.values(state.entitiesById))
    expect(queuedIds(turns)).toEqual([])
    // Cancelled user turns are omitted from the transcript entirely
    expect(turns.filter(turn => turn.type === 'user')).toEqual([])
  })
})
