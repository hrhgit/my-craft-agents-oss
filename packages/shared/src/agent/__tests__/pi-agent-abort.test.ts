import { describe, expect, it, jest } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import { EventQueue } from '../backend/event-queue.ts'
import { AbortReason } from '../core/session-lifecycle.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { PiProjectionEventV1, PiProjectionSnapshotV1 } from '../../protocol/pi-projection.ts'

const testWorkspace = {
  schemaVersion: 2,
  id: 'ws-test',
  revision: 0,
  primaryLocationId: 'primary',
  locations: [{
    id: 'primary',
    name: 'Primary',
    rootName: 'mortise-test',
    endpoint: { kind: 'local', rootPath: '/tmp/mortise-test' },
  }],
  name: 'Test Workspace',
  nameSource: 'custom',
  slug: 'test-workspace',
  createdAt: 0,
} as BackendConfig['workspace']

function createAgent(): PiAgent {
  return new PiAgent({
    provider: 'pi',
    workspace: testWorkspace,
    session: { id: 'session-test', mortiseId: 'session-test', workspaceRootPath: '/tmp/mortise-test', createdAt: 0, lastUsedAt: 0 } as any,
    isHeadless: true,
    onPiProjectionEvent: () => {},
  } satisfies BackendConfig)
}

describe('PiAgent abort', () => {
  it('keeps the Mortise event stream open across retry attempts until agent_settled', async () => {
    const emitted: PiProjectionEventV1[] = []
    const agent = new PiAgent({
      provider: 'pi',
      workspace: testWorkspace,
      session: { id: 'session-test', mortiseId: 'session-test', workspaceRootPath: '/tmp/mortise-test', createdAt: 0, lastUsedAt: 0 } as any,
      isHeadless: true,
      onPiProjectionEvent: event => emitted.push(event),
    } satisfies BackendConfig)
    ;(agent as any).rpcClient = { runtimeId: 'runtime-test' }
    const eventQueue = new EventQueue()
    ;(agent as any).activeAttemptId = 'execution-test'
    ;(agent as any).activeEventStream = { attemptId: 'execution-test', queue: eventQueue }

    ;(agent as any).handlePiEvent({ type: 'agent_start', attemptId: 'execution-test' })
    ;(agent as any).handlePiEvent({
      type: 'agent_end', attemptId: 'execution-test', willRetry: true,
      messages: [{ role: 'assistant', stopReason: 'error' }],
    })
    expect(eventQueue.isComplete).toBe(false)
    expect(emitted.at(-1)).toMatchObject({
      kind: 'agent_end', payload: { status: 'failed', willRetry: true, settlementPending: true },
    })

    ;(agent as any).handlePiEvent({ type: 'auto_retry_start', attemptId: 'execution-test', attempt: 1, maxAttempts: 3 })
    ;(agent as any).handlePiEvent({ type: 'agent_end', attemptId: 'execution-test', willRetry: false, messages: [] })
    expect(eventQueue.isComplete).toBe(false)

    ;(agent as any).handlePiEvent({ type: 'agent_settled', attemptId: 'execution-test' })
    expect(eventQueue.isComplete).toBe(true)
    expect(emitted.filter(event => event.kind === 'agent_settled')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ status: 'completed' }) }),
    ])
    const drained = []
    for await (const event of eventQueue.drain()) drained.push(event)
    expect(drained.filter(event => event.type === 'complete')).toHaveLength(1)

    agent.destroy()
  })

  it('uses a fresh projection runtime identity for each host connection', () => {
    const first = createAgent()
    const second = createAgent()
    ;(first as any).rpcClient = { runtimeId: 'session-test' }
    ;(second as any).rpcClient = { runtimeId: 'session-test' }

    expect((first as any).getProjectionBuilder().runtimeId).not.toBe(
      (second as any).getProjectionBuilder().runtimeId,
    )
    first.destroy()
    second.destroy()
  })

  it('seeds a replacement runtime and routes Host projections through its builder', () => {
    const emitted: PiProjectionEventV1[] = []
    const seed: PiProjectionSnapshotV1 = {
      schemaVersion: 1,
      sessionId: 'session-test',
      runtimeId: 'old-runtime',
      lastSeq: 3,
      entities: [{
        entityId: 'turn:pi-turn-2', entityType: 'turn', entityVersion: 2,
        createdSeq: 1, turnId: 'pi-turn-2', kind: 'turn_end', payload: { status: 'completed' },
        lastEventId: 'old-runtime:3', lastSeq: 3,
      }],
    }
    const agent = new PiAgent({
      provider: 'pi',
      workspace: testWorkspace,
      session: { id: 'session-test', mortiseId: 'session-test', workspaceRootPath: '/tmp/mortise-test', createdAt: 0, lastUsedAt: 0 } as any,
      isHeadless: true,
      getPiProjectionSnapshot: () => seed,
      onPiProjectionEvent: event => emitted.push(event),
    } satisfies BackendConfig)
    ;(agent as any).rpcClient = { runtimeId: 'new-runtime' }

    agent.projectQueuedUser({ message: 'later', clientMutationId: 'mutation-1' })
    agent.projectRuntimeError({ phase: 'queue', message: 'queue failed', retryable: true })

    expect(emitted[0]).toMatchObject({
      seq: 4, runtimeId: expect.stringContaining('new-runtime'),
      entityId: 'content:user:mutation-1', payload: { queueStatus: 'queued' },
    })
    expect(emitted[1]).toMatchObject({
      seq: 5, runtimeId: emitted[0]!.runtimeId, kind: 'runtime_error',
      payload: { source: 'host', phase: 'queue', message: 'queue failed' },
    })
    expect((agent as any).getProjectionBuilder().acceptRuntimeEvent({ type: 'turn_start' })[0])
      .toMatchObject({ seq: 6, entityId: 'turn:pi-turn-3' })

    agent.destroy()
  })

  it('waits for Pi to acknowledge the abort and suppresses late turn content', async () => {
    const agent = createAgent()
    let releaseAbort!: () => void
    const abortAcknowledged = new Promise<void>(resolve => { releaseAbort = resolve })
    ;(agent as any)._isProcessing = true
    ;(agent as any).activeAttemptId = 'execution-abort'
    ;(agent as any).activeEventStream = { attemptId: 'execution-abort', queue: new EventQueue() }
    ;(agent as any).rpcClient = { abort: async () => { await abortAcknowledged; return { status: 'accepted', attemptId: 'execution-abort' } } }

    let settled = false
    const aborting = agent.abort(AbortReason.UserStop).then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(agent.isProcessing()).toBe(false)
    expect((agent as any).suppressAbortedTurnEvents).toBe(true)

    let adaptedEvents = 0
    ;(agent as any).adapter = { adaptEvent: () => { adaptedEvents++; return [] } }
    ;(agent as any).handlePiEvent({ type: 'message_update', attemptId: 'execution-abort' })
    expect(adaptedEvents).toBe(0)
    ;(agent as any).handlePiEvent({ type: 'turn_end', attemptId: 'execution-abort' })
    expect(adaptedEvents).toBe(1)

    releaseAbort()
    ;(agent as any).handlePiEvent({ type: 'agent_settled', attemptId: 'execution-abort' })
    await aborting
    expect(settled).toBe(true)

    agent.destroy()
  })

  it('releases the runtime when the cooperative abort command fails', async () => {
    const agent = createAgent()
    let released = false
    ;(agent as any)._isProcessing = true
    ;(agent as any).activeAttemptId = 'execution-failed-abort'
    ;(agent as any).activeEventStream = { attemptId: 'execution-failed-abort', queue: new EventQueue() }
    ;(agent as any).rpcClient = {
      runtimeId: 'runtime-test',
      abort: async () => { throw new Error('transport closed') },
    }
    ;(agent as any).rpcHostLease = { release: async () => { released = true } }

    await agent.abort(AbortReason.UserStop)

    expect(released).toBe(true)
    expect((agent as any).rpcClient).toBeNull()
    agent.destroy()
  })

  it('releases the runtime before a stalled abort can exhaust the renderer request timeout', async () => {
    jest.useFakeTimers()
    const agent = createAgent()
    let released = false
    ;(agent as any)._isProcessing = true
    ;(agent as any).activeAttemptId = 'execution-stalled-abort'
    ;(agent as any).activeEventStream = { attemptId: 'execution-stalled-abort', queue: new EventQueue() }
    ;(agent as any).rpcClient = {
      runtimeId: 'runtime-test',
      abort: () => new Promise(() => {}),
    }
    ;(agent as any).rpcHostLease = { release: async () => { released = true } }

    try {
      const aborting = agent.abort(AbortReason.UserStop)
      await Promise.resolve()
      expect(released).toBe(false)

      jest.advanceTimersByTime(5_000)
      await aborting

      expect(released).toBe(true)
      expect((agent as any).rpcClient).toBeNull()
    } finally {
      jest.useRealTimers()
      agent.destroy()
    }
  })

  it('settles a suspended turn only after restart disposal releases its runtime', async () => {
    const agent = createAgent()
    let releaseRuntime!: () => void
    const runtimeReleased = new Promise<void>(resolve => { releaseRuntime = resolve })
    let waiterSettled = false
    const eventQueue = new EventQueue()
    ;(agent as any).activeAttemptId = 'execution-replaced'
    ;(agent as any).activeEventStream = { attemptId: 'execution-replaced', queue: eventQueue }
    ;(agent as any).rpcClient = { runtimeId: 'runtime-replaced' }
    ;(agent as any).rpcHostLease = { release: () => runtimeReleased }
    void (agent as any).waitForAgentSettled('execution-replaced').then(() => { waiterSettled = true })

    const disposing = agent.disposeForRestart()
    await Promise.resolve()

    expect((agent as any).rpcClient).toBeNull()
    expect(eventQueue.isComplete).toBe(false)
    expect(waiterSettled).toBe(false)

    releaseRuntime()
    await disposing

    expect(eventQueue.isComplete).toBe(true)
    expect(waiterSettled).toBe(true)
  })

  it('contains synchronous teardown callback failures and still releases the runtime', async () => {
    const agent = createAgent()
    let released = false
    const logged: Array<{ event: string; meta?: Record<string, unknown> }> = []
    ;(agent as any).coordinationBridge = {
      releasePending: () => { throw new Error('coordination cleanup failed') },
      completeTurn: () => {},
    }
    ;(agent as any).rpcClient = { runtimeId: 'runtime-cleanup' }
    ;(agent as any).rpcHostLease = { release: async () => { released = true } }
    ;(agent as any).unsubscribePiEvent = () => { throw new Error('agent unsubscribe failed') }
    ;(agent as any).unsubscribePiClientEvent = () => { throw new Error('client unsubscribe failed') }
    ;(agent as any).writePiRuntimeLog = (_level: string, event: string, meta?: Record<string, unknown>) => {
      logged.push({ event, meta })
    }

    await agent.reconnect()

    expect(released).toBe(true)
    expect((agent as any).rpcClient).toBeNull()
    expect(logged.map(entry => entry.event)).toEqual([
      'host.coordination_release_failed',
      'host.event_unsubscribe_failed',
      'host.event_unsubscribe_failed',
    ])
  })

  it('observes rejected detached cleanup from synchronous replacement APIs', async () => {
    const agent = createAgent()
    const logged: Array<{ event: string; reason?: unknown }> = []
    ;(agent as any).stopRpcClient = async () => { throw new Error('cleanup rejected') }
    ;(agent as any).writePiRuntimeLog = (_level: string, event: string, meta?: Record<string, unknown>) => {
      logged.push({ event, reason: meta?.reason })
    }

    agent.clearHistory()
    await Promise.resolve()
    await Promise.resolve()

    expect(logged).toEqual([
      { event: 'host.runtime_detached_cleanup_failed', reason: 'history-cleared' },
    ])
  })

  it('retires the runtime before a force-abort timeout completes the event stream', async () => {
    jest.useFakeTimers()
    const agent = createAgent()
    let released = false
    ;(agent as any)._isProcessing = true
    const eventQueue = new EventQueue()
    ;(agent as any).activeAttemptId = 'execution-force-abort'
    ;(agent as any).activeEventStream = { attemptId: 'execution-force-abort', queue: eventQueue }
    ;(agent as any).rpcClient = {
      runtimeId: 'runtime-force-abort',
      abort: () => new Promise(() => {}),
    }
    ;(agent as any).rpcHostLease = {
      release: async () => { released = true },
    }

    try {
      agent.forceAbort(AbortReason.Redirect)
      jest.advanceTimersByTime(5_000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(released).toBe(true)
      expect((agent as any).rpcClient).toBeNull()
      expect(eventQueue.isComplete).toBe(true)
    } finally {
      jest.useRealTimers()
      agent.destroy()
    }
  })

})
