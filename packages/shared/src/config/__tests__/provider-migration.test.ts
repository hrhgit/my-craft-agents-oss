import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_URL = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function run(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'mortise-provider-migration-'))
  const piDir = join(root, 'pi')
  mkdirSync(piDir, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    defaultLlmConnection: 'old-anthropic',
    llmConnections: [{
      slug: 'old-anthropic',
      name: 'Old Anthropic',
      providerType: 'pi',
      authType: 'api_key',
      piAuthProvider: 'anthropic',
      models: [{ id: 'claude-test', name: 'Claude Test', supportsImages: true }],
      defaultModel: 'claude-test',
      createdAt: 1,
    }],
  }))
  writeFileSync(join(piDir, 'models.json'), JSON.stringify({ providers: {} }))
  writeFileSync(join(piDir, 'settings.json'), '{}')
  const proc = Bun.spawnSync([process.execPath, '--eval', source], {
    env: { ...process.env, MORTISE_CONFIG_DIR: root, PI_CODING_AGENT_DIR: piDir },
    stdout: 'pipe', stderr: 'pipe',
  })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  return { root, piDir, value: JSON.parse(proc.stdout.toString()) }
}

describe('legacy provider migration', () => {
  it('imports providers and never writes retired config fields back', () => {
    const result = run(`
      import { writeFileSync } from 'fs';
      import { join } from 'path';
      import { loadStoredConfig, saveConfig } from ${JSON.stringify(STORAGE_URL)};
      writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({
        providers: {},
        mortiseConnections: [{
          slug: 'old-anthropic',
          piAuthProvider: 'anthropic',
          models: [{ id: 'claude-test', supportsImages: true }],
        }],
      }));
      const config = loadStoredConfig();
      saveConfig(config);
      console.log(JSON.stringify(config));
    `)
    const config = JSON.parse(readFileSync(join(result.root, 'config.json'), 'utf8'))
    const models = JSON.parse(readFileSync(join(result.piDir, 'models.json'), 'utf8'))
    const settings = JSON.parse(readFileSync(join(result.piDir, 'settings.json'), 'utf8'))
    expect(result.value.defaultLlmConnection).toBeUndefined()
    expect(config.defaultLlmConnection).toBeUndefined()
    expect(config.llmConnections).toBeUndefined()
    expect(models.mortiseConnections).toEqual([])
    expect(models.providers.anthropic.models[0]).toMatchObject({
      id: 'claude-test', input: ['text', 'image'],
    })
    expect(settings).toMatchObject({ defaultProvider: 'anthropic', defaultModel: 'claude-test' })
  }, 30000)

  it('keeps workspace and legacy provider data when Pi migration fails', () => {
    const result = run(`
      import { readFileSync, readdirSync, writeFileSync } from 'fs';
      import { join } from 'path';
      import { loadStoredConfig, saveConfig } from ${JSON.stringify(STORAGE_URL)};

      const configPath = join(process.env.MORTISE_CONFIG_DIR, 'config.json');
      const rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      rawConfig.workspaces = [{
        id: 'workspace-1',
        name: 'Workspace One',
        rootPath: join(process.env.MORTISE_CONFIG_DIR, 'workspace-one'),
        createdAt: 1,
      }];
      writeFileSync(configPath, JSON.stringify(rawConfig));
      writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), '{ not valid json');

      const config = loadStoredConfig();
      if (config) saveConfig(config);
      console.log(JSON.stringify({
        workspaceIds: config?.workspaces.map(workspace => workspace.id),
        keepsLegacyConnections: Object.hasOwn(config ?? {}, 'llmConnections'),
        corruptBackups: readdirSync(process.env.MORTISE_CONFIG_DIR)
          .filter(name => name.includes('.corrupt-')),
      }));
    `)
    const config = JSON.parse(readFileSync(join(result.root, 'config.json'), 'utf8'))

    expect(result.value).toEqual({
      workspaceIds: ['workspace-1'],
      keepsLegacyConnections: true,
      corruptBackups: [],
    })
    expect(config).toMatchObject({
      defaultLlmConnection: 'old-anthropic',
      llmConnections: [{ slug: 'old-anthropic' }],
      workspaces: [{ id: 'workspace-1' }],
    })
  }, 30000)

  it('stores steer/queue globally and rejects invalid values', () => {
    const result = run(`
      import { getMidStreamBehavior, setMidStreamBehavior } from ${JSON.stringify(STORAGE_URL)};
      const before = getMidStreamBehavior();
      const invalid = setMidStreamBehavior('abort');
      const valid = setMidStreamBehavior('steer');
      console.log(JSON.stringify({ before, invalid, valid, after: getMidStreamBehavior() }));
    `)
    expect(result.value).toEqual({ before: 'queue', invalid: false, valid: true, after: 'steer' })
  }, 30000)
})
