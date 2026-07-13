import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspaceConfig } from '../storage.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  }
});

describe('workspace storage: config normalization', () => {
  it('removes legacy workspace AI defaults from memory and disk', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-global-ai-defaults-'));
    tempDirs.push(workspaceRoot);

    const configPath = join(workspaceRoot, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      id: 'ws_legacy_ai',
      name: 'Legacy AI Defaults',
      slug: 'legacy-ai-defaults',
      defaults: {
        provider: 'legacy-provider',
        model: 'legacy-model',
        thinkingLevel: 'high',
        permissionMode: 'safe',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2), 'utf-8');

    const loaded = loadWorkspaceConfig(workspaceRoot);
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));

    expect(loaded?.defaults).toEqual({ permissionMode: 'safe' });
    expect(persisted.defaults).toEqual({ permissionMode: 'safe' });
  });

  it('maps canonical defaults.permissionMode and cyclablePermissionModes on read', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-mode-map-'));
    tempDirs.push(workspaceRoot);

    const rawConfig = {
      id: 'ws_123',
      name: 'Test Workspace',
      slug: 'test-workspace',
      defaults: {
        permissionMode: 'explore',
        cyclablePermissionModes: ['explore', 'ask', 'execute'],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf-8');

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaults?.permissionMode).toBe('safe');
    expect(loaded?.defaults?.cyclablePermissionModes).toEqual(['safe', 'ask', 'allow-all']);
  });

  it('falls back to full cycle if persisted cyclablePermissionModes are invalid', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-mode-invalid-'));
    tempDirs.push(workspaceRoot);

    const rawConfig = {
      id: 'ws_456',
      name: 'Broken Modes',
      slug: 'broken-modes',
      defaults: {
        permissionMode: 'execute',
        cyclablePermissionModes: ['unknown'],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf-8');

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaults?.permissionMode).toBe('allow-all');
    expect(loaded?.defaults?.cyclablePermissionModes).toEqual(['safe', 'ask', 'allow-all']);
  });

});
