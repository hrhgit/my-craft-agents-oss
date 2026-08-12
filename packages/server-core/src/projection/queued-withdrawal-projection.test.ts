import { describe, expect, it } from 'bun:test'
import { PiProjectionBuilder } from '@mortise/shared/agent/backend'
import type { PiProjectionEventV1 } from '@mortise/shared/protocol'
import { ConversationProjector } from '../projection/conversation-projector'

/**
 * Regression: host queued-message withdrawal must be projected through the
 * sequence-owning builder. A hand-built cancel event at projector.lastSeq + 1
 * (without advancing the builder) collides with the next runtime event's seq,
 * which the projector then drops as stale — losing live stream content
 * (e.g. the assistant's final message_end, freezing the streaming turn).
 */
describe('queued-message withdrawal projection sequencing', () => {
  it('cancels through the builder so the next runtime event is not dropped', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const projector = new ConversationProjector('session-1', 'runtime-1')

    const broadcast: PiProjectionEventV1[] = []
    const push = (event: PiProjectionEventV1) => {
      const result = projector.apply(event)
      expect(result.status).toBe('applied')
      broadcast.push(event)
    }

    // Runtime streams turn_start, then Host queues a follow-up (as the real flow does)
    for (const event of builder.acceptRuntimeEvent({ type: 'turn_start' })) push(event)
    for (const event of builder.acceptHostQueuedUser({
      message: 'later', clientMutationId: 'mutation-1', messageId: 'mutation-1',
    })) push(event)

    // Host withdraws: cancellation routed through the builder (the fix)
    const cancelled = builder.acceptHostQueueCancellation({ clientMutationId: 'mutation-1', messageId: 'mutation-1' })
    expect(cancelled.length).toBe(1)
    expect(cancelled[0]).toMatchObject({
      entityId: 'content:user:mutation-1',
      entityVersion: 2,
      payload: { queueStatus: 'cancelled', messageId: 'mutation-1' },
    })
    for (const event of cancelled) push(event)

    // Runtime keeps streaming: the next event must NOT collide with the cancel seq
    const nextEvents = builder.acceptRuntimeEvent({
      type: 'message_end',
      message: {
        role: 'assistant', id: 'assistant-1', timestamp: Date.now(),
        content: [{ type: 'text', text: 'final chunk' }],
        stopReason: 'end_turn',
      },
    })
    expect(nextEvents.length).toBeGreaterThan(0)
    expect(nextEvents[0]!.seq).toBeGreaterThan(cancelled[0]!.seq)
    for (const event of nextEvents) push(event)

    // Every event reached the projector (nothing dropped as stale)
    expect(broadcast.map(e => e.seq)).toEqual([1, 2, 3, 4])
    const entity = projector.getEntity('content:text:assistant-1:0')
    expect(entity?.payload).toMatchObject({ text: 'final chunk', streaming: false, isFinal: true })
  })

  it('emits no events when nothing was queued', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    expect(builder.acceptHostQueueCancellation({ clientMutationId: 'unknown-mutation' })).toEqual([])
  })

  it('cancels the attachment entities of the queued message too', () => {
    const builder = new PiProjectionBuilder('session-1', 'runtime-1')
    const queued = builder.acceptHostQueuedUser({
      message: 'later', clientMutationId: 'mutation-1', messageId: 'message-1',
      attachments: [{ id: 'att-1', name: 'note.txt', mediaType: 'text/plain', size: 5 }],
    })
    expect(queued.length).toBe(2)

    const cancelled = builder.acceptHostQueueCancellation({ clientMutationId: 'mutation-1', messageId: 'message-1' })
    expect(cancelled.map(e => e.entityId).sort()).toEqual([
      'artifact:attachment:mutation-1:att-1',
      'content:user:mutation-1',
    ])
    expect(cancelled.every(e => (e.payload as { queueStatus?: string } | undefined)?.queueStatus === 'cancelled')).toBe(true)
    expect(cancelled.every(e => e.entityVersion === 2)).toBe(true)
  })
})
