import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  electronDevControlStatePath,
  sendElectronDevControlCommand,
  startElectronDevControlServer,
  type ElectronDevControlServer,
} from './electron-dev-control-protocol.ts'

const roots: string[] = []
const servers: ElectronDevControlServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Electron dev control protocol', () => {
  it('derives a stable state path from the repository identity', () => {
    const stateDirectory = createTempDir()
    expect(electronDevControlStatePath('C:/work/mortise', stateDirectory))
      .toBe(electronDevControlStatePath('C:/work/mortise', stateDirectory))
    expect(electronDevControlStatePath('C:/work/mortise-a', stateDirectory))
      .not.toBe(electronDevControlStatePath('C:/work/mortise-b', stateDirectory))
  })

  it('routes authenticated loopback commands to the owning supervisor', async () => {
    const stateDirectory = createTempDir()
    const repoRoot = createTempDir()
    let electronPid: number | undefined
    let nextPid = 400
    const server = await startElectronDevControlServer(repoRoot, {
      status: () => ({
        state: electronPid ? 'running' : 'idle',
        supervisorPid: process.pid,
        vitePid: 300,
        vitePort: 5173,
        ...(electronPid ? { electronPid } : {}),
      }),
      start: async () => {
        electronPid ??= nextPid++
        return {
          ok: true,
          operationId: '',
          state: 'running',
          supervisorPid: process.pid,
          vitePid: 300,
          vitePort: 5173,
          electronPid,
        }
      },
      restart: async () => {
        const previousElectronPid = electronPid
        electronPid = nextPid++
        return {
          ok: true,
          operationId: '',
          state: 'running',
          supervisorPid: process.pid,
          vitePid: 300,
          vitePort: 5173,
          electronPid,
          previousElectronPid,
        }
      },
    }, stateDirectory)
    servers.push(server)

    const initial = await sendElectronDevControlCommand(repoRoot, 'status', { stateDirectory })
    expect(initial?.state).toBe('idle')
    expect(initial?.vitePid).toBe(300)
    expect(initial?.vitePort).toBe(5173)
    const started = await sendElectronDevControlCommand(repoRoot, 'start', { stateDirectory })
    expect(started?.electronPid).toBe(400)
    const restarted = await sendElectronDevControlCommand(repoRoot, 'restart', { stateDirectory })
    expect(restarted?.previousElectronPid).toBe(400)
    expect(restarted?.electronPid).toBe(401)
    expect(restarted?.vitePid).toBe(300)
    expect(restarted?.vitePort).toBe(5173)
    expect(restarted?.operationId).not.toBe('')
  })

  it('returns an asynchronous restart receipt and observes the settled pid through status', async () => {
    const stateDirectory = createTempDir()
    const repoRoot = createTempDir()
    let state: 'running' | 'restarting' = 'running'
    let electronPid = 400
    let settleRestart: (() => void) | undefined
    const restartSettled = new Promise<void>(resolve => { settleRestart = resolve })
    const server = await startElectronDevControlServer(repoRoot, {
      status: () => ({ state, supervisorPid: process.pid, vitePid: 300, vitePort: 5173, electronPid }),
      start: async () => ({ ok: true, operationId: '', state, supervisorPid: process.pid, vitePid: 300, vitePort: 5173, electronPid }),
      restart: async () => {
        const previousElectronPid = electronPid
        state = 'restarting'
        void restartSettled.then(() => {
          electronPid = 401
          state = 'running'
        })
        return {
          ok: true,
          operationId: '',
          state,
          supervisorPid: process.pid,
          vitePid: 300,
          vitePort: 5173,
          previousElectronPid,
        }
      },
    }, stateDirectory)
    servers.push(server)

    const receipt = await sendElectronDevControlCommand(repoRoot, 'restart', { stateDirectory })
    expect(receipt).toMatchObject({ state: 'restarting', previousElectronPid: 400, vitePid: 300, vitePort: 5173 })
    expect(receipt?.electronPid).toBeUndefined()
    settleRestart?.()
    await Bun.sleep(0)
    expect(await sendElectronDevControlCommand(repoRoot, 'status', { stateDirectory }))
      .toMatchObject({ state: 'running', electronPid: 401, vitePid: 300, vitePort: 5173 })
  })

  it('removes a stale state file when its loopback endpoint is unavailable', async () => {
    const stateDirectory = createTempDir()
    const repoRoot = createTempDir()
    const statePath = electronDevControlStatePath(repoRoot, stateDirectory)
    const unavailablePort = await reserveClosedPort()
    writeFileSync(statePath, `${JSON.stringify({
      version: 1,
      repoRoot: normalizeTestRoot(repoRoot),
      pid: process.pid,
      recordedAt: Date.now(),
      port: unavailablePort,
      token: 'stale-token',
    })}\n`)

    expect(await sendElectronDevControlCommand(repoRoot, 'status', { stateDirectory, timeoutMs: 1_000 })).toBeUndefined()
    expect(existsSync(statePath)).toBe(false)
  })

  it('rejects a response that does not echo the command operation id', async () => {
    const stateDirectory = createTempDir()
    const repoRoot = createTempDir()
    const fakeServer = createServer(socket => {
      socket.once('data', () => socket.end(`${JSON.stringify({
        ok: true,
        operationId: 'wrong-operation',
        state: 'running',
        supervisorPid: process.pid,
      })}\n`))
    })
    await new Promise<void>((resolveListen, reject) => {
      fakeServer.once('error', reject)
      fakeServer.listen(0, '127.0.0.1', () => resolveListen())
    })
    const address = fakeServer.address()
    if (!address || typeof address === 'string') throw new Error('Fake control server did not bind')
    const statePath = electronDevControlStatePath(repoRoot, stateDirectory)
    writeFileSync(statePath, `${JSON.stringify({
      version: 1,
      repoRoot: normalizeTestRoot(repoRoot),
      pid: process.pid,
      recordedAt: Date.now(),
      port: address.port,
      token: 'fake-token',
    })}\n`)

    try {
      expect(await sendElectronDevControlCommand(repoRoot, 'status', { stateDirectory })).toBeUndefined()
      expect(existsSync(statePath)).toBe(false)
    } finally {
      await new Promise<void>(resolveClose => fakeServer.close(() => resolveClose()))
    }
  })

  it('does not discover a supervisor through another repository identity', async () => {
    const stateDirectory = createTempDir()
    const repoRoot = createTempDir()
    const otherRoot = createTempDir()
    const server = await startElectronDevControlServer(repoRoot, {
      status: () => ({ state: 'idle', supervisorPid: process.pid }),
      start: async () => ({ ok: true, operationId: '', state: 'idle', supervisorPid: process.pid }),
      restart: async () => ({ ok: true, operationId: '', state: 'idle', supervisorPid: process.pid }),
    }, stateDirectory)
    servers.push(server)

    expect(await sendElectronDevControlCommand(otherRoot, 'status', { stateDirectory })).toBeUndefined()
  })
})

function createTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'mortise-electron-dev-control-'))
  roots.push(root)
  return root
}

function normalizeTestRoot(root: string): string {
  const normalized = resolve(root)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function reserveClosedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Temporary server did not bind')
  await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  return address.port
}
