import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { THINKING_LEVEL_IDS } from '../../agent/thinking-levels.ts'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const BUNDLED_CONFIG_DEFAULTS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  'apps',
  'electron',
  'resources',
  'config-defaults.json',
)

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
      },
    }, null, 2),
    'utf-8',
  )

  return { configDir, configPath }
}

function runEval(configDir: string, code: string): string {
  // Isolate the Mortise Agent settings from real user state.
  const piAgentDir = join(configDir, 'agent')
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
  it('ships a current thinking level in the bundled defaults', () => {
    const bundledDefaults = JSON.parse(readFileSync(BUNDLED_CONFIG_DEFAULTS_PATH, 'utf-8')) as {
      workspaceDefaults?: { thinkingLevel?: unknown }
    }
    const bundledLevel = bundledDefaults.workspaceDefaults?.thinkingLevel

    expect(THINKING_LEVEL_IDS).toContain(bundledLevel as (typeof THINKING_LEVEL_IDS)[number])
    expect(bundledLevel).toBe('medium')
    expect(bundledLevel).not.toBe('think')
    expect(bundledLevel).not.toBe('max')
  })

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

    const piSettings = JSON.parse(readFileSync(join(configDir, 'agent', 'settings.json'), 'utf-8'))
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

  it('rejects the retired "think" value persisted in pi settings instead of migrating it', () => {
    const { configDir } = setupWorkspaceConfigDir()
    const piAgentDir = join(configDir, 'agent')
    mkdirSync(piAgentDir, { recursive: true })
    writeFileSync(
      join(piAgentDir, 'settings.json'),
      JSON.stringify({ defaultThinkingLevel: 'think' }, null, 2),
      'utf-8',
    )

    // No aliasing/migration: the retired literal is invalid, so the getter
    // falls back to the workspace default ('off') rather than returning 'medium'.
    // Mutation guard: if the think -> medium alias is reintroduced, this fails.
    const output = runEval(configDir, "console.log(String(getDefaultThinkingLevel()))")
    expect(output).toBe('off')
    expect(output).not.toBe('medium')
  }, 15_000)

  it('accepts the "max" value at the setter boundary and persists it', () => {
    const { configDir } = setupWorkspaceConfigDir()
    // max is a current thinking level, so the setter must accept and persist it.
    const accepted = runEval(configDir, "console.log(String(await setDefaultThinkingLevel('max')))")
    expect(accepted).toBe('true')

    const piSettingsPath = join(configDir, 'agent', 'settings.json')
    const persistedLevel = existsSync(piSettingsPath)
      ? (JSON.parse(readFileSync(piSettingsPath, 'utf-8')) as { defaultThinkingLevel?: unknown }).defaultThinkingLevel
      : undefined
    expect(persistedLevel).toBe('max')
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
