import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const worker = join(import.meta.dir, 'fixtures', 'server-registration-worker.ts')
const directories: string[] = []
const children: ChildProcess[] = []

function waitReady(child: ChildProcess): Promise<void> {
  children.push(child)
  return new Promise((resolve, reject) => {
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      output += chunk
      if (output.includes('READY')) resolve()
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (!output.includes('READY')) reject(new Error(`worker exited before ready: ${code}`))
    })
  })
}

function stop(child: ChildProcess): Promise<void> {
  child.stdin?.write('STOP\n')
  return new Promise(resolve => child.once('exit', () => resolve()))
}

afterEach(async () => {
  await Promise.all(children.splice(0).filter(child => child.exitCode === null).map(stop))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('server protocol registry', () => {
  it('allows multiple protocol-aware backends and transfers the legacy sentinel', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mortise-server-registry-'))
    directories.push(directory)
    const lockFile = join(directory, '.server.lock')
    const registrationDir = `${lockFile}.d`

    const first = spawn(process.execPath, [worker, lockFile], { stdio: ['pipe', 'pipe', 'pipe'] })
    await waitReady(first)
    const second = spawn(process.execPath, [worker, lockFile], { stdio: ['pipe', 'pipe', 'pipe'] })
    await waitReady(second)

    expect(readdirSync(registrationDir).filter(name => name.endsWith('.json'))).toHaveLength(2)
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).protocolVersion).toBe(2)

    await stop(first)
    expect(readdirSync(registrationDir).filter(name => name.endsWith('.json'))).toHaveLength(1)
    expect(existsSync(lockFile)).toBe(true)

    await stop(second)
    expect(existsSync(lockFile)).toBe(false)
  }, 30_000)
})
