import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const VALIDATORS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'validators.ts')).href
const TOPOLOGY_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', '..', 'workspaces', 'topology-storage.ts')).href

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([process.execPath, '--eval', code], {
    env: { ...process.env, MORTISE_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
  return run.stdout.toString().trim()
}

describe('SQLite global config authority', () => {
  it('removes only the Workspace registration and preserves markers, files, and Mortise data', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-config-remove-registration-'))
    const workspaceRoot = join(configDir, 'workspace-root')
    const workspaceData = join(configDir, 'workspaces', 'workspace-1')
    const output = runEval(configDir, `
      const { existsSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { removeWorkspace, saveConfig } = await import(${JSON.stringify(STORAGE_MODULE_PATH)});
      const { getDefaultWorkspaceTopologyStore } = await import(${JSON.stringify(TOPOLOGY_MODULE_PATH)});
      const root = ${JSON.stringify(workspaceRoot)};
      const data = ${JSON.stringify(workspaceData)};
      mkdirSync(root, { recursive: true });
      mkdirSync(data, { recursive: true });
      writeFileSync(join(root, 'ordinary.txt'), 'ordinary');
      writeFileSync(join(data, 'session.json'), 'session');
      getDefaultWorkspaceTopologyStore().create({
        schemaVersion: 2,
        id: 'workspace-1',
        revision: 0,
        primaryLocationId: 'primary',
        locations: [{
          id: 'primary',
          name: 'Primary',
          rootName: 'workspace-root',
          endpoint: { kind: 'local', rootPath: root },
        }],
        name: 'workspace-root',
        nameSource: 'derived',
        slug: 'workspace-1',
        createdAt: 1,
      });
      saveConfig({ activeWorkspaceId: 'workspace-1', activeSessionId: null });
      const removed = await removeWorkspace('workspace-1');
      console.log(JSON.stringify({
        removed,
        registered: getDefaultWorkspaceTopologyStore().get('workspace-1') !== null,
        marker: existsSync(join(root, '.mortise', 'workspace.json')),
        ordinary: existsSync(join(root, 'ordinary.txt')),
        sessionData: existsSync(join(data, 'session.json')),
      }));
    `)

    expect(JSON.parse(output)).toEqual({
      removed: true,
      registered: false,
      marker: true,
      ordinary: true,
      sessionData: true,
    })
  }, 30_000)

  it('validates SQLite state while ignoring and preserving retired JSON files', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-config-authority-'))
    const legacyPath = join(configDir, 'config.json')
    const legacyContents = '{ invalid legacy json'
    writeFileSync(legacyPath, legacyContents)

    const output = runEval(configDir, `
      const { saveConfig } = await import(${JSON.stringify(STORAGE_MODULE_PATH)});
      const { validateConfig } = await import(${JSON.stringify(VALIDATORS_MODULE_PATH)});
      saveConfig({ activeWorkspaceId: null, activeSessionId: null });
      console.log(JSON.stringify(validateConfig()));
    `)

    const result = JSON.parse(output) as { valid: boolean; errors: unknown[] }
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyContents)
    expect(existsSync(join(configDir, '.config.json.sync'))).toBe(false)
  }, 30_000)

  it('rejects retired thinking aliases in the canonical SQLite record', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-config-retired-thinking-'))
    const output = runEval(configDir, `
      const { saveConfig } = await import(${JSON.stringify(STORAGE_MODULE_PATH)});
      const { validateConfig } = await import(${JSON.stringify(VALIDATORS_MODULE_PATH)});
      saveConfig({
        activeWorkspaceId: null, activeSessionId: null,
        defaultThinkingLevel: 'think',
      });
      console.log(JSON.stringify(validateConfig()));
    `)

    const result = JSON.parse(output) as { valid: boolean; errors: Array<{ path: string }> }
    expect(result.valid).toBe(false)
    expect(result.errors.some(error => error.path === 'defaultThinkingLevel')).toBe(true)
  }, 30_000)

  it('keeps Workspace topology out of global config and reads the canonical registry', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mortise-config-workspace-authority-'))
    const workspaceRoot = join(configDir, 'canonical-root')
    const output = runEval(configDir, `
      const { mkdirSync } = await import('node:fs');
      const { Database } = await import('bun:sqlite');
      const { getWorkspaces, saveConfig } = await import(${JSON.stringify(STORAGE_MODULE_PATH)});
      const { getDefaultWorkspaceTopologyStore } = await import(${JSON.stringify(TOPOLOGY_MODULE_PATH)});
      mkdirSync(${JSON.stringify(workspaceRoot)}, { recursive: true });
      getDefaultWorkspaceTopologyStore().create({
        schemaVersion: 2,
        id: 'canonical-workspace',
        revision: 0,
        primaryLocationId: 'primary',
        locations: [{
          id: 'primary',
          name: 'Primary',
          rootName: 'canonical-root',
          endpoint: { kind: 'local', rootPath: ${JSON.stringify(workspaceRoot)} },
        }],
        name: 'canonical-root',
        nameSource: 'derived',
        slug: 'canonical-workspace',
        createdAt: 1,
      });
      saveConfig({
        activeWorkspaceId: 'canonical-workspace',
        activeSessionId: null,
        workspaces: [{ id: 'retired-workspace' }],
      });
      const database = new Database(${JSON.stringify(join(configDir, 'state.sqlite'))}, { readonly: true });
      const row = database.query(
        "SELECT value_json FROM mortise_records WHERE namespace = 'config' AND record_key = 'root'",
      ).get();
      const storedConfig = JSON.parse(row.value_json);
      console.log(JSON.stringify({
        hasRetiredTopology: Object.hasOwn(storedConfig, 'workspaces'),
        workspaceIds: getWorkspaces().map(workspace => workspace.id),
      }));
    `)

    expect(JSON.parse(output)).toEqual({
      hasRetiredTopology: false,
      workspaceIds: ['canonical-workspace'],
    })
  }, 30_000)
})
