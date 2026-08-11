import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformServices } from '../../runtime/platform'

const originalConfigDir = process.env.MORTISE_CONFIG_DIR
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR
const configDir = mkdtempSync(join(tmpdir(), 'mortise-bootstrap-rollback-'))
process.env.MORTISE_CONFIG_DIR = configDir
process.env.PI_CODING_AGENT_DIR = join(configDir, 'pi-agent')

const { bootstrapServer } = await import('../headless-start')

const TOKEN = 'bootstrap-rollback-test-token-0123456789'
const activeListeners = new Set<ReturnType<typeof createServer>>()

afterEach(async () => {
  await Promise.all(Array.from(activeListeners, listener => new Promise<void>(resolve => {
    listener.close(() => resolve())
  })))
  activeListeners.clear()
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.MORTISE_CONFIG_DIR
  else process.env.MORTISE_CONFIG_DIR = originalConfigDir
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir
  // The config store is process-scoped and may keep SQLite handles open on
  // Windows. Cleanup is best effort; never invoke a product-level "clear all"
  // API here because it also owns user credentials outside this fixture.
  try { rmSync(configDir, { recursive: true, force: true }) } catch { /* process exit releases handles */ }
})

function createPlatform(): PlatformServices {
  return {
    appRootPath: configDir,
    resourcesPath: configDir,
    isPackaged: false,
    appVersion: 'test',
    imageProcessor: {
      getMetadata: async () => null,
      process: async input => Buffer.isBuffer(input) ? input : Buffer.from(input),
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    isDebugMode: true,
  }
}

async function listenOn(port = 0): Promise<ReturnType<typeof createServer>> {
  const listener = createServer()
  activeListeners.add(listener)
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(port, '127.0.0.1', resolve)
  })
  return listener
}

async function reservePort(): Promise<number> {
  const listener = await listenOn()
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  const port = address.port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  activeListeners.delete(listener)
  return port
}

function assertLockReleased(lockFile: string): void {
  expect(existsSync(lockFile)).toBe(false)
  const registrations = `${lockFile}.d`
  expect(existsSync(registrations) ? readdirSync(registrations).filter(name => name.endsWith('.json')) : []).toEqual([])
}

function createOptions(input: {
  lockFile: string
  port: number
  initialize?: () => Promise<void>
  initializeRuntime?: () => Promise<void>
}) {
  const calls = {
    createSessionManager: 0,
    registerHandlers: 0,
    setEventSink: 0,
    initialize: 0,
    initializeRuntime: 0,
    cleanupRuntime: 0,
    cleanupSessionManager: 0,
  }
  const sessionManager = { identity: Symbol('session-manager') }

  return {
    calls,
    options: {
      serverToken: TOKEN,
      rpcHost: '127.0.0.1',
      rpcPort: input.port,
      serverLockName: input.lockFile,
      platformFactory: createPlatform,
      createSessionManager: () => {
        calls.createSessionManager++
        return sessionManager
      },
      createHandlerDeps: ({ sessionManager: manager }: { sessionManager: typeof sessionManager }) => ({ manager }),
      registerAllRpcHandlers: () => { calls.registerHandlers++ },
      initializeSessionManager: async () => {
        calls.initialize++
        await input.initialize?.()
      },
      initializeRuntime: async () => {
        calls.initializeRuntime++
        await input.initializeRuntime?.()
      },
      cleanupRuntime: async () => { calls.cleanupRuntime++ },
      setSessionEventSink: () => { calls.setEventSink++ },
      initModelRefreshService: () => {},
      cleanupSessionManager: async () => { calls.cleanupSessionManager++ },
    },
  }
}

describe('headless bootstrap startup transaction', () => {
  it('rolls back the session manager and lock when initialization fails before readiness', async () => {
    const port = await reservePort()
    const lockFile = join(configDir, 'initialize-failure.lock')
    const failure = new Error('session initialization failed')
    const { calls, options } = createOptions({
      lockFile,
      port,
      initialize: async () => { throw failure },
    })

    await expect(bootstrapServer(options)).rejects.toBe(failure)

    expect(calls).toEqual({
      createSessionManager: 1,
      registerHandlers: 1,
      setEventSink: 1,
      initialize: 1,
      initializeRuntime: 0,
      cleanupRuntime: 0,
      cleanupSessionManager: 1,
    })
    assertLockReleased(lockFile)

    const proof = await listenOn(port)
    expect(proof.listening).toBe(true)
  })

  it('rolls back a partially initialized application runtime before readiness', async () => {
    const port = await reservePort()
    const lockFile = join(configDir, 'runtime-failure.lock')
    const failure = new Error('application runtime initialization failed')
    const { calls, options } = createOptions({
      lockFile,
      port,
      initializeRuntime: async () => { throw failure },
    })

    await expect(bootstrapServer(options)).rejects.toBe(failure)

    expect(calls.initializeRuntime).toBe(1)
    expect(calls.cleanupRuntime).toBe(1)
    expect(calls.cleanupSessionManager).toBe(1)
    assertLockReleased(lockFile)
    expect((await listenOn(port)).listening).toBe(true)
  })

  it('rolls back the runtime, session, and lock when the readiness listener cannot bind', async () => {
    const occupied = await listenOn()
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
    const lockFile = join(configDir, 'listen-failure.lock')
    const { calls, options } = createOptions({ lockFile, port: address.port })

    await expect(bootstrapServer(options)).rejects.toMatchObject({ code: 'EADDRINUSE' })

    expect(calls.cleanupRuntime).toBe(1)
    expect(calls.cleanupSessionManager).toBe(1)
    assertLockReleased(lockFile)
    expect(occupied.listening).toBe(true)
  })

  it('stops a ready server idempotently and releases its listener and lock', async () => {
    const port = await reservePort()
    const lockFile = join(configDir, 'successful-stop.lock')
    const { calls, options } = createOptions({ lockFile, port })
    const instance = await bootstrapServer(options)

    expect(existsSync(lockFile)).toBe(true)
    expect(instance.port).toBe(port)

    // Skip the normal two-second notification drain; the shutdown cleanup
    // path must still run after a notification failure.
    instance.wsServer.push = (() => { throw new Error('no connected clients') }) as typeof instance.wsServer.push
    await Promise.all([instance.stop(), instance.stop()])

    expect(calls.cleanupRuntime).toBe(1)
    expect(calls.cleanupSessionManager).toBe(1)
    assertLockReleased(lockFile)

    const proof = await listenOn(port)
    expect(proof.listening).toBe(true)
  })
})
