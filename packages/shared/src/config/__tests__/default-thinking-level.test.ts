import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { THINKING_LEVEL_IDS } from '../../agent/thinking-levels.ts'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupWorkspaceConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'mortise-config-thinking-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: 'ws-config-1',
      name: 'My Workspace',
      slug: 'my-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
    'utf-8',
  )

  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
    }, null, 2),
    'utf-8',
  )

  writeFileSync(
    join(configDir, 'config-defaults.json'),
    JSON.stringify({
      version: 'test',
      description: 'test defaults',
      defaults: {
        notificationsEnabled: true,
        colorTheme: 'default',
        autoCapitalisation: true,
        sendMessageKey: 'enter',
        spellCheck: false,
        keepAwakeWhileRunning: false,
        richToolDescriptions: true,
      },
      workspaceDefaults: {
        thinkingLevel: 'off',
        permissionMode: 'ask',
        cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
      },
    }, null, 2),
    'utf-8',
  )

  return { configDir, configPath }
}

function runEval(configDir: string, code: string): string {
  // Isolate ~/.pi/agent/settings.json to a per-config temp dir so the test
  // neither pollutes the real pi settings nor reads stale real values.
  // getDefaultThinkingLevel() now prefers pi settings.json as the SoT.
  const piAgentDir = join(configDir, 'pi-agent')
  mkdirSync(piAgentDir, { recursive: true })
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getDefaultThinkingLevel, setDefaultThinkingLevel } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, MORTISE_CONFIG_DIR: configDir, PI_CODING_AGENT_DIR: piAgentDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

describe('default thinking level storage', () => {
  it('falls back to bundled default when no app-level default is set', () => {
    const { configDir } = setupWorkspaceConfigDir()
    const output = runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")
    expect(output).toBe('off')
  }, 15_000)

  it('persists defaultThinkingLevel to pi settings without writing config.json', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()

    runEval(configDir, "await setDefaultThinkingLevel('xhigh'); console.log(String(getDefaultThinkingLevel()))")

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.defaultThinkingLevel).toBeUndefined()

    const piSettings = JSON.parse(readFileSync(join(configDir, 'pi-agent', 'settings.json'), 'utf-8'))
    expect(piSettings.defaultThinkingLevel).toBe('xhigh')
  }, 15_000)

  it('round-trips persisted value across processes', () => {
    const { configDir } = setupWorkspaceConfigDir()
    runEval(configDir, "await setDefaultThinkingLevel('medium')")
    const output = runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")
    expect(output).toBe('medium')
  }, 15_000)

  it('supports every thinking level', () => {
    const { configDir } = setupWorkspaceConfigDir()
    const levels = [...THINKING_LEVEL_IDS]
    const output = runEval(
      configDir,
      `
      const levels = ${JSON.stringify(levels)};
      for (const level of levels) {
        await setDefaultThinkingLevel(level);
        console.log(String(getDefaultThinkingLevel()));
      }
      `,
    )
    expect(output.split(/\r?\n/)).toEqual(levels)
  }, 15_000)

  it('normalizes legacy "think" value from pi settings to "medium"', () => {
    const { configDir } = setupWorkspaceConfigDir()
    const piAgentDir = join(configDir, 'pi-agent')
    mkdirSync(piAgentDir, { recursive: true })
    writeFileSync(
      join(piAgentDir, 'settings.json'),
      JSON.stringify({ defaultThinkingLevel: 'think' }, null, 2),
      'utf-8',
    )

    const output = runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")
    expect(output).toBe('medium')
  }, 15_000)

  it('normalizes legacy "max" value to "xhigh"', () => {
    const { configDir } = setupWorkspaceConfigDir()
    runEval(configDir, "await setDefaultThinkingLevel('max'); console.log(String(getDefaultThinkingLevel()))")

    const piSettings = JSON.parse(readFileSync(join(configDir, 'pi-agent', 'settings.json'), 'utf-8'))
    expect(piSettings.defaultThinkingLevel).toBe('xhigh')
  }, 15_000)

  it('does not read legacy defaultThinkingLevel from mortise config', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.defaultThinkingLevel = 'xhigh'
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    const output = runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")
    expect(output).toBe('off')
  }, 15_000)
})
