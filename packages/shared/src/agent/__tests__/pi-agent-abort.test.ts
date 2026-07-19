import { describe, expect, it, jest } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import { AbortReason } from '../core/session-lifecycle.ts'
import type { BackendConfig } from '../backend/types.ts'
import type { PiProjectionEventV1, PiProjectionSnapshotV1 } from '../../protocol/pi-projection.ts'

function createAgent(): PiAgent {
  return new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/mortise-test' } as any,
    session: { id: 'session-test', mortiseId: 'session-test', workspaceRootPath: '/tmp/mortise-test', createdAt: 0, lastUsedAt: 0 } as any,
    isHeadless: true,
    onPiProjectionEvent: () => {},
  } satisfies BackendConfig)
}

describe('PiAgent abort', () => {
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
      workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/mortise-test' } as any,
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
    ;(agent as any).rpcClient = { abort: () => abortAcknowledged }

    let settled = false
    const aborting = agent.abort(AbortReason.UserStop).then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(agent.isProcessing()).toBe(false)
    expect((agent as any).suppressAbortedTurnEvents).toBe(true)

    let adaptedEvents = 0
    ;(agent as any).adapter = { adaptEvent: () => { adaptedEvents++; return [] } }
    ;(agent as any).handlePiEvent({ type: 'message_update' })
    expect(adaptedEvents).toBe(0)
    ;(agent as any).handlePiEvent({ type: 'turn_end' })
    expect(adaptedEvents).toBe(1)

    releaseAbort()
    await aborting
    expect(settled).toBe(true)

    agent.destroy()
  })

  it('releases the runtime when the cooperative abort command fails', async () => {
    const agent = createAgent()
    let stopped = false
    ;(agent as any)._isProcessing = true
    ;(agent as any).rpcClient = {
      abort: async () => { throw new Error('transport closed') },
      stop: async () => { stopped = true },
    }

    await agent.abort(AbortReason.UserStop)

    expect(stopped).toBe(true)
    expect((agent as any).rpcClient).toBeNull()
    agent.destroy()
  })

  it('releases the runtime before a stalled abort can exhaust the renderer request timeout', async () => {
    jest.useFakeTimers()
    const agent = createAgent()
    let stopped = false
    ;(agent as any)._isProcessing = true
    ;(agent as any).rpcClient = {
      abort: () => new Promise<void>(() => {}),
      stop: async () => { stopped = true },
    }

    try {
      const aborting = agent.abort(AbortReason.UserStop)
      await Promise.resolve()
      expect(stopped).toBe(false)

      jest.advanceTimersByTime(5_000)
      await aborting

      expect(stopped).toBe(true)
      expect((agent as any).rpcClient).toBeNull()
    } finally {
      jest.useRealTimers()
      agent.destroy()
    }
  })

  it('does not start a runtime solely to reload extensions', async () => {
    const agent = createAgent()
    let startupAttempts = 0
    ;(agent as any).ensureRpcClient = async () => {
      startupAttempts++
      throw new Error('should not start')
    }

    await expect(agent.reloadExtensions()).resolves.toEqual({ reloaded: false, deferred: false })
    expect(startupAttempts).toBe(0)
    agent.destroy()
  })
})
