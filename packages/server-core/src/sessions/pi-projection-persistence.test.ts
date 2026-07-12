import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PiProjectionEventV1 } from '@craft-agent/shared/protocol'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  appendStoredMessagesViaPiSessionManager,
  createSession,
  getSessionFilePath,
  getSessionPath,
  loadSession,
  setSharedPiSessionsDirForTests,
} from '@craft-agent/shared/sessions'
import { PiProjectionBuilder } from '@craft-agent/shared/agent/backend'
import { SessionManager, createManagedSession } from './SessionManager.ts'

function projectionEvent(
  seq: number,
  overrides: Partial<PiProjectionEventV1> = {},
): PiProjectionEventV1 {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    seq,
    sessionId: 'session-1',
    runtimeId: 'runtime-1',
    turnId: 'turn-1',
    entityId: `block-${seq}`,
    entityType: 'content_block',
    entityVersion: 1,
    kind: 'assistant_text',
    payload: { text: `text-${seq}` },
    ...overrides,
  }
}

describe('Pi projection persistence', () => {
  let workspaceRoot: string

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'pi-projection-persistence-'))
    setSharedPiSessionsDirForTests(join(workspaceRoot, 'pi-sessions'))
  })

  afterEach(() => {
    setSharedPiSessionsDirForTests(undefined)
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('reloads pi-projection-v1.json after the Host restarts', async () => {
    const workspace = {
      id: 'workspace-1',
      name: 'Projection Workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    } as never
    const session = createManagedSession({ craftId: 'session-1' }, workspace)
    const firstHost = new SessionManager()
    const firstHostInternals = firstHost as unknown as {
      sessions: Map<string, typeof session>
      piProjectionWrites: Map<string, Promise<void>>
    }
    firstHostInternals.sessions.set(session.id, session)

    expect(firstHost.applyPiProjectionEvent(projectionEvent(1)).status).toBe('applied')
    expect(firstHost.applyPiProjectionEvent(projectionEvent(2)).status).toBe('applied')
    await firstHostInternals.piProjectionWrites.get(session.id)

    const sidecarPath = join(getSessionPath(workspaceRoot, session.id), 'pi-projection-v1.json')
    const persisted = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    expect(persisted.lastSeq).toBe(2)
    expect(persisted.entities.map((entity: { entityId: string }) => entity.entityId))
      .toEqual(['block-1', 'block-2'])

    const restartedHost = new SessionManager()
    const restartedSession = createManagedSession({ craftId: 'session-1' }, workspace)
    const restartedHostInternals = restartedHost as unknown as {
      sessions: Map<string, typeof restartedSession>
      piProjectionWrites: Map<string, Promise<void>>
    }
    restartedHostInternals.sessions.set(restartedSession.id, restartedSession)

    const restored = await restartedHost.getPiProjectionSnapshot(restartedSession.id)
    expect(restored).toEqual(persisted)
    expect(restartedHost.applyPiProjectionEvent(projectionEvent(3)).status).toBe('applied')
    expect((await restartedHost.getPiProjectionSnapshot(restartedSession.id))?.lastSeq).toBe(3)
    await restartedHostInternals.piProjectionWrites.get(restartedSession.id)
  })

  it('coalesces streaming updates and persists the latest contiguous snapshot', async () => {
    const workspace = { id: 'workspace-1', name: 'Projection Workspace', rootPath: workspaceRoot, createdAt: Date.now() } as never
    const session = createManagedSession({ craftId: 'session-1' }, workspace)
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof session>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(session.id, session)
    for (let seq = 1; seq <= 25; seq++) host.applyPiProjectionEvent(projectionEvent(seq))
    await internals.piProjectionWrites.get(session.id)
    const sidecarPath = join(getSessionPath(workspaceRoot, session.id), 'pi-projection-v1.json')
    const persisted = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    expect(persisted.lastSeq).toBe(25)
    expect(persisted.entities).toHaveLength(25)
  })

  it('rebuilds a missing sidecar from the public Pi session projection', async () => {
    const workspace = {
      id: 'workspace-1', name: 'Projection Workspace', rootPath: workspaceRoot, createdAt: Date.now(),
    } as never
    const header = await createSession(workspaceRoot, { name: 'Pi history' })
    const sessionFile = getSessionFilePath(workspaceRoot, header.craftId)
    appendStoredMessagesViaPiSessionManager(sessionFile, dirname(sessionFile), workspaceRoot, [
      { id: 'source-user', type: 'user', content: 'question from Pi', timestamp: 100 },
    ])

    const managed = createManagedSession(header, workspace, { messagesLoaded: true })
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof managed>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(managed.id, managed)
    const sidecarPath = join(getSessionPath(workspaceRoot, managed.id), 'pi-projection-v1.json')
    expect(existsSync(sidecarPath)).toBe(false)

    const rebuilt = await host.getPiProjectionSnapshot(managed.id)

    expect(rebuilt?.runtimeId).toBe(`history:${managed.id}`)
    expect(rebuilt?.entities).toContainEqual(expect.objectContaining({
      kind: 'user_text', payload: expect.objectContaining({ text: 'question from Pi' }),
    }))
    await internals.piProjectionWrites.get(managed.id)
    expect(JSON.parse(readFileSync(sidecarPath, 'utf8'))).toEqual(rebuilt)
  })

  it('rebuilds an invalid sidecar from the public Pi session projection', async () => {
    const workspace = {
      id: 'workspace-1', name: 'Projection Workspace', rootPath: workspaceRoot, createdAt: Date.now(),
    } as never
    const header = await createSession(workspaceRoot, { name: 'Pi history' })
    const sessionFile = getSessionFilePath(workspaceRoot, header.craftId)
    appendStoredMessagesViaPiSessionManager(sessionFile, dirname(sessionFile), workspaceRoot, [
      { id: 'source-user', type: 'user', content: 'survives corrupt sidecar', timestamp: 100 },
    ])

    const managed = createManagedSession(header, workspace, { messagesLoaded: true })
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof managed>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(managed.id, managed)
    const sidecarPath = join(getSessionPath(workspaceRoot, managed.id), 'pi-projection-v1.json')
    mkdirSync(dirname(sidecarPath), { recursive: true })
    writeFileSync(sidecarPath, JSON.stringify({
      schemaVersion: 1,
      sessionId: managed.id,
      runtimeId: '',
      lastSeq: 0,
      entities: [],
    }), 'utf8')

    const rebuilt = await host.getPiProjectionSnapshot(managed.id)

    expect(rebuilt?.entities).toContainEqual(expect.objectContaining({
      kind: 'user_text', payload: expect.objectContaining({ text: 'survives corrupt sidecar' }),
    }))
    await internals.piProjectionWrites.get(managed.id)
    expect(JSON.parse(readFileSync(sidecarPath, 'utf8'))).toEqual(rebuilt)
  })

  it('continues sequence across replacement runtimes and rejects retired runtimes', async () => {
    const workspace = {
      id: 'workspace-1', name: 'Projection Workspace', rootPath: workspaceRoot, createdAt: Date.now(),
    } as never
    const managed = createManagedSession({ craftId: 'session-1' }, workspace, { messagesLoaded: true })
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof managed>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(managed.id, managed)

    expect(host.applyPiProjectionEvent(projectionEvent(1)).status).toBe('applied')
    expect(host.applyPiProjectionEvent(projectionEvent(2, { runtimeId: 'runtime-2' })).status).toBe('applied')
    expect(() => host.applyPiProjectionEvent(projectionEvent(3, { runtimeId: 'runtime-1' })))
      .toThrow('Rejected event from retired Pi projection runtime: runtime-1')
    expect(host.applyPiProjectionEvent(projectionEvent(3, { runtimeId: 'runtime-3' })).status).toBe('applied')
    expect(() => host.applyPiProjectionEvent(projectionEvent(4, { runtimeId: 'runtime-2' })))
      .toThrow('Rejected event from retired Pi projection runtime: runtime-2')

    const snapshot = await host.getPiProjectionSnapshot(managed.id)
    expect(snapshot).toMatchObject({ runtimeId: 'runtime-3', lastSeq: 3 })
    expect(snapshot?.entities.map(entity => entity.entityId)).toEqual(['block-1', 'block-2', 'block-3'])
    await internals.piProjectionWrites.get(managed.id)
  })

  it('derives cached session metadata from projected message identity and finality', async () => {
    const workspace = {
      id: 'workspace-1', name: 'Projection Workspace', rootPath: workspaceRoot, createdAt: Date.now(),
    } as never
    const managed = createManagedSession({ craftId: 'session-1' }, workspace, { messagesLoaded: true })
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof managed>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(managed.id, managed)

    host.applyPiProjectionEvent(projectionEvent(1, {
      entityId: 'content:user:user-1', kind: 'user_text',
      payload: { role: 'user', messageId: 'user-1', text: '  Projected   prompt  ' },
    }))
    host.applyPiProjectionEvent(projectionEvent(2, {
      entityId: 'content:text:assistant-mid:0', kind: 'assistant_text',
      payload: {
        role: 'assistant', contentKind: 'text', messageId: 'assistant-mid', text: 'Working',
        streaming: false, contentIndex: 0, isIntermediate: true,
      },
    }))
    expect(managed.lastFinalMessageId).toBeUndefined()

    host.applyPiProjectionEvent(projectionEvent(3, {
      entityId: 'content:text:assistant-final:0', kind: 'assistant_text',
      payload: {
        role: 'assistant', contentKind: 'text', messageId: 'assistant-final', text: 'Done',
        streaming: false, contentIndex: 0, isIntermediate: false,
      },
    }))

    expect(managed).toMatchObject({
      messageCount: 3,
      preview: 'Projected prompt',
      lastMessageRole: 'assistant',
      lastFinalMessageId: 'assistant-final',
    })
    await internals.piProjectionWrites.get(managed.id)
  })

  it('persists projection-derived metadata through the session queue and restart', async () => {
    const workspace = {
      id: 'workspace-1', name: 'Projection Workspace', rootPath: workspaceRoot, createdAt: Date.now(),
    } as never
    const header = await createSession(workspaceRoot, { name: 'Projected metadata' })
    const managed = createManagedSession(header, workspace, { messagesLoaded: true })
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof managed>
      persistSession: (session: typeof managed) => void
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(managed.id, managed)

    host.applyPiProjectionEvent(projectionEvent(1, {
      sessionId: managed.id,
      entityId: 'content:user:user-1',
      kind: 'user_text',
      payload: { role: 'user', messageId: 'user-1', text: '  Persisted   projection prompt  ' },
    }))
    host.applyPiProjectionEvent(projectionEvent(2, {
      sessionId: managed.id,
      entityId: 'content:text:assistant-mid:0',
      kind: 'assistant_text',
      payload: {
        role: 'assistant', contentKind: 'text', messageId: 'assistant-mid', text: 'Working',
        streaming: false, contentIndex: 0, isIntermediate: true,
      },
    }))
    host.applyPiProjectionEvent(projectionEvent(3, {
      sessionId: managed.id,
      entityId: 'content:text:assistant-final:0',
      kind: 'assistant_text',
      payload: {
        role: 'assistant', contentKind: 'text', messageId: 'assistant-final', text: 'Done',
        streaming: false, contentIndex: 0, isIntermediate: false,
      },
    }))

    expect(managed.messages).toEqual([])
    internals.persistSession(managed)
    await host.flushSession(managed.id)
    await internals.piProjectionWrites.get(managed.id)

    const stored = loadSession(workspaceRoot, managed.id)
    expect(stored).toMatchObject({
      messageCount: 3,
      preview: 'Persisted projection prompt',
      lastMessageRole: 'assistant',
      lastFinalMessageId: 'assistant-final',
      messages: [],
    })

    const restarted = createManagedSession({
      craftId: stored!.craftId,
      messageCount: stored!.messageCount,
      preview: stored!.preview,
      lastMessageRole: stored!.lastMessageRole,
      lastFinalMessageId: stored!.lastFinalMessageId,
    }, workspace, { messagesLoaded: false })
    expect(restarted).toMatchObject({
      messageCount: 3,
      preview: 'Persisted projection prompt',
      lastMessageRole: 'assistant',
      lastFinalMessageId: 'assistant-final',
    })
  })

  it('hands a fallback Host runtime error off to the next real Pi runtime without resetting history', async () => {
    const workspace = {
      id: 'workspace-1', name: 'Projection Workspace', rootPath: workspaceRoot, createdAt: Date.now(),
    } as never
    const managed = createManagedSession({ craftId: 'session-1' }, workspace, { messagesLoaded: true })
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof managed>
      piProjectionWrites: Map<string, Promise<void>>
      projectHostRuntimeError: (
        session: typeof managed,
        error: { phase: 'send'; message: string; retryable: boolean },
      ) => Promise<void>
    }
    internals.sessions.set(managed.id, managed)

    await internals.projectHostRuntimeError(managed, {
      phase: 'send', message: 'agent construction failed', retryable: true,
    })
    const fallback = await host.getPiProjectionSnapshot(managed.id)
    expect(fallback).toMatchObject({ runtimeId: 'host:session-1', lastSeq: 1 })
    expect(fallback?.entities).toContainEqual(expect.objectContaining({
      kind: 'runtime_error', payload: expect.objectContaining({ source: 'host' }),
    }))

    const realRuntime = new PiProjectionBuilder(managed.id, 'pi-runtime-1', fallback ?? undefined)
    const turnStart = realRuntime.acceptRuntimeEvent({ type: 'turn_start' })[0]!
    expect(turnStart).toMatchObject({ runtimeId: 'pi-runtime-1', seq: 2 })
    expect(host.applyPiProjectionEvent(turnStart).status).toBe('applied')

    const resumed = await host.getPiProjectionSnapshot(managed.id)
    expect(resumed).toMatchObject({ runtimeId: 'pi-runtime-1', lastSeq: 2 })
    expect(resumed?.entities.map(entity => entity.kind)).toEqual(['runtime_error', 'turn_start'])
    expect(() => host.applyPiProjectionEvent(projectionEvent(3, {
      runtimeId: 'host:session-1', eventId: 'retired-host:3', entityId: 'late-host-error',
      kind: 'runtime_error', entityType: 'conversation', turnId: undefined,
    }))).toThrow('Rejected event from retired Pi projection runtime: host:session-1')
    await internals.piProjectionWrites.get(managed.id)
  })

  it('recovers a queued projection message exactly once after Host restart', async () => {
    const workspace = {
      id: 'workspace-1', name: 'Projection Workspace', rootPath: workspaceRoot, createdAt: Date.now(),
    } as never
    const firstSession = createManagedSession({ craftId: 'session-1' }, workspace, { messagesLoaded: true })
    const firstHost = new SessionManager()
    const firstInternals = firstHost as unknown as {
      sessions: Map<string, typeof firstSession>
      piProjectionWrites: Map<string, Promise<void>>
    }
    firstInternals.sessions.set(firstSession.id, firstSession)
    firstHost.applyPiProjectionEvent(projectionEvent(1, {
      entityId: 'content:user:mutation-1',
      kind: 'user_text',
      payload: {
        role: 'user', text: 'queued after restart', messageId: 'message-1',
        clientMutationId: 'mutation-1', queueStatus: 'queued', source: 'host',
      },
    }))
    await firstInternals.piProjectionWrites.get(firstSession.id)

    const restartedSession = createManagedSession({ craftId: 'session-1' }, workspace, { messagesLoaded: true })
    const restartedHost = new SessionManager()
    ;(restartedHost as unknown as { sessions: Map<string, typeof restartedSession> })
      .sessions.set(restartedSession.id, restartedSession)
    const originalSetImmediate = globalThis.setImmediate
    const scheduled: Array<() => void> = []
    ;(globalThis as typeof globalThis & { setImmediate: typeof setImmediate }).setImmediate = ((callback: () => void) => {
      scheduled.push(callback)
      return 0 as unknown as ReturnType<typeof setImmediate>
    }) as typeof setImmediate

    try {
      await restartedHost.getPiProjectionSnapshot(restartedSession.id)
      await restartedHost.getPiProjectionSnapshot(restartedSession.id)

      expect(restartedSession.messageQueue).toEqual([expect.objectContaining({
        message: 'queued after restart',
        messageId: 'message-1',
        optimisticMessageId: 'message-1',
        options: expect.objectContaining({ optimisticMessageId: 'message-1' }),
      })])
      expect(scheduled).toHaveLength(1)
    } finally {
      globalThis.setImmediate = originalSetImmediate
    }
  })
})
