import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MultiWriterStore } from '@mortise/shared/storage'
import type { Session } from '@mortise/shared/protocol'
import { OperationCoordinator } from '../../operations/index.ts'
import {
  AGENT_CHILD_TASK_CAPABILITY,
  createSessionRuntimeCapabilityProviders,
  SESSION_CATALOG_CAPABILITY,
  SESSION_EXECUTION_CAPABILITY,
  SESSION_SETTINGS_CAPABILITY,
  type SessionRuntimeCapabilityAdapter,
} from '../providers/session-runtime.ts'

const roots: string[] = []

function session(id: string, workspaceId: string): Session {
  return { id, workspaceId, name: id } as Session
}

function coordinator(): OperationCoordinator {
  const root = mkdtempSync(join(tmpdir(), 'mortise-session-capability-'))
  roots.push(root)
  return new OperationCoordinator(MultiWriterStore.openSync({
    databasePath: join(root, 'state.sqlite'),
    writerId: `session-capability-${roots.length}`,
    writerVersion: 1,
  }))
}

function context(sessionId = 'session-1', extensionId = 'plan-mode') {
  return {
    request: {
      version: 1 as const,
      requestId: 'request-1',
      capability: '',
      operation: '',
      sessionId,
      runtimeId: 'runtime-1',
      extensionId,
      input: {},
    },
    signal: new AbortController().signal,
    reportProgress() {},
  }
}

function harness() {
  const sessions = [session('session-1', 'workspace-1'), session('session-2', 'workspace-1'), session('other', 'workspace-2')]
  const submitMessage = mock(async () => undefined)
  const compactSession = mock(async () => undefined)
  const interruptSession = mock(async () => undefined)
  const createAndSubmit = mock(async () => 'session-created')
  const updateSessionModel = mock(async () => undefined)
  const updateSessionThinkingLevel = mock(() => undefined)
  const runChildTask = mock(async () => ({ status: 'completed', output: 'reviewed' }))
  const adapter: SessionRuntimeCapabilityAdapter = {
    async getSession(id) { return sessions.find(candidate => candidate.id === id) ?? null },
    listSessions(workspaceId) { return sessions.filter(candidate => candidate.workspaceId === workspaceId) },
    getSessionCwd(id) { return `C:/workspace/${id}` },
    submitMessage,
    compactSession,
    interruptSession,
    createAndSubmit,
    updateSessionModel,
    updateSessionThinkingLevel,
    runChildTask,
  }
  const operations = coordinator()
  const providers = createSessionRuntimeCapabilityProviders(adapter, operations)
  return {
    operations,
    submitMessage,
    compactSession,
    interruptSession,
    createAndSubmit,
    updateSessionModel,
    updateSessionThinkingLevel,
    runChildTask,
    execution: providers.find(provider => provider.capability === SESSION_EXECUTION_CAPABILITY)!,
    catalog: providers.find(provider => provider.capability === SESSION_CATALOG_CAPABILITY)!,
    settings: providers.find(provider => provider.capability === SESSION_SETTINGS_CAPABILITY)!,
    childTask: providers.find(provider => provider.capability === AGENT_CHILD_TASK_CAPABILITY)!,
  }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function settleOperation(operations: OperationCoordinator, operationId: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (operations.get(operationId)?.status === 'accepted' || operations.get(operationId)?.status === 'running') {
    if (Date.now() >= deadline) throw new Error(`Timed out settling ${operationId}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Mortise-owned Session runtime capabilities', () => {
  it('returns a durable receipt before running a submitted message', async () => {
    const h = harness()
    try {
      const accepted = await h.execution.invoke('submit-message', {
        sessionId: 'session-2',
        operationId: 'operation-1',
        message: 'continue',
      }, context())
      expect(accepted).toMatchObject({ accepted: true, operationId: 'operation-1', status: 'accepted' })
      await settleOperation(h.operations, 'operation-1')
      expect(h.submitMessage).toHaveBeenCalledWith('session-2', 'continue', 'operation-1', undefined)
      expect(h.operations.get('operation-1')).toMatchObject({
        status: 'succeeded',
        resultRef: 'session:session-2:message:operation-1',
        scope: { workspaceId: 'workspace-1', sessionId: 'session-2', extensionId: 'plan-mode' },
      })
    } finally {
      h.operations.close()
    }
  })

  it('creates and publishes a new Session only through the first-turn transaction', async () => {
    const h = harness()
    try {
      const accepted = await h.execution.invoke('create-and-submit', {
        operationId: 'operation-create',
        message: 'first message',
        name: 'Remote Session',
      }, context('session-1', 'pi-remote'))
      expect(accepted).toMatchObject({ accepted: true, operationId: 'operation-create', status: 'accepted' })
      await settle()
      expect(h.createAndSubmit).toHaveBeenCalledWith(
        'workspace-1',
        'first message',
        'operation-create',
        expect.objectContaining({ name: 'Remote Session', signal: expect.any(AbortSignal) }),
      )
      expect(h.operations.get('operation-create')).toMatchObject({
        status: 'succeeded',
        resultRef: 'session:session-created',
        scope: { workspaceId: 'workspace-1', sessionId: 'session-1', extensionId: 'pi-remote' },
      })
    } finally {
      h.operations.close()
    }
  })

  it('settles a failed submission on the operation receipt without an Agent result artifact', async () => {
    const h = harness()
    try {
      h.submitMessage.mockRejectedValueOnce(new Error('message was not persisted'))
      await h.execution.invoke('submit-message', {
        operationId: 'operation-failed',
        message: 'fail',
      }, context())
      await settleOperation(h.operations, 'operation-failed')
      expect(h.operations.get('operation-failed')).toMatchObject({
        status: 'failed',
        error: { message: 'message was not persisted' },
      })
    } finally {
      h.operations.close()
    }
  })

  it('keeps catalog, target Sessions, and operation queries inside the caller Workspace', async () => {
    const h = harness()
    try {
      expect(await h.catalog.invoke('list', {}, context())).toEqual([
        expect.objectContaining({ id: 'session-1', cwd: 'C:/workspace/session-1', messageCount: 0 }),
        expect.objectContaining({ id: 'session-2', cwd: 'C:/workspace/session-2', messageCount: 0 }),
      ])
      expect(await h.catalog.invoke('get', { sessionId: 'other' }, context())).toBeNull()
      await expect(h.execution.invoke('submit-message', {
        sessionId: 'other', message: 'escape', operationId: 'operation-other',
      }, context())).rejects.toThrow('caller Workspace')

      h.operations.accept('foreign-operation', 'extension.session.compact', { workspaceId: 'workspace-2', sessionId: 'other' })
      await expect(h.execution.invoke('query-operation', {
        operationId: 'foreign-operation',
      }, context())).rejects.toThrow('caller Workspace')

      h.operations.accept('same-workspace-operation', 'extension.session.compact', {
        workspaceId: 'workspace-1', sessionId: 'session-1', extensionId: 'plan-mode',
      })
      await expect(h.execution.invoke('query-operation', {
        operationId: 'same-workspace-operation',
      }, context('session-1', 'other-extension'))).rejects.toThrow('caller Extension')
    } finally {
      h.operations.close()
    }
  })

  it('updates target Session settings through Mortise ownership', async () => {
    const h = harness()
    try {
      await h.settings.invoke('set-model', {
        sessionId: 'session-2', provider: 'openai', model: 'gpt-5.4',
      }, context('session-1', 'pi-remote'))
      expect(h.updateSessionModel).toHaveBeenCalledWith('session-2', 'workspace-1', 'gpt-5.4', 'openai')

      await h.settings.invoke('set-thinking-level', {
        sessionId: 'session-2', level: 'high',
      }, context('session-1', 'pi-remote'))
      expect(h.updateSessionThinkingLevel).toHaveBeenCalledWith('session-2', 'high')
    } finally {
      h.operations.close()
    }
  })

  it('routes compaction, interruption, and child tasks through the adapter', async () => {
    const h = harness()
    try {
      await h.execution.invoke('compact', {
        operationId: 'compact-1', instructions: 'retain decisions',
      }, context())
      await settle()
      expect(h.compactSession).toHaveBeenCalledWith('session-1', 'compact-1', 'retain decisions')

      await h.execution.invoke('interrupt', { sessionId: 'session-2' }, context())
      expect(h.interruptSession).toHaveBeenCalledWith('session-2')

      await expect(h.childTask.invoke('run', {
        prompt: 'review', model: 'stepfun/step-3.7-flash', tools: ['read'], systemPrompt: 'read only',
      }, context())).resolves.toEqual({ status: 'completed', output: 'reviewed' })
      expect(h.runChildTask).toHaveBeenCalledWith(expect.objectContaining({
        parentSessionId: 'session-1', prompt: 'review', tools: ['read'],
      }))
    } finally {
      h.operations.close()
    }
  })
})
