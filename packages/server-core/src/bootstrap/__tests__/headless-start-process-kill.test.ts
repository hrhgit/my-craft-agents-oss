import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

const WORKER = join(import.meta.dir, 'fixtures', 'bootstrap-process-probe.ts')
const TIMEOUT_MS = 20_000

const phases = [
  'lock-acquired',
  'handlers-registered',
  'session-initializing',
  'runtime-initializing',
  'model-refresh-starting',
  'listener-binding',
  'ready',
] as const

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

async function assertPortReusable(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  expect(server.listening).toBe(true)
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (connected: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await Bun.sleep(20)
  }
}

async function waitForExit(proc: Subprocess): Promise<number> {
  return await Promise.race([
    proc.exited,
    Bun.sleep(TIMEOUT_MS).then(() => { throw new Error(`Timed out waiting for process ${proc.pid} to exit`) }),
  ])
}

function spawnProbe(input: {
  configDir: string
  lockFile: string
  markerFile: string
  stopFile: string
  port: number
  phase: typeof phases[number]
}): Subprocess {
  const { CLAUDECODE: _, ...parentEnv } = process.env
  return Bun.spawn(['bun', 'run', WORKER], {
    env: {
      ...parentEnv,
      MORTISE_CONFIG_DIR: input.configDir,
      PI_CODING_AGENT_DIR: join(input.configDir, 'pi-agent'),
      MORTISE_BOOTSTRAP_PROBE_PHASE: input.phase,
      MORTISE_BOOTSTRAP_PROBE_MARKER: input.markerFile,
      MORTISE_BOOTSTRAP_PROBE_STOP: input.stopFile,
      MORTISE_BOOTSTRAP_PROBE_LOCK: input.lockFile,
      MORTISE_BOOTSTRAP_PROBE_PORT: String(input.port),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
}

function registrationCount(lockFile: string): number {
  const directory = `${lockFile}.d`
  return existsSync(directory)
    ? readdirSync(directory).filter(name => name.endsWith('.json')).length
    : 0
}

describe('headless bootstrap process-kill recovery', () => {
  for (const phase of phases) {
    it(`recovers the lock and listener after a process is killed in ${phase}`, async () => {
      const configDir = mkdtempSync(join(tmpdir(), `mortise-bootstrap-kill-${phase}-`))
      const lockFile = join(configDir, 'server.lock')
      const markerFile = join(configDir, 'phase.json')
      const stopFile = join(configDir, 'stop')
      const successorMarker = join(configDir, 'successor-phase.json')
      const successorStop = join(configDir, 'successor-stop')
      const port = await reservePort()
      let killed: Subprocess | null = null
      let successor: Subprocess | null = null

      try {
        killed = spawnProbe({ configDir, lockFile, markerFile, stopFile, port, phase })
        await waitFor(() => existsSync(markerFile), `${phase} marker`)
        expect(existsSync(lockFile)).toBe(true)
        expect(registrationCount(lockFile)).toBe(1)
        expect(await canConnect(port)).toBe(phase === 'ready')

        killed.kill('SIGKILL')
        await waitForExit(killed)
        killed = null

        // The OS releases an abruptly terminated process's listener. Its lock
        // registration intentionally remains for the next writer to prune.
        await assertPortReusable(port)
        expect(existsSync(lockFile)).toBe(true)
        expect(registrationCount(lockFile)).toBe(1)

        successor = spawnProbe({
          configDir,
          lockFile,
          markerFile: successorMarker,
          stopFile: successorStop,
          port,
          phase: 'ready',
        })
        await waitFor(() => existsSync(successorMarker), 'successor READY marker')
        expect(registrationCount(lockFile)).toBe(1)

        writeFileSync(successorStop, 'stop', 'utf8')
        expect(await waitForExit(successor)).toBe(0)
        successor = null

        expect(existsSync(lockFile)).toBe(false)
        expect(registrationCount(lockFile)).toBe(0)
        await assertPortReusable(port)
      } finally {
        killed?.kill('SIGKILL')
        successor?.kill('SIGKILL')
        if (killed) await waitForExit(killed).catch(() => {})
        if (successor) await waitForExit(successor).catch(() => {})
        try { rmSync(configDir, { recursive: true, force: true }) } catch { /* subprocess exit releases fixture handles */ }
      }
    }, 60_000)
  }
})
