import { describe, expect, it } from 'bun:test'
import { subscribeToConversationStream, type ConversationStreamEvent } from './conversation-stream.ts'

class EventClient {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(callback)
    this.listeners.set(channel, listeners)
    return () => listeners.delete(callback)
  }

  emit(channel: string, value: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(value)
  }
}

function projection(kind: string, payload: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, eventId: `runtime:${kind}`, seq: 1,
    sessionId: 'session-1', runtimeId: 'runtime-1',
    entityId: 'conversation:session-1', entityType: 'conversation',
    entityVersion: 1, kind, payload,
  }
}

describe('CLI conversation stream', () => {
  it('consumes Pi projection and ignores the legacy dual-write', async () => {
    const client = new EventClient()
    const received: ConversationStreamEvent[] = []
    const unsubscribe = subscribeToConversationStream(client, 'session-1', event => received.push(event))

    client.emit('session:piProjectionEvent', projection('assistant_text_delta', { delta: 'hello' }))
    client.emit('session:event', { type: 'text_delta', sessionId: 'session-1', delta: 'hello' })
    await Bun.sleep(10)

    expect(received.map(event => [event.source, event.kind, event.payload.delta])).toEqual([
      ['pi-projection', 'assistant_text_delta', 'hello'],
    ])
    unsubscribe()
  })

  it('ignores legacy transcript events before projection arrives', async () => {
    const client = new EventClient()
    const received: ConversationStreamEvent[] = []
    const unsubscribe = subscribeToConversationStream(client, 'session-1', event => received.push(event))

    client.emit('session:event', { type: 'text_delta', sessionId: 'session-1', delta: 'duplicate' })
    client.emit('session:piProjectionEvent', projection('assistant_text_delta', { delta: 'canonical' }))
    await Bun.sleep(25)

    expect(received.map(event => event.payload.delta)).toEqual(['canonical'])
    unsubscribe()
  })

  it('does not fall back when projection is unavailable', async () => {
    const client = new EventClient()
    const received: ConversationStreamEvent[] = []
    const unsubscribe = subscribeToConversationStream(client, 'session-1', event => received.push(event))

    client.emit('session:event', { type: 'text_delta', sessionId: 'session-1', delta: 'old host' })
    await Bun.sleep(5)
    client.emit('session:event', { type: 'complete', sessionId: 'session-1' })

    expect(received).toEqual([])
    unsubscribe()
  })

  it('isolates events from other sessions', async () => {
    const client = new EventClient()
    const received: ConversationStreamEvent[] = []
    const unsubscribe = subscribeToConversationStream(client, 'session-1', event => received.push(event))

    client.emit('session:piProjectionEvent', { ...projection('agent_end'), sessionId: 'session-2' })
    client.emit('session:event', { type: 'complete', sessionId: 'session-2' })
    await Bun.sleep(5)

    expect(received).toEqual([])
    unsubscribe()
  })
})
