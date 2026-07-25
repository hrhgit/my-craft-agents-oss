import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createImmutableRuntimeEnvironment,
  resolveImmutableRuntimeLayout,
} from './immutable-runtime.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('immutable runtime layout', () => {
  it('validates one canonical layout and projects it without rebuilding fields', () => {
    const fixture = createLayoutFixture();
    const layout = resolveImmutableRuntimeLayout({ env: fixture.env, requireAssets: false });
    expect(layout).toMatchObject({
      appRootPath: fixture.appRootPath,
      resourcesPath: fixture.resourcesPath,
      runtimePath: fixture.runtimePath,
      nodeRuntimePath: fixture.executablePath,
    });
    expect(createImmutableRuntimeEnvironment(layout!)).toMatchObject(fixture.env);
  });

  it('uses Windows case-insensitive path identity for the same capsule', () => {
    if (process.platform !== 'win32') return;
    const fixture = createLayoutFixture();
    const driveCaseVariant = fixture.appRootPath[0] === fixture.appRootPath[0]?.toUpperCase()
      ? fixture.appRootPath[0]!.toLowerCase() + fixture.appRootPath.slice(1)
      : fixture.appRootPath[0]!.toUpperCase() + fixture.appRootPath.slice(1);
    expect(resolveImmutableRuntimeLayout({
      env: fixture.env,
      expectedAppRootPath: driveCaseVariant,
      requireAssets: false,
    })).toBeDefined();
  });

  it('rejects non-file executables at the canonical boundary', () => {
    const fixture = createLayoutFixture();
    rmSync(fixture.executablePath, { force: true });
    mkdirSync(fixture.executablePath, { recursive: true });
    expect(() => resolveImmutableRuntimeLayout({ env: fixture.env, requireAssets: false }))
      .toThrow('must be a file');
  });
});

function createLayoutFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mortise-runtime-layout-'));
  roots.push(root);
  const appRootPath = join(root, 'app');
  const resourcesBasePath = join(appRootPath, 'dist');
  const resourcesPath = join(resourcesBasePath, 'resources');
  const runtimePath = join(resourcesBasePath, 'packaging-inputs', 'runtime');
  const executablePath = process.platform === 'win32'
    ? join(runtimePath, 'electron', 'electron.exe')
    : process.platform === 'darwin'
      ? join(runtimePath, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join(runtimePath, 'electron', 'electron');
  mkdirSync(resourcesPath, { recursive: true });
  mkdirSync(join(executablePath, '..'), { recursive: true });
  writeFileSync(executablePath, 'runtime');
  return {
    appRootPath,
    resourcesPath,
    runtimePath,
    executablePath,
    env: {
      MORTISE_RUNTIME_IMMUTABLE: '1',
      MORTISE_RUNTIME_APP_ROOT: appRootPath,
      MORTISE_RUNTIME_RESOURCES_DIR: resourcesPath,
      MORTISE_RUNTIME_RESOURCES_BASE: resourcesBasePath,
      MORTISE_RUNTIME_BUNDLE_PATH: runtimePath,
      MORTISE_RUNTIME_ELECTRON_PATH: executablePath,
      MORTISE_RUNTIME_NODE_PATH: executablePath,
    },
  };
}
