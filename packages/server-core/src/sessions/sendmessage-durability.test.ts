import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { SessionManager as PiSessionManager } from '@mortise/pi-coding-agent/host-facade'
import type { AgentBackend } from '@mortise/shared/agent/backend'
import type { Workspace } from '@mortise/core/types'
import { getSessionAttachmentsPath, getSessionFilePath, getSessionPath, readSessionJsonl, setSharedPiSessionsDirForTests } from '@mortise/shared/sessions'
import {
  SessionManager,
  SessionProjectionPersistenceError,
  SessionSendDurabilityError,
  SessionSettlementDurabilityError,
  createManagedSession,
  type SessionBackendFactory,
} from './SessionManager.ts'

// Regression test for the High-severity finding in eb81086e, adapted for
// Pi-first transcript ownership:
//
//   sendMessage's `{ accepted, messageId }` ack contract must not return before
//   the Mortise-owned attachment/badge overlay hits disk. A crash inside the
//   persistence debounce window would otherwise lose its Pi message identity.
//
// The fix added `await this.flushSession(managed.id)` between persistSession
// and onAck. This test locks that ordering by reading the session file from
// inside the onAck callback and asserting the user message is already there.

describe('sendMessage durability', () => {
  let tmpRoot: string
  let sm: SessionManager
  let testWorkspace: Workspace

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-durability-'))
    setSharedPiSessionsDirForTests(join(tmpRoot, 'pi-sessions'))
    testWorkspace = {
      schemaVersion: 2,
      id: 'ws_test',
      revision: 0,
      name: 'Test Workspace',
      nameSource: 'custom',
      slug: 'test-workspace',
      primaryLocationId: 'primary',
      locations: [{ id: 'primary', name: 'Primary', rootName: 'test-workspace', endpoint: { kind: 'local', rootPath: tmpRoot } }],
      createdAt: Date.now(),
    }
    sm = new SessionManager({
      resolveWorkspaceByNameOrId: workspaceId => workspaceId === testWorkspace.id ? testWorkspace : null,
    })
  })

  afterEach(async () => {
    await sm.flushAllSessions()
    const projectionWrites = [
      ...(sm as unknown as { piProjectionWrites: Map<string, Promise<void>> }).piProjectionWrites.values(),
    ]
    await Promise.all(projectionWrites)
    mock.restore()
    setSharedPiSessionsDirForTests(undefined)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const managed = createManagedSession(
      { mortiseId: id, name: 'durability test' },
      testWorkspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  async function publishExistingSession(id: string): Promise<void> {
    const piSession = PiSessionManager.create(
      tmpRoot,
      dirname(getSessionFilePath(testWorkspace.id, id, Date.now())),
      { id },
    )
    piSession.appendMessage({ role: 'user', content: 'seed', timestamp: Date.now() })
    piSession.appendMessage({
      role: 'assistant',
      api: 'openai-completions',
      content: [{ type: 'text', text: 'seeded' }],
      timestamp: Date.now() + 1,
      provider: 'test',
      model: 'pi-validation-model',
      stopReason: 'stop',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })
    await piSession.flush()
  }

  function readPersistedMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(testWorkspace.id, sessionId)
    const ids = new Set<string>()
    if (existsSync(path)) {
      for (const message of readSessionJsonl(path)?.messages ?? []) {
        ids.add(message.id)
      }
    }

    // In Pi tree mode, Mortise persists pre-Pi user message IDs in the sidecar
    // overlay while Pi owns the canonical transcript body.
    const overlayPath = join(getSessionPath(testWorkspace.id, sessionId), 'overlay.json')
    if (existsSync(overlayPath)) {
      const overlay = JSON.parse(readFileSync(overlayPath, 'utf-8')) as { messages?: Array<{ id?: unknown }> }
      for (const message of overlay.messages ?? []) {
        if (typeof message.id === 'string') ids.add(message.id)
      }
    }

    return [...ids]
  }

  function readPersistedQueuedMessageIds(sessionId: string): string[] {
    const path = join(getSessionPath(testWorkspace.id, sessionId), 'pi-projection-v1.json')
    if (!existsSync(path)) return []
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as {
      entities?: Array<{ kind?: unknown; payload?: { messageId?: unknown; queueStatus?: unknown } }>
    }
    return snapshot.entities?.flatMap(entity => (
      entity.kind === 'user_text'
        && entity.payload?.queueStatus === 'queued'
        && typeof entity.payload.messageId === 'string'
        ? [entity.payload.messageId]
        : []
    )) ?? []
  }

  const overlayOptions = {
    badges: [{ type: 'skill' as const, label: 'Linear', rawText: '@linear', start: 0, end: 7 }],
  }

  function createInjectedAgent(
    sessionId: string,
    chat: AgentBackend['chat'],
  ): AgentBackend {
    return {
      supportsBranching: true,
      chat,
      postInit: async () => ({ authInjected: false }),
      ensureBranchReady: async () => undefined,
      getModel: () => 'pi-validation-model',
      setModel: () => undefined,
      getThinkingLevel: () => 'medium',
      setThinkingLevel: () => undefined,
      getPermissionMode: () => 'ask',
      getSessionId: () => sessionId,
      setSessionId: () => undefined,
      isProcessing: () => false,
      abort: async () => undefined,
      forceAbort: () => undefined,
      interruptForHandoff: () => undefined,
      redirect: () => false,
      followUp: async () => false,
      runMiniCompletion: async () => null,
      runIsolatedAgent: async () => null,
      dispose: () => undefined,
      destroy: () => undefined,
      respondToPermission: () => undefined,
      setPermissionMode: () => undefined,
      cyclePermissionMode: () => 'ask',
      updateRuntimeConfig: async () => false,
      projectQueuedUser: () => undefined,
      projectRuntimeError: () => undefined,
      getSummarizeCallback: () => async () => null,
      updateSdkCwd: () => undefined,
      setWorkspace: () => undefined,
      generateTitle: async () => null,
      regenerateTitle: async () => null,
      sendExtensionCommandInvoke: async () => ({ invoked: false, customMessages: [] }),
      onPermissionRequest: null,
      onPlanSubmitted: null,
      onPermissionModeChange: null,
      onDebug: null,
      onBackendAuthRequired: null,
      onSpawnSession: null,
    }
  }

  function installFirstAssistantAgent(managed: ReturnType<typeof createManagedSession>, sessionId: string): string {
    const sessionFile = getSessionFilePath(testWorkspace.id, sessionId, Date.now())
    const fakeAgent = {
      getModel: () => 'pi-test-model',
      setAllSources: mock(() => undefined),
      getSessionId: () => sessionId,
      abort: mock(async () => undefined),
      dispose: mock(() => undefined),
      chat: mock(async function* () {
        const timestamp = new Date().toISOString()
        writeFileSync(sessionFile, [
          JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp, cwd: tmpRoot }),
          JSON.stringify({
            type: 'message', id: 'user-entry', parentId: null, timestamp,
            message: { role: 'user', content: [{ type: 'text', text: 'first real message' }], timestamp: Date.now() },
          }),
          JSON.stringify({
            type: 'message', id: 'assistant-entry', parentId: 'user-entry', timestamp,
            message: {
              role: 'assistant', content: [{ type: 'text', text: 'first answer' }], timestamp: Date.now(),
              provider: 'test', model: 'pi-test-model', stopReason: 'stop',
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
            },
          }),
        ].join('\n') + '\n')
        yield { type: 'text_complete', text: 'first answer', isIntermediate: false, turnId: 'turn-1' } as const
        yield { type: 'complete' } as const
      }),
    }
    managed.agent = fakeAgent as never
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = mock(async () => fakeAgent)
    return sessionFile
  }

  it('user overlay is on disk before onAck fires (normal branch)', async () => {
    const sessionId = 'durability-normal'
    const managed = buildSession(sessionId)
    await publishExistingSession(sessionId)
    const fakeAgent = createInjectedAgent(sessionId, async function* () {
      yield { type: 'pi_user_message_persisted' }
      yield { type: 'complete' }
    })
    managed.agent = fakeAgent
    ;(sm as unknown as { getOrCreateAgent: () => Promise<AgentBackend> }).getOrCreateAgent = mock(async () => fakeAgent)

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    await sm.sendMessage(
        sessionId,
        'hello',
        undefined,
        undefined,
        overlayOptions,
        undefined,
        undefined,
        (messageId) => {
          ackedMessageId = messageId
          onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
        },
      )

    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })

  it('abandons a provisional new session when runtime startup fails before an assistant message', async () => {
    const sessionId = 'provisional-session-failure'
    const managed = buildSession(sessionId)
    managed.publicationState = 'provisional'
    const events: unknown[] = []
    let acked = false
    sm.setEventSink((_channel, _target, event) => events.push(event))
    expect(sm.getSessions('ws_test')).toEqual([])

    await expect(sm.sendMessage(
      sessionId,
      'first real message',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        acked = true
      },
    )).rejects.toThrow('setSessionPlatform() must be called before session creation')

    expect(acked).toBe(false)
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(sessionId)).toBe(false)
    expect(existsSync(getSessionFilePath(testWorkspace.id, sessionId))).toBe(false)
    // Provider/title resolution can happen during startup, but a failed first
    // turn has never become a Session and must not leak any session-scoped
    // renderer event. Global unread summaries may still be recomputed.
    expect(events.filter(event => (
      (event as { sessionId?: unknown }).sessionId === sessionId
    ))).toEqual([])
  })

  it('publishes a provisional session only after Pi atomically writes the first assistant message', async () => {
    const sessionId = 'provisional-first-assistant'
    const managed = buildSession(sessionId)
    managed.publicationState = 'provisional'
    const events: unknown[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))
    expect(sm.getSessions('ws_test')).toEqual([])

    const sessionFile = getSessionFilePath(testWorkspace.id, sessionId, Date.now())
    const fakeAgent = {
      getModel: () => 'pi-test-model',
      setAllSources: mock(() => undefined),
      getSessionId: () => sessionId,
      chat: mock(async function* () {
        const timestamp = new Date().toISOString()
        writeFileSync(sessionFile, [
          JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp, cwd: tmpRoot }),
          JSON.stringify({
            type: 'message', id: 'user-entry', parentId: null, timestamp,
            message: { role: 'user', content: [{ type: 'text', text: 'first real message' }], timestamp: Date.now() },
          }),
          JSON.stringify({
            type: 'message', id: 'assistant-entry', parentId: 'user-entry', timestamp,
            message: {
              role: 'assistant', content: [{ type: 'text', text: 'first answer' }], timestamp: Date.now(),
              provider: 'test', model: 'pi-test-model', stopReason: 'stop',
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
            },
          }),
        ].join('\n') + '\n')
        yield { type: 'text_complete', text: 'first answer', isIntermediate: false, turnId: 'turn-1' } as const
        yield { type: 'complete' } as const
      }),
    }
    managed.agent = fakeAgent as never
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = mock(async () => fakeAgent)

    let persistedAssistantAtAck = false
    await sm.sendMessage(
      sessionId,
      'first real message',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        persistedAssistantAtAck = readSessionJsonl(sessionFile)?.messages.some(
          message => message.type === 'assistant',
        ) ?? false
      },
    )

    expect(persistedAssistantAtAck).toBe(true)
    expect(managed.publicationState).toBeUndefined()
    expect(sm.getSessions('ws_test').map(session => session.id)).toContain(sessionId)
    expect(events).toContainEqual({ type: 'session_created', sessionId })
    expect(events.findIndex(event => (event as { type?: string }).type === 'session_created')).toBeLessThan(
      events.findIndex(event => (event as { type?: string }).type === 'complete'),
    )
  })

  it('uses an injected backend factory without bypassing first-turn abandonment', async () => {
    let provisionalId = ''
    let factoryProvisional: boolean | undefined
    const createSessionBackend = mock((args: Parameters<SessionBackendFactory>[0]) => {
      provisionalId = args.coreConfig.session!.mortiseId
      factoryProvisional = args.provisional
      return createInjectedAgent(provisionalId, async function* () {
        throw new Error('deterministic pre-assistant failure')
      })
    })
    sm = new SessionManager({
      resolveWorkspaceByNameOrId: workspaceId => workspaceId === testWorkspace.id ? testWorkspace : null,
      createSessionBackend,
    })

    await expect(sm.createAndSendFirstTurn({
      workspaceId: testWorkspace.id,
      message: 'first real message',
    })).rejects.toThrow('deterministic pre-assistant failure')

    expect(createSessionBackend).toHaveBeenCalledTimes(1)
    expect(factoryProvisional).toBe(true)
    expect(provisionalId).not.toBe('')
    expect(sm.getSessions(testWorkspace.id)).toEqual([])
    expect(existsSync(getSessionFilePath(testWorkspace.id, provisionalId))).toBe(false)
    expect(existsSync(getSessionPath(testWorkspace.id, provisionalId))).toBe(false)
  })

  it('marks an ordinary Session backend construction as non-provisional', async () => {
    let factoryProvisional: boolean | undefined
    const createSessionBackend = mock((args: Parameters<SessionBackendFactory>[0]) => {
      factoryProvisional = args.provisional
      return createInjectedAgent(args.coreConfig.session!.mortiseId, async function* () {
        yield { type: 'complete' }
      })
    })
    sm = new SessionManager({
      resolveWorkspaceByNameOrId: workspaceId => workspaceId === testWorkspace.id ? testWorkspace : null,
      createSessionBackend,
    })

    const session = await sm.createSession(testWorkspace.id, { hidden: true })
    const managed = (sm as unknown as {
      sessions: Map<string, ReturnType<typeof createManagedSession>>
      getOrCreateAgent: (session: ReturnType<typeof createManagedSession>) => Promise<AgentBackend>
    }).sessions.get(session.id)!
    await (sm as unknown as {
      getOrCreateAgent: (session: ReturnType<typeof createManagedSession>) => Promise<AgentBackend>
    }).getOrCreateAgent(managed)

    expect(createSessionBackend).toHaveBeenCalledTimes(1)
    expect(factoryProvisional).toBe(false)
  })

  it('publishes an injected backend first turn through Pi atomic persistence', async () => {
    let provisionalId = ''
    let sessionFile = ''
    let fileExistedBeforeAssistant = true
    const createSessionBackend = mock((args: Parameters<SessionBackendFactory>[0]) => {
      provisionalId = args.coreConfig.session!.mortiseId
      const piSession = PiSessionManager.create(
        tmpRoot,
        dirname(getSessionFilePath(testWorkspace.id, provisionalId, Date.now())),
        { id: provisionalId },
      )
      sessionFile = piSession.getSessionFile()!
      return createInjectedAgent(provisionalId, async function* (message) {
        piSession.appendMessage({ role: 'user', content: [{ type: 'text', text: message }], timestamp: Date.now() })
        fileExistedBeforeAssistant = existsSync(sessionFile)
        piSession.appendMessage({
          role: 'assistant',
          api: 'openai-completions',
          content: [{ type: 'text', text: 'deterministic first answer' }],
          timestamp: Date.now(),
          provider: 'test',
          model: 'pi-validation-model',
          stopReason: 'stop',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        })
        await piSession.flush()
        yield { type: 'text_complete', text: 'deterministic first answer', isIntermediate: false }
        yield { type: 'complete' }
      })
    })
    sm = new SessionManager({
      resolveWorkspaceByNameOrId: workspaceId => workspaceId === testWorkspace.id ? testWorkspace : null,
      createSessionBackend,
    })

    const result = await sm.createAndSendFirstTurn({
      workspaceId: testWorkspace.id,
      message: 'first real message',
      createOptions: { permissionMode: 'allow-all' },
    })

    expect(createSessionBackend).toHaveBeenCalledTimes(1)
    expect(fileExistedBeforeAssistant).toBe(false)
    expect(existsSync(sessionFile)).toBe(true)
    expect(result.session.id).toBe(provisionalId)
    expect(sm.getSessions(testWorkspace.id).map(session => session.id)).toEqual([provisionalId])
    expect(readSessionJsonl(sessionFile)?.messages.map(message => message.type)).toEqual(['user', 'assistant'])
  })

  it('abandons createAndSendFirstTurn after a real publication metadata filesystem failure', async () => {
    const events: unknown[] = []
    let provisionalId = ''
    let sessionFile = ''
    sm.setEventSink((_channel, _target, event) => events.push(event))

    const result = sm.createAndSendFirstTurn({
      workspaceId: testWorkspace.id,
      message: 'first real message',
      createOptions: { name: 'Metadata failure' },
    }, managed => {
      provisionalId = managed.id
      sessionFile = installFirstAssistantAgent(managed, managed.id)
      // A file at the Session sidecar path makes ensureSessionDir fail with a
      // real EEXIST/ENOTDIR error while Pi's canonical JSONL remains writable.
      const blockedSessionPath = getSessionPath(testWorkspace.id, managed.id)
      mkdirSync(dirname(blockedSessionPath), { recursive: true })
      writeFileSync(blockedSessionPath, 'blocked Session directory', 'utf8')
    })

    await expect(result).rejects.toMatchObject({
      name: 'SessionPublicationDurabilityError',
      code: 'SESSION_PUBLICATION_DURABILITY_FAILED',
      retryable: true,
      terminal: true,
      outcome: 'unpublished',
      stage: 'metadata',
    })
    expect(provisionalId).not.toBe('')
    expect(sm.getSessions(testWorkspace.id)).toEqual([])
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(provisionalId)).toBe(false)
    expect(events.filter(event => (
      (event as { sessionId?: unknown }).sessionId === provisionalId
    ))).toEqual([])
    expect(existsSync(sessionFile)).toBe(false)
    expect(existsSync(getSessionPath(testWorkspace.id, provisionalId))).toBe(false)
  })

  it('abandons first-turn publication when the overlay atomic rename fails', async () => {
    const events: unknown[] = []
    let provisionalId = ''
    let sessionFile = ''
    sm.setEventSink((_channel, _target, event) => events.push(event))

    const result = sm.createAndSendFirstTurn({
      workspaceId: testWorkspace.id,
      message: 'first real message',
      createOptions: { name: 'Overlay failure' },
      sendOptions: overlayOptions,
    }, managed => {
      provisionalId = managed.id
      sessionFile = installFirstAssistantAgent(managed, managed.id)
      mkdirSync(join(getSessionPath(testWorkspace.id, managed.id), 'overlay.json'), { recursive: true })
    })

    await expect(result).rejects.toMatchObject({
      name: 'SessionPublicationDurabilityError',
      code: 'SESSION_PUBLICATION_DURABILITY_FAILED',
      retryable: true,
      terminal: true,
      outcome: 'unpublished',
      stage: 'metadata',
      cause: expect.objectContaining({
        name: 'SessionPersistenceError',
        code: 'SESSION_PERSISTENCE_FAILED',
      }),
    })
    expect(provisionalId).not.toBe('')
    expect(sm.getSessions(testWorkspace.id)).toEqual([])
    expect(events.filter(event => (
      (event as { sessionId?: unknown }).sessionId === provisionalId
    ))).toEqual([])
    expect(existsSync(sessionFile)).toBe(false)
    expect(existsSync(getSessionPath(testWorkspace.id, provisionalId))).toBe(false)
  })

  it('abandons createAndSendFirstTurn after a real projection rename failure', async () => {
    const events: unknown[] = []
    let provisionalId = ''
    let sessionFile = ''
    sm.setEventSink((_channel, _target, event) => events.push(event))

    const result = sm.createAndSendFirstTurn({
      workspaceId: testWorkspace.id,
      message: 'first real message',
      createOptions: { name: 'Projection failure' },
    }, managed => {
      provisionalId = managed.id
      sessionFile = installFirstAssistantAgent(managed, managed.id)
      sm.applyPiProjectionEvent({
        schemaVersion: 1,
        eventId: 'publication-projection-event',
        seq: 1,
        sessionId: managed.id,
        runtimeId: 'runtime-publication-test',
        entityId: 'content:user:first-turn',
        entityType: 'content_block',
        entityVersion: 1,
        kind: 'user_text',
        occurredAt: Date.now(),
        payload: {
          role: 'user',
          text: 'first real message',
          messageId: 'first-turn',
          clientMutationId: 'first-turn',
          queueStatus: 'sent',
          source: 'pi',
          timestamp: Date.now(),
        },
      })
      // rename(temp, target) cannot replace a directory. This exercises the
      // actual projection writer and its retained retry snapshot.
      mkdirSync(join(getSessionPath(testWorkspace.id, managed.id), 'pi-projection-v1.json'), { recursive: true })
    })

    await expect(result).rejects.toMatchObject({
      name: 'SessionPublicationDurabilityError',
      code: 'SESSION_PUBLICATION_DURABILITY_FAILED',
      retryable: true,
      terminal: true,
      outcome: 'unpublished',
      stage: 'projection',
      cause: expect.objectContaining({
        name: 'SessionProjectionPersistenceError',
        code: 'SESSION_PROJECTION_PERSISTENCE_FAILED',
        retryable: true,
      }),
    })
    expect(provisionalId).not.toBe('')
    expect(sm.getSessions(testWorkspace.id)).toEqual([])
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(provisionalId)).toBe(false)
    expect(events.filter(event => (
      (event as { sessionId?: unknown }).sessionId === provisionalId
    ))).toEqual([])
    expect(existsSync(sessionFile)).toBe(false)
    expect(existsSync(getSessionPath(testWorkspace.id, provisionalId))).toBe(false)
  })

  it('abandons a provisional Session with a failed projection retry during shutdown', async () => {
    const sessionId = 'provisional-shutdown-projection-failure'
    const managed = buildSession(sessionId)
    managed.publicationState = 'provisional'
    const sessionPath = getSessionPath(testWorkspace.id, sessionId)
    mkdirSync(join(sessionPath, 'pi-projection-v1.json'), { recursive: true })
    const snapshot = {
      schemaVersion: 1,
      sessionId,
      runtimeId: 'shutdown-fault-runtime',
      lastSeq: 0,
      entities: [],
    } as never
    const internals = sm as unknown as {
      enqueuePiProjectionPersist: (session: typeof managed, value: typeof snapshot) => void
      piProjectionWrites: Map<string, Promise<void>>
      piProjectionWriteErrors: Map<string, unknown>
    }

    internals.enqueuePiProjectionPersist(managed, snapshot)
    await internals.piProjectionWrites.get(sessionId)
    expect(internals.piProjectionWriteErrors.get(sessionId)).toBeInstanceOf(SessionProjectionPersistenceError)

    await expect(sm.cleanup()).resolves.toBeUndefined()

    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(sessionId)).toBe(false)
    expect(existsSync(sessionPath)).toBe(false)
  })

  it('makes abandonment terminal before a late assistant can publish', async () => {
    const sessionId = 'provisional-abort-race'
    const managed = buildSession(sessionId)
    managed.publicationState = 'provisional'
    const abortGate = Promise.withResolvers<void>()
    managed.agent = {
      abort: mock(async () => abortGate.promise),
      dispose: mock(() => undefined),
    } as never
    const events: unknown[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    const abandoning = (sm as unknown as {
      abandonProvisionalSession: (managed: ReturnType<typeof createManagedSession>, reason: string) => Promise<void>
    }).abandonProvisionalSession(managed, 'transport timeout')
    expect((managed as { publicationState?: string }).publicationState).toBe('abandoning')

    const timestamp = new Date().toISOString()
    const sessionFile = getSessionFilePath(testWorkspace.id, sessionId, Date.now())
    writeFileSync(sessionFile, [
      JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp, cwd: tmpRoot }),
      JSON.stringify({
        type: 'message', id: 'assistant-late', parentId: null, timestamp,
        message: {
          role: 'assistant', content: [{ type: 'text', text: 'too late' }], timestamp: Date.now(),
          provider: 'test', model: 'pi-test-model', stopReason: 'stop',
          usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { total: 0 } },
        },
      }),
    ].join('\n') + '\n')

    await expect((sm as unknown as {
      publishProvisionalSessionIfReady: (managed: ReturnType<typeof createManagedSession>) => Promise<boolean>
    }).publishProvisionalSessionIfReady(managed)).resolves.toBe(false)
    abortGate.resolve()
    await abandoning

    expect(events).not.toContainEqual({ type: 'session_created', sessionId })
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has(sessionId)).toBe(false)
    expect(existsSync(sessionFile)).toBe(false)
  })

  it('keeps permanently hidden sessions hidden after their first message', async () => {
    const sessionId = 'permanently-hidden-session'
    const managed = buildSession(sessionId)
    managed.hidden = true
    const events: unknown[] = []
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await sm.sendMessage(sessionId, 'internal message').catch(() => {
      // This focused harness does not start a runtime; visibility changes happen
      // before the post-ack runtime work.
    })

    expect(managed.hidden).toBe(true)
    expect(events).not.toContainEqual({ type: 'session_created', sessionId })
  })

  it('adopts first-turn attachment staging without exposing the staging identity', async () => {
    const sessionId = 'attachment-publication-target'
    buildSession(sessionId)
    const stagingId = `draft-${randomUUID()}`
    const stagingAttachments = getSessionAttachmentsPath(testWorkspace.id, stagingId)
    const targetAttachments = getSessionAttachmentsPath(testWorkspace.id, sessionId)
    const sourcePath = join(stagingAttachments, 'document.txt')
    const markdownPath = join(stagingAttachments, 'document.md')
    mkdirSync(stagingAttachments, { recursive: true })
    writeFileSync(sourcePath, 'source')
    writeFileSync(markdownPath, 'markdown')

    const adopted = await (sm as unknown as {
      adoptFirstTurnAttachmentStaging: (
        session: { id: string; workspaceId: string },
        stagingId: string,
        attachments: Array<{ name: string; path: string; storedPath: string; markdownPath: string }>,
        storedAttachments: Array<{ id: string; name: string; mimeType: string; size: number; storedPath: string; markdownPath: string }>,
      ) => Promise<{
        attachments: Array<{ path: string; storedPath: string; markdownPath: string }>
        storedAttachments: Array<{ storedPath: string; markdownPath: string }>
      }>
    }).adoptFirstTurnAttachmentStaging(
      { id: sessionId, workspaceId: 'ws_test' },
      stagingId,
      [{ name: 'document.txt', path: sourcePath, storedPath: sourcePath, markdownPath }],
      [{ id: 'attachment-1', name: 'document.txt', mimeType: 'text/plain', size: 6, storedPath: sourcePath, markdownPath }],
    )

    expect(existsSync(getSessionPath(testWorkspace.id, stagingId))).toBe(false)
    expect(readFileSync(join(targetAttachments, 'document.txt'), 'utf8')).toBe('source')
    expect(adopted.attachments[0].storedPath).toBe(join(targetAttachments, 'document.txt'))
    expect(adopted.attachments[0].markdownPath).toBe(join(targetAttachments, 'document.md'))
    expect(adopted.attachments[0].path).toBe(join(targetAttachments, 'document.txt'))
    expect(adopted.storedAttachments[0].storedPath).toBe(join(targetAttachments, 'document.txt'))
  })

  it('rejects first-turn attachment paths outside staging', async () => {
    const sessionId = 'attachment-path-rejection'
    buildSession(sessionId)
    const stagingId = `draft-${randomUUID()}`
    const stagingAttachments = getSessionAttachmentsPath(testWorkspace.id, stagingId)
    mkdirSync(stagingAttachments, { recursive: true })
    const outsidePath = join(tmpRoot, 'outside.txt')
    writeFileSync(outsidePath, 'outside')

    await expect((sm as unknown as {
      adoptFirstTurnAttachmentStaging: (
        session: { id: string; workspaceId: string },
        stagingId: string,
        attachments: Array<{ name: string; path: string; storedPath: string }>,
        storedAttachments: Array<{ id: string; name: string; mimeType: string; size: number; storedPath: string }>,
      ) => Promise<unknown>
    }).adoptFirstTurnAttachmentStaging(
      { id: sessionId, workspaceId: 'ws_test' },
      stagingId,
      [{ name: 'outside.txt', path: outsidePath, storedPath: outsidePath }],
      [{ id: 'attachment-2', name: 'outside.txt', mimeType: 'text/plain', size: 7, storedPath: outsidePath }],
    )).rejects.toThrow('outside first-turn staging')

    expect(existsSync(stagingAttachments)).toBe(true)
  })

  it('acks only after Pi confirms canonical user-message persistence', async () => {
    const sessionId = 'durability-ack-before-pi-runtime'
    const managed = buildSession(sessionId)

    let agentInitStarted = false
    let persistenceConfirmed = false
    let ackedAfterPersistence = false
    const fakeAgent = createInjectedAgent(sessionId, async function* () {
      persistenceConfirmed = true
      yield { type: 'pi_user_message_persisted' }
      yield { type: 'complete' }
    })
    managed.agent = fakeAgent
    ;(sm as unknown as { getOrCreateAgent: () => Promise<AgentBackend> }).getOrCreateAgent = mock(async () => {
      agentInitStarted = true
      return fakeAgent
    })

    await sm.sendMessage(
      sessionId,
      'hello before pi runtime',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        ackedAfterPersistence = agentInitStarted && persistenceConfirmed
      },
    )

    expect(ackedAfterPersistence).toBe(true)
  })

  it('does not ack when Pi completes without confirming canonical user persistence', async () => {
    const sessionId = 'durability-complete-before-user-persisted'
    const managed = buildSession(sessionId)
    const fakeAgent = createInjectedAgent(sessionId, async function* () {
      yield { type: 'complete' }
    })
    managed.agent = fakeAgent
    ;(sm as unknown as { getOrCreateAgent: () => Promise<AgentBackend> }).getOrCreateAgent = mock(async () => fakeAgent)
    let acked = false

    await expect(sm.sendMessage(
      sessionId,
      'must be durable before ack',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => { acked = true },
    )).rejects.toMatchObject({
      name: 'SessionSendDurabilityError',
      code: 'SESSION_PERSISTENCE_FAILED',
      retryable: true,
      terminal: true,
      outcome: 'unaccepted',
    })
    expect(acked).toBe(false)
  })

  it('user overlay is on disk before onAck fires (mid-stream / queued branch)', async () => {
    const sessionId = 'durability-midstream'
    const managed = buildSession(sessionId)
    await publishExistingSession(sessionId)
    // Force the mid-stream branch. The fake runtime declines redirect so the
    // durable Host queue projection path runs.
    managed.isProcessing = true
    const projectQueuedUser = mock((input: {
      message: string
      clientMutationId: string
      messageId?: string
      timestamp?: number
    }) => {
      sm.applyPiProjectionEvent({
        schemaVersion: 1,
        eventId: 'queued-event-1',
        seq: 1,
        sessionId,
        runtimeId: 'runtime-1',
        entityId: `content:user:${input.clientMutationId}`,
        entityType: 'content_block',
        entityVersion: 1,
        kind: 'user_text',
        occurredAt: input.timestamp,
        payload: {
          role: 'user',
          text: input.message,
          messageId: input.messageId ?? input.clientMutationId,
          clientMutationId: input.clientMutationId,
          queueStatus: 'queued',
          source: 'host',
          timestamp: input.timestamp,
        },
      })
    })
    const followUp = mock(() => false)
    managed.agent = { redirect: () => false, followUp, projectQueuedUser } as never

    let ackedMessageId: string | null = null
    let onDiskAtAck = false
    let projectionOnDiskAtAck = false

    await sm.sendMessage(
      sessionId,
      'queued message',
      undefined,
      undefined,
      overlayOptions,
      undefined,
      undefined,
      (messageId) => {
        ackedMessageId = messageId
        onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
        projectionOnDiskAtAck = readPersistedQueuedMessageIds(sessionId).includes(messageId)
      },
    )

    expect(projectQueuedUser).toHaveBeenCalledTimes(1)
    expect(followUp).toHaveBeenCalledTimes(1)
    expect(managed.messageQueue).toHaveLength(1)
    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
    expect(projectionOnDiskAtAck).toBe(true)
  })

  it('uses native follow-up without adding a host replay queue entry', async () => {
    const sessionId = 'durability-native-follow-up'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    const followUp = mock(() => true)
    const projectQueuedUser = mock((input: { message: string; clientMutationId: string; messageId?: string; timestamp?: number }) => {
      sm.applyPiProjectionEvent({
        schemaVersion: 1,
        eventId: 'native-follow-up-event',
        seq: 1,
        sessionId,
        runtimeId: 'runtime-1',
        entityId: `content:user:${input.clientMutationId}`,
        entityType: 'content_block',
        entityVersion: 1,
        kind: 'user_text',
        occurredAt: input.timestamp,
        payload: {
          role: 'user', text: input.message,
          messageId: input.messageId ?? input.clientMutationId,
          clientMutationId: input.clientMutationId,
          queueStatus: 'queued', source: 'host', timestamp: input.timestamp,
        },
      })
    })
    managed.agent = { followUp, projectQueuedUser } as never

    await sm.sendMessage(sessionId, 'native queued message')

    expect(followUp).toHaveBeenCalledTimes(1)
    expect(projectQueuedUser).toHaveBeenCalledTimes(1)
    expect(managed.messageQueue).toHaveLength(0)
    expect(managed.wasInterrupted).not.toBe(true)
  })

  it('falls back to the durable host queue when native follow-up is rejected', async () => {
    const sessionId = 'durability-native-follow-up-rejected'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    const followUp = mock(async () => { throw new Error('Pi runtime settled before follow-up') })
    managed.agent = { followUp, projectQueuedUser: mock(() => undefined) } as never

    await sm.sendMessage(sessionId, 'fallback queued message')

    expect(followUp).toHaveBeenCalledTimes(1)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.message).toBe('fallback queued message')
  })

  it('passes native follow-up attachments through the backend contract', async () => {
    const sessionId = 'durability-native-follow-up-attachments'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    const attachment = {
      type: 'image', path: 'C:/tmp/image.png', name: 'image.png', mimeType: 'image/png',
      base64: 'aW1hZ2U=', size: 5,
    }
    const stored = { id: 'attachment-1', name: 'image.png', mimeType: 'image/png', size: 5, originalSize: 5 }
    const followUp = mock(async (_message: string, attachments?: unknown[], options?: { attachmentRefs?: unknown[] }) => {
      expect(attachments).toHaveLength(1)
      expect(options?.attachmentRefs).toEqual([
        expect.objectContaining({ id: 'attachment-1', name: 'image.png', mediaType: 'image/png' }),
      ])
      return true
    })
    managed.agent = { followUp, projectQueuedUser: mock(() => undefined) } as never

    await sm.sendMessage(sessionId, 'inspect image', [attachment as never], [stored as never])

    expect(followUp).toHaveBeenCalledTimes(1)
    expect(managed.messageQueue).toHaveLength(0)
  })

  it('settles a terminal complete after a stop request as interrupted', async () => {
    const sessionId = 'durability-stop-settlement'
    const managed = buildSession(sessionId)
    const originalOnProcessingStopped = (sm as unknown as {
      onProcessingStopped: (id: string, reason: 'complete' | 'interrupted' | 'error' | 'timeout') => Promise<void>
    }).onProcessingStopped.bind(sm)
    const stopped = mock(originalOnProcessingStopped)
    ;(sm as unknown as { onProcessingStopped: typeof stopped }).onProcessingStopped = stopped
    const fakeAgent = {
      getModel: () => 'pi-test-model',
      setAllSources: mock(() => undefined),
      getSessionId: () => null,
      chat: mock(async function* () {
        yield { type: 'complete' } as const
      }),
    }
    managed.agent = fakeAgent as never
    managed.stopRequested = true
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = mock(async () => fakeAgent)

    await sm.sendMessage(sessionId, 'stop race')

    expect(stopped).toHaveBeenCalledTimes(1)
    expect(stopped).toHaveBeenCalledWith(sessionId, 'interrupted')
  })

  it('awaits metadata and projection durability before exposing turn completion', async () => {
    const sessionId = 'durability-settlement-order'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    const metadataGate = Promise.withResolvers<void>()
    const projectionGate = Promise.withResolvers<void>()
    const order: string[] = []
    sm.setEventSink((_channel, _target, event) => {
      if ((event as { type?: string }).type === 'complete') order.push('complete')
    })
    sm.flushSession = async () => {
      order.push('metadata:start')
      await metadataGate.promise
      order.push('metadata:end')
    }
    const internals = sm as unknown as {
      flushPiProjectionWrites: (session: typeof managed) => Promise<void>
      onProcessingStopped: (id: string, reason: 'complete') => Promise<void>
    }
    internals.flushPiProjectionWrites = async () => {
      order.push('projection:start')
      await projectionGate.promise
      order.push('projection:end')
    }

    const settling = internals.onProcessingStopped(sessionId, 'complete')
    await Promise.resolve()
    expect(order).toEqual(['metadata:start'])

    metadataGate.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['metadata:start', 'metadata:end', 'projection:start'])

    projectionGate.resolve()
    await settling
    expect(order).toEqual([
      'metadata:start',
      'metadata:end',
      'projection:start',
      'projection:end',
      'complete',
    ])
  })

  it('does not expose Host completion before compaction sidecar persistence finishes', async () => {
    const sessionId = 'durability-compaction-sidecar-order'
    const managed = buildSession(sessionId)
    managed.pendingPlanExecution = {
      planPath: join(tmpRoot, 'plan.md'),
      awaitingCompaction: true,
      executionDispatched: false,
    }
    const compactionGate = Promise.withResolvers<void>()
    const order: string[] = []
    let chatCalls = 0
    const fakeAgent = createInjectedAgent(sessionId, async function* () {
      chatCalls++
      yield { type: 'pi_user_message_persisted' }
      yield { type: 'info', message: 'Compacted 12 messages' }
      yield { type: 'complete' }
    })
    managed.agent = fakeAgent
    ;(sm as unknown as { getOrCreateAgent: () => Promise<AgentBackend> }).getOrCreateAgent = mock(async () => fakeAgent)
    sm.setEventSink((_channel, _target, event) => {
      if ((event as { type?: string }).type === 'complete') order.push('complete')
    })
    const originalMarkCompactionComplete = sm.markCompactionComplete.bind(sm)
    sm.markCompactionComplete = async id => {
      order.push('compaction:start')
      await compactionGate.promise
      await originalMarkCompactionComplete(id)
      order.push('compaction:end')
    }

    try {
      const sending = sm.sendMessage(sessionId, 'compact once')
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(order).toEqual(['compaction:start'])
      expect(chatCalls).toBe(1)
      expect(managed.isProcessing).toBe(true)

      compactionGate.resolve()
      await sending

      expect(order).toEqual(['compaction:start', 'compaction:end', 'complete'])
      expect(managed.pendingPlanExecution.awaitingCompaction).toBe(false)
    } finally {
      sm.markCompactionComplete = originalMarkCompactionComplete
    }
  })

  it('retries failed compaction sidecar settlement without rerunning the Pi turn', async () => {
    const sessionId = 'durability-compaction-sidecar-retry'
    const managed = buildSession(sessionId)
    managed.pendingPlanExecution = {
      planPath: join(tmpRoot, 'plan.md'),
      awaitingCompaction: true,
      executionDispatched: false,
    }
    let chatCalls = 0
    const fakeAgent = createInjectedAgent(sessionId, async function* () {
      chatCalls++
      yield { type: 'pi_user_message_persisted' }
      yield { type: 'info', message: 'Compacted 12 messages' }
      yield { type: 'complete' }
    })
    managed.agent = fakeAgent
    ;(sm as unknown as { getOrCreateAgent: () => Promise<AgentBackend> }).getOrCreateAgent = mock(async () => fakeAgent)
    const events: string[] = []
    sm.setEventSink((_channel, _target, event) => events.push((event as { type: string }).type))
    const originalMarkCompactionComplete = sm.markCompactionComplete.bind(sm)
    let sidecarBlocked = true
    let sidecarAttempts = 0
    sm.markCompactionComplete = async id => {
      sidecarAttempts++
      if (sidecarBlocked) throw new Error('compaction sidecar unavailable')
      await originalMarkCompactionComplete(id)
    }

    try {
      await expect(sm.sendMessage(sessionId, 'compact once')).rejects.toMatchObject({
        name: 'SessionSettlementDurabilityError',
        code: 'SESSION_SETTLEMENT_FAILED',
        retryable: true,
        terminal: false,
        outcome: 'accepted-pending-settlement',
      } satisfies Partial<SessionSettlementDurabilityError>)

      expect(chatCalls).toBe(1)
      expect(sidecarAttempts).toBe(2)
      expect(managed.pendingCompactionCompletion).toBe(true)
      expect(managed.pendingSettlementReason).toBe('complete')
      expect(managed.isProcessing).toBe(true)
      expect(events.filter(type => type === 'complete')).toHaveLength(0)

      sidecarBlocked = false
      await sm.retryPendingSettlement(sessionId)

      expect(chatCalls).toBe(1)
      expect(sidecarAttempts).toBe(3)
      expect(managed.pendingCompactionCompletion).toBe(false)
      expect(managed.pendingPlanExecution.awaitingCompaction).toBe(false)
      expect(managed.pendingSettlementReason).toBeUndefined()
      expect(managed.isProcessing).toBe(false)
      expect(events.filter(type => type === 'complete')).toHaveLength(1)
    } finally {
      sm.markCompactionComplete = originalMarkCompactionComplete
    }
  })

  it('does not start queued replay until settlement writes are durable', async () => {
    const sessionId = 'durability-replay-settlement-order'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.messageQueue.push({ message: 'queued', messageId: 'queued-after-settlement' })
    const projectionGate = Promise.withResolvers<void>()
    let replayed = false
    const internals = sm as unknown as {
      flushPiProjectionWrites: (session: typeof managed) => Promise<void>
      onProcessingStopped: (id: string, reason: 'complete') => Promise<void>
      processNextQueuedMessage: (id: string) => void
    }
    internals.flushPiProjectionWrites = async () => projectionGate.promise
    internals.processNextQueuedMessage = () => { replayed = true }

    const settling = internals.onProcessingStopped(sessionId, 'complete')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(replayed).toBe(false)

    projectionGate.resolve()
    await settling
    expect(replayed).toBe(true)
  })

  it('clears browser visuals once before releasing ownership on completion', async () => {
    const sessionId = 'durability-browser-release'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    const calls: string[] = []
    sm.setBrowserPaneManager({
      setSessionPathResolver: () => undefined,
      clearVisualsForSession: async (id: string) => { calls.push(`clear:${id}`) },
      unbindAllForSession: (id: string) => { calls.push(`unbind:${id}`) },
    } as never)
    const internals = sm as unknown as {
      onProcessingStopped: (id: string, reason: 'complete') => Promise<void>
    }

    await internals.onProcessingStopped(sessionId, 'complete')

    expect(calls).toEqual([
      `clear:${sessionId}`,
      `unbind:${sessionId}`,
    ])
  })

  it('keeps an accepted turn pending without re-entering cleanup when metadata settlement persistently fails', async () => {
    const sessionId = 'durability-metadata-settlement-failure'
    const managed = buildSession(sessionId)
    const projectRuntimeError = mock(() => undefined)
    let chatCalls = 0
    const fakeAgent = createInjectedAgent(sessionId, async function* () {
      chatCalls++
      yield { type: 'pi_user_message_persisted' }
      yield { type: 'complete' }
    })
    fakeAgent.projectRuntimeError = projectRuntimeError
    managed.agent = fakeAgent
    ;(sm as unknown as { getOrCreateAgent: () => Promise<AgentBackend> }).getOrCreateAgent = mock(async () => fakeAgent)

    const events: string[] = []
    sm.setEventSink((_channel, _target, event) => events.push((event as { type: string }).type))
    const originalFlushSession = sm.flushSession.bind(sm)
    const internals = sm as unknown as {
      onProcessingStopped: (id: string, reason: 'complete' | 'interrupted' | 'error' | 'timeout') => Promise<void>
    }
    const originalOnProcessingStopped = internals.onProcessingStopped.bind(sm)
    let settlementEntries = 0
    internals.onProcessingStopped = async (id, reason) => {
      settlementEntries++
      return originalOnProcessingStopped(id, reason)
    }
    let accepted = false
    sm.flushSession = async id => {
      if (id === sessionId && accepted) throw new Error('metadata disk remains unavailable')
      await originalFlushSession(id)
    }

    try {
      await expect(sm.sendMessage(
        sessionId,
        'accepted exactly once',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => { accepted = true },
      )).rejects.toMatchObject({
        name: 'SessionSettlementDurabilityError',
        code: 'SESSION_SETTLEMENT_FAILED',
        retryable: true,
        terminal: false,
        outcome: 'accepted-pending-settlement',
      } satisfies Partial<SessionSettlementDurabilityError>)

      expect(settlementEntries).toBe(1)
      expect(managed.isProcessing).toBe(true)
      expect(managed.pendingSettlementReason).toBe('complete')
      expect(events.filter(type => type === 'complete')).toHaveLength(0)
      expect(projectRuntimeError).not.toHaveBeenCalled()
      expect(chatCalls).toBe(1)

      await expect(sm.sendMessage(sessionId, 'must wait for old settlement')).rejects.toMatchObject({
        code: 'SESSION_SETTLEMENT_FAILED',
        outcome: 'accepted-pending-settlement',
      })
      expect(settlementEntries).toBe(2)
      expect(chatCalls).toBe(1)
      expect(managed.messageQueue).toHaveLength(0)
      expect(events.filter(type => type === 'complete')).toHaveLength(0)
    } finally {
      sm.flushSession = originalFlushSession
      internals.onProcessingStopped = originalOnProcessingStopped
    }
  })

  it('does not emit complete or replay a queued message while projection settlement persistently fails', async () => {
    const sessionId = 'durability-projection-settlement-failure'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.messageQueue.push({ message: 'queued once', messageId: 'queued-once' })
    const events: string[] = []
    sm.setEventSink((_channel, _target, event) => events.push((event as { type: string }).type))

    const internals = sm as unknown as {
      flushPiProjectionWrites: (session: typeof managed) => Promise<void>
      onProcessingStopped: (id: string, reason: 'complete') => Promise<void>
      processNextQueuedMessage: (id: string) => void
    }
    const originalProjectionFlush = internals.flushPiProjectionWrites.bind(sm)
    const originalReplay = internals.processNextQueuedMessage.bind(sm)
    let projectionAttempts = 0
    let replayAttempts = 0
    internals.flushPiProjectionWrites = async () => {
      projectionAttempts++
      throw new Error('projection disk remains unavailable')
    }
    internals.processNextQueuedMessage = () => { replayAttempts++ }

    try {
      const first = internals.onProcessingStopped(sessionId, 'complete')
      const concurrent = internals.onProcessingStopped(sessionId, 'complete')
      const results = await Promise.allSettled([first, concurrent])
      expect(results).toHaveLength(2)
      for (const result of results) {
        expect(result.status).toBe('rejected')
        expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'SESSION_SETTLEMENT_FAILED' })
      }

      expect(projectionAttempts).toBe(1)
      expect(replayAttempts).toBe(0)
      expect(managed.messageQueue).toHaveLength(1)
      expect(managed.isProcessing).toBe(true)
      expect(events.filter(type => type === 'complete')).toHaveLength(0)

      await expect(internals.onProcessingStopped(sessionId, 'complete')).rejects.toMatchObject({
        code: 'SESSION_SETTLEMENT_FAILED',
      })
      expect(projectionAttempts).toBe(2)
      expect(replayAttempts).toBe(0)
      expect(managed.messageQueue).toHaveLength(1)
      expect(events.filter(type => type === 'complete')).toHaveLength(0)
    } finally {
      internals.flushPiProjectionWrites = originalProjectionFlush
      internals.processNextQueuedMessage = originalReplay
    }
  })

  it('retries retained projection settlement over a restored baseline file', async () => {
    const sessionId = 'durability-projection-restored-baseline'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    const sessionPath = getSessionPath(testWorkspace.id, sessionId)
    const projectionPath = join(sessionPath, 'pi-projection-v1.json')
    mkdirSync(projectionPath, { recursive: true })

    const internals = sm as unknown as {
      piProjectionWrites: Map<string, Promise<void>>
      onProcessingStopped: (id: string, reason: 'complete') => Promise<void>
    }
    expect(sm.applyPiProjectionEvent({
      schemaVersion: 1,
      eventId: 'settlement-retry-projection',
      seq: 1,
      sessionId,
      runtimeId: 'settlement-retry-runtime',
      turnId: 'settlement-retry-turn',
      entityId: 'settlement-retry-content',
      entityType: 'content_block',
      entityVersion: 1,
      kind: 'assistant_text',
      occurredAt: Date.now(),
      payload: { text: 'durable assistant response' },
    }).status).toBe('applied')
    await internals.piProjectionWrites.get(sessionId)

    await expect(internals.onProcessingStopped(sessionId, 'complete')).rejects.toMatchObject({
      code: 'SESSION_SETTLEMENT_FAILED',
      outcome: 'accepted-pending-settlement',
    })
    expect(managed.pendingSettlementReason).toBe('complete')

    rmSync(projectionPath, { recursive: true, force: true })
    writeFileSync(projectionPath, JSON.stringify({
      schemaVersion: 1,
      sessionId,
      runtimeId: 'baseline-runtime',
      lastSeq: 0,
      entities: [],
    }), 'utf8')

    await sm.retryPendingSettlement(sessionId)

    const persisted = JSON.parse(readFileSync(projectionPath, 'utf8'))
    expect(persisted.runtimeId).toBe('settlement-retry-runtime')
    expect(persisted.lastSeq).toBe(1)
    expect(managed.pendingSettlementReason).toBeUndefined()
    expect(managed.isProcessing).toBe(false)
    expect(readdirSync(sessionPath).filter(name => name.endsWith('.tmp') || name.endsWith('.replaced'))).toEqual([])
  })

  it('single-flights concurrent public settlement retries and emits one complete after success', async () => {
    const sessionId = 'durability-public-settlement-retry'
    const managed = buildSession(sessionId)
    managed.isProcessing = true
    managed.pendingSettlementReason = 'complete'
    const projectionGate = Promise.withResolvers<void>()
    const events: string[] = []
    sm.setEventSink((_channel, _target, event) => events.push((event as { type: string }).type))

    const internals = sm as unknown as {
      flushPiProjectionWrites: (session: typeof managed) => Promise<void>
    }
    const originalProjectionFlush = internals.flushPiProjectionWrites.bind(sm)
    let projectionAttempts = 0
    internals.flushPiProjectionWrites = async () => {
      projectionAttempts++
      await projectionGate.promise
    }

    try {
      expect(sm.getSessions(testWorkspace.id).find(session => session.id === sessionId)?.pendingFailure).toMatchObject({
        code: 'SESSION_SETTLEMENT_FAILED',
        data: {
          sessionId,
          outcome: 'accepted-pending-settlement',
          retryable: true,
          terminal: false,
        },
      })

      const first = sm.retryPendingSettlement(sessionId)
      const concurrent = sm.retryPendingSettlement(sessionId)
      await Promise.resolve()
      expect(projectionAttempts).toBe(0)

      await new Promise(resolve => setTimeout(resolve, 0))
      expect(projectionAttempts).toBe(1)
      expect(events.filter(type => type === 'complete')).toHaveLength(0)

      projectionGate.resolve()
      await Promise.all([first, concurrent])

      expect(projectionAttempts).toBe(1)
      expect(managed.pendingSettlementReason).toBeUndefined()
      expect(managed.isProcessing).toBe(false)
      expect(events.filter(type => type === 'complete')).toHaveLength(1)
      expect(sm.getSessions(testWorkspace.id).find(session => session.id === sessionId)?.pendingFailure).toBeUndefined()
    } finally {
      internals.flushPiProjectionWrites = originalProjectionFlush
    }
  })

  it('keeps new sends queued behind a shifted replay message', async () => {
    const sessionId = 'fifo-replay'
    const managed = buildSession(sessionId)
    const queuedMessage = {
      id: 'queued-1',
      role: 'user' as const,
      content: 'first queued',
      timestamp: Date.now(),
      isQueued: true,
    }
    managed.messages.push(queuedMessage)
    managed.messageQueue.push({ message: queuedMessage.content, messageId: queuedMessage.id })

    const originalSetImmediate = globalThis.setImmediate
    let replayCallback: (() => void) | null = null
    ;(globalThis as typeof globalThis & { setImmediate: typeof setImmediate }).setImmediate = ((cb: () => void) => {
      replayCallback = cb
      return 0 as unknown as ReturnType<typeof setImmediate>
    }) as typeof setImmediate

    try {
      ;(sm as unknown as { processNextQueuedMessage: (id: string) => void }).processNextQueuedMessage(sessionId)

      expect(managed.isProcessing).toBe(true)
      expect(managed.replayingQueuedMessageId).toBe('queued-1')

      await sm.sendMessage(sessionId, 'new arrival while replay is pending')

      expect(replayCallback).toBeTruthy()
      expect(managed.messageQueue.map(q => q.message)).toEqual(['new arrival while replay is pending'])
    } finally {
      globalThis.setImmediate = originalSetImmediate
    }
  })

  it('rejects with a terminal retryable outcome if chat fails before Pi persistence', async () => {
    const sessionId = 'durability-pi-chat-failure'
    const managed = buildSession(sessionId)
    const projectRuntimeError = mock(() => undefined)
    const fakeAgent = {
      getModel: () => 'pi-test-model',
      setAllSources: mock(() => undefined),
      getSessionId: () => null,
      projectRuntimeError,
      chat: mock(() => {
        throw new Error('chat failed before iterator')
      }),
    }
    managed.agent = fakeAgent as never
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = mock(async () => fakeAgent)

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    await expect(sm.sendMessage(
      sessionId,
      'pi provider delayed ack',
      undefined,
      undefined,
      overlayOptions,
      undefined,
      undefined,
      (messageId) => {
        ackedMessageId = messageId
        onDiskAtAck = readPersistedMessageIds(sessionId).includes(messageId)
      },
    )).rejects.toMatchObject({
      name: 'SessionSendDurabilityError',
      code: 'SESSION_PERSISTENCE_FAILED',
      retryable: true,
      terminal: true,
      outcome: 'unaccepted',
      sessionId,
      data: {
        sessionId,
        messageId: expect.any(String),
        stage: 'canonical-user-message',
        retryable: true,
        terminal: true,
        outcome: 'unaccepted',
      },
    } satisfies Partial<SessionSendDurabilityError>)

    expect(fakeAgent.chat).toHaveBeenCalled()
    expect(projectRuntimeError).toHaveBeenCalledWith({
      phase: 'send',
      message: 'chat failed before iterator',
      retryable: true,
    })
    expect(managed.messages.some(message => message.role === 'error')).toBe(false)
    expect(ackedMessageId).toBeNull()
    expect(onDiskAtAck).toBe(false)
  })
})
