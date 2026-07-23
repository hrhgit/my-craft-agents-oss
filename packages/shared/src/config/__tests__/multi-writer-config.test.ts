import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MultiWriterStore } from '../../storage/index.ts'

const repositoryRoot = resolve(import.meta.dir, '../../../../..')
const workerPath = join(import.meta.dir, 'fixtures', 'multi-writer-config-worker.ts')
const temporaryDirectories: string[] = []

function setupConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'mortise-config-multi-writer-'))
  temporaryDirectories.push(configDir)
  writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
    version: 'test',
    description: 'test defaults',
    defaults: {
      notificationsEnabled: true,
      colorTheme: 'default',
      piExtensions: { enabled: {}, config: {} },
      piShell: { fullPassthrough: true },
    },
    workspaceDefaults: {
      thinkingLevel: 'medium',
      permissionMode: 'ask',
      cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
    },
  }, null, 2))
  return configDir
}

function spawnWorker(configDir: string, field: string, value: string): ChildProcess {
  return spawn(
    process.execPath,
    [workerPath, configDir, field, value],
    {
      cwd: repositoryRoot,
      env: { ...process.env, MORTISE_CONFIG_DIR: configDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
}

function collect(child: ChildProcess): Promise<void> {
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', chunk => { stderr += chunk })
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolvePromise()
      : reject(new Error(`worker exited with ${code}: ${stderr}`)))
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('config multi-writer compatibility', () => {
  it('merges disjoint edits from Bun and Electron writers', async () => {
    const configDir = setupConfigDir()
    await collect(spawnWorker(configDir, 'colorTheme', 'dark'))

    const [bunWriter, electronWriter] = await Promise.all([
      collect(spawnWorker(configDir, 'colorTheme', 'light')),
      collect(spawnWorker(configDir, 'notificationsEnabled', 'false')),
    ])
    void bunWriter
    void electronWriter

    const store = MultiWriterStore.openSync({
      databasePath: join(configDir, 'state.sqlite'),
      writerId: 'test-reader',
      writerVersion: 1,
    })
    const config = store.getRecord('config', 'root')?.value as Record<string, unknown>
    store.close()
    expect(config.colorTheme).toBe('light')
    expect(config.notificationsEnabled).toBe(false)
    expect(existsSync(join(configDir, 'config.json'))).toBe(false)
    expect(existsSync(join(configDir, '.config.json.sync'))).toBe(false)
  }, 30_000)

  it('ignores and preserves retired config.json data', async () => {
    const configDir = setupConfigDir()
    const legacyPath = join(configDir, 'config.json')
    const legacyContents = JSON.stringify({
      workspaces: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      colorTheme: 'legacy-theme',
    }, null, 2)
    writeFileSync(legacyPath, legacyContents)

    await collect(spawnWorker(configDir, 'colorTheme', 'current-theme'))

    const store = MultiWriterStore.openSync({
      databasePath: join(configDir, 'state.sqlite'),
      writerId: 'legacy-test-reader',
      writerVersion: 1,
    })
    expect((store.getRecord('config', 'root')?.value as Record<string, unknown>).colorTheme).toBe('current-theme')
    store.close()
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyContents)
    expect(existsSync(join(configDir, '.config.json.sync'))).toBe(false)
  }, 30_000)
})
