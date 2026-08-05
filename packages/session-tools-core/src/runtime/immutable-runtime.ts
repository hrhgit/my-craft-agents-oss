import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const IMMUTABLE_RUNTIME_ENV_KEYS = [
  'MORTISE_RUNTIME_APP_ROOT',
  'MORTISE_RUNTIME_RESOURCES_DIR',
  'MORTISE_RUNTIME_RESOURCES_BASE',
  'MORTISE_RUNTIME_BUNDLE_PATH',
  'MORTISE_RUNTIME_ELECTRON_PATH',
  'MORTISE_RUNTIME_NODE_PATH',
  'MORTISE_RUNTIME_IMMUTABLE',
] as const;

export const RUNTIME_LAYOUT_PROCESS_ENV_KEYS = [
  ...IMMUTABLE_RUNTIME_ENV_KEYS,
  'MORTISE_WORKSPACE_SERVER_ENTRY',
] as const;

const immutableRuntimeLayoutBrand: unique symbol = Symbol('mortise.immutableRuntimeLayout');

export interface ImmutableRuntimeLayout {
  readonly [immutableRuntimeLayoutBrand]: true;
  appRootPath: string;
  resourcesPath: string;
  resourcesBasePath: string;
  runtimePath: string;
  electronRuntimePath: string;
  nodeRuntimePath: string;
}

export interface ResolveImmutableRuntimeLayoutOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  expectedAppRootPath?: string;
  expectedExecutablePath?: string;
  requireAssets?: boolean;
}

export function immutableElectronExecutableRelativePath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'electron/electron.exe';
  if (platform === 'darwin') return 'electron/Electron.app/Contents/MacOS/Electron';
  if (platform === 'linux') return 'electron/electron';
  throw new Error(`Immutable Electron runtime is unsupported on ${platform}.`);
}

export function immutableRuntimeRequiredAppPaths(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Immutable Electron runtime is unsupported for ${platform}-${arch}.`);
  }
  const executable = platform === 'win32' ? '.exe' : '';
  const platformRuntimeDir = `${platform}-${arch}`;
  const sidecarPlatform = platform === 'win32' ? 'windows' : platform;
  const sidecarRuntimeDir = `${sidecarPlatform}-${arch}`;
  return [
    'dist/main.cjs',
    'dist/bootstrap-preload.cjs',
    'dist/browser-toolbar-preload.cjs',
    'dist/workspace-server.mjs',
    'dist/renderer/index.html',
    `dist/resources/bin/${platformRuntimeDir}/uv${executable}`,
    'dist/resources/docs/mortise-cli.md',
    'dist/resources/pi-extensions/browser.js',
    'dist/resources/pi-extensions/messaging.js',
    'dist/resources/pi-extensions/package.json',
    `dist/resources/pi-runtime/pi${executable}`,
    'dist/resources/pi-runtime/package.json',
    `dist/resources/pi-runtime/sidecar/bin/${sidecarRuntimeDir}/pi-network-sidecar${executable}`,
    'dist/resources/powershell-parser.ps1',
    'dist/resources/scripts/pdf_tool.py',
    'dist/resources/session-mcp-server/index.js',
    'dist/packaging-inputs/electron-builder.yml',
    'dist/packaging-inputs/electron-builder.devhost.yml',
    'dist/packaging-inputs/hooks/beforePack.cjs',
    'dist/packaging-inputs/hooks/afterPack.cjs',
    'dist/packaging-inputs/hooks/afterSign.cjs',
    `dist/packaging-inputs/runtime/ripgrep/bin/rg${executable}`,
    `dist/packaging-inputs/runtime/bun/${platform === 'win32' ? 'bun.exe' : 'bun'}`,
    `dist/packaging-inputs/runtime/${immutableElectronExecutableRelativePath(platform)}`,
    'dist/packaging-inputs/runtime/messaging-whatsapp-worker/worker.cjs',
    'dist/packaging-inputs/toolchain.json',
  ];
}

export function resolveImmutableRuntimeLayout(
  options: ResolveImmutableRuntimeLayoutOptions = {},
): ImmutableRuntimeLayout | undefined {
  const env = options.env ?? process.env;
  if (env.MORTISE_RUNTIME_IMMUTABLE !== '1') return undefined;

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const appRootPath = requiredPath(env, 'MORTISE_RUNTIME_APP_ROOT', 'directory');
  const resourcesPath = requiredPath(env, 'MORTISE_RUNTIME_RESOURCES_DIR', 'directory');
  const resourcesBasePath = requiredPath(env, 'MORTISE_RUNTIME_RESOURCES_BASE', 'directory');
  const runtimePath = requiredPath(env, 'MORTISE_RUNTIME_BUNDLE_PATH', 'directory');
  const electronRuntimePath = requiredPath(env, 'MORTISE_RUNTIME_ELECTRON_PATH', 'file');
  const nodeRuntimePath = requiredPath(env, 'MORTISE_RUNTIME_NODE_PATH', 'file');

  assertSamePath(resourcesBasePath, join(appRootPath, 'dist'), 'resources base', platform);
  assertSamePath(resourcesPath, join(resourcesBasePath, 'resources'), 'resources directory', platform);
  assertSamePath(runtimePath, join(resourcesBasePath, 'packaging-inputs', 'runtime'), 'runtime bundle', platform);
  assertSamePath(
    electronRuntimePath,
    join(runtimePath, ...immutableElectronExecutableRelativePath(platform).split('/')),
    'Electron executable',
    platform,
  );
  assertSamePath(nodeRuntimePath, electronRuntimePath, 'Node executable', platform);

  if (options.expectedAppRootPath) assertSamePath(appRootPath, options.expectedAppRootPath, 'application root', platform);
  if (options.expectedExecutablePath) {
    assertSamePath(electronRuntimePath, options.expectedExecutablePath, 'current executable', platform);
  }

  assertGenericProjection(env.MORTISE_APP_ROOT, appRootPath, 'MORTISE_APP_ROOT', platform);
  assertGenericProjection(env.MORTISE_RESOURCES_PATH, resourcesPath, 'MORTISE_RESOURCES_PATH', platform);
  assertGenericProjection(env.MORTISE_RESOURCES_BASE, resourcesBasePath, 'MORTISE_RESOURCES_BASE', platform);

  if (options.requireAssets !== false) {
    for (const asset of immutableRuntimeRequiredAppPaths(platform, arch)) {
      const assetPath = join(appRootPath, ...asset.split('/'));
      if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
        throw new Error(`Immutable runtime asset is missing: ${assetPath}`);
      }
    }
  }

  return {
    [immutableRuntimeLayoutBrand]: true,
    appRootPath,
    resourcesPath,
    resourcesBasePath,
    runtimePath,
    electronRuntimePath,
    nodeRuntimePath,
  };
}

export function createImmutableRuntimeEnvironment(layout: ImmutableRuntimeLayout): Record<string, string> {
  return {
    MORTISE_RUNTIME_APP_ROOT: layout.appRootPath,
    MORTISE_RUNTIME_RESOURCES_DIR: layout.resourcesPath,
    MORTISE_RUNTIME_RESOURCES_BASE: layout.resourcesBasePath,
    MORTISE_RUNTIME_BUNDLE_PATH: layout.runtimePath,
    MORTISE_RUNTIME_ELECTRON_PATH: layout.electronRuntimePath,
    MORTISE_RUNTIME_NODE_PATH: layout.nodeRuntimePath,
    MORTISE_RUNTIME_IMMUTABLE: '1',
  };
}

export function stripRuntimeLayoutProcessEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of RUNTIME_LAYOUT_PROCESS_ENV_KEYS) delete env[key];
  return env;
}

export function clearRuntimeLayoutProcessEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of RUNTIME_LAYOUT_PROCESS_ENV_KEYS) delete env[key];
}

function requiredPath(
  env: NodeJS.ProcessEnv,
  name: typeof IMMUTABLE_RUNTIME_ENV_KEYS[number],
  kind: 'file' | 'directory',
): string {
  const value = env[name];
  if (!value) throw new Error(`Immutable runtime requires ${name}.`);
  if (!isAbsolute(value)) throw new Error(`Immutable runtime ${name} must be absolute: ${value}`);
  const path = resolve(value);
  if (!existsSync(path)) throw new Error(`Immutable runtime ${name} is missing: ${path}`);
  const stat = statSync(path);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`Immutable runtime ${name} must be a ${kind}: ${path}`);
  }
  return realpathSync(path);
}

function assertSamePath(actual: string, expected: string, label: string, platform: NodeJS.Platform): void {
  if (pathIdentity(actual, platform) !== pathIdentity(expected, platform)) {
    throw new Error(`Immutable runtime ${label} is outside the canonical capsule layout: ${actual}`);
  }
}

function assertGenericProjection(value: string | undefined, expected: string, name: string, platform: NodeJS.Platform): void {
  if (value && pathIdentity(value, platform) !== pathIdentity(expected, platform)) {
    throw new Error(`Immutable runtime ${name} conflicts with the canonical capsule layout.`);
  }
}

function pathIdentity(value: string, platform: NodeJS.Platform): string {
  const resolved = resolve(value);
  const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
  return platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}
