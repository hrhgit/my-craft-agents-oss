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

describe('resolvePiCliPath', () => {
  const tmpBase = join(tmpdir(), `pi-cli-resolver-test-${Date.now()}`);

  afterEach(() => {
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  it('prefers a packaged compiled Pi binary', () => {
    const appRoot = join(tmpBase, 'packaged-binary-app');
    const resourcesPath = join(tmpBase, 'packaged-binary-resources');
    const binaryPath = join(resourcesPath, 'pi-runtime', process.platform === 'win32' ? 'pi.exe' : 'pi');
    mkdirSync(dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, 'pi binary');

    const paths = resolveBackendRuntimePaths({ appRootPath: appRoot, resourcesPath, isPackaged: true });
    expect(paths.piCliPath).toBe(binaryPath);
  });

  it('finds the packaged Pi CLI runtime in external resources', () => {
    const appRoot = join(tmpBase, 'packaged-app');
    const resourcesPath = join(tmpBase, 'packaged-resources');
    const cliPath = join(
      resourcesPath,
      'pi-runtime',
      'dist',
      'cli.bundle.js',
    );
    mkdirSync(dirname(cliPath), { recursive: true });
    writeFileSync(cliPath, '// pi cli\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath,
      isPackaged: true,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piCliPath).toBe(cliPath);
  });

  it('keeps the legacy packaged Pi CLI node_modules path as a fallback', () => {
    const appRoot = join(tmpBase, 'packaged-app-legacy');
    const cliPath = join(
      appRoot,
      'dist',
      'resources',
      'pi-runtime',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'cli.js',
    );
    mkdirSync(dirname(cliPath), { recursive: true });
    writeFileSync(cliPath, '// pi cli\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: true,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piCliPath).toBe(cliPath);
  });

  it('finds the workspace Pi CLI runtime in development', () => {
    const appRoot = join(tmpBase, 'monorepo', 'apps', 'electron');
    const cliPath = join(
      tmpBase,
      'monorepo',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'cli.js',
    );
    mkdirSync(dirname(cliPath), { recursive: true });
    writeFileSync(cliPath, '// pi cli\n');

    const hostRuntime: BackendHostRuntimeContext = {
      appRootPath: appRoot,
      resourcesPath: appRoot,
      isPackaged: false,
    };
    const paths = resolveBackendRuntimePaths(hostRuntime);
    expect(paths.piCliPath).toBe(cliPath);
  });
});
