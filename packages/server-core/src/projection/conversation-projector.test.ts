import { describe, expect, it } from 'bun:test'
import type { PiProjectionEventV1 } from '@craft-agent/shared/protocol'
import { ConversationProjector, ProjectionIdentityError } from './conversation-projector'

function event(
  seq: number,
  overrides: Partial<PiProjectionEventV1> = {},
): PiProjectionEventV1 {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    seq,
    sessionId: 'session-1',
    runtimeId: 'runtime-1',
    turnId: 'turn-1',
    entityId: `block-${seq}`,
    entityType: 'content_block',
    entityVersion: 1,
    kind: 'assistant_text',
    payload: { text: `text-${seq}` },
    ...overrides,
  }
}

describe('ConversationProjector', () => {
  it('applies ordered events and creates a normalized snapshot', () => {
    const projector = new ConversationProjector('session-1', 'runtime-1')

    expect(projector.apply(event(1)).status).toBe('applied')
    expect(projector.apply(event(2)).status).toBe('applied')

    const snapshot = projector.createSnapshot()
    expect(snapshot.lastSeq).toBe(2)
    expect(snapshot.entities.map(entity => entity.entityId)).toEqual(['block-1', 'block-2'])
    expect(projector.getExpectedSeq()).toBe(3)
    expect(projector.hasGap()).toBe(false)
  })

  it('preserves first-seen entity order when streaming updates arrive after later entities', () => {
    const projector = new ConversationProjector('session-1', 'runtime-1')
    projector.apply(event(1, { entityId: 'text', entityVersion: 1 }))
    projector.apply(event(2, { entityId: 'tool', entityType: 'tool_run', kind: 'tool_execution_start' }))
    projector.apply(event(3, { entityId: 'text', entityVersion: 2, payload: { text: 'updated' } }))

    const snapshot = projector.createSnapshot()
    expect(snapshot.entities.map(entity => entity.entityId)).toEqual(['text', 'tool'])
    expect(snapshot.entities.map(entity => entity.createdSeq)).toEqual([1, 2])
    expect(new ConversationProjector('session-1', 'runtime-1', snapshot).createSnapshot()).toEqual(snapshot)
  })

  it('buffers a gap without exposing the later entity and drains when filled', () => {
    const projector = new ConversationProjector('session-1', 'runtime-1')
    projector.apply(event(1))

    expect(projector.apply(event(3))).toEqual({
      status: 'buffered',
      expectedSeq: 2,
      receivedSeq: 3,
    })
    expect(projector.hasGap()).toBe(true)
    expect(projector.getEntity('block-3')).toBeUndefined()
    expect(projector.createSnapshot().lastSeq).toBe(1)

    const result = projector.apply(event(2))
    expect(result.status).toBe('applied')
    if (result.status === 'applied') {
      expect(result.events.map(item => item.seq)).toEqual([2, 3])
    }
    expect(projector.getEntity('block-3')?.lastSeq).toBe(3)
    expect(projector.hasGap()).toBe(false)
  })

  it('treats repeated event ids and sequences idempotently', () => {
    const projector = new ConversationProjector('session-1', 'runtime-1')
    projector.apply(event(1))

    expect(projector.apply(event(1))).toEqual({ status: 'duplicate', lastSeq: 1 })
    expect(projector.apply(event(1, { eventId: 'conflict' }))).toEqual({
      status: 'stale',
      reason: 'sequence',
      lastSeq: 1,
    })

    projector.apply(event(3))
    expect(projector.apply(event(4, { eventId: 'event-3' }))).toEqual({
      status: 'duplicate',
      lastSeq: 1,
    })
  })

  it('consumes entity version regression without mutating the entity or blocking later events', () => {
    const projector = new ConversationProjector('session-1', 'runtime-1')
    projector.apply(event(1, { entityId: 'block', entityVersion: 2 }))

    expect(projector.apply(event(2, { entityId: 'block', entityVersion: 1 }))).toEqual({
      status: 'stale',
      reason: 'entity_version',
      lastSeq: 2,
    })
    expect(projector.getEntity('block')?.entityVersion).toBe(2)
    expect(projector.apply(event(3)).status).toBe('applied')
    expect(projector.createSnapshot().lastSeq).toBe(3)
  })

  it('classifies pre-snapshot replay by sequence even when the event is not an entity head', () => {
    const source = new ConversationProjector('session-1', 'runtime-1')
    source.apply(event(1, { entityId: 'block' }))
    source.apply(event(2, { entityId: 'block', entityVersion: 2 }))
    const restored = new ConversationProjector('session-1', 'runtime-1', source.createSnapshot())

    expect(restored.apply(event(1, { entityId: 'block' }))).toEqual({
      status: 'stale',
      reason: 'sequence',
      lastSeq: 2,
    })
  })

  it('installs a snapshot to recover from a gap and resumes at its sequence', () => {
    const projector = new ConversationProjector('session-1', 'runtime-1')
    projector.apply(event(2))
    expect(projector.hasGap()).toBe(true)

    projector.installSnapshot({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      lastSeq: 5,
      entities: [{
        entityId: 'turn-1',
        entityType: 'turn',
        entityVersion: 3,
        createdSeq: 5,
        kind: 'turn_completed',
        payload: { status: 'completed' },
        lastEventId: 'snapshot-event',
        lastSeq: 5,
      }],
    })

    expect(projector.hasGap()).toBe(false)
    expect(projector.getExpectedSeq()).toBe(6)
    expect(projector.apply(event(6)).status).toBe('applied')
  })

  it('returns defensive copies of payload data', () => {
    const projector = new ConversationProjector('session-1', 'runtime-1')
    projector.apply(event(1))
    const entity = projector.getEntity('block-1')!
    ;(entity.payload as { text: string }).text = 'changed'

    expect(projector.getEntity('block-1')?.payload).toEqual({ text: 'text-1' })
  })

  it('reduces auth request and resolution onto one prompt entity', () => {
    const projector = new ConversationProjector('session-1', 'runtime-1')
    const request = event(1, {
      entityId: 'prompt:auth-1', entityType: 'prompt_request', entityVersion: 1,
      kind: 'auth_request', payload: {
        requestId: 'auth-1', promptKind: 'credential', authType: 'credential',
        sourceSlug: 'github', sourceName: 'GitHub', status: 'pending',
      },
    })
    const resolution = event(2, {
      entityId: 'prompt:auth-1', entityType: 'prompt_request', entityVersion: 2,
      kind: 'prompt_resolved', payload: {
        requestId: 'auth-1', promptKind: 'credential', authType: 'credential',
        sourceSlug: 'github', sourceName: 'GitHub', status: 'resolved', resolution: 'completed',
      },
    })

    expect(projector.apply(request).status).toBe('applied')
    expect(projector.apply(resolution).status).toBe('applied')
    expect(projector.createSnapshot().entities).toContainEqual(expect.objectContaining({
      entityId: 'prompt:auth-1', entityType: 'prompt_request', entityVersion: 2,
      kind: 'prompt_resolved', payload: {
        requestId: 'auth-1', promptKind: 'credential', authType: 'credential',
        sourceSlug: 'github', sourceName: 'GitHub', status: 'resolved', resolution: 'completed',
      },
    }))
  })

  it('rejects events and snapshots for a different runtime identity', () => {
    const projector = new ConversationProjector('session-1', 'runtime-1')

    expect(() => projector.apply(event(1, { sessionId: 'session-2' }))).toThrow(ProjectionIdentityError)
    expect(() => projector.installSnapshot({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtimeId: 'runtime-2',
      lastSeq: 0,
      entities: [],
    })).toThrow(ProjectionIdentityError)
  })

  it('rejects malformed or conflicting snapshot entities', () => {
    const base = new ConversationProjector('session-1', 'runtime-1')
    base.apply(event(1))
    const snapshot = base.createSnapshot()
    expect(() => new ConversationProjector('session-1', 'runtime-1', {
      ...snapshot,
      entities: [{ ...snapshot.entities[0]!, entityVersion: 0 }],
    })).toThrow('Invalid Pi projection snapshot entity')
    expect(() => new ConversationProjector('session-1', 'runtime-1', {
      ...snapshot,
      entities: [snapshot.entities[0]!, { ...snapshot.entities[0]!, entityId: 'other' }],
    })).toThrow('Invalid Pi projection snapshot entity')
    expect(() => new ConversationProjector('session-1', 'runtime-1', {
      ...snapshot,
      entities: [{ ...snapshot.entities[0]!, lastSeq: snapshot.lastSeq + 1 }],
    })).toThrow('Invalid Pi projection snapshot entity')
    expect(() => new ConversationProjector('session-1', 'runtime-1', {
      ...snapshot,
      entities: [{ ...snapshot.entities[0]!, createdSeq: snapshot.entities[0]!.lastSeq + 1 }],
    })).toThrow('Invalid Pi projection snapshot entity')
  })
})
