import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-data-sources-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: [],
      activeWorkspaceId: null,
      activeSessionId: null,
    }, null, 2),
    'utf-8',
  )
  return { configDir, configPath }
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getDataSourcesEnabled, setDataSourcesEnabled } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

describe('data-source feature storage', () => {
  it('defaults to enabled for existing configs', () => {
    const { configDir } = setupConfigDir()
    expect(runEval(configDir, 'console.log(String(getDataSourcesEnabled()))')).toBe('true')
  })

  it('persists disabled state in the global config', () => {
    const { configDir, configPath } = setupConfigDir()
    expect(runEval(configDir, 'setDataSourcesEnabled(false); console.log(String(getDataSourcesEnabled()))')).toBe('false')

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.dataSourcesEnabled).toBe(false)
  })

  it('round-trips enabled state across processes', () => {
    const { configDir, configPath } = setupConfigDir()
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.dataSourcesEnabled = false
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    runEval(configDir, 'setDataSourcesEnabled(true)')
    expect(runEval(configDir, 'console.log(String(getDataSourcesEnabled()))')).toBe('true')
  }, 10_000)
})
