import { afterEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../../../..')
const workerPath = join(import.meta.dir, 'fixtures', 'multi-writer-config-worker.ts')
const temporaryDirectories: string[] = []

function setupConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-config-multi-writer-'))
  temporaryDirectories.push(configDir)
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  }, null, 2))
  writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
    version: 'test',
    description: 'test defaults',
    defaults: {
      notificationsEnabled: true,
      colorTheme: 'default',
      dataSourcesEnabled: false,
      piExtensions: { delegatePromptAutomation: false, enabled: {}, config: {} },
      piShell: { fullPassthrough: true },
    },
    workspaceDefaults: {
      thinkingLevel: 'medium',
      permissionMode: 'ask',
      cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
      localMcpServers: { enabled: true },
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
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
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
    const imported = spawnWorker(configDir, 'colorTheme', 'dark')
    await collect(imported)

    const [bunWriter, electronWriter] = await Promise.all([
      collect(spawnWorker(configDir, 'colorTheme', 'light')),
      collect(spawnWorker(configDir, 'notificationsEnabled', 'false')),
    ])
    void bunWriter
    void electronWriter

    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as Record<string, unknown>
    expect(config.colorTheme).toBe('light')
    expect(config.notificationsEnabled).toBe(false)
    expect(JSON.parse(readFileSync(join(configDir, '.config.json.sync'), 'utf8'))).toEqual(config)
  }, 30_000)
})
