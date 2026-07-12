import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  loadSession,
  saveSession,
  setSharedPiSessionsDirForTests,
  appendStoredMessagesViaPiSessionManager,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import type { StoredMessage } from '@craft-agent/core/types'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Regression test for the silent-drop bug in persistSession:
//
//   On startup, sessions load with messagesLoaded=false and only get loaded
//   on first getSession(). The old persistSession early-returned in that
//   state to avoid wiping the JSONL with []. As a result, status/label/rename
//   changes on sessions the user hadn't opened since restart were never
//   written to disk and were lost on the next restart.
//
// The fix synchronously hydrates the Pi projection and Craft overlay before
// enqueueing the updated metadata. flushSession then waits for the queued
// write, so durability holds for mutate-then-flush callers.

describe('cold-session metadata persistence', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-cold-meta-'))
    setSharedPiSessionsDirForTests(join(tmpRoot, 'pi-sessions'))
    sm = new SessionManager()
  })

  afterEach(() => {
    setSharedPiSessionsDirForTests(undefined)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildWorkspace() {
    return {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  // Seed a Pi session on disk to simulate a session present from a
  // previous app run, then register it in the SessionManager with the
  // post-restart `messagesLoaded: false` state — i.e. metadata only.
  async function seedColdSession(
    sessionId: string,
    opts: {
      name?: string
      sessionStatus?: string
      labels?: string[]
      messages?: StoredMessage[]
    } = {},
  ) {
    const stored: StoredSession = {
      craftId: sessionId,
      workspaceRootPath: tmpRoot,
      name: opts.name ?? 'cold session',
      sessionStatus: opts.sessionStatus ?? 'todo',
      labels: opts.labels ?? [],
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: opts.messages ?? [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as StoredSession
    await saveSession(stored)
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    const importedIdMap = appendStoredMessagesViaPiSessionManager(
      filePath,
      dirname(filePath),
      tmpRoot,
      stored.messages,
    )

    const managed = createManagedSession(
      {
        craftId: sessionId,
        name: stored.name,
        sessionStatus: stored.sessionStatus,
        labels: stored.labels,
        createdAt: stored.createdAt,
      },
      buildWorkspace(),
      // messagesLoaded defaults to false — this is the cold-session state.
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    return importedIdMap
  }

  function readDiskHeader(sessionId: string): Record<string, unknown> {
    const path = getSessionFilePath(tmpRoot, sessionId)
    const firstLine = readFileSync(path, 'utf-8').split('\n')[0]
    const header = JSON.parse(firstLine)
    return { ...header, ...(header.craft ?? {}) }
  }

  function readDiskMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').trim().split('\n').slice(1)
    return lines.map(l => JSON.parse(l)).map(m => m.id as string)
  }

  function makeUserMessage(id: string, content: string): StoredMessage {
    return { id, type: 'user', content, timestamp: Date.now() } as StoredMessage
  }

  it('setSessionStatus on a cold session is on disk after flushSession resolves', async () => {
    const sessionId = 'cold-status'
    await seedColdSession(sessionId, { sessionStatus: 'todo' })

    await sm.setSessionStatus(sessionId, 'done')

    const header = readDiskHeader(sessionId)
    expect(header.sessionStatus).toBe('done')

    // Independently re-load from disk via the production loader to confirm
    // round-trip integrity.
    const reloaded = loadSession(tmpRoot, sessionId)
    expect(reloaded?.sessionStatus).toBe('done')
  })

  it('setSessionLabels on a cold session is on disk after flushSession resolves', async () => {
    const sessionId = 'cold-labels'
    await seedColdSession(sessionId, { labels: [] })

    await sm.setSessionLabels(sessionId, ['urgent', 'bug'])

    const header = readDiskHeader(sessionId)
    expect(header.labels).toEqual(['urgent', 'bug'])

    const reloaded = loadSession(tmpRoot, sessionId)
    expect(reloaded?.labels).toEqual(['urgent', 'bug'])
  })

  it('renameSession on a cold session persists (with explicit flushSession)', async () => {
    const sessionId = 'cold-rename'
    await seedColdSession(sessionId, { name: 'old name' })

    // renameSession does not flush internally; mirror the production order
    // (rename → flushSession). Without the cold-load fix, this assertion fails
    // because persistSession silently dropped the enqueue.
    await sm.renameSession(sessionId, 'new name')
    await sm.flushSession(sessionId)

    const header = readDiskHeader(sessionId)
    expect(header.name).toBe('new name')
  })

  it('cold-session persist preserves existing messages on disk', async () => {
    const sessionId = 'cold-preserve-msgs'
    const seededMessages = [
      makeUserMessage('m1', 'hello'),
      makeUserMessage('m2', 'world'),
      makeUserMessage('m3', 'three'),
    ]
    const importedIdMap = await seedColdSession(sessionId, { messages: seededMessages })
    const importedMessageIds = seededMessages.map(message => importedIdMap.get(message.id)!)

    // Sanity: messages are on disk before mutation.
    expect(readDiskMessageIds(sessionId)).toEqual(importedMessageIds)

    await sm.setSessionStatus(sessionId, 'done')

    // Header reflects the new status…
    expect(readDiskHeader(sessionId).sessionStatus).toBe('done')
    // …and the seeded messages survive (regression: original guard's intent).
    expect(readDiskMessageIds(sessionId)).toEqual(importedMessageIds)
  })

  it('concurrent cold-session status changes serialize to last-writer-wins on disk', async () => {
    const sessionId = 'cold-concurrent'
    await seedColdSession(sessionId, { sessionStatus: 'todo' })

    // Fire two mutations back-to-back without awaiting the first. Both flow
    // through the cold-persist path; ensureMessagesLoaded dedupes the load,
    // and the persistence queue debounces enqueues. Both calls must resolve
    // and disk must reflect the second value with no JSONL corruption.
    const p1 = sm.setSessionStatus(sessionId, 'in-progress')
    const p2 = sm.setSessionStatus(sessionId, 'done')
    await Promise.all([p1, p2])

    // Disk header has the last value.
    expect(readDiskHeader(sessionId).sessionStatus).toBe('done')

    // JSONL is well-formed: every line parses, none is empty.
    const lines = readFileSync(getSessionFilePath(tmpRoot, sessionId), 'utf-8')
      .trim()
      .split('\n')
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0)
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('flushSession on a cold session returns only after the disk write lands', async () => {
    const sessionId = 'cold-flush-ordering'
    await seedColdSession(sessionId, { sessionStatus: 'todo' })

    // Mirror the production pattern where a caller mutates and immediately
    // flushes (e.g. setSessionStatus, or any UI flow that quits the app
    // right after a metadata change). The disk must reflect the new value
    // by the time flushSession resolves — no debounce window.
    const managed = (sm as unknown as { sessions: Map<string, { sessionStatus?: string }> })
      .sessions.get(sessionId)!
    managed.sessionStatus = 'cancelled'
    ;(sm as unknown as { persistSession: (m: unknown) => void }).persistSession(managed)
    await sm.flushSession(sessionId)

    expect(readDiskHeader(sessionId).sessionStatus).toBe('cancelled')
  })
})
