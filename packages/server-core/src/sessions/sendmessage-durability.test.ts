import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionFilePath, getSessionPath, readSessionJsonl, setSharedPiSessionsDirForTests } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Regression test for the High-severity finding in eb81086e, adapted for
// Pi-first transcript ownership:
//
//   sendMessage's `{ accepted, messageId }` ack contract must not return before
//   the Craft-owned attachment/badge overlay hits disk. A crash inside the
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
      { craftId: id, name: 'durability test' },
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

    // In Pi tree mode, Craft persists pre-Pi user message IDs in the sidecar
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
    badges: [{ type: 'source' as const, label: 'Linear', rawText: '@linear', start: 0, end: 7 }],
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

  it('reveals a deferred new session only after its first message is durable', async () => {
    const sessionId = 'deferred-session-visibility'
    const managed = buildSession(sessionId)
    managed.hidden = true
    managed.deferListUntilFirstMessage = true
    const events: unknown[] = []
    let persistedHiddenAtAck: boolean | undefined
    sm.setEventSink((_channel, _target, event) => events.push(event))

    await sm.sendMessage(
      sessionId,
      'first real message',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        persistedHiddenAtAck = readSessionJsonl(getSessionFilePath(tmpRoot, sessionId))?.hidden
      },
    ).catch(() => {
      // This focused harness does not start a runtime; visibility changes happen
      // before the post-ack runtime work.
    })

    expect(managed.hidden).toBe(false)
    expect(managed.deferListUntilFirstMessage).toBe(false)
    expect(persistedHiddenAtAck).toBe(false)
    expect(events).toContainEqual({ type: 'session_created', sessionId })
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
    managed.agent = { redirect: () => false, projectQueuedUser } as never

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
    expect(ackedMessageId).not.toBeNull()
    expect(onDiskAtAck).toBe(true)
    expect(projectionOnDiskAtAck).toBe(true)
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
