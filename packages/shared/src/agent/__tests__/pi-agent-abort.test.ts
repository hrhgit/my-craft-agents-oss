import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import { AbortReason } from '../core/session-lifecycle.ts'
import type { BackendConfig } from '../backend/types.ts'

function createAgent(): PiAgent {
  return new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/craft-agent-test' } as any,
    session: { id: 'session-test', craftId: 'session-test', workspaceRootPath: '/tmp/craft-agent-test', createdAt: 0, lastUsedAt: 0 } as any,
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
})
