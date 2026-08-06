import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;
const CONFIG_STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', '..', 'config', 'storage.ts')).href;

function runEval(configDir: string, code: string): unknown {
  const run = Bun.spawnSync([process.execPath, '--eval', `
    const { ensureConfigDir } = await import(${JSON.stringify(CONFIG_STORAGE_MODULE_PATH)});
    ensureConfigDir();
    const storage = await import(${JSON.stringify(STORAGE_MODULE_PATH)});
    const result = await (async () => { ${code} })();
    storage.closeWorkspaceStorage();
    console.log(JSON.stringify(result));
  `], {
    env: { ...process.env, MORTISE_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString().trim());
}

describe('workspace storage: SQLite authority', () => {
  it('exposes the side-effect-free current record identity contract', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-workspace-identity-'));
    const result = runEval(configDir, `
      return {
        namespace: storage.normalizeWorkspaceRecordNamespace('C:\\\\Users\\\\Mortise\\\\Workspace'),
        identity: storage.getWorkspaceConfigRecordIdentity('C:\\\\Users\\\\Mortise\\\\Workspace'),
        databaseExists: require('node:fs').existsSync(require('node:path').join(process.env.MORTISE_CONFIG_DIR, 'state.sqlite')),
      };
    `) as { namespace: string; identity: object; databaseExists: boolean };

    expect(result).toEqual({
      namespace: 'C:/Users/Mortise/Workspace',
      identity: { namespace: 'C:/Users/Mortise/Workspace', key: 'root' },
      databaseExists: false,
    });
  });

  it('creates, loads, and validates a workspace exclusively through state.sqlite', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-create-'));
    const configDir = join(root, 'config');
    const workspaceRoot = join(root, 'workspace');
    const result = runEval(configDir, `
      const created = storage.createWorkspaceAtPath(${JSON.stringify(workspaceRoot)}, 'SQLite Only');
      const loaded = storage.loadWorkspaceConfig(${JSON.stringify(workspaceRoot)});
      return {
        createdId: created.id,
        loaded,
        valid: storage.isValidWorkspace(${JSON.stringify(workspaceRoot)}),
      };
    `) as { createdId: string; loaded: { id: string; name: string; slug: string }; valid: boolean };

    expect(result.loaded).toMatchObject({
      id: result.createdId,
      name: 'SQLite Only',
      slug: 'sqlite-only',
    });
    expect(result.valid).toBe(true);
    expect(existsSync(join(configDir, 'state.sqlite'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'config.json'))).toBe(false);
    expect(existsSync(join(workspaceRoot, '.mortise-config.sync'))).toBe(false);
    expect(existsSync(join(workspaceRoot, 'sources'))).toBe(false);
  });

  it('ignores and preserves retired workspace-local configuration files', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-retired-json-'));
    const configDir = join(root, 'config');
    const workspaceRoot = join(root, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    const legacyConfigPath = join(workspaceRoot, 'config.json');
    const legacySyncPath = join(workspaceRoot, '.mortise-config.sync');
    const legacyConfig = '{ invalid retired config';
    const legacySync = '{"old":true}';
    writeFileSync(legacyConfigPath, legacyConfig, 'utf8');
    writeFileSync(legacySyncPath, legacySync, 'utf8');

    const result = runEval(configDir, `
      const before = {
        loaded: storage.loadWorkspaceConfig(${JSON.stringify(workspaceRoot)}),
        valid: storage.isValidWorkspace(${JSON.stringify(workspaceRoot)}),
      };
      storage.createWorkspaceAtPath(${JSON.stringify(workspaceRoot)}, 'Current Workspace');
      return { before, currentName: storage.loadWorkspaceConfig(${JSON.stringify(workspaceRoot)})?.name };
    `) as { before: { loaded: unknown; valid: boolean }; currentName: string };

    expect(result.before).toEqual({ loaded: null, valid: false });
    expect(result.currentName).toBe('Current Workspace');
    expect(readFileSync(legacyConfigPath, 'utf8')).toBe(legacyConfig);
    expect(readFileSync(legacySyncPath, 'utf8')).toBe(legacySync);
  });

  it('loads retired permission aliases and drops them on the next save', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-retired-mode-'));
    const configDir = join(root, 'config');
    const workspaceRoot = join(root, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    const result = runEval(configDir, `
      const { MultiWriterStore } = await import('@mortise/shared/storage');
      const { join } = await import('node:path');
      const now = Date.now();
      const retired = {
        id: 'ws_retired_mode', name: 'Retired Mode', slug: 'retired-mode',
        defaults: {
          permissionMode: 'explore',
          cyclablePermissionModes: ['explore', 'ask', 'execute'],
        },
        createdAt: now, updatedAt: now,
      };
      const identity = storage.getWorkspaceConfigRecordIdentity(${JSON.stringify(workspaceRoot)});
      const databasePath = join(process.env.MORTISE_CONFIG_DIR, 'state.sqlite');
      const seedStore = MultiWriterStore.openSync({
        databasePath, writerId: 'retired-mode-seed', writerVersion: 1,
      });
      seedStore.mutateRecord({
        namespace: identity.namespace, key: identity.key, value: retired,
        expectedVersion: null, operationId: 'retired-mode-seed',
      });
      seedStore.close();
      const loaded = storage.loadWorkspaceConfig(${JSON.stringify(workspaceRoot)});
      let saveError = null;
      try { storage.saveWorkspaceConfig(${JSON.stringify(workspaceRoot)}, loaded); }
      catch (error) { saveError = error instanceof Error ? error.message : String(error); }
      const verifyStore = MultiWriterStore.openSync({
        databasePath, writerId: 'retired-mode-verify', writerVersion: 1,
      });
      const persisted = verifyStore.getRecord(identity.namespace, identity.key)?.value;
      verifyStore.close();
      return {
        loaded,
        valid: storage.isValidWorkspace(${JSON.stringify(workspaceRoot)}),
        saveError,
        persisted,
      };
    `) as { loaded: unknown; valid: boolean; saveError: string | null; persisted: { defaults: object } };

    expect(result.loaded).toMatchObject({ name: 'Retired Mode', defaults: {} });
    expect(result.valid).toBe(true);
    expect(result.saveError).toBeNull();
    expect(result.persisted.defaults).toEqual({});
  });

  it('never writes retired permission defaults from current callers', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-current-write-'));
    const configDir = join(root, 'config');
    const createdRoot = join(root, 'created');
    const savedRoot = join(root, 'saved');
    const result = runEval(configDir, `
      const created = storage.createWorkspaceAtPath(${JSON.stringify(createdRoot)}, 'Created', {
        colorTheme: 'graphite',
        permissionMode: 'allow-all',
        cyclablePermissionModes: ['ask', 'allow-all'],
      });
      const now = Date.now();
      storage.saveWorkspaceConfig(${JSON.stringify(savedRoot)}, {
        id: 'ws_saved', name: 'Saved', slug: 'saved',
        defaults: {
          colorTheme: 'paper',
          permissionMode: 'ask',
          cyclablePermissionModes: ['ask', 'allow-all'],
        },
        createdAt: now, updatedAt: now,
      });
      return {
        created,
        createdLoaded: storage.loadWorkspaceConfig(${JSON.stringify(createdRoot)}),
        savedLoaded: storage.loadWorkspaceConfig(${JSON.stringify(savedRoot)}),
      };
    `) as {
      created: { defaults: object };
      createdLoaded: { defaults: object };
      savedLoaded: { defaults: object };
    };

    expect(result.created.defaults).toEqual({ colorTheme: 'graphite' });
    expect(result.createdLoaded.defaults).toEqual({ colorTheme: 'graphite' });
    expect(result.savedLoaded.defaults).toEqual({ colorTheme: 'paper' });
  });

  it('preserves optimistic concurrency for workspace writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-cas-'));
    const configDir = join(root, 'config');
    const workspaceRoot = join(root, 'workspace');
    const result = runEval(configDir, `
      storage.createWorkspaceAtPath(${JSON.stringify(workspaceRoot)}, 'Original');
      const first = storage.loadWorkspaceConfig(${JSON.stringify(workspaceRoot)});
      const stale = storage.loadWorkspaceConfig(${JSON.stringify(workspaceRoot)});
      first.name = 'First Writer';
      storage.saveWorkspaceConfig(${JSON.stringify(workspaceRoot)}, first);
      stale.name = 'Stale Writer';
      let conflict = null;
      try { storage.saveWorkspaceConfig(${JSON.stringify(workspaceRoot)}, stale); }
      catch (error) { conflict = error instanceof Error ? error.message : String(error); }
      return { conflict, name: storage.loadWorkspaceConfig(${JSON.stringify(workspaceRoot)}).name };
    `) as { conflict: string; name: string };

    expect(result.conflict).toContain('write conflicted');
    expect(result.name).toBe('First Writer');
  });

  it('discovers default-location workspaces by SQLite record, not config.json', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-workspace-discovery-'));
    const currentRoot = join(configDir, 'workspaces', 'current');
    const legacyRoot = join(configDir, 'workspaces', 'legacy-json-only');
    mkdirSync(legacyRoot, { recursive: true });
    writeFileSync(join(legacyRoot, 'config.json'), '{"name":"Legacy"}', 'utf8');

    const result = runEval(configDir, `
      storage.createWorkspaceAtPath(${JSON.stringify(currentRoot)}, 'Current');
      return storage.discoverWorkspacesInDefaultLocation();
    `);

    expect(result).toEqual([currentRoot]);
  });

  it('leaves retired organization and source data untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-workspace-retired-data-'));
    const configDir = join(root, 'config');
    const workspaceRoot = join(root, 'workspace');
    mkdirSync(join(workspaceRoot, 'labels'), { recursive: true });
    mkdirSync(join(workspaceRoot, 'statuses'), { recursive: true });
    mkdirSync(join(workspaceRoot, 'sources', 'example-source'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'labels', 'config.json'), '{"labels":[]}', 'utf8');
    writeFileSync(join(workspaceRoot, 'statuses', 'config.json'), '{"statuses":[]}', 'utf8');
    writeFileSync(join(workspaceRoot, 'sources', 'example-source', 'config.json'), '{"type":"mcp"}', 'utf8');
    writeFileSync(join(workspaceRoot, 'views.json'), '{"views":[]}', 'utf8');

    runEval(configDir, `
      storage.createWorkspaceAtPath(${JSON.stringify(workspaceRoot)}, 'Opaque Legacy Data');
      return storage.loadWorkspaceConfig(${JSON.stringify(workspaceRoot)}) !== null;
    `);
    expect(existsSync(join(workspaceRoot, 'labels', 'config.json'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'statuses', 'config.json'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'sources', 'example-source', 'config.json'))).toBe(true);
    expect(existsSync(join(workspaceRoot, 'views.json'))).toBe(true);
  });
});
