import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import type { BackendHostRuntimeContext } from '../types.ts';

/**
 * When set, the resolver walks further up from the .app bundle to find
 * interceptor and runtime assets in the monorepo / on the system PATH.
 * Intended for local `electron:dist:mac` builds that skip `build-dmg.sh`.
 */
function isDevelopmentRuntime(): boolean {
  return process.env.MORTISE_DEV_RUNTIME === '1';
}

export interface ResolvedBackendRuntimePaths {
  sessionServerPath?: string;
  nodeRuntimePath?: string;
  bundledRuntimePath?: string;
	piRuntimePath?: string;
}

export interface ResolvedBackendHostTooling {
  ripgrepPath?: string;
}

function firstExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function usesBundledRuntime(hostRuntime: BackendHostRuntimeContext): boolean {
  return hostRuntime.isPackaged || !!hostRuntime.immutableRuntime;
}

/**
 * Walk up from `base` checking `join(ancestor, relativePath)` at each level.
 * Stops after `maxLevels` ancestors or when hitting the filesystem root.
 */
function resolveUpwards(base: string, relativePath: string, maxLevels = 4): string | undefined {
  let dir = resolve(base);
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

function resolveBundledRuntimePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
  if (hostRuntime.immutableRuntime) {
    const immutableBun = join(hostRuntime.immutableRuntime.runtimePath, 'bun', bunBinary);
    if (existsSync(immutableBun)) return immutableBun;
  }
  const bunBasePath = process.platform === 'win32'
    ? (hostRuntime.resourcesPath || hostRuntime.appRootPath)
    : hostRuntime.appRootPath;
  const bunPath = join(bunBasePath, 'vendor', 'bun', bunBinary);
  if (existsSync(bunPath)) return bunPath;

  // Non-packaged (headless server, dev mode): fall back to system bun via PATH.
  // Packaged apps must ship their own bundled bun — never resolve from PATH
  // to avoid picking up an incompatible system install.
  if (!usesBundledRuntime(hostRuntime)) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemBun = execFileSync(whichCmd, ['bun'], { encoding: 'utf-8' }).trim();
      if (systemBun && existsSync(systemBun)) return systemBun;
    } catch { /* system bun not found */ }
  }
  return undefined;
}

function resolveServerPath(hostRuntime: BackendHostRuntimeContext, serverName: string): string | undefined {
  if (usesBundledRuntime(hostRuntime)) {
    return firstExistingPath([
      join(hostRuntime.appRootPath, 'resources', serverName, 'index.js'),
      join(hostRuntime.appRootPath, 'dist', 'resources', serverName, 'index.js'),
    ]);
  }
  return resolveUpwards(
    hostRuntime.appRootPath,
    join('packages', serverName, 'dist', 'index.js'),
  );
}

function resolvePiRuntimePath(hostRuntime: BackendHostRuntimeContext): string | undefined {
	if (usesBundledRuntime(hostRuntime)) {
    const runtimeLabel = hostRuntime.isPackaged ? 'Packaged' : 'Immutable';
    if (!hostRuntime.resourcesPath) {
      throw new Error(`${runtimeLabel} Pi runtime resolution requires resourcesPath`);
    }

    const compiledRuntimePath = join(
      hostRuntime.resourcesPath,
      'pi-runtime',
      process.platform === 'win32' ? 'pi.exe' : 'pi',
    );
    if (!existsSync(compiledRuntimePath)) {
      throw new Error(`${runtimeLabel} Pi runtime is missing: ${compiledRuntimePath}`);
    }
		return compiledRuntimePath;
	}

  if (isDevelopmentRuntime()) {
    const binaryName = process.platform === 'win32' ? 'pi.exe' : 'pi';
    const relativePath = join('pi', 'packages', 'coding-agent', 'dist', binaryName);
    const compiledRuntimePath = resolveUpwards(hostRuntime.appRootPath, relativePath, 10);
    if (!compiledRuntimePath) {
      throw new Error(
        `Development Pi runtime is missing below the Mortise source root (${relativePath}). `
        + 'Run "bun run pi:build && bun run pi:build:binary" before starting Electron.',
      );
    }
    return compiledRuntimePath;
  }

	return undefined;
}

/**
 * Locate ripgrep. Sourced from `@vscode/ripgrep` since SDK 0.2.113 stopped
 * shipping `vendor/ripgrep/<platform>/rg` (the binary is now compiled into
 * the native `claude` executable, but our search service in
 * `packages/server-core/src/services/search.ts` still calls it directly).
 */
function resolveRipgrepPath(hostRuntime: BackendHostRuntimeContext): string | undefined {
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const ripgrepRelative = join('node_modules', '@vscode', 'ripgrep', 'bin', binaryName);

  if (usesBundledRuntime(hostRuntime)) {
    const bundled = firstExistingPath([
      ...(hostRuntime.immutableRuntime ? [join(hostRuntime.immutableRuntime.runtimePath, 'ripgrep', 'bin', binaryName)] : []),
      join(hostRuntime.appRootPath, ripgrepRelative),
    ]);
    if (bundled) return bundled;
    return undefined;
  }

  const fromHostRoot = resolveUpwards(hostRuntime.appRootPath, ripgrepRelative, 10);
  if (fromHostRoot) return fromHostRoot;

  const cwdFallback = join(process.cwd(), ripgrepRelative);
  if (existsSync(cwdFallback)) return cwdFallback;

  // Non-packaged (headless server, dev mode): fall back to system rg via PATH.
  // Packaged apps must use vendored binary only — never resolve from PATH
  // to avoid picking up an incompatible system install.
  if (!usesBundledRuntime(hostRuntime)) {
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const systemRg = execFileSync(whichCmd, ['rg'], { encoding: 'utf-8' }).trim();
      if (systemRg && existsSync(systemRg)) return systemRg;
    } catch { /* system rg not found */ }
  }

  return undefined;
}

export function resolveBackendRuntimePaths(hostRuntime: BackendHostRuntimeContext): ResolvedBackendRuntimePaths {
  const bundledRuntimePath = hostRuntime.immutableRuntime?.nodeRuntimePath || resolveBundledRuntimePath(hostRuntime);

  return {
    sessionServerPath: resolveServerPath(hostRuntime, 'session-mcp-server'),
    nodeRuntimePath: hostRuntime.immutableRuntime?.nodeRuntimePath || bundledRuntimePath || process.execPath,
    bundledRuntimePath,
		piRuntimePath: resolvePiRuntimePath(hostRuntime),
  };
}

export function resolveBackendHostTooling(hostRuntime: BackendHostRuntimeContext): ResolvedBackendHostTooling {
  return {
    ripgrepPath: resolveRipgrepPath(hostRuntime),
  };
}
