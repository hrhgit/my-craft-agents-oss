import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RPC_CHANNELS } from '../../../shared/types'
import { registerSessionsHandlers, cleanupSessionFileWatchForClient } from '@craft-agent/server-core/handlers/rpc'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

type HandlerFn = (ctx: { clientId: string; workspaceId?: string }, ...args: any[]) => Promise<any> | any

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('sessions file watchers', () => {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; target: any; args: any[] }> = []

  let tempRoot = ''
  let sessionDirA = ''
  let sessionDirB = ''

  beforeEach(() => {
    handlers.clear()
    pushed.length = 0

    tempRoot = mkdtempSync(join(tmpdir(), 'craft-session-watchers-'))
    sessionDirA = join(tempRoot, 'session-a')
    sessionDirB = join(tempRoot, 'session-b')
    mkdirSync(sessionDirA, { recursive: true })
    mkdirSync(sessionDirB, { recursive: true })

    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn)
      },
      push(channel, target, ...args) {
        pushed.push({ channel, target, args })
      },
      async invokeClient() {
        return null
      },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }

    const deps: HandlerDeps = {
      sessionManager: {
        getSession: async (sessionId: string) => {
          if (sessionId === 'session-a' || sessionId === 'session-b') {
            return { id: sessionId, workspaceId: 'ws-1' }
          }
          return null
        },
        getSessionPath: (sessionId: string) => {
          if (sessionId === 'session-a') return sessionDirA
          if (sessionId === 'session-b') return sessionDirB
          return null
        },
      } as unknown as HandlerDeps['sessionManager'],
      platform: {
        appRootPath: '',
        resourcesPath: '',
        isPackaged: false,
        appVersion: '0.0.0-test',
        isDebugMode: true,
        imageProcessor: {
          getMetadata: async () => null,
          process: async () => Buffer.from(''),
        },
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      },
      oauthFlowStore: {
        store: () => {},
        getByState: () => null,
        remove: () => {},
        cleanup: () => {},
        dispose: () => {},
        get size() { return 0 },
      } as unknown as HandlerDeps['oauthFlowStore'],
    }

    registerSessionsHandlers(server, deps)
  })

  afterEach(() => {
    cleanupSessionFileWatchForClient('client-a')
    cleanupSessionFileWatchForClient('client-b')
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('isolates file change notifications per client watcher', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    const unwatch = handlers.get(RPC_CHANNELS.sessions.UNWATCH_FILES)
    expect(watch).toBeTruthy()
    expect(unwatch).toBeTruthy()

    await watch!({ clientId: 'client-a', workspaceId: 'ws-1' }, 'session-a')
    await watch!({ clientId: 'client-b', workspaceId: 'ws-1' }, 'session-b')
    await wait(50)

    writeFileSync(join(sessionDirA, 'a.txt'), `a-${Date.now()}`)
    writeFileSync(join(sessionDirB, 'b.txt'), `b-${Date.now()}`)
    await wait(300)

    const aEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === 'client-a')
    const bEvents = pushed.filter((evt) => evt.target?.to === 'client' && evt.target?.clientId === 'client-b')

    expect(aEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-a')).toBe(true)
    expect(bEvents.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-b')).toBe(true)

    pushed.length = 0
    await unwatch!({ clientId: 'client-a', workspaceId: 'ws-1' })

    writeFileSync(join(sessionDirA, 'a.txt'), `a2-${Date.now()}`)
    writeFileSync(join(sessionDirB, 'b.txt'), `b2-${Date.now()}`)
    await wait(300)

    const aEventsAfter = pushed.filter((evt) => evt.target?.clientId === 'client-a')
    const bEventsAfter = pushed.filter((evt) => evt.target?.clientId === 'client-b')

    expect(aEventsAfter.length).toBe(0)
    expect(bEventsAfter.some((evt) => evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED && evt.args[0] === 'session-b')).toBe(true)
  })

  it('disconnect cleanup removes watcher and prevents further events', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    expect(watch).toBeTruthy()

    await watch!({ clientId: 'client-a', workspaceId: 'ws-1' }, 'session-a')
    await wait(50)

    cleanupSessionFileWatchForClient('client-a')
    pushed.length = 0

    writeFileSync(join(sessionDirA, 'after-cleanup.txt'), `x-${Date.now()}`)
    await wait(300)

    expect(pushed.length).toBe(0)
  })

  it('reads and conflict-checks files only inside the requested session directory', async () => {
    const read = handlers.get(RPC_CHANNELS.sessions.READ_FILE)
    const write = handlers.get(RPC_CHANNELS.sessions.WRITE_FILE)
    const fileA = join(sessionDirA, 'notes.txt')
    const fileB = join(sessionDirB, 'private.txt')
    writeFileSync(fileA, 'before', 'utf-8')
    writeFileSync(fileB, 'other session', 'utf-8')
    const ctx = { clientId: 'client-a', workspaceId: 'ws-1' }

    await expect(read!(ctx, 'session-a', fileA)).resolves.toBe('before')
    await expect(write!(ctx, 'session-a', fileA, 'after', 'before')).resolves.toEqual({ status: 'saved' })
    expect(readFileSync(fileA, 'utf-8')).toBe('after')
    await expect(write!(ctx, 'session-a', fileA, 'stale', 'before')).resolves.toEqual({
      status: 'conflict',
      currentContent: 'after',
    })
    expect(readFileSync(fileA, 'utf-8')).toBe('after')
    await expect(read!(ctx, 'session-a', fileB)).rejects.toThrow('outside allowed directories')
  })

  it('rejects oversized files at the session RPC boundary', async () => {
    const read = handlers.get(RPC_CHANNELS.sessions.READ_FILE)
    const write = handlers.get(RPC_CHANNELS.sessions.WRITE_FILE)
    const oversized = join(sessionDirA, 'oversized.txt')
    writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024 + 1, 97))
    const ctx = { clientId: 'client-a', workspaceId: 'ws-1' }

    await expect(read!(ctx, 'session-a', oversized)).rejects.toThrow('2 MiB')
    await expect(write!(ctx, 'session-a', oversized, 'small', 'stale')).rejects.toThrow('2 MiB')
  })
})
