import { describe, expect, it, mock } from 'bun:test'
import type { PiProjectionSnapshotV1 } from '@craft-agent/shared/protocol'
import type { Message } from '@craft-agent/core/types'
import {
  SessionManager,
  appendLegacyAuthRequestMessage,
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

describe('Pi-native auth and plan transcript boundary', () => {
  it('does not construct or append an auth Message for Pi-native sessions', () => {
    const managed = createManagedSession(
      { craftId: 'native-auth', conversationFormat: 'pi-projection-v1' },
      workspace as never,
    )
    let constructions = 0

    const result = appendLegacyAuthRequestMessage(managed, () => {
      constructions += 1
      return { id: 'auth-1', role: 'auth-request', content: 'Authenticate', timestamp: 1 }
    })

    expect(result).toBeUndefined()
    expect(constructions).toBe(0)
    expect(managed.messages).toEqual([])
  })

  it('continues appending auth Messages for unmarked legacy sessions', () => {
    const managed = createManagedSession({ craftId: 'legacy-auth' }, workspace as never)
    const message: Message = { id: 'auth-1', role: 'auth-request', content: 'Authenticate', timestamp: 1 }

    expect(appendLegacyAuthRequestMessage(managed, () => message)).toBe(message)
    expect(managed.messages).toEqual([message])
  })

  it('does not append a plan Message for Pi-native sessions while legacy sessions still do', async () => {
    const manager = new SessionManager()
    ;(manager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(manager as unknown as { sendEvent: () => void }).sendEvent = () => {}
    const processEvent = (managed: unknown) => (
      manager as unknown as { processEvent: (session: unknown, event: unknown) => Promise<void> }
    ).processEvent(managed, {
      type: 'custom_message',
      id: 'custom-plan',
      customType: 'craft-plan-artifact',
      content: '# Plan',
      details: { schemaVersion: 1, artifact },
      timestamp: 3,
    })

    const native = createManagedSession(
      { craftId: 'native-plan', conversationFormat: 'pi-projection-v1' },
      workspace as never,
      { messagesLoaded: true },
    )
    const legacy = createManagedSession(
      { craftId: 'legacy-plan' },
      workspace as never,
      { messagesLoaded: true },
    )

    await processEvent(native)
    await processEvent(legacy)

    expect(native.messages).toEqual([])
    expect(legacy.messages).toHaveLength(1)
    expect(legacy.messages[0]).toMatchObject({
      role: 'assistant',
      content: '# Plan',
      artifact: { artifactId: 'plan-1' },
    })
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
      { craftId: 'native-slices', conversationFormat: 'pi-projection-v1' },
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

  it('retains legacy transcript persistence and events for unmarked sessions', async () => {
    const manager = new SessionManager()
    const emitted: Array<{ type: string }> = []
    ;(manager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(manager as unknown as { sendEvent: (event: { type: string }) => void }).sendEvent = event => emitted.push(event)
    const processEvent = (managed: unknown, event: unknown) => (
      manager as unknown as { processEvent: (session: unknown, value: unknown) => Promise<void> }
    ).processEvent(managed, event)
    const legacy = createManagedSession(
      { craftId: 'legacy-slices' },
      workspace as never,
      { messagesLoaded: true, isProcessing: true },
    )

    await processEvent(legacy, { type: 'text_delta', text: 'hel', turnId: 'turn-1' })
    await processEvent(legacy, { type: 'text_complete', text: 'hello', turnId: 'turn-1' })
    await processEvent(legacy, { type: 'tool_start', toolName: 'Read', toolUseId: 'tool-1', input: {} })
    await processEvent(legacy, { type: 'tool_result', toolName: 'Read', toolUseId: 'tool-1', result: 'done' })
    await processEvent(legacy, { type: 'info', message: 'Compacted 12 messages' })
    await processEvent(legacy, { type: 'error', message: 'runtime failed' })

    expect(legacy.messages.map(message => message.role)).toEqual(['assistant', 'tool', 'info', 'error'])
    expect(emitted.map(event => event.type)).toEqual([
      'text_delta', 'text_complete', 'tool_start', 'tool_result', 'info', 'error',
    ])
  })

  it('queues and replays Pi-native input without requiring a stored user Message', async () => {
    const manager = new SessionManager()
    const emitted: Array<{ type: string }> = []
    ;(manager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(manager as unknown as { flushSession: () => Promise<void> }).flushSession = async () => {}
    ;(manager as unknown as { sendEvent: (event: { type: string }) => void }).sendEvent = event => emitted.push(event)
    const native = createManagedSession(
      { craftId: 'native-queue', conversationFormat: 'pi-projection-v1', name: 'Native' },
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
      lastSeq: 4,
      entities: [
        { entityId: 'a', entityType: 'content_block', entityVersion: 1, createdSeq: 2, kind: 'assistant_text', payload: { text: 'answer' }, lastEventId: 'e2', lastSeq: 2 },
        { entityId: 'tool', entityType: 'tool_run', entityVersion: 1, createdSeq: 3, kind: 'tool_result', payload: { result: 'ignored' }, lastEventId: 'e3', lastSeq: 3 },
        { entityId: 'u', entityType: 'content_block', entityVersion: 1, createdSeq: 1, kind: 'user_text', payload: { text: 'question' }, lastEventId: 'e1', lastSeq: 1 },
        { entityId: 'delta', entityType: 'content_block', entityVersion: 1, createdSeq: 4, kind: 'assistant_text_delta', payload: { text: 'ignored partial' }, lastEventId: 'e4', lastSeq: 4 },
      ],
    }

    expect(getPiProjectionRecoveryMessages(snapshot)).toEqual([
      { type: 'user', content: 'question' },
      { type: 'assistant', content: 'answer' },
    ])
  })
})
