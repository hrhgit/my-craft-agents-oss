import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PiProjectionEventV1 } from '@mortise/shared/protocol'
import type { Workspace } from '@mortise/core/types'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  createSession,
  getSessionPath,
  loadSession,
  saveSession,
  setSharedPiSessionsDirForTests,
} from '@mortise/shared/sessions'
import { PiProjectionBuilder } from '@mortise/shared/agent/backend'
import type { ConversationProjector } from '../projection'
import { SessionManager, createManagedSession, selectPiProjectionReplaceStrategy } from './SessionManager.ts'

const WORKSPACE_ID = 'workspace-1'

function createTestWorkspace(rootPath: string): Workspace {
  return {
    schemaVersion: 2,
    id: WORKSPACE_ID,
    revision: 0,
    name: 'Projection Workspace',
    nameSource: 'custom',
    slug: 'projection-workspace',
    primaryLocationId: 'primary',
    locations: [{ id: 'primary', name: 'Primary', rootName: 'projection-workspace', endpoint: { kind: 'local', rootPath } }],
    createdAt: Date.now(),
  }
}

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

  it('selects displacement before awaiting Windows replacement of an existing file', () => {
    expect(selectPiProjectionReplaceStrategy('win32', true)).toBe('displace-existing')
    expect(selectPiProjectionReplaceStrategy('win32', false)).toBe('direct')
    expect(selectPiProjectionReplaceStrategy('linux', true)).toBe('direct')
  })

  it('reloads pi-projection-v1.json after the Host restarts', async () => {
    const workspace = createTestWorkspace(workspaceRoot)
    const session = createManagedSession({ mortiseId: 'session-1' }, workspace)
    const firstHost = new SessionManager()
    const firstHostInternals = firstHost as unknown as {
      sessions: Map<string, typeof session>
      piProjectionWrites: Map<string, Promise<void>>
    }
    firstHostInternals.sessions.set(session.id, session)

    expect(firstHost.applyPiProjectionEvent(projectionEvent(1)).status).toBe('applied')
    expect(firstHost.applyPiProjectionEvent(projectionEvent(2)).status).toBe('applied')
    await firstHostInternals.piProjectionWrites.get(session.id)

    const sidecarPath = join(getSessionPath(WORKSPACE_ID, session.id), 'pi-projection-v1.json')
    const persisted = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    expect(persisted.lastSeq).toBe(2)
    expect(persisted.entities.map((entity: { entityId: string }) => entity.entityId))
      .toEqual(['block-1', 'block-2'])

    const restartedHost = new SessionManager()
    const restartedSession = createManagedSession({ mortiseId: 'session-1' }, workspace)
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

  it('closes a crashed running projection at the last complete persisted message', async () => {
    const workspace = createTestWorkspace(workspaceRoot)
    const firstSession = createManagedSession({ mortiseId: 'session-1' }, workspace)
    const firstHost = new SessionManager()
    const firstInternals = firstHost as unknown as {
      sessions: Map<string, typeof firstSession>
      piProjectionWrites: Map<string, Promise<void>>
    }
    firstInternals.sessions.set(firstSession.id, firstSession)

    const startedAt = 1_783_861_200_000
    const lastCompleteAt = startedAt + 20_000
    const incompleteAt = startedAt + 45_000
    const events: PiProjectionEventV1[] = [
      projectionEvent(1, {
        entityId: 'lifecycle:agent_start:1', entityType: 'conversation', turnId: undefined,
        kind: 'agent_start', payload: { status: 'running' }, occurredAt: startedAt,
      }),
      projectionEvent(2, {
        entityId: 'content:user:user-1', kind: 'user_text',
        payload: {
          role: 'user', messageId: 'user-1', text: 'inspect this', streaming: false,
          queueStatus: 'accepted', timestamp: startedAt,
        },
        occurredAt: startedAt,
      }),
      projectionEvent(3, {
        entityId: 'content:text:assistant-complete:0', kind: 'assistant_text',
        payload: {
          role: 'assistant', messageId: 'assistant-complete', contentKind: 'text',
          contentIndex: 0, text: 'Starting the inspection.', streaming: false,
          stopReason: 'toolUse', isIntermediate: true, isFinal: false,
          timestamp: lastCompleteAt,
        },
        occurredAt: lastCompleteAt,
      }),
      projectionEvent(4, {
        entityId: 'turn:turn-2', entityType: 'turn', turnId: 'turn-2',
        kind: 'turn_start', payload: { status: 'running' }, occurredAt: lastCompleteAt + 1,
      }),
      projectionEvent(5, {
        entityId: 'content:thinking:assistant-incomplete:0', kind: 'thinking_end', turnId: 'turn-2',
        payload: {
          role: 'assistant', messageId: 'assistant-incomplete', contentKind: 'thinking',
          contentIndex: 0, text: 'Partial reasoning', streaming: false, timestamp: incompleteAt,
        },
        occurredAt: incompleteAt,
      }),
      projectionEvent(6, {
        entityId: 'content:text:assistant-incomplete:1', kind: 'assistant_text_delta', turnId: 'turn-2',
        payload: {
          role: 'assistant', messageId: 'assistant-incomplete', contentKind: 'text',
          contentIndex: 1, text: 'unfinished', streaming: true, timestamp: incompleteAt,
        },
        occurredAt: incompleteAt,
      }),
    ]
    for (const event of events) expect(firstHost.applyPiProjectionEvent(event).status).toBe('applied')
    await firstInternals.piProjectionWrites.get(firstSession.id)

    const restartedSession = createManagedSession({ mortiseId: 'session-1' }, workspace)
    const restartedHost = new SessionManager()
    const restartedInternals = restartedHost as unknown as {
      sessions: Map<string, typeof restartedSession>
      piProjectionWrites: Map<string, Promise<void>>
    }
    restartedInternals.sessions.set(restartedSession.id, restartedSession)

    const restored = await restartedHost.getPiProjectionSnapshot(restartedSession.id)
    expect(restored?.lastSeq).toBe(8)
    expect(restored?.entities.slice(-2)).toEqual([
      expect.objectContaining({
        kind: 'agent_end', updatedAt: lastCompleteAt,
        payload: expect.objectContaining({ status: 'interrupted', reason: 'host_restart' }),
      }),
      expect.objectContaining({
        kind: 'agent_settled', updatedAt: lastCompleteAt,
        payload: expect.objectContaining({ status: 'interrupted', reason: 'host_restart' }),
      }),
    ])
    await restartedInternals.piProjectionWrites.get(restartedSession.id)
    const persisted = JSON.parse(readFileSync(
      join(getSessionPath(WORKSPACE_ID, restartedSession.id), 'pi-projection-v1.json'),
      'utf8',
    ))
    expect(persisted.entities.at(-1)).toMatchObject({ kind: 'agent_settled', updatedAt: lastCompleteAt })
  })

  it('does not use restart time when a crashed projection has no complete message', async () => {
    const workspace = createTestWorkspace(workspaceRoot)
    const firstSession = createManagedSession({ mortiseId: 'session-1' }, workspace)
    const firstHost = new SessionManager()
    const firstInternals = firstHost as unknown as {
      sessions: Map<string, typeof firstSession>
      piProjectionWrites: Map<string, Promise<void>>
    }
    firstInternals.sessions.set(firstSession.id, firstSession)

    const startedAt = 1_783_861_200_000
    const lastPersistedAt = startedAt + 12_000
    expect(firstHost.applyPiProjectionEvent(projectionEvent(1, {
      entityId: 'lifecycle:agent_start:1', entityType: 'conversation', turnId: undefined,
      kind: 'agent_start', payload: { status: 'running' }, occurredAt: startedAt,
    })).status).toBe('applied')
    expect(firstHost.applyPiProjectionEvent(projectionEvent(2, {
      entityId: 'content:thinking:assistant-incomplete:0', kind: 'thinking_delta',
      payload: {
        role: 'assistant', messageId: 'assistant-incomplete', contentKind: 'thinking',
        contentIndex: 0, text: 'partial', streaming: true, timestamp: lastPersistedAt,
      },
      occurredAt: lastPersistedAt,
    })).status).toBe('applied')
    await firstInternals.piProjectionWrites.get(firstSession.id)

    const restartedSession = createManagedSession({ mortiseId: 'session-1' }, workspace)
    const restartedHost = new SessionManager()
    const restartedInternals = restartedHost as unknown as {
      sessions: Map<string, typeof restartedSession>
      piProjectionWrites: Map<string, Promise<void>>
    }
    restartedInternals.sessions.set(restartedSession.id, restartedSession)

    const restored = await restartedHost.getPiProjectionSnapshot(restartedSession.id)
    expect(restored?.entities.slice(-2)).toEqual([
      expect.objectContaining({ kind: 'agent_end', updatedAt: lastPersistedAt }),
      expect.objectContaining({ kind: 'agent_settled', updatedAt: lastPersistedAt }),
    ])
    await restartedInternals.piProjectionWrites.get(restartedSession.id)
  })

  it('coalesces streaming updates and persists the latest contiguous snapshot', async () => {
    const workspace = createTestWorkspace(workspaceRoot)
    const session = createManagedSession({ mortiseId: 'session-1' }, workspace)
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof session>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(session.id, session)
    for (let seq = 1; seq <= 25; seq++) host.applyPiProjectionEvent(projectionEvent(seq))
    await internals.piProjectionWrites.get(session.id)
    const sidecarPath = join(getSessionPath(WORKSPACE_ID, session.id), 'pi-projection-v1.json')
    const persisted = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    expect(persisted.lastSeq).toBe(25)
    expect(persisted.entities).toHaveLength(25)
  })

  it('atomically replaces an existing projection without leaving write artifacts', async () => {
    const workspace = createTestWorkspace(workspaceRoot)
    const session = createManagedSession({ mortiseId: 'session-1' }, workspace)
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof session>
      flushPiProjectionWrites: (managed: typeof session) => Promise<void>
    }
    internals.sessions.set(session.id, session)

    expect(host.applyPiProjectionEvent(projectionEvent(1)).status).toBe('applied')
    await internals.flushPiProjectionWrites(session)
    expect(host.applyPiProjectionEvent(projectionEvent(2)).status).toBe('applied')
    await internals.flushPiProjectionWrites(session)

    const sessionPath = getSessionPath(WORKSPACE_ID, session.id)
    const persisted = JSON.parse(readFileSync(join(sessionPath, 'pi-projection-v1.json'), 'utf8'))
    expect(persisted.lastSeq).toBe(2)
    expect(readdirSync(sessionPath).filter(name => name.endsWith('.tmp') || name.endsWith('.replaced'))).toEqual([])
  })

  it('propagates projection write failures and retries the retained snapshot', async () => {
    const workspace = createTestWorkspace(workspaceRoot)
    const session = createManagedSession({ mortiseId: 'session-1' }, workspace)
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof session>
      getPiProjectionSnapshotPath: (managed: typeof session) => string
      flushPiProjectionWrites: (managed: typeof session) => Promise<void>
      enqueuePiProjectionPersist: (managed: typeof session, snapshot: ReturnType<ConversationProjector['createSnapshot']>) => void
      piProjectionBySession: Map<string, ConversationProjector>
    }
    internals.sessions.set(session.id, session)

    const blockedParent = join(workspaceRoot, 'blocked-parent')
    writeFileSync(blockedParent, 'not a directory', 'utf8')
    const originalPathResolver = internals.getPiProjectionSnapshotPath.bind(host)
    internals.getPiProjectionSnapshotPath = () => join(blockedParent, 'pi-projection-v1.json')

    expect(host.applyPiProjectionEvent(projectionEvent(1)).status).toBe('applied')
    await expect(internals.flushPiProjectionWrites(session)).rejects.toBeDefined()

    internals.getPiProjectionSnapshotPath = originalPathResolver
    const snapshot = internals.piProjectionBySession.get(session.id)!.createSnapshot()
    internals.enqueuePiProjectionPersist(session, snapshot)
    await internals.flushPiProjectionWrites(session)

    const persisted = JSON.parse(readFileSync(join(getSessionPath(WORKSPACE_ID, session.id), 'pi-projection-v1.json'), 'utf8'))
    expect(persisted.lastSeq).toBe(1)
  })

  it('rebuilds a missing sidecar from the public Pi session projection', async () => {
    const workspace = createTestWorkspace(workspaceRoot)
    const header = await createSession(WORKSPACE_ID, workspaceRoot, { name: 'Pi history' })
    await saveSession({
      ...header,
      messages: [
        { id: 'source-user', type: 'user', content: 'question from Pi', timestamp: 100 },
        { id: 'source-assistant', type: 'assistant', content: 'answer from Pi', timestamp: 101 },
      ],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const managed = createManagedSession(header, workspace, { messagesLoaded: true })
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof managed>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(managed.id, managed)
    const sidecarPath = join(getSessionPath(WORKSPACE_ID, managed.id), 'pi-projection-v1.json')
    expect(existsSync(sidecarPath)).toBe(false)

    const rebuilt = await host.getPiProjectionSnapshot(managed.id)

    expect(rebuilt?.runtimeId).toBe(`history:${managed.id}`)
    expect(rebuilt?.entities).toContainEqual(expect.objectContaining({
      kind: 'user_text', payload: expect.objectContaining({ text: 'question from Pi' }),
    }))
    await internals.piProjectionWrites.get(managed.id)
    expect(JSON.parse(readFileSync(sidecarPath, 'utf8'))).toEqual(rebuilt)
  })

  it('rebuilds a legacy sidecar whose user messages have no wall-clock time', async () => {
    const workspace = createTestWorkspace(workspaceRoot)
    const timestamp = 1_783_861_200_000
    const header = await createSession(WORKSPACE_ID, workspaceRoot, { name: 'Pi history' })
    await saveSession({
      ...header,
      messages: [
        { id: 'source-user', type: 'user', content: 'restore my timestamp', timestamp },
        { id: 'source-assistant', type: 'assistant', content: 'restored', timestamp: timestamp + 1 },
      ],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const managed = createManagedSession(header, workspace, { messagesLoaded: true })
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof managed>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(managed.id, managed)
    const sidecarPath = join(getSessionPath(WORKSPACE_ID, managed.id), 'pi-projection-v1.json')
    mkdirSync(dirname(sidecarPath), { recursive: true })
    writeFileSync(sidecarPath, JSON.stringify({
      schemaVersion: 1,
      sessionId: managed.id,
      runtimeId: `history:${managed.id}`,
      lastSeq: 1,
      entities: [{
        entityId: 'content:user:legacy',
        entityType: 'content_block',
        entityVersion: 1,
        createdSeq: 1,
        kind: 'user_text',
        payload: { role: 'user', messageId: 'legacy', text: 'restore my timestamp', streaming: false },
        lastEventId: 'legacy:1',
        lastSeq: 1,
      }],
    }), 'utf8')

    const rebuilt = await host.getPiProjectionSnapshot(managed.id)
    const user = rebuilt?.entities.find(entity => entity.kind === 'user_text')

    expect(user).toMatchObject({
      createdAt: timestamp,
      payload: expect.objectContaining({ text: 'restore my timestamp', timestamp }),
    })
    await internals.piProjectionWrites.get(managed.id)
    expect(JSON.parse(readFileSync(sidecarPath, 'utf8'))).toEqual(rebuilt)
  })

  it('rebuilds an invalid sidecar from the public Pi session projection', async () => {
    const workspace = createTestWorkspace(workspaceRoot)
    const header = await createSession(WORKSPACE_ID, workspaceRoot, { name: 'Pi history' })
    await saveSession({
      ...header,
      messages: [
        { id: 'source-user', type: 'user', content: 'survives corrupt sidecar', timestamp: 100 },
        { id: 'source-assistant', type: 'assistant', content: 'survives too', timestamp: 101 },
      ],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })

    const managed = createManagedSession(header, workspace, { messagesLoaded: true })
    const host = new SessionManager()
    const internals = host as unknown as {
      sessions: Map<string, typeof managed>
      piProjectionWrites: Map<string, Promise<void>>
    }
    internals.sessions.set(managed.id, managed)
    const sidecarPath = join(getSessionPath(WORKSPACE_ID, managed.id), 'pi-projection-v1.json')
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
    const workspace = createTestWorkspace(workspaceRoot)
    const managed = createManagedSession({ mortiseId: 'session-1' }, workspace, { messagesLoaded: true })
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
    const workspace = createTestWorkspace(workspaceRoot)
    const managed = createManagedSession({ mortiseId: 'session-1' }, workspace, { messagesLoaded: true })
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
    const workspace = createTestWorkspace(workspaceRoot)
    const header = await createSession(WORKSPACE_ID, workspaceRoot, { name: 'Projected metadata' })
    await saveSession({
      ...header,
      messages: [
        { id: 'seed-user', type: 'user', content: 'seed', timestamp: 100 },
        { id: 'seed-assistant', type: 'assistant', content: 'seeded', timestamp: 101 },
      ],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    })
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

    const stored = loadSession(WORKSPACE_ID, managed.id)
    expect(stored).toMatchObject({
      messageCount: 3,
      preview: 'Persisted projection prompt',
      lastMessageRole: 'assistant',
      lastFinalMessageId: 'assistant-final',
      messages: expect.any(Array),
    })

    const restarted = createManagedSession({
      mortiseId: stored!.mortiseId,
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
    const workspace = createTestWorkspace(workspaceRoot)
    const managed = createManagedSession({ mortiseId: 'session-1' }, workspace, { messagesLoaded: true })
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
    const workspace = createTestWorkspace(workspaceRoot)
    const firstSession = createManagedSession({ mortiseId: 'session-1' }, workspace, { messagesLoaded: true })
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

    const restartedSession = createManagedSession({ mortiseId: 'session-1' }, workspace, { messagesLoaded: true })
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
