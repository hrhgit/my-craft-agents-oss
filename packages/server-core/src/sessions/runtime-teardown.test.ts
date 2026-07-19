import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('SessionManager runtime teardown', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-runtime-teardown-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function injectManagedSession(sessionId: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { mortiseId: sessionId, name: sessionId },
      workspace as never,
      { messagesLoaded: true },
    ) as any
    const agent = { dispose: jest.fn() }
    const poolServer = { stop: jest.fn(async () => undefined) }
    const mcpPool = { disconnectAll: jest.fn(async () => undefined) }

    managed.agent = agent
    managed.poolServer = poolServer
    managed.mcpPool = mcpPool
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)

    return { managed, agent, poolServer, mcpPool }
  }

  it('deleteSession disconnects MCP pool through the shared runtime disposer', async () => {
    const { managed, agent, poolServer, mcpPool } = injectManagedSession('delete-runtime')

    await sm.deleteSession('delete-runtime')

    expect(agent.dispose).toHaveBeenCalledTimes(1)
    expect(poolServer.stop).toHaveBeenCalledTimes(1)
    expect(mcpPool.disconnectAll).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    expect(managed.poolServer).toBeUndefined()
    expect(managed.mcpPool).toBeUndefined()
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.has('delete-runtime')).toBe(false)
  })

  it('deleteSession waits for projection persistence and clears retired runtime state', async () => {
    injectManagedSession('delete-projection')
    let release!: () => void
    const flush = jest.fn(() => new Promise<void>(resolve => { release = resolve }))
    const internals = sm as unknown as {
      sessions: Map<string, unknown>
      piProjectionRetiredRuntimeIds: Map<string, Set<string>>
      flushPiProjectionWrites: (managed: unknown) => Promise<void>
    }
    internals.piProjectionRetiredRuntimeIds.set('delete-projection', new Set(['runtime-1']))
    internals.flushPiProjectionWrites = flush

    const deleting = sm.deleteSession('delete-projection')
    while (flush.mock.calls.length === 0) await Promise.resolve()
    expect(internals.sessions.has('delete-projection')).toBe(true)

    release()
    await deleting
    expect(internals.sessions.has('delete-projection')).toBe(false)
    expect(internals.piProjectionRetiredRuntimeIds.has('delete-projection')).toBe(false)
  })

  it('cleanup disposes active session runtimes before clearing sessions', async () => {
    const first = injectManagedSession('cleanup-runtime-a')
    const second = injectManagedSession('cleanup-runtime-b')

    await sm.cleanup()

    expect(first.agent.dispose).toHaveBeenCalledTimes(1)
    expect(first.poolServer.stop).toHaveBeenCalledTimes(1)
    expect(first.mcpPool.disconnectAll).toHaveBeenCalledTimes(1)
    expect(second.agent.dispose).toHaveBeenCalledTimes(1)
    expect(second.poolServer.stop).toHaveBeenCalledTimes(1)
    expect(second.mcpPool.disconnectAll).toHaveBeenCalledTimes(1)
    expect((sm as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
  })

  it('cleanup flushes projection persistence before clearing runtime state', async () => {
    injectManagedSession('cleanup-projection')
    let release!: () => void
    const flush = jest.fn(() => new Promise<void>(resolve => { release = resolve }))
    const internals = sm as unknown as {
      sessions: Map<string, unknown>
      piProjectionBySession: Map<string, unknown>
      piProjectionRetiredRuntimeIds: Map<string, Set<string>>
      piProjectionWrites: Map<string, Promise<void>>
      piProjectionPendingSnapshots: Map<string, unknown>
      flushPiProjectionWrites: (managed: unknown) => Promise<void>
    }
    internals.piProjectionBySession.set('cleanup-projection', {})
    internals.piProjectionRetiredRuntimeIds.set('cleanup-projection', new Set(['runtime-1']))
    internals.piProjectionWrites.set('cleanup-projection', Promise.resolve())
    internals.piProjectionPendingSnapshots.set('cleanup-projection', {})
    internals.flushPiProjectionWrites = flush

    const cleaning = sm.cleanup()
    while (flush.mock.calls.length === 0) await Promise.resolve()
    expect(internals.sessions.has('cleanup-projection')).toBe(true)

    release()
    await cleaning
    expect(internals.sessions.size).toBe(0)
    expect(internals.piProjectionBySession.size).toBe(0)
    expect(internals.piProjectionRetiredRuntimeIds.size).toBe(0)
    expect(internals.piProjectionWrites.size).toBe(0)
    expect(internals.piProjectionPendingSnapshots.size).toBe(0)
  })
})
