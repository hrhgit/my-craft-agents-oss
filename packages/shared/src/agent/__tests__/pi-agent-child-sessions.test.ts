import { describe, expect, it, jest, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAgent, type PiChildSessionInfo } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      schemaVersion: 2,
      id: 'workspace',
      revision: 0,
      name: 'Workspace',
      nameSource: 'custom',
      slug: 'workspace',
      primaryLocationId: 'primary',
      locations: [{
        id: 'primary',
        name: 'Primary',
        rootName: 'workspace',
        endpoint: { kind: 'local', rootPath: process.cwd() },
      }],
      createdAt: Date.now(),
    } as never,
    session: {
      mortiseId: 'mortise-parent',
      workspaceRootPath: process.cwd(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
  }
}

describe('PiAgent child session listing', () => {
  it.each([
    ['omitted', undefined, []],
    ['recent turn', 1, [
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: [{ type: 'text', text: 'second answer' }], stopReason: 'length' },
    ]],
    ['all reliable history', 'all', [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }], stopReason: 'stop' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: [{ type: 'text', text: 'second answer' }], stopReason: 'length' },
    ]],
  ] as const)('passes %s fork context and an immutable run snapshot to the new child runtime', async (_label, forkTurns, expectedSeed) => {
    const agent = new PiAgent(createConfig())
    const acquireRuntime = mock(async (options: Record<string, unknown>) => ({
      runtime: {
        runtimeId: 'child-runtime',
        runtimeSummary: { sessionId: 'child', sessionFile: 'child.jsonl' },
        onClientEvent: mock(() => () => undefined),
        onEvent: mock(() => () => undefined),
        getState: mock(async () => ({ sessionId: 'child', sessionFile: 'child.jsonl' })),
        prompt: mock(async () => { throw new Error('stop after capture') }),
      },
      startupEvents: [],
      release: mock(async () => undefined),
    }))
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'orphan answer' }], stopReason: 'stop' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'text', text: 'first answer' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
      ], stopReason: 'stop' },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'tool output' }] },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }], stopReason: 'aborted' },
      { role: 'assistant', content: [{ type: 'text', text: 'second answer' }], stopReason: 'length' },
    ]
    ;(agent as any).ensureRpcClient = async () => ({
      getMessages: async () => messages,
      getState: async () => ({
        sessionId: 'pi-parent',
        sessionFile: 'parent.jsonl',
        model: { provider: 'test', id: 'model' },
        thinkingLevel: 'low',
      }),
    })
    ;(agent as any).configureChildRuntime = async () => undefined
    ;(agent as any).rpcHostLease = { acquireRuntime }

    try {
      await expect(agent.spawnChildSession('pi-parent', {
        prompt: 'Do the work.',
        agent: 'reviewer',
        forkTurns,
        systemPrompt: 'Review carefully.',
        tools: ['read'],
        model: 'model',
        thinkingLevel: 'high',
        schema: { type: 'object' },
      })).rejects.toThrow('stop after capture')
      expect(acquireRuntime).toHaveBeenCalledTimes(1)
      const options = acquireRuntime.mock.calls[0]?.[0] as {
        seedMessages: unknown[]
        spawnConfig: Record<string, unknown>
      }
      expect(options.seedMessages.map(message => {
        const value = message as { role: string; content: unknown; stopReason?: string }
        return { role: value.role, content: value.content, ...(value.stopReason ? { stopReason: value.stopReason } : {}) }
      })).toEqual([...expectedSeed])
      expect(options.spawnConfig).toEqual({
        connection: 'test',
        model: 'model',
        thinkingLevel: 'high',
        template: undefined,
        systemPrompt: 'Review carefully.',
        tools: ['read'],
        background: undefined,
        agent: 'reviewer',
        forkTurns,
        seedMessageCount: expectedSeed.length,
        schema: { type: 'object' },
      })
    } finally {
      ;(agent as any).rpcHostLease = null
      agent.destroy()
    }
  })

  it('routes child runtime host capabilities with the child identity and releases them with the lease', async () => {
    const onHostCapabilityDeclaration = mock(() => undefined)
    const onHostCapabilityRequest = mock(async request => ({
      requestId: request.requestId,
      status: 'success' as const,
      output: { ok: true },
    }))
    const onHostCapabilityRuntimeReleased = mock(() => undefined)
    const agent = new PiAgent({
      ...createConfig(), onHostCapabilityDeclaration, onHostCapabilityRequest, onHostCapabilityRuntimeReleased,
    })
    let clientListener: ((event: any) => void) | undefined
    const unsubscribe = mock(() => undefined)
    const respondToExtensionHostCapability = mock(() => undefined)
    const runtime = {
      runtimeId: 'child-runtime',
      runtimeSummary: { sessionId: 'child-session' },
      onEvent: mock(() => () => undefined),
      onClientEvent: mock((listener: typeof clientListener) => {
        clientListener = listener
        return unsubscribe
      }),
      respondToExtensionHostCapability,
      reportExtensionHostCapabilityProgress: mock(() => undefined),
    }
    const release = mock(async () => undefined)
    const lease = {
      runtime,
      startupEvents: [{
        type: 'extension_host_capability_declaration', version: 1,
        extensionId: 'child-extension', runtimeId: 'child-runtime', sessionId: 'child-session',
        declarations: [{ capability: 'files.pick', operations: ['open'] }],
      }],
      release,
    }

    const acquired = await (agent as any).acquireChildRuntimeLease(async () => lease)
    expect(onHostCapabilityDeclaration).toHaveBeenCalledWith({
      version: 1, runtimeId: 'child-runtime', sessionId: 'child-session',
      extensionId: 'child-extension',
      declarations: [{ capability: 'files.pick', operations: ['open'] }],
    })

    clientListener?.({
      type: 'extension_host_capability_request', version: 1, id: 'child-capability',
      extensionId: 'child-extension', capability: 'files.pick', operation: 'open', input: {},
      runtimeId: 'child-runtime', sessionId: 'child-session',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(onHostCapabilityRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'child-capability', runtimeId: 'child-runtime', sessionId: 'child-session',
    }), expect.any(Function))
    expect(respondToExtensionHostCapability).toHaveBeenCalledWith(expect.objectContaining({
      id: 'child-capability', runtimeId: 'child-runtime', sessionId: 'child-session', status: 'success',
    }))

    await (agent as any).releaseChildRuntimeLease(acquired.lease)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(onHostCapabilityRuntimeReleased).toHaveBeenCalledWith('child-runtime')
    ;(agent as any).rpcHostLease = null
    agent.destroy()
  })

  it('keeps a shared runtime subscription and bridge alive until the last lease is released', async () => {
    const onHostCapabilityRuntimeReleased = mock(() => undefined)
    const agent = new PiAgent({ ...createConfig(), onHostCapabilityRuntimeReleased })
    const unsubscribe = mock(() => undefined)
    const closeBridge = mock(() => undefined)
    const runtime = {
      runtimeId: 'child-runtime',
      runtimeSummary: { sessionId: 'child-session' },
      onEvent: mock(() => () => undefined),
      onClientEvent: mock(() => unsubscribe),
    }
    ;(agent as any).childCoordinationBridges.set('child-runtime', { close: closeBridge })
    let acquireCount = 0
    const releaseFirst = mock(async () => undefined)
    const releaseSecond = mock(async () => undefined)
    const acquire = mock(async () => {
      acquireCount += 1
      return { runtime, startupEvents: [], release: acquireCount === 1 ? releaseFirst : releaseSecond }
    })

    const first = await (agent as any).acquireChildRuntimeLease(acquire)
    const second = await (agent as any).acquireChildRuntimeLease(acquire)
    expect((agent as any).childRuntimeClientSubscriptions.get('child-runtime')?.refCount).toBe(2)

    await (agent as any).releaseChildRuntimeLease(first.lease)
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(closeBridge).not.toHaveBeenCalled()
    expect(onHostCapabilityRuntimeReleased).not.toHaveBeenCalled()

    await (agent as any).releaseChildRuntimeLease(second.lease)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(closeBridge).toHaveBeenCalledTimes(1)
    expect(onHostCapabilityRuntimeReleased).toHaveBeenCalledWith('child-runtime')
    expect((agent as any).childCoordinationBridges.has('child-runtime')).toBe(false)
    ;(agent as any).rpcHostLease = null
    agent.destroy()
  })
  it('projects bounded child tool activity without exposing arguments or results', async () => {
    const onChildTaskActivity = mock(() => undefined)
    const agent = new PiAgent({ ...createConfig(), onChildTaskActivity })
    let eventListener: ((event: any) => void) | undefined
    const lease = {
      runtime: {
        runtimeId: 'child-runtime',
        runtimeSummary: { sessionId: 'child-session' },
        onClientEvent: mock(() => () => undefined),
        onEvent: mock(listener => {
          eventListener = listener
          return () => undefined
        }),
      },
      startupEvents: [],
      release: mock(async () => undefined),
    }

    const acquired = await (agent as any).acquireChildRuntimeLease(async () => lease)
    eventListener?.({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'secret.txt' },
    })
    eventListener?.({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'private output' }] },
      isError: false,
    })

    expect(onChildTaskActivity).toHaveBeenNthCalledWith(1, expect.objectContaining({
      childSessionId: 'child-session',
      phase: 'activity',
      status: 'running',
      summary: 'Started tool read',
    }))
    expect(onChildTaskActivity).toHaveBeenNthCalledWith(2, expect.objectContaining({
      childSessionId: 'child-session',
      phase: 'activity',
      status: 'running',
      summary: 'Completed tool read',
    }))
    expect(JSON.stringify(onChildTaskActivity.mock.calls)).not.toContain('secret.txt')
    expect(JSON.stringify(onChildTaskActivity.mock.calls)).not.toContain('private output')

    await (agent as any).releaseChildRuntimeLease(acquired.lease)
    ;(agent as any).rpcHostLease = null
    agent.destroy()
  })

  it('routes child tool starts and results through a child-owned coordination bridge', async () => {
    const agent = new PiAgent(createConfig())
    const beforeTool = mock(async (_request, decision) => decision)
    const recordResult = mock(async () => undefined)
    const bridge = { beforeTool, recordResult }
    ;(agent as any).getChildCoordinationBridge = () => bridge
    ;(agent as any).childCoordinationBridges.set('child-runtime', bridge)
    ;(agent as any).assertBackendSessionToolParity = () => undefined
    let executionHandler: ((request: any) => Promise<unknown>) | undefined
    let resultHandler: ((request: any) => Promise<void>) | undefined
    const runtime = {
      runtimeId: 'child-runtime',
      runtimeSummary: { sessionId: 'child-session' },
      setToolExecutionHandler: mock(async handler => { executionHandler = handler }),
      setToolResultHandler: mock(async handler => { resultHandler = handler }),
      registerTools: mock(async () => []),
      getState: mock(async () => ({ activeTools: [] })),
      setActiveTools: mock(async () => undefined),
      setCompactionPrompt: mock(async () => undefined),
    }
    agent.onBeforeToolExecution = mock(async () => ({ allowed: true as const }))

    await (agent as any).configureChildRuntime(runtime, {}, {})
    const request = {
      type: 'tool_execution_request', id: 'request', runtimeId: 'child-runtime',
      attemptId: 'child-attempt', toolName: 'write', toolCallId: 'tool',
      input: { path: 'README.md' }, assistantTimestamp: 1,
    }
    await expect(executionHandler?.(request)).resolves.toEqual({ action: 'allow' })
    expect(beforeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'write', toolCallId: 'tool', input: { path: 'README.md' }, assistantTimestamp: 1,
    }), { action: 'allow' })

    await resultHandler?.({ ...request, type: 'tool_result_request', content: [], isError: false })
    expect(recordResult).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: 'child-runtime', attemptId: 'child-attempt', toolCallId: 'tool', isError: false,
    }))
    agent.destroy()
  })

  it('routes parent runtime tool results through the parent coordination bridge', async () => {
    const agent = new PiAgent(createConfig())
    const parentRecordResult = mock(async () => undefined)
    const childRecordResult = mock(async () => undefined)
    ;(agent as any).coordinationBridge = {
      beforeTool: mock(async () => undefined),
      recordResult: parentRecordResult,
      completeTurn: mock(() => undefined),
      close: mock(() => undefined),
      releasePending: mock(() => undefined),
    }
    ;(agent as any).childCoordinationBridges.set('child-runtime', {
      beforeTool: mock(async () => undefined),
      recordResult: childRecordResult,
      completeTurn: mock(() => undefined),
      close: mock(() => undefined),
      releasePending: mock(() => undefined),
    })

    // parent results carry mortiseId as runtimeId, which is not a child bridge key, so they fall back to the parent bridge
    await (agent as any).handleCoordinatedToolResult({
      type: 'tool_result_request', id: 'request', runtimeId: 'mortise-parent',
      attemptId: 'parent-attempt', toolName: 'write', toolCallId: 'tool-parent',
      content: [], isError: false,
    })
    expect(parentRecordResult).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: 'mortise-parent', attemptId: 'parent-attempt', toolCallId: 'tool-parent', isError: false,
    }))
    expect(childRecordResult).not.toHaveBeenCalled()
    agent.destroy()
  })

  it('falls back to the parent coordination bridge for an unknown runtime', async () => {
    const agent = new PiAgent(createConfig())
    const parentRecordResult = mock(async () => undefined)
    const childRecordResult = mock(async () => undefined)
    ;(agent as any).coordinationBridge = {
      beforeTool: mock(async () => undefined),
      recordResult: parentRecordResult,
      completeTurn: mock(() => undefined),
      close: mock(() => undefined),
      releasePending: mock(() => undefined),
    }
    ;(agent as any).childCoordinationBridges.set('child-runtime', {
      beforeTool: mock(async () => undefined),
      recordResult: childRecordResult,
      completeTurn: mock(() => undefined),
      close: mock(() => undefined),
      releasePending: mock(() => undefined),
    })

    await (agent as any).handleCoordinatedToolResult({
      type: 'tool_result_request', id: 'request', runtimeId: 'foreign-runtime',
      attemptId: 'foreign-attempt', toolName: 'read', toolCallId: 'tool-foreign',
      content: [], isError: false,
    })
    expect(parentRecordResult).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: 'foreign-runtime', attemptId: 'foreign-attempt', toolCallId: 'tool-foreign',
    }))
    expect(childRecordResult).not.toHaveBeenCalled()
    agent.destroy()
  })

  it('routes a known child runtime result through its own coordination bridge', async () => {
    const agent = new PiAgent(createConfig())
    const parentRecordResult = mock(async () => undefined)
    const childRecordResult = mock(async () => undefined)
    ;(agent as any).coordinationBridge = {
      beforeTool: mock(async () => undefined),
      recordResult: parentRecordResult,
      completeTurn: mock(() => undefined),
      close: mock(() => undefined),
      releasePending: mock(() => undefined),
    }
    ;(agent as any).childCoordinationBridges.set('child-runtime', {
      beforeTool: mock(async () => undefined),
      recordResult: childRecordResult,
      completeTurn: mock(() => undefined),
      close: mock(() => undefined),
      releasePending: mock(() => undefined),
    })

    await (agent as any).handleCoordinatedToolResult({
      type: 'tool_result_request', id: 'request', runtimeId: 'child-runtime',
      attemptId: 'child-attempt', toolName: 'write', toolCallId: 'tool-child',
      content: [], isError: false,
    })
    expect(childRecordResult).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: 'child-runtime', attemptId: 'child-attempt', toolCallId: 'tool-child',
    }))
    expect(parentRecordResult).not.toHaveBeenCalled()
    agent.destroy()
  })

  it('does not register a child Attempt when Pi rejects the prompt', async () => {
    const order: string[] = []
    const onChildAttemptStarted = mock(async () => {
      order.push('lease')
      return { attemptId: 'pi-attempt', operationId: 'host-operation' }
    })
    const onChildAttemptAbandoned = mock(async () => { order.push('abandon') })
    const agent = new PiAgent({ ...createConfig(), onChildAttemptStarted, onChildAttemptAbandoned })
    const release = mock(async () => {})
    const runtime = {
      runtimeId: 'child-runtime',
      runtimeSummary: { sessionId: 'child', sessionFile: 'child.jsonl' },
      getState: mock(async () => ({
        sessionId: 'child',
        sessionFile: 'child.jsonl',
        activeTools: [],
        model: { provider: 'test', id: 'model' },
        thinkingLevel: 'low',
        isStreaming: false,
      })),
      setModel: mock(async () => {}),
      setThinkingLevel: mock(async () => {}),
      setToolExecutionHandler: mock(async () => {}),
      setToolResultHandler: mock(async () => {}),
      registerTools: mock(async () => []),
      setActiveTools: mock(async () => {}),
      setCompactionPrompt: mock(async () => {}),
      onEvent: mock(() => () => {}),
	  onClientEvent: mock(() => () => {}),
	  prompt: mock(async () => {
		order.push('prompt')
        throw new Error('prompt rejected')
      }),
    }
    ;(agent as any).ensureRpcClient = async () => ({
      getMessages: async () => [],
      getState: async () => ({
        sessionId: 'pi-parent',
        sessionFile: 'parent.jsonl',
        model: { provider: 'test', id: 'model' },
        thinkingLevel: 'low',
      }),
    })
    ;(agent as any).assertBackendSessionToolParity = () => undefined
    ;(agent as any).rpcHostLease = {
      acquireRuntime: async () => ({ runtime, startupEvents: [], release }),
    }

    await expect(agent.spawnChildSession('pi-parent', { prompt: 'Do the work.', background: true }))
      .rejects.toThrow('prompt rejected')
    expect(order).toEqual(['prompt'])
    expect(onChildAttemptStarted).not.toHaveBeenCalled()
    expect(onChildAttemptAbandoned).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    ;(agent as any).rpcHostLease = null
    agent.destroy()
  })

  it('does not register an operation when Pi rejects a child follow-up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-child-followup-'))
    const onChildTaskSettled = mock(async () => {})
    const onChildAttemptAbandoned = mock(async () => {})
    const agent = new PiAgent({
      ...createConfig(),
      getChildAttempt: () => ({ attemptId: 'shared-attempt' }),
      onChildAttemptStarted: async request => ({
		attemptId: request.attemptId,
        operationId: 'rejected-operation',
      }),
      onChildTaskSettled,
      onChildAttemptAbandoned,
    })
    const child: PiChildSessionInfo = {
      sessionId: 'child',
      sessionPath: join(root, 'child.jsonl'),
      cwd: root,
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
      firstMessage: 'Initial task',
      status: 'running',
      persistedClientMutationIds: [],
      history: [],
    }
    const release = mock(async () => {})
    const runtime = {
      runtimeId: 'child-runtime',
      getState: mock(async () => ({ isStreaming: true })),
      onEvent: mock(() => () => {}),
      steer: mock(async () => ({ status: 'rejected', reason: 'not-running' as const })),
    }
    ;(agent as any).acquireChildRuntime = async () => ({
      lease: { runtime, release },
      runtime,
      child,
      epoch: 0,
    })
    agent.listChildSessions = mock(async () => [child])
    ;(agent as any).queueChildInboxMessage = async () => {}
    ;(agent as any).removeChildInboxMessages = async () => {}
    ;(agent as any).watchChildMessagePersistence = () => ({ promise: Promise.resolve(false), cancel: () => {} })

    try {
      await expect(agent.sendChildSessionMessage('parent', 'child', 'adjust', { background: true }))
        .rejects.toThrow('Child steer was not queued')
      expect(onChildAttemptAbandoned).not.toHaveBeenCalled()
      expect(onChildTaskSettled).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      agent.destroy()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists a message for an interrupted task without starting a new Attempt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-child-queued-message-'))
    const agent = new PiAgent(createConfig())
    const child: PiChildSessionInfo = {
      sessionId: 'child',
      sessionPath: join(root, 'child.jsonl'),
      cwd: root,
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
      firstMessage: 'Initial task',
      status: 'interrupted',
      persistedClientMutationIds: [],
      history: [],
    }
    agent.listChildSessions = mock(async () => [child])
    const acquireChildRuntime = mock(async () => { throw new Error('must not acquire runtime') })
    ;(agent as any).acquireChildRuntime = acquireChildRuntime

    try {
      await expect(agent.sendChildSessionMessage('parent', 'child', 'Use the new constraint.'))
        .resolves.toMatchObject({ sessionId: 'child', status: 'interrupted' })
      expect(acquireChildRuntime).not.toHaveBeenCalled()
      await expect((agent as any).getPendingChildInboxMessages(child)).resolves.toEqual([
        expect.objectContaining({ message: 'Use the new constraint.' }),
      ])
    } finally {
      agent.destroy()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a timed-out child Attempt pending and closes its record when settlement arrives late', async () => {
    jest.useFakeTimers()
    let listener: ((event: { type: string; attemptId: string }) => void) | undefined
    const onChildAttemptSettled = mock(async () => {})
    const agent = new PiAgent({ ...createConfig(), onChildAttemptSettled })
    const runtime = {
      runtimeId: 'child-runtime',
      onEvent: mock((callback: typeof listener) => {
        listener = callback
        return () => { listener = undefined }
      }),
    }
    const watcher = (agent as any).watchChildSettlement(runtime, 'child', 'child-execution') as {
      promise: Promise<void>
      cancel: () => void
    }
    const outcome = watcher.promise.catch((error: Error) => error)

    try {
      jest.advanceTimersByTime(600_000)
      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining('remains pending verification'),
      })
      expect(onChildAttemptSettled).not.toHaveBeenCalled()

      listener?.({ type: 'agent_settled', attemptId: 'child-execution' })
      await Promise.resolve()
      await Promise.resolve()
      expect(onChildAttemptSettled).toHaveBeenCalledWith('child-runtime', 'child', 'child-execution')
    } finally {
      watcher.cancel()
      jest.useRealTimers()
      agent.destroy()
    }
  })

  it('fences a delayed child runtime acquisition when the parent is disposed', async () => {
    const agent = new PiAgent(createConfig())
    let resolveAcquire!: (lease: unknown) => void
    let markAcquireStarted!: () => void
    const acquireStarted = new Promise<void>(resolve => { markAcquireStarted = resolve })
    const release = mock(async () => {})
    const acquireRuntime = mock(() => {
      markAcquireStarted()
      return new Promise(resolve => { resolveAcquire = resolve })
    })
    const parent = {
      getMessages: mock(async () => []),
      getState: mock(async () => ({
        sessionId: 'pi-parent',
        sessionFile: 'parent.jsonl',
        model: { provider: 'test', id: 'model' },
        thinkingLevel: 'low',
      })),
    }
    ;(agent as any).ensureRpcClient = async () => parent
    ;(agent as any).rpcHostLease = { acquireRuntime }
    ;(agent as any).stopRpcClient = async () => {}

    const spawn = agent.spawnChildSession('pi-parent', { prompt: 'Do the work.' })
    await acquireStarted
    const dispose = agent.disposeForRestart()
    resolveAcquire({
      runtime: { runtimeId: 'child-runtime', runtimeSummary: { sessionId: 'child' } },
      release,
    })

    await expect(spawn).rejects.toThrow('Parent runtime is unavailable')
    await expect(dispose).resolves.toBeUndefined()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('queries with the runtime session ID established during RPC readiness', async () => {
    const agent = new PiAgent(createConfig())
    const listChildSessions = mock(async () => [])
    ;(agent as unknown as { ensureRpcClient: () => Promise<unknown> }).ensureRpcClient = async () => {
      agent.setSessionId('pi-parent')
      return { listChildSessions }
    }
    ;(agent as unknown as { requirePiRpcCommand: () => void }).requirePiRpcCommand = () => {}

    await expect(agent.listChildSessions('mortise-parent')).resolves.toEqual([])
    expect(listChildSessions).toHaveBeenCalledWith('pi-parent', expect.stringContaining('subagents'))
    agent.destroy()
  })

  it('persists child adjustment messages until their canonical history settles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-child-inbox-'))
    const agent = new PiAgent(createConfig())
    const child = {
      sessionId: 'child',
      sessionPath: join(root, 'child.jsonl'),
      cwd: root,
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
      firstMessage: 'Initial task',
      status: 'interrupted' as const,
      persistedClientMutationIds: [],
      history: [],
    }
    const inbox = agent as unknown as {
      queueChildInboxMessage: (child: PiChildSessionInfo, id: string, message: string) => Promise<void>
      getPendingChildInboxMessages: (child: PiChildSessionInfo) => Promise<Array<{ id: string; message: string }>>
      completeChildInboxMessages: (child: PiChildSessionInfo, ids: string[]) => Promise<void>
    }

    try {
      await inbox.queueChildInboxMessage(child, 'message-1', 'Use the updated constraint.')
      await expect(inbox.getPendingChildInboxMessages(child)).resolves.toEqual([
        expect.objectContaining({ id: 'message-1', message: 'Use the updated constraint.' }),
      ])
      await inbox.completeChildInboxMessages(child, ['message-1'])
      await expect(inbox.getPendingChildInboxMessages(child)).resolves.toEqual([])
    } finally {
      agent.destroy()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deduplicates recovery by mutation ID instead of message text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-child-inbox-id-'))
    const agent = new PiAgent(createConfig())
    const child: PiChildSessionInfo = {
      sessionId: 'child',
      sessionPath: join(root, 'child.jsonl'),
      cwd: root,
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
      firstMessage: 'Initial task',
      status: 'interrupted',
      persistedClientMutationIds: ['message-1'],
      history: [{ role: 'user', text: 'Same instruction.', clientMutationId: 'message-1' }],
    }
    const inbox = agent as any

    try {
      await inbox.queueChildInboxMessage(child, 'message-1', 'Same instruction.')
      await inbox.queueChildInboxMessage(child, 'message-2', 'Same instruction.')
      await expect(inbox.getPendingChildInboxMessages(child)).resolves.toEqual([
        expect.objectContaining({ id: 'message-2', message: 'Same instruction.' }),
      ])
    } finally {
      agent.destroy()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects inbox overflow without evicting accepted pending messages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-child-inbox-capacity-'))
    const agent = new PiAgent(createConfig())
    const child: PiChildSessionInfo = {
      sessionId: 'child',
      sessionPath: join(root, 'child.jsonl'),
      cwd: root,
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
      firstMessage: 'Initial task',
      status: 'interrupted',
      persistedClientMutationIds: [],
      history: [],
    }
    const inbox = agent as any

    try {
      for (let index = 0; index < 100; index++) {
        await inbox.queueChildInboxMessage(child, `message-${index}`, `Instruction ${index}`)
      }
      await expect(inbox.queueChildInboxMessage(child, 'overflow', 'Do not evict anything.'))
        .rejects.toThrow('inbox is full')
      await expect(inbox.getPendingChildInboxMessages(child)).resolves.toHaveLength(100)
    } finally {
      agent.destroy()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
