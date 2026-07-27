import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAgent, type PiChildSessionInfo } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'workspace',
      name: 'Workspace',
      rootPath: process.cwd(),
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
  it('records a background operation only after the child prompt is accepted', async () => {
    const onChildTaskBackgroundStarted = mock(async () => {})
    const agent = new PiAgent({ ...createConfig(), onChildTaskBackgroundStarted })
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
      setToolPermissionHandler: mock(async () => {}),
      setToolResultHandler: mock(async () => {}),
      registerTools: mock(async () => []),
      setActiveTools: mock(async () => {}),
      setCompactionPrompt: mock(async () => {}),
      onEvent: mock(() => () => {}),
      prompt: mock(async () => { throw new Error('prompt rejected') }),
    }
    ;(agent as any).ensureRpcClient = async () => ({
      getState: async () => ({
        sessionId: 'pi-parent',
        sessionFile: 'parent.jsonl',
        model: { provider: 'test', id: 'model' },
        thinkingLevel: 'low',
      }),
    })
    ;(agent as any).rpcHostLease = {
      acquireRuntime: async () => ({ runtime, release }),
    }

    await expect(agent.spawnChildSession('pi-parent', { prompt: 'Do the work.', background: true }))
      .rejects.toThrow('prompt rejected')
    expect(onChildTaskBackgroundStarted).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    ;(agent as any).rpcHostLease = null
    agent.destroy()
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
