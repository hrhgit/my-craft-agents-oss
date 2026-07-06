import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import {
  defaultMidStreamBehavior,
  resolveMidStreamBehavior,
  type LlmConnection,
} from '../llm-connections.ts'

// ============================================================
// Pure helpers
// ============================================================

describe('defaultMidStreamBehavior', () => {
  it("returns 'steer' for pi (Pi's native steer is non-destructive)", () => {
    expect(defaultMidStreamBehavior('pi')).toBe('steer')
  })

  it("returns 'steer' for pi_compat (same backend as pi)", () => {
    expect(defaultMidStreamBehavior('pi_compat')).toBe('steer')
  })
})

describe('resolveMidStreamBehavior', () => {
  const basePiAnthropic = { providerType: 'pi' as const, piAuthProvider: 'anthropic' }
  const basePi = { providerType: 'pi' as const }

  it('returns the explicit value when set to steer', () => {
    expect(resolveMidStreamBehavior({ ...basePiAnthropic, midStreamBehavior: 'steer' })).toBe('steer')
  })

  it('returns the explicit value when set to queue', () => {
    expect(resolveMidStreamBehavior({ ...basePi, midStreamBehavior: 'queue' })).toBe('queue')
  })

  it('falls back to default when midStreamBehavior is undefined (legacy connection)', () => {
    expect(resolveMidStreamBehavior(basePiAnthropic)).toBe('steer')
    expect(resolveMidStreamBehavior(basePi)).toBe('steer')
  })

  it('falls back to default when midStreamBehavior has an unknown value (corrupt config.json)', () => {
    const corruptPiAnthropic = { ...basePiAnthropic, midStreamBehavior: 'invalid' as never }
    const corruptPi = { ...basePi, midStreamBehavior: '' as never }
    expect(resolveMidStreamBehavior(corruptPiAnthropic)).toBe('steer')
    expect(resolveMidStreamBehavior(corruptPi)).toBe('steer')
  })
})

// ============================================================
// Storage round-trip — updateLlmConnection persists midStreamBehavior
// ============================================================

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfig(llmConnections: LlmConnection[]) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-midstream-'))
  const piAgentDir = join(configDir, 'pi-agent')
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(piAgentDir, { recursive: true })

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

  writeFileSync(
    join(piAgentDir, 'models.json'),
    JSON.stringify({ providers: {}, craftConnections: llmConnections }, null, 2),
    'utf-8',
  )

  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      defaultLlmConnection: llmConnections[0]?.slug ?? null,
    }, null, 2),
    'utf-8',
  )

  function runUpdate(slug: string, updates: Record<string, unknown>): boolean {
    const updatesJson = JSON.stringify(updates)
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { updateLlmConnection } from '${STORAGE_MODULE_PATH}'; const ok = updateLlmConnection(${JSON.stringify(slug)}, ${updatesJson}); process.exit(ok ? 0 : 1);`,
    ], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir, PI_CODING_AGENT_DIR: piAgentDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (run.exitCode !== 0 && run.stderr.toString().trim()) {
      throw new Error(`update subprocess failed:\n${run.stderr.toString()}`)
    }
    return run.exitCode === 0
  }

  function readConnection(slug: string) {
    const models = JSON.parse(readFileSync(join(piAgentDir, 'models.json'), 'utf-8'))
    return models.craftConnections.find((c: { slug: string }) => c.slug === slug)
  }

  return { runUpdate, readConnection }
}

function makeConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'pi-test',
    name: 'Test Connection',
    providerType: 'pi',
    authType: 'api_key',
    createdAt: Date.now(),
    midStreamBehavior: 'steer',
    ...overrides,
  }
}

describe('updateLlmConnection persists midStreamBehavior', () => {
  it("flips midStreamBehavior from 'steer' to 'queue'", () => {
    const { runUpdate, readConnection } = setupConfig([makeConnection({ midStreamBehavior: 'steer' })])
    expect(runUpdate('pi-test', { midStreamBehavior: 'queue' })).toBe(true)
    expect(readConnection('pi-test').midStreamBehavior).toBe('queue')
  })

  it("flips midStreamBehavior from 'queue' to 'steer'", () => {
    const { runUpdate, readConnection } = setupConfig([
      makeConnection({ providerType: 'pi', piAuthProvider: 'anthropic', authType: 'api_key', midStreamBehavior: 'queue' }),
    ])
    expect(runUpdate('pi-test', { midStreamBehavior: 'steer' })).toBe(true)
    expect(readConnection('pi-test').midStreamBehavior).toBe('steer')
  })

  it('preserves existing midStreamBehavior when other fields are updated', () => {
    const { runUpdate, readConnection } = setupConfig([makeConnection({ midStreamBehavior: 'queue' })])
    expect(runUpdate('pi-test', { name: 'Renamed' })).toBe(true)
    const updated = readConnection('pi-test')
    expect(updated.name).toBe('Renamed')
    expect(updated.midStreamBehavior).toBe('queue')
  })

  it('seeds midStreamBehavior from undefined when patch sets it explicitly', () => {
    // Legacy connection (no midStreamBehavior on disk) — patch sets it.
    const { runUpdate, readConnection } = setupConfig([makeConnection({ midStreamBehavior: undefined })])
    expect(runUpdate('pi-test', { midStreamBehavior: 'queue' })).toBe(true)
    expect(readConnection('pi-test').midStreamBehavior).toBe('queue')
  })
})
