import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ConfigStore } from '../config-store'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const worker = join(import.meta.dir, 'fixtures', 'json-store-worker.ts')
const directories: string[] = []

function collect(child: ChildProcess): Promise<void> {
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', chunk => { stderr += chunk })
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(stderr)))
  })
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('JsonFileStore multi-writer persistence', () => {
  it('merges disjoint object updates from separate backend processes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mortise-json-store-'))
    directories.push(directory)
    new ConfigStore(directory).update({ enabled: true })

    const spawnWorker = (platform: string) => spawn(process.execPath, [worker, directory, platform], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await Promise.all([collect(spawnWorker('telegram')), collect(spawnWorker('whatsapp'))])

    const config = new ConfigStore(directory).get()
    expect(config.enabled).toBe(true)
    expect(config.platforms.telegram?.enabled).toBe(true)
    expect(config.platforms.whatsapp?.enabled).toBe(true)
  }, 30_000)
})
