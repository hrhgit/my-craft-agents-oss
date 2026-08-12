import { describe, expect, it, mock } from 'bun:test'
import type { AgentEvent } from '@mortise/core/types'
import { PiAgent } from '../pi-agent.ts'
import { EventQueue } from '../backend/event-queue.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    runtime: { piAuthProvider: 'anthropic' },
    workspace: {
      schemaVersion: 2, id: 'ws-control', revision: 0, primaryLocationId: 'primary',
      locations: [{ id: 'primary', name: 'Primary', rootName: 'control', endpoint: { kind: 'local', rootPath: '/tmp/control' } }],
      name: 'Control', nameSource: 'custom', slug: 'control', createdAt: Date.now(),
    } as BackendConfig['workspace'],
    session: {
      mortiseId: 'session-control', workspaceRootPath: '/tmp/control',
      createdAt: Date.now(), lastUsedAt: Date.now(),
    } as NonNullable<BackendConfig['session']>,
    isHeadless: true,
  }
}

async function collectEvents(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of generator) events.push(event)
  return events
}

async function nextMicrotask(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('PiAgent Attempt boundaries', () => {
  const dispose = (agent: PiAgent) => {
    const internals = agent as any
    internals.clearSettlementRetry?.()
    internals.activeEventStream?.queue.complete()
    internals.activeEventStream = undefined
    internals.activeAttemptId = undefined
    internals.rpcClient = null
    internals.rpcHostLease = null
    agent.destroy()
  }

  it('ends command observation after Pi persists the user message while the Attempt keeps running', async () => {
    const longLivedEvents: AgentEvent[] = []
    const agent = new PiAgent({ ...createConfig(), onAgentEvent: event => longLivedEvents.push(event) })
    const internals = agent as any
    const prompt = mock(async () => {
      setTimeout(() => internals.handlePiEvent({
        type: 'pi_user_message_persisted', attemptId: 'attempt-pi', clientMutationId: 'mutation-1',
      }), 0)
      return { status: 'started', attemptId: 'attempt-pi' } as const
    })
    internals.ensureRpcClient = async () => ({ prompt })

    const events = await collectEvents(internals.chatImpl('exact user text', undefined, { clientMutationId: 'mutation-1' }))

    expect(prompt).toHaveBeenCalledWith(
      'exact user text',
      undefined,
      expect.objectContaining({ appendSystemPrompt: '' }),
    )
    expect(events).toEqual([{ type: 'pi_user_message_persisted', clientMutationId: 'mutation-1' }])
    expect(longLivedEvents).toEqual(events)
    expect(internals.activeAttemptId).toBe('attempt-pi')
    internals.handlePiEvent({ type: 'agent_settled', attemptId: 'attempt-pi' })
    expect(internals.activeAttemptId).toBeUndefined()
    dispose(agent)
  })

  it('keeps a stale Attempt out of the current chat queue while still projecting it', async () => {
    const projections: unknown[] = []
    const agent = new PiAgent({ ...createConfig(), onPiProjectionEvent: event => projections.push(event) })
    const internals = agent as any
    internals.rpcClient = { runtimeId: 'runtime-main' }
    const queue = new EventQueue()
    internals.activeAttemptId = 'attempt-b'
    internals.activeEventStream = { attemptId: 'attempt-b', queue }

    internals.handlePiEvent({
      type: 'message_update', attemptId: 'attempt-a',
      message: { id: 'assistant-a', timestamp: 1 },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'stale but durable' },
    })
    await nextMicrotask()

    expect((queue as any).queue).toEqual([])
    expect(projections).toContainEqual(expect.objectContaining({
      attemptId: 'attempt-a', kind: 'assistant_text_delta',
    }))
    dispose(agent)
  })

  it('routes Attempt events through the long-lived Session callback', () => {
    const events: AgentEvent[] = []
    const agent = new PiAgent({ ...createConfig(), onAgentEvent: event => events.push(event) })
    const internals = agent as any
    const queue = new EventQueue()
    internals.activeAttemptId = 'attempt-b'
    internals.activeEventStream = { attemptId: 'attempt-b', queue }

    internals.handlePiEvent({
      type: 'message_update', attemptId: 'attempt-b',
      assistantMessageEvent: { type: 'text_delta', delta: 'current' },
    })

    expect((queue as any).queue).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', text: 'current' }))
    dispose(agent)
  })

  it('keeps settlement pending and retries Pi persistence for the exact Attempt', async () => {
    const longLivedEvents: AgentEvent[] = []
    const agent = new PiAgent({ ...createConfig(), onAgentEvent: event => longLivedEvents.push(event) })
    const internals = agent as any
    let retryCount = 0
    const retrySettlement = mock(async (attemptId: string) => {
      retryCount++
      if (retryCount === 1) {
        internals.handlePiEvent({ type: 'settlement_failed', attemptId, attempt: 2, error: 'still unavailable' })
        throw new Error('still unavailable')
      }
      internals.handlePiEvent({ type: 'agent_settled', attemptId })
    })
    const prompt = mock(async () => {
      setTimeout(() => internals.handlePiEvent({
        type: 'settlement_failed', attemptId: 'attempt-retry', attempt: 1, error: 'unavailable',
      }), 0)
      setTimeout(() => internals.handlePiEvent({
        type: 'pi_user_message_persisted', attemptId: 'attempt-retry', clientMutationId: 'mutation-retry',
      }), 1)
      return { status: 'started', attemptId: 'attempt-retry' } as const
    })
    const runtime = { prompt, retrySettlement }
    internals.rpcClient = runtime
    internals.ensureRpcClient = async () => runtime

    const events = await collectEvents(internals.chatImpl('persist me', undefined, { clientMutationId: 'mutation-retry' }))

    while (internals.activeAttemptId) await new Promise(resolve => setTimeout(resolve, 10))

    expect(retrySettlement).toHaveBeenCalledTimes(2)
    expect(retrySettlement).toHaveBeenCalledWith('attempt-retry')
    expect(events).toEqual([{ type: 'pi_user_message_persisted', clientMutationId: 'mutation-retry' }])
    expect(longLivedEvents).toContainEqual(expect.objectContaining({ type: 'status' }))
    expect(longLivedEvents.at(-1)).toEqual({ type: 'complete' })
    dispose(agent)
  })

  it('accepts steer only when Pi assigns it to the active Attempt', async () => {
    const agent = new PiAgent(createConfig())
    const internals = agent as any
    internals._isProcessing = true
    internals.activeAttemptId = 'attempt-steer'
    internals.activeEventStream = { attemptId: 'attempt-steer', queue: new EventQueue() }
    const steer = mock(async () => ({ status: 'accepted', attemptId: 'attempt-steer' } as const))
    internals.rpcClient = { steer }

    await expect(agent.redirect('new direction', 'mutation-1')).resolves.toBe(true)
    expect(steer).toHaveBeenCalledWith('new direction', undefined, { clientMutationId: 'mutation-1' })
    dispose(agent)
  })

  it('accepts follow-up only when Pi queues it on the active Attempt', async () => {
    const agent = new PiAgent(createConfig())
    const internals = agent as any
    internals._isProcessing = true
    internals.activeAttemptId = 'attempt-follow-up'
    internals.activeEventStream = { attemptId: 'attempt-follow-up', queue: new EventQueue() }
    const followUp = mock(async () => ({ status: 'queued', attemptId: 'attempt-follow-up' } as const))
    internals.rpcClient = { followUp }

    await expect(agent.followUp('next', undefined, { clientMutationId: 'mutation-2' })).resolves.toBe(true)
    expect(followUp).toHaveBeenCalledWith('next', undefined, {
      clientMutationId: 'mutation-2', attachments: undefined,
    })
    dispose(agent)
  })

  it('executes host tools without treating Attempt identity as permission', async () => {
    const agent = new PiAgent(createConfig())
    const internals = agent as any
    const routeToolCall = mock(async () => ({ content: 'executed', isError: false }))
    internals.routeToolCall = routeToolCall

    const result = await internals.executeHostTool({
      type: 'tool_execute_request', id: 'request', runtimeId: 'runtime-main',
      attemptId: 'attempt-pi', toolName: 'session_tool', toolCallId: 'tool', input: {},
    })

    expect(result).toEqual({ content: 'executed', isError: false })
    expect(routeToolCall).toHaveBeenCalledTimes(1)
    dispose(agent)
  })
})
