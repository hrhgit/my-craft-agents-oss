import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@mortise/core/types'
import type { PiProjectionEventV1, PiProjectionSnapshotV1 } from '@mortise/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('SessionManager Workspace topology interruption', () => {
  let root: string
  let manager: SessionManager

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mortise-workspace-interruption-'))
    manager = new SessionManager()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function workspace(id: string): Workspace {
    return {
      schemaVersion: 2,
      id,
      revision: 1,
      name: id,
      nameSource: 'custom',
      slug: id,
      primaryLocationId: 'primary',
      locations: [
        { id: 'primary', name: 'Primary', rootName: 'primary', endpoint: { kind: 'local', rootPath: root } },
        { id: 'assets', name: 'Assets', rootName: 'assets', endpoint: { kind: 'local', rootPath: root } },
      ],
      createdAt: 1,
    }
  }

  function inject(
    sessionId: string,
    workspaceId: string,
    options: { processing?: boolean; locationId?: string; queued?: boolean; agent?: ReturnType<typeof agent> } = {},
  ) {
    const managed = createManagedSession(
      { mortiseId: sessionId },
      workspace(workspaceId),
      {
        messagesLoaded: true,
        publicationState: 'provisional',
        isProcessing: options.processing ?? false,
      },
    ) as any
    managed.activeWorkspaceLocationId = options.locationId
    if (options.queued) managed.messageQueue.push({ message: `queued-${sessionId}`, messageId: `message-${sessionId}` })
    if (options.agent) managed.agent = options.agent
    ;(manager as any).sessions.set(sessionId, managed)
    return managed
  }

  function agent(onAbort?: () => Promise<void>) {
    const calls: string[] = []
    return {
      calls,
      abort: jest.fn(async () => {
        calls.push('abort')
        await onAbort?.()
      }),
      disposeForRestart: jest.fn(async () => { calls.push('disposeForRestart') }),
      isProcessing: () => true,
      redirect: async () => true,
      followUp: async () => false,
    }
  }

  function queuedProjection(sessionId: string): PiProjectionEventV1 {
    return {
      schemaVersion: 1,
      eventId: 'runtime-1:1',
      seq: 1,
      sessionId,
      runtimeId: 'runtime-1',
      entityId: 'content:user:queued-1',
      entityType: 'content_block',
      entityVersion: 1,
      kind: 'user_text',
      payload: {
        role: 'user',
        text: 'queued work',
        messageId: 'queued-1',
        clientMutationId: 'queued-1',
        queueStatus: 'queued',
        source: 'host',
      },
    }
  }

  it('selects every non-terminal Session in the Workspace and no terminal or foreign Session', async () => {
    const firstAgent = agent()
    const first = inject('first', 'workspace-a', { processing: true, locationId: 'primary', agent: firstAgent })
    const queued = inject('queued', 'workspace-a', { queued: true, locationId: 'assets' })
    const idle = inject('idle', 'workspace-a', { locationId: 'primary' })
    const foreignAgent = agent()
    const foreign = inject('foreign', 'workspace-b', { processing: true, locationId: 'primary', agent: foreignAgent })

    const result = await manager.interruptWorkspaceSessionsForTopologyChange({
      workspaceId: 'workspace-a',
      scope: 'workspace',
    })

    expect(result).toEqual({
      selectedSessionIds: ['first', 'queued'],
      interruptedSessionIds: ['first', 'queued'],
    })
    expect(first.isProcessing).toBe(false)
    expect(queued.messageQueue).toEqual([])
    expect(idle.workspaceTopologyAutoResumeBlocked).toBeUndefined()
    expect(foreign.isProcessing).toBe(true)
    expect(firstAgent.calls).toEqual(['abort', 'disposeForRestart'])
    expect(foreignAgent.abort).not.toHaveBeenCalled()
  })

  it('selects only non-terminal work attributed to the affected location', async () => {
    const primaryAgent = agent()
    const assetsAgent = agent()
    inject('primary-work', 'workspace-a', { processing: true, locationId: 'primary', agent: primaryAgent })
    inject('assets-work', 'workspace-a', { processing: true, locationId: 'assets', agent: assetsAgent })
    inject('unattributed-work', 'workspace-a', { processing: true, agent: agent() })

    const result = await manager.interruptWorkspaceSessionsForTopologyChange({
      workspaceId: 'workspace-a',
      scope: 'location',
      locationId: 'assets',
    })

    expect(result).toEqual({
      selectedSessionIds: ['assets-work'],
      interruptedSessionIds: ['assets-work'],
    })
    expect(primaryAgent.abort).not.toHaveBeenCalled()
    expect(assetsAgent.abort).toHaveBeenCalledTimes(1)
  })

  it('durably retires queued projection work and refuses to recover it', async () => {
    const managed = inject('queued-projection', 'workspace-a', { queued: true, locationId: 'primary' })
    manager.applyPiProjectionEvent(queuedProjection(managed.id))

    await manager.interruptWorkspaceSessionsForTopologyChange({
      workspaceId: 'workspace-a',
      scope: 'workspace',
    })

    const snapshot = await manager.getPiProjectionSnapshot(managed.id)
    expect(snapshot?.entities.find(entity => entity.entityId === 'content:user:queued-1')?.payload)
      .toMatchObject({ queueStatus: 'interrupted' })
    expect(managed.messageQueue).toEqual([])

    ;(manager as any).recoverQueuedProjectionMessages(managed, {
      schemaVersion: 1,
      sessionId: managed.id,
      runtimeId: 'runtime-1',
      lastSeq: 1,
      entities: [queuedProjection(managed.id)].map(event => ({
        entityId: event.entityId,
        entityType: event.entityType,
        entityVersion: event.entityVersion,
        createdSeq: event.seq,
        kind: event.kind,
        payload: event.payload,
        lastEventId: event.eventId,
        lastSeq: event.seq,
      })),
    } satisfies PiProjectionSnapshotV1)
    expect(managed.messageQueue).toEqual([])
  })

  it('coalesces concurrent interruption and is a no-op after work is terminal', async () => {
    let releaseAbort!: () => void
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve })
    const runtime = agent(() => abortGate)
    inject('coalesced', 'workspace-a', { processing: true, locationId: 'primary', agent: runtime })

    const first = manager.interruptWorkspaceSessionsForTopologyChange({ workspaceId: 'workspace-a', scope: 'workspace' })
    while (runtime.abort.mock.calls.length === 0) await Promise.resolve()
    const second = manager.interruptWorkspaceSessionsForTopologyChange({ workspaceId: 'workspace-a', scope: 'workspace' })
    releaseAbort()

    expect(await first).toEqual({ selectedSessionIds: ['coalesced'], interruptedSessionIds: ['coalesced'] })
    expect(await second).toEqual({ selectedSessionIds: ['coalesced'], interruptedSessionIds: [] })
    expect(runtime.abort).toHaveBeenCalledTimes(1)
    expect(runtime.disposeForRestart).toHaveBeenCalledTimes(1)
    expect(await manager.interruptWorkspaceSessionsForTopologyChange({ workspaceId: 'workspace-a', scope: 'workspace' }))
      .toEqual({ selectedSessionIds: [], interruptedSessionIds: [] })
  })

  it('does not run delayed queue replay after interruption', async () => {
    const managed = inject('no-replay', 'workspace-a', { queued: true, locationId: 'primary' })
    await manager.interruptWorkspaceSessionsForTopologyChange({ workspaceId: 'workspace-a', scope: 'workspace' })
    managed.messageQueue.push({ message: 'stale replay', messageId: 'stale-replay' })
    const send = jest.spyOn(manager, 'sendMessage')

    ;(manager as any).processNextQueuedMessage(managed.id)
    await new Promise(resolve => setImmediate(resolve))

    expect(send).not.toHaveBeenCalled()
    expect(managed.messageQueue).toHaveLength(1)
  })

  it('attributes explicit new work to the current primary location after interruption', async () => {
    const runtime = agent()
    const managed = inject('new-primary', 'workspace-a', { processing: true, locationId: 'primary', agent: runtime })
    await manager.interruptWorkspaceSessionsForTopologyChange({ workspaceId: 'workspace-a', scope: 'workspace' })

    const updatedWorkspace = {
      ...managed.workspace,
      revision: managed.workspace.revision + 1,
      primaryLocationId: 'assets',
    }
    manager.updateWorkspaceTopology(updatedWorkspace)
    managed.publicationState = undefined
    managed.name = 'Existing session'
    const chat = jest.fn(() => (async function* () {
      yield { type: 'complete' as const }
    })())
    const nextRuntime = {
      getModel: () => 'test-model',
      getSessionId: () => null,
      chat,
    }
    const internals = manager as any
    internals.persistSession = () => {}
    internals.flushSession = async () => {}
    internals.flushPiProjectionWrites = async () => {}
    internals.getOrCreateAgent = async () => {
      managed.agent = nextRuntime
      return nextRuntime
    }
    await manager.sendMessage(managed.id, 'new work')

    expect(chat).toHaveBeenCalledTimes(1)
    expect(managed.isProcessing).toBe(false)
    expect(managed.workspace).toBe(updatedWorkspace)
    expect(managed.workspaceTopologyAutoResumeBlocked).toBe(false)
    expect(managed.activeWorkspaceLocationId).toBe('assets')
  })

  it('refreshes every managed Session from the authoritative Workspace record', () => {
    const first = inject('refresh-first', 'workspace-a')
    const second = inject('refresh-second', 'workspace-a')
    const foreign = inject('refresh-foreign', 'workspace-b')
    const updatedWorkspace = {
      ...first.workspace,
      revision: first.workspace.revision + 1,
      primaryLocationId: 'assets',
    }

    manager.updateWorkspaceTopology(updatedWorkspace)

    expect(first.workspace).toBe(updatedWorkspace)
    expect(second.workspace).toBe(updatedWorkspace)
    expect(foreign.workspace).not.toBe(updatedWorkspace)
  })

  it('keeps a failed teardown blocking instead of treating it as an idempotent success', async () => {
    const runtime = agent()
    runtime.disposeForRestart.mockImplementationOnce(async () => {
      runtime.calls.push('disposeForRestart')
      throw new Error('child runtime did not settle')
    })
    inject('failed-teardown', 'workspace-a', { processing: true, locationId: 'primary', agent: runtime })
    const target = { workspaceId: 'workspace-a', scope: 'workspace' as const }

    await expect(manager.interruptWorkspaceSessionsForTopologyChange(target)).rejects.toThrow(
      'Failed to fully interrupt Session failed-teardown',
    )
    await expect(manager.interruptWorkspaceSessionsForTopologyChange(target)).rejects.toThrow(
      'Failed to fully interrupt Session failed-teardown',
    )
    expect(runtime.disposeForRestart).toHaveBeenCalledTimes(1)
  })
})
