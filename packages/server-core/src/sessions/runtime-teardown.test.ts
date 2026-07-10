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
      { craftId: sessionId, name: sessionId },
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
})
