import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionAttachmentsPath, getSessionFilePath, getSessionPath, readSessionJsonl, setSharedPiSessionsDirForTests } from '@mortise/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

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

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-durability-'))
    setSharedPiSessionsDirForTests(join(tmpRoot, 'pi-sessions'))
    sm = new SessionManager()
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
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { mortiseId: id, name: 'durability test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  function readPersistedMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    const ids = new Set<string>()
    if (existsSync(path)) {
      for (const message of readSessionJsonl(path)?.messages ?? []) {
        ids.add(message.id)
      }
    }

    // In Pi tree mode, Mortise persists pre-Pi user message IDs in the sidecar
    // overlay while Pi owns the canonical transcript body.
    const overlayPath = join(getSessionPath(tmpRoot, sessionId), 'overlay.json')
    if (existsSync(overlayPath)) {
      const overlay = JSON.parse(readFileSync(overlayPath, 'utf-8')) as { messages?: Array<{ id?: unknown }> }
      for (const message of overlay.messages ?? []) {
        if (typeof message.id === 'string') ids.add(message.id)
      }
    }

    return [...ids]
  }

  function readPersistedQueuedMessageIds(sessionId: string): string[] {
    const path = join(getSessionPath(tmpRoot, sessionId), 'pi-projection-v1.json')
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

  it('user overlay is on disk before onAck fires (normal branch)', async () => {
    const sessionId = 'durability-normal'
    buildSession(sessionId)

    let ackedMessageId: string | null = null
    let onDiskAtAck = false

    // sendMessage continues past the ack into agent-init, which would throw
    // because we haven't called `setSessionPlatform()` in this minimal test
    // harness. That's fine — we only care about the persist+flush+ack ordering
    // that happens before agent-init. Catch the post-ack rejection.
    await sm
      .sendMessage(
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
      .catch(() => { /* expected post-ack agent-init failure */ })

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
    expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(false)
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

    const sessionFile = getSessionFilePath(tmpRoot, sessionId, tmpRoot, Date.now())
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
    const sessionFile = getSessionFilePath(tmpRoot, sessionId, tmpRoot, Date.now())
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
    const stagingAttachments = getSessionAttachmentsPath(tmpRoot, stagingId)
    const targetAttachments = getSessionAttachmentsPath(tmpRoot, sessionId)
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

    expect(existsSync(getSessionPath(tmpRoot, stagingId))).toBe(false)
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
    const stagingAttachments = getSessionAttachmentsPath(tmpRoot, stagingId)
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

  it('acks before Pi startup or runtime confirmation is required', async () => {
    const sessionId = 'durability-ack-before-pi-runtime'
    buildSession(sessionId)

    let agentInitStarted = false
    let ackedBeforeAgentInit = false
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = mock(async () => {
      agentInitStarted = true
      throw new Error('agent init should be post-ack runtime work')
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
        ackedBeforeAgentInit = !agentInitStarted
      },
    )

    expect(ackedBeforeAgentInit).toBe(true)
    const projection = await sm.getPiProjectionSnapshot(sessionId)
    expect(projection?.entities.some(entity => entity.kind === 'runtime_error')).toBe(true)
  })

  it('user overlay is on disk before onAck fires (mid-stream / queued branch)', async () => {
    const sessionId = 'durability-midstream'
    const managed = buildSession(sessionId)
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

  it('acks Pi sends if chat fails before the event loop starts', async () => {
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

    await sm.sendMessage(
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
    )

    expect(fakeAgent.chat).toHaveBeenCalled()
    expect(projectRuntimeError).toHaveBeenCalledWith({
      phase: 'send',
      message: 'chat failed before iterator',
      retryable: true,
    })
    expect(managed.messages.some(message => message.role === 'error')).toBe(false)
    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
  })
})
