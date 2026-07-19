/**
 * Validate packaged resource staging before electron-builder runs.
 */

import { existsSync, mkdirSync, rmSync, statSync, symlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const ELECTRON_DIR = resolve(import.meta.dir, '..');
const resourcesDir = join(ELECTRON_DIR, 'dist', 'resources');
const piRuntimeRoot = join(resourcesDir, 'pi-runtime');
const piRuntimeModules = join(piRuntimeRoot, 'runtime_modules');
const piRuntimeNodeModules = join(piRuntimeRoot, 'node_modules');
const piCompiledBinary = join(piRuntimeRoot, process.platform === 'win32' ? 'pi.exe' : 'pi');
const usesCompiledBinary = existsSync(piCompiledBinary);

// Runtime dependencies use a neutral staging name so electron-builder does
// not prune them. Expose the conventional name only while smoke tests run;
// afterPack performs the same rename in the packaged application.
if (!usesCompiledBinary) {
  if (existsSync(piRuntimeNodeModules)) {
    rmSync(piRuntimeNodeModules, { recursive: true, force: true });
  }
  symlinkSync('runtime_modules', piRuntimeNodeModules, process.platform === 'win32' ? 'junction' : 'dir');
}

const sidecarPlatform = process.platform === 'win32' ? 'windows' : process.platform;
const sidecarTarget = `${sidecarPlatform}-${process.arch}`;
const sidecarBinary = process.platform === 'win32' ? 'pi-network-sidecar.exe' : 'pi-network-sidecar';

const requiredPaths = usesCompiledBinary ? [
  resourcesDir,
  join(resourcesDir, 'powershell-parser.ps1'),
  piCompiledBinary,
  join(piRuntimeRoot, 'package.json'),
  join(piRuntimeRoot, 'theme', 'dark.json'),
  join(piRuntimeRoot, 'sidecar', 'bin', sidecarTarget, sidecarBinary),
] : [
  resourcesDir,
  join(resourcesDir, 'powershell-parser.ps1'),
  join(piRuntimeRoot, 'package.json'),
  join(piRuntimeRoot, 'dist', 'cli.bundle.js'),
  join(piRuntimeRoot, 'dist', 'cli.full.bundle.js'),
  join(piRuntimeRoot, 'dist', 'cli.interactive.bundle.js'),
  join(piRuntimeRoot, 'dist', 'index.js'),
  join(piRuntimeRoot, 'dist', 'core', 'package-manager.js'),
  join(piRuntimeRoot, 'dist', 'core', 'export-html', 'template.html'),
  join(piRuntimeRoot, 'dist', 'modes', 'interactive', 'theme', 'dark.json'),
  join(piRuntimeRoot, 'sidecar', 'bin', sidecarTarget, sidecarBinary),
  join(piRuntimeModules, '@mortise', 'pi-ai', 'package.json'),
  join(piRuntimeModules, 'ignore', 'package.json'),
  join(piRuntimeModules, 'minimatch', 'package.json'),
  join(piRuntimeModules, 'undici', 'package.json'),
];

let failed = false;

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

function evalArgs(script: string): string[] {
  return 'bun' in process.versions
    ? ['-e', script]
    : ['--input-type=module', '-e', script];
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

if (usesCompiledBinary) {
  validateSpawn('Pi compiled binary version smoke test', ['--version'], {
    command: piCompiledBinary,
    cwd: piRuntimeRoot,
  });
  const piSmokeAgentDir = join(ELECTRON_DIR, 'dist', '.pi-smoke-agent');
  rmSync(piSmokeAgentDir, { recursive: true, force: true });
  mkdirSync(piSmokeAgentDir, { recursive: true });
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
      env: { PI_CODING_AGENT_DIR: piSmokeAgentDir },
    });
  } finally {
    rmSync(piSmokeAgentDir, { recursive: true, force: true });
  }
} else {
  validateSpawn(
    'Pi CLI bundle smoke test',
    [join(piRuntimeRoot, 'dist', 'cli.bundle.js'), '--version'],
    { cwd: piRuntimeRoot },
  );

  const packageManagerUrl = pathToFileURL(join(piRuntimeRoot, 'dist', 'core', 'package-manager.js')).href;
  validateSpawn(
    'Pi package-manager dynamic import smoke test',
    evalArgs(`await import(${JSON.stringify(packageManagerUrl)});`),
    { cwd: piRuntimeRoot },
  );

  const publicApiUrl = pathToFileURL(join(piRuntimeRoot, 'dist', 'index.js')).href;
  validateSpawn(
    'Pi public API import smoke test',
    evalArgs(`await import(${JSON.stringify(publicApiUrl)});`),
    { cwd: piRuntimeRoot },
  );
}

console.log('Staged Electron assets validated');
if (!usesCompiledBinary) {
  rmSync(piRuntimeNodeModules, { recursive: true, force: true });
}
