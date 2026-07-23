/**
 * Validate packaged resource staging before electron-builder runs.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { assertNoSourceRootReferences } from '../../../scripts/build/bundle-portability';

const ELECTRON_DIR = resolve(import.meta.dir, '..');
const resourcesDir = join(ELECTRON_DIR, 'dist', 'resources');
const piRuntimeRoot = join(resourcesDir, 'pi-runtime');
const piRuntimeModules = join(piRuntimeRoot, 'runtime_modules');
const piRuntimeNodeModules = join(piRuntimeRoot, 'node_modules');
const piCompiledBinary = join(piRuntimeRoot, process.platform === 'win32' ? 'pi.exe' : 'pi');
const usesCompiledBinary = existsSync(piCompiledBinary);
const legacyRuntimeCandidates = [
  piRuntimeModules,
  piRuntimeNodeModules,
  join(piRuntimeRoot, 'dist', 'cli.bundle.js'),
  join(piRuntimeRoot, 'dist', 'cli.full.bundle.js'),
  join(piRuntimeRoot, 'dist', 'cli.interactive.bundle.js'),
];

const sidecarPlatform = process.platform === 'win32' ? 'windows' : process.platform;
const sidecarTarget = `${sidecarPlatform}-${process.arch}`;
const sidecarBinary = process.platform === 'win32' ? 'pi-network-sidecar.exe' : 'pi-network-sidecar';

const requiredPaths = [
  resourcesDir,
  join(resourcesDir, 'powershell-parser.ps1'),
  piCompiledBinary,
  join(piRuntimeRoot, 'package.json'),
  join(piRuntimeRoot, 'theme', 'dark.json'),
  join(piRuntimeRoot, 'sidecar', 'bin', sidecarTarget, sidecarBinary),
];

let failed = false;

const sessionServerBundle = join(resourcesDir, 'session-mcp-server', 'index.js');
if (existsSync(sessionServerBundle)) {
  try {
    assertNoSourceRootReferences(
      readFileSync(sessionServerBundle, 'utf8'),
      'staged session-mcp-server/index.js',
      resolve(ELECTRON_DIR, '../..'),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    failed = true;
  }
}

if (!usesCompiledBinary) {
  console.error(`Electron production staging requires the compiled Pi runtime: ${piCompiledBinary}`);
  failed = true;
}
for (const candidate of legacyRuntimeCandidates) {
  if (!existsSync(candidate)) continue;
  console.error(`Electron production staging contains a legacy Pi runtime candidate: ${candidate}`);
  failed = true;
}

for (const path of requiredPaths) {
  if (!existsSync(path)) {
    console.error(`Missing required staged asset: ${path}`);
    failed = true;
    continue;
  }

  const stat = statSync(path);
  if (stat.isFile() && stat.size === 0) {
    console.error(`Required staged asset is empty: ${path}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

function validateSpawn(
  name: string,
  args: string[],
  options?: { command?: string; cwd?: string; input?: string; env?: NodeJS.ProcessEnv },
): void {
  const result = spawnSync(options?.command ?? process.execPath, args, {
    cwd: options?.cwd ?? ELECTRON_DIR,
    encoding: 'utf-8',
    input: options?.input,
    env: {
      ...process.env,
      PI_CHECK_PACKAGE_UPDATES: '0',
      PI_OFFLINE: '1',
      ...options?.env,
    },
  });

  if (result.status === 0) return;

  console.error(`${name} failed with exit code ${result.status ?? 'unknown'}`);
  if (result.stdout.trim()) {
    console.error(result.stdout.trim());
  }
  if (result.stderr.trim()) {
    console.error(result.stderr.trim());
  }
  throw new Error(`${name} failed`);
}

validateSpawn('Pi compiled binary version smoke test', ['--version'], {
  command: piCompiledBinary,
  cwd: piRuntimeRoot,
});
const mortiseSmokeAgentDir = join(ELECTRON_DIR, 'dist', '.mortise-agent-smoke');
rmSync(mortiseSmokeAgentDir, { recursive: true, force: true });
mkdirSync(mortiseSmokeAgentDir, { recursive: true });
try {
  validateSpawn('Pi compiled binary RPC smoke test', [
    '--mode', 'rpc',
    '--no-session',
    '--offline',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
  ], {
    command: piCompiledBinary,
    cwd: piRuntimeRoot,
    input: '{"id":"capabilities","type":"get_capabilities"}\n',
    env: { PI_CODING_AGENT_DIR: mortiseSmokeAgentDir },
  });
} finally {
  rmSync(mortiseSmokeAgentDir, { recursive: true, force: true });
}

console.log('Staged Electron assets validated');
