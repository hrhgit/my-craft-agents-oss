import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  getSessionFilePath,
  getSessionPath,
  saveSession,
  setSharedPiSessionsDirForTests,
  appendStoredMessagesViaPiSessionManager,
  type StoredSession,
} from '@mortise/shared/sessions'
import type { StoredMessage } from '@mortise/core/types'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('cold-session metadata persistence', () => {
  let tmpRoot: string
  let manager: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-cold-meta-'))
    setSharedPiSessionsDirForTests(join(tmpRoot, 'pi-sessions'))
    manager = new SessionManager()
  })

  afterEach(() => {
    setSharedPiSessionsDirForTests(undefined)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function seedColdSession(sessionId: string, messages: StoredMessage[] = []) {
    const stored: StoredSession = {
      mortiseId: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'cold session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as StoredSession
    await saveSession(stored)
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    const importedIdMap = appendStoredMessagesViaPiSessionManager(
      filePath,
      dirname(filePath),
      tmpRoot,
      messages,
    )
    const managed = createManagedSession(
      { mortiseId: sessionId, name: stored.name, createdAt: stored.createdAt },
      { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() } as never,
    )
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    return importedIdMap
  }

  function readDiskHeader(sessionId: string): Record<string, unknown> {
    const firstLine = readFileSync(getSessionFilePath(tmpRoot, sessionId), 'utf-8').split('\n')[0]
    const header = JSON.parse(firstLine)
    return { ...header, ...(header.mortise ?? {}) }
  }

  function readDiskMessageIds(sessionId: string): string[] {
    const path = getSessionFilePath(tmpRoot, sessionId)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').trim().split('\n').slice(1).map(line => JSON.parse(line).id as string)
  }

  it('renameSession persists on a cold session after flush', async () => {
    const sessionId = 'cold-rename'
    await seedColdSession(sessionId)
    await manager.renameSession(sessionId, 'new name')
    await manager.flushSession(sessionId)
    expect(readDiskHeader(sessionId).name).toBe('new name')
  })

  it('cold-session persistence preserves existing messages', async () => {
    const sessionId = 'cold-preserve-msgs'
    const messages = [
      { id: 'm1', type: 'user', content: 'hello', timestamp: Date.now() },
      { id: 'm2', type: 'user', content: 'world', timestamp: Date.now() },
    ] as StoredMessage[]
    const imported = await seedColdSession(sessionId, messages)
    const expectedIds = messages.map(message => imported.get(message.id)!)
    expect(readDiskMessageIds(sessionId)).toEqual(expectedIds)

    await manager.renameSession(sessionId, 'renamed')
    await manager.flushSession(sessionId)

    expect(readDiskHeader(sessionId).name).toBe('renamed')
    expect(readDiskMessageIds(sessionId)).toEqual(expectedIds)
  })

  it('keeps storage paths out of list metadata and resolves them for one loaded session', async () => {
    const sessionId = 'cold-storage-path'
    await seedColdSession(sessionId)

    const listed = manager.getSessions('ws_test')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.sessionFolderPath).toBeUndefined()

    const loaded = await manager.getSession(sessionId)
    expect(loaded?.sessionFolderPath).toBe(getSessionPath(tmpRoot, sessionId))
  })
})
