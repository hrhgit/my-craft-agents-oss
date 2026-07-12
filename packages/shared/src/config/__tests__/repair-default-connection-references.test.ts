import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const REPAIR_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'migrations', 'repair-default-connection-references.ts')).href;
const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;

function setup(options: {
  defaultSlug?: string;
  workspaceDefaultSlug?: string;
  includeProvider?: boolean;
  includeCraftConnection?: boolean;
  includeRetiredFields?: boolean;
}) {
  const configDir = mkdtempSync(join(tmpdir(), 'default-connection-repair-'));
  const piAgentDir = join(configDir, 'pi-agent');
  const workspaceRoot = join(configDir, 'workspace');
  mkdirSync(piAgentDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });

  writeFileSync(join(piAgentDir, 'models.json'), JSON.stringify({
    providers: options.includeProvider ? {
      cloud: {
        baseUrl: 'https://example.test/v1',
        api: 'openai-responses',
        models: [{ id: 'cloud-model', name: 'Cloud Model' }],
      },
    } : {},
    craftConnections: options.includeCraftConnection ? [{
      slug: 'craft-local',
      name: 'Craft Local',
      providerType: 'pi_compat',
      authType: 'none',
      createdAt: 1,
    }] : [],
  }, null, 2));

  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
    id: 'workspace-config',
    name: 'Workspace',
    slug: 'workspace',
    defaults: options.workspaceDefaultSlug
      ? { defaultLlmConnection: options.workspaceDefaultSlug }
      : {},
    createdAt: 1,
    updatedAt: 1,
  }, null, 2));

  const config: Record<string, unknown> = {
    workspaces: [{ id: 'workspace-id', name: 'Workspace', rootPath: workspaceRoot, createdAt: 1 }],
    activeWorkspaceId: 'workspace-id',
    activeSessionId: null,
  };
  if (options.defaultSlug) config.defaultLlmConnection = options.defaultSlug;
  if (options.includeRetiredFields) {
    config.llmConnections = [{ slug: 'retired' }];
    config.migrationsApplied = ['retired-migration'];
  }
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2));

  return { configDir, piAgentDir, workspaceRoot };
}

function run(env: ReturnType<typeof setup>, source: string): unknown {
  const result = Bun.spawnSync([process.execPath, '--eval', source], {
    env: {
      ...process.env,
      CRAFT_CONFIG_DIR: env.configDir,
      PI_CODING_AGENT_DIR: env.piAgentDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`config subprocess failed:\n${result.stderr.toString()}`);
  }
  return JSON.parse(result.stdout.toString());
}

describe('repairDefaultLlmConnectionReferences', () => {
  it('keeps provider-derived defaults and clears only orphaned workspace references', () => {
    const env = setup({
      defaultSlug: 'pi-cloud',
      workspaceDefaultSlug: 'missing',
      includeProvider: true,
      includeCraftConnection: true,
    });
    const output = run(env, `
      import { readFileSync } from 'fs';
      import { join } from 'path';
      import { repairDefaultLlmConnectionReferences } from ${JSON.stringify(REPAIR_MODULE_PATH)};
      repairDefaultLlmConnectionReferences();
      console.log(JSON.stringify({
        config: JSON.parse(readFileSync(join(process.env.CRAFT_CONFIG_DIR, 'config.json'), 'utf8')),
        workspace: JSON.parse(readFileSync(${JSON.stringify(join(env.workspaceRoot, 'config.json'))}, 'utf8')),
      }));
    `) as { config: { defaultLlmConnection?: string }; workspace: { defaults: { defaultLlmConnection?: string } } };

    expect(output.config.defaultLlmConnection).toBe('pi-cloud');
    expect(output.workspace.defaults.defaultLlmConnection).toBeUndefined();
    const models = JSON.parse(readFileSync(join(env.piAgentDir, 'models.json'), 'utf8'));
    expect(models.craftConnections[0].slug).toBe('craft-local');
  });

  it('repairs an orphaned global default from the canonical connection list', () => {
    const env = setup({ defaultSlug: 'missing', includeProvider: true });
    const output = run(env, `
      import { readFileSync } from 'fs';
      import { join } from 'path';
      import { repairDefaultLlmConnectionReferences } from ${JSON.stringify(REPAIR_MODULE_PATH)};
      repairDefaultLlmConnectionReferences();
      console.log(readFileSync(join(process.env.CRAFT_CONFIG_DIR, 'config.json'), 'utf8'));
    `) as { defaultLlmConnection?: string };
    expect(output.defaultLlmConnection).toBe('pi-cloud');
  });

  it('drops retired StoredConfig fields on the next save', () => {
    const env = setup({ includeRetiredFields: true });
    const output = run(env, `
      import { readFileSync } from 'fs';
      import { join } from 'path';
      import { loadStoredConfig, saveConfig } from ${JSON.stringify(STORAGE_MODULE_PATH)};
      const config = loadStoredConfig();
      saveConfig(config);
      console.log(readFileSync(join(process.env.CRAFT_CONFIG_DIR, 'config.json'), 'utf8'));
    `) as Record<string, unknown>;
    expect(output.llmConnections).toBeUndefined();
    expect(output.migrationsApplied).toBeUndefined();
  });
});
