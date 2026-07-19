import { describe, expect, it, mock } from 'bun:test'
import type { PiProjectionSnapshotV1 } from '@mortise/shared/protocol'
import {
  SessionManager,
  createManagedSession,
  getPiProjectionRecoveryMessages,
} from './SessionManager.ts'

const workspace = {
  id: 'ws_test',
  name: 'Test Workspace',
  rootPath: '/tmp/pi-native-transcript-test',
  createdAt: 1,
}

const artifact = {
  schemaVersion: 1 as const,
  kind: 'plan' as const,
  artifactId: 'plan-1',
  revision: 1,
  state: 'ready' as const,
  review: { status: 'passed' as const, verdict: 'pass' as const, body: 'Ready.' },
  checklist: [{ id: 'step-1', title: 'Implement', status: 'pending' as const }],
  models: { planner: 'planner', reviewer: 'reviewer' },
  createdAt: 1,
  finalizedAt: 2,
}

describe('Pi projection transcript boundary', () => {
  it('does not append a plan Message for managed sessions', async () => {
    const manager = new SessionManager()
    ;(manager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(manager as unknown as { sendEvent: () => void }).sendEvent = () => {}
    const processEvent = (managed: unknown) => (
      manager as unknown as { processEvent: (session: unknown, event: unknown) => Promise<void> }
    ).processEvent(managed, {
      type: 'custom_message',
      id: 'custom-plan',
      customType: 'mortise-plan-artifact',
      content: '# Plan',
      details: { schemaVersion: 1, artifact },
      timestamp: 3,
    })

    const managed = createManagedSession(
      { mortiseId: 'plan' },
      workspace as never,
      { messagesLoaded: true },
    )

    await processEvent(managed)

    expect(managed.messages).toEqual([])
  })

  it('suppresses legacy transcript persistence and events for Pi-native agent slices', async () => {
    const manager = new SessionManager()
    const emitted: Array<{ type: string }> = []
    ;(manager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(manager as unknown as { sendEvent: (event: { type: string }) => void }).sendEvent = event => emitted.push(event)
    const processEvent = (managed: unknown, event: unknown) => (
      manager as unknown as { processEvent: (session: unknown, value: unknown) => Promise<void> }
    ).processEvent(managed, event)
    const native = createManagedSession(
      { mortiseId: 'native-slices' },
      workspace as never,
      { messagesLoaded: true, isProcessing: true },
    )

    await processEvent(native, { type: 'text_delta', text: 'hel', turnId: 'turn-1' })
    await processEvent(native, { type: 'text_complete', text: 'hello', turnId: 'turn-1' })
    await processEvent(native, { type: 'tool_start', toolName: 'Read', toolUseId: 'tool-1', input: {} })
    await processEvent(native, { type: 'tool_result', toolName: 'Read', toolUseId: 'tool-1', result: 'done' })
    await processEvent(native, { type: 'info', message: 'Compacted 12 messages' })
    await processEvent(native, { type: 'error', message: 'runtime failed' })
    await processEvent(native, { type: 'typed_error', error: { code: 'unknown', title: 'Failed', message: 'again' } })

    expect(native.messages).toEqual([])
    expect(emitted.map(event => event.type)).toEqual([])
  })

  it('queues and replays input without requiring a stored user Message', async () => {
    const manager = new SessionManager()
    const emitted: Array<{ type: string }> = []
    ;(manager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(manager as unknown as { flushSession: () => Promise<void> }).flushSession = async () => {}
    ;(manager as unknown as { sendEvent: (event: { type: string }) => void }).sendEvent = event => emitted.push(event)
    const native = createManagedSession(
      { mortiseId: 'queue', name: 'Queue' },
      workspace as never,
      { messagesLoaded: true, isProcessing: true },
    )
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(native.id, native)

    let ackId = ''
    await manager.sendMessage(native.id, 'queued', undefined, undefined, undefined, undefined, undefined, id => { ackId = id })
    expect(native.messages).toEqual([])
    expect(native.messageQueue).toHaveLength(1)
    expect(ackId).toBe(native.messageQueue[0]!.messageId!)
    expect(emitted).toEqual([])

    ;(manager as unknown as { getOrCreateAgent: () => Promise<never> }).getOrCreateAgent = mock(async () => {
      throw new Error('expected runtime stop')
    })
    await expect(manager.sendMessage(
      native.id, 'queued', undefined, undefined, undefined, ackId, undefined, undefined, undefined, true,
    )).resolves.toBeUndefined()
    expect(native.messages).toEqual([])
  })

  it('derives recovery context from ordered Pi projection entities', () => {
    const snapshot: PiProjectionSnapshotV1 = {
      schemaVersion: 1,
      sessionId: 'native-recovery',
      runtimeId: 'runtime-1',
      lastSeq: 5,
      entities: [
        { entityId: 'a', entityType: 'content_block', entityVersion: 1, createdSeq: 2, kind: 'assistant_text', payload: { text: 'answer' }, lastEventId: 'e2', lastSeq: 2 },
        { entityId: 'tool', entityType: 'tool_run', entityVersion: 1, createdSeq: 3, kind: 'tool_result', payload: { result: 'ignored' }, lastEventId: 'e3', lastSeq: 3 },
        { entityId: 'u', entityType: 'content_block', entityVersion: 1, createdSeq: 1, kind: 'user_text', payload: { text: 'question' }, lastEventId: 'e1', lastSeq: 1 },
        { entityId: 'delta', entityType: 'content_block', entityVersion: 1, createdSeq: 4, kind: 'assistant_text_delta', payload: { text: 'ignored partial' }, lastEventId: 'e4', lastSeq: 4 },
        { entityId: 'intermediate', entityType: 'content_block', entityVersion: 1, createdSeq: 5, kind: 'assistant_text', payload: { text: 'ignored tool preamble', isIntermediate: true }, lastEventId: 'e5', lastSeq: 5 },
      ],
    }

    expect(getPiProjectionRecoveryMessages(snapshot)).toEqual([
      { type: 'user', content: 'question' },
      { type: 'assistant', content: 'answer' },
    ])
  })
})
