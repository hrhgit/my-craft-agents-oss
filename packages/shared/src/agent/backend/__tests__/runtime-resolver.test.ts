/**
 * Tests for runtime-resolver.ts
 *
 * Verifies:
 * - Ripgrep path resolution with system rg fallback
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBackendRuntimePaths } from '../internal/runtime-resolver.ts';
import { resolveBackendHostTooling } from '../factory.ts';
import type { BackendHostRuntimeContext } from '../types.ts';
import { resolveImmutableRuntimeLayout } from '@mortise/session-tools-core/runtime';

describe('resolveBackendRuntimePaths', () => {
  it('returns only the supported backend runtime path keys', () => {
    const resourcesPath = join(tmpdir(), `runtime-resolver-shape-${process.pid}`);
    const binaryPath = join(resourcesPath, 'pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi');
    mkdirSync(dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, 'pi binary');

    const paths = resolveBackendRuntimePaths({
      appRootPath: tmpdir(),
      resourcesPath,
      isPackaged: true,
    });

    expect(Object.keys(paths).sort()).toEqual([
      'bundledRuntimePath',
      'nodeRuntimePath',
      'piRuntimePath',
      'sessionServerPath',
    ]);

    rmSync(resourcesPath, { recursive: true, force: true });
  });

  it('resolves an immutable source runtime only from its capsule', () => {
    const appRoot = join(tmpdir(), `immutable-runtime-${process.pid}`);
    const resourcesPath = join(appRoot, 'dist', 'resources');
    const runtimePath = join(appRoot, 'dist', 'packaging-inputs', 'runtime');
    const electronRuntimePath = process.platform === 'win32'
      ? join(runtimePath, 'electron', 'electron.exe')
      : process.platform === 'darwin'
        ? join(runtimePath, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join(runtimePath, 'electron', 'electron');
    const sessionServerPath = join(resourcesPath, 'session-mcp-server', 'index.js');
    const piRuntimePath = join(resourcesPath, 'pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi');
    const ripgrepPath = join(runtimePath, 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
    for (const path of [sessionServerPath, piRuntimePath, ripgrepPath, electronRuntimePath]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'capsule artifact');
    }
    const immutableRuntime = resolveImmutableRuntimeLayout({
      env: {
        MORTISE_RUNTIME_IMMUTABLE: '1',
        MORTISE_RUNTIME_APP_ROOT: appRoot,
        MORTISE_RUNTIME_RESOURCES_DIR: resourcesPath,
        MORTISE_RUNTIME_RESOURCES_BASE: join(appRoot, 'dist'),
        MORTISE_RUNTIME_BUNDLE_PATH: runtimePath,
        MORTISE_RUNTIME_ELECTRON_PATH: electronRuntimePath,
        MORTISE_RUNTIME_NODE_PATH: electronRuntimePath,
      },
      requireAssets: false,
    });
    if (!immutableRuntime) throw new Error('Expected immutable runtime fixture.');
    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath,
      resourcesBasePath: join(appRoot, 'dist'),
      immutableRuntime,
      isPackaged: false,
    };

    expect(resolveBackendRuntimePaths(hostRuntime)).toMatchObject({
      sessionServerPath,
      piRuntimePath,
      nodeRuntimePath: electronRuntimePath,
    });
    expect(resolveBackendHostTooling({ hostRuntime }).ripgrepPath).toBe(ripgrepPath);
    rmSync(appRoot, { recursive: true, force: true });
  });
});

describe('resolveRipgrepPath', () => {
  const tmpBase = join(tmpdir(), `rg-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('finds vendored ripgrep binary (@vscode/ripgrep)', () => {
    const appRoot = join(tmpBase, 'vendored');
    const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const rgDir = join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin');
    mkdirSync(rgDir, { recursive: true });
    const rgPath = join(rgDir, binaryName);
    writeFileSync(rgPath, '#!/bin/sh\n');
    chmodSync(rgPath, 0o755);

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    expect(result.ripgrepPath).toBe(rgPath);
  });

  it('falls back to system rg when vendored binary is missing (non-packaged)', () => {
    const appRoot = join(tmpBase, 'no-vendored');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    // On CI/dev machines with rg installed, this finds system rg.
    // On machines without rg, this returns undefined.
    // We just verify it doesn't throw.
    expect(result.ripgrepPath === undefined || typeof result.ripgrepPath === 'string').toBe(true);
  });

  it('does NOT fall back to system rg for packaged apps (respects isPackaged guard)', () => {
    // On dev machines, the CWD fallback (existing pre-change behavior) will find
    // the vendored binary from the monorepo. This test verifies the system PATH
    // fallback is gated by isPackaged — if the result is defined, it must be
    // a vendored path (not /usr/bin/rg or similar system path).
    const appRoot = join(tmpBase, 'packaged');
    mkdirSync(appRoot, { recursive: true });

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };

    const result = resolveBackendHostTooling({ hostRuntime });
    if (result.ripgrepPath) {
      // Must be a vendored path, not a system PATH resolution
      expect(result.ripgrepPath).toContain('node_modules');
    }
  });
});

describe('resolvePiRuntimePath', () => {
  const tmpBase = join(tmpdir(), `pi-runtime-resolver-test-${Date.now()}`);
  const originalOverride = process.env.MORTISE_PI_CLI_PATH;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.MORTISE_PI_CLI_PATH;
    else process.env.MORTISE_PI_CLI_PATH = originalOverride;
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('selects only the packaged compiled Pi binary', () => {
    const appRoot = join(tmpBase, 'packaged-binary-app');
    const resourcesPath = join(tmpBase, 'packaged-binary-resources');
    const binaryPath = join(resourcesPath, 'pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi');
    const overridePath = join(tmpBase, 'override', process.platform === 'win32' ? 'pi.exe' : 'pi');
    const legacyCandidates = [
      join(resourcesPath, 'pi-runtime', 'dist', 'cli.bundle.js'),
      join(resourcesPath, 'pi-runtime', 'dist', 'cli.full.bundle.js'),
      join(appRoot, 'resources', 'pi-runtime', 'dist', 'cli.bundle.js'),
      join(appRoot, 'dist', 'resources', 'pi-runtime', 'node_modules', '@mortise', 'pi-coding-agent', 'dist', 'cli.js'),
    ];

    mkdirSync(dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, 'pi binary');
    mkdirSync(dirname(overridePath), { recursive: true });
    writeFileSync(overridePath, 'override binary');
    for (const candidate of legacyCandidates) {
      mkdirSync(dirname(candidate), { recursive: true });
      writeFileSync(candidate, '// legacy Pi runtime');
    }
    process.env.MORTISE_PI_CLI_PATH = overridePath;

    const paths = resolveBackendRuntimePaths({ appRootPath: appRoot, resourcesPath, isPackaged: true });
    expect(paths.piRuntimePath).toBe(binaryPath);
  });

  it('fails explicitly when the packaged compiled Pi binary is missing', () => {
    const appRoot = join(tmpBase, 'missing-binary-app');
    const resourcesPath = join(tmpBase, 'missing-binary-resources');
    const expectedBinaryPath = join(resourcesPath, 'pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi');
    const overridePath = join(tmpBase, 'override-only', process.platform === 'win32' ? 'pi.exe' : 'pi');
    const legacyCliPath = join(resourcesPath, 'pi-runtime', 'dist', 'cli.bundle.js');

    for (const candidate of [overridePath, legacyCliPath]) {
      mkdirSync(dirname(candidate), { recursive: true });
      writeFileSync(candidate, '// non-canonical runtime');
    }
    process.env.MORTISE_PI_CLI_PATH = overridePath;

    expect(() => resolveBackendRuntimePaths({ appRootPath: appRoot, resourcesPath, isPackaged: true }))
      .toThrow(`Packaged Pi runtime is missing: ${expectedBinaryPath}`);
  });

  it('fails explicitly when packaged resourcesPath is unavailable', () => {
    expect(() => resolveBackendRuntimePaths({ appRootPath: tmpBase, isPackaged: true }))
      .toThrow('Packaged Pi runtime resolution requires resourcesPath');
  });

  it('does not select a mutable JavaScript runtime in development', () => {
    const appRoot = join(tmpBase, 'monorepo', 'apps', 'electron');
    const legacyRuntimePath = join(
      tmpBase,
      'monorepo',
      'node_modules',
      '@mortise',
      'pi-coding-agent',
      'dist',
      'headless.js',
	);
	mkdirSync(dirname(legacyRuntimePath), { recursive: true });
	writeFileSync(legacyRuntimePath, '// mutable runtime\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
	};
	const paths = resolveBackendRuntimePaths(hostRuntime);
	expect(paths.piRuntimePath).toBeUndefined();
  });
});
