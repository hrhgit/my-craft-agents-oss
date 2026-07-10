/**
 * Common build utilities shared across all platforms
 */

import { $ } from 'bun';
import { execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  chmodSync,
} from 'fs';
import { builtinModules } from 'module';
import { join, dirname, relative, resolve, sep } from 'path';
import { createHash } from 'crypto';

export type Platform = 'darwin' | 'win32' | 'linux';
export type Arch = 'x64' | 'arm64';

export interface BuildConfig {
  platform: Platform;
  arch: Arch;
  upload: boolean;
  uploadLatest: boolean;
  uploadScript: boolean;
  rootDir: string;
  electronDir: string;
}

/**
 * Bun version to bundle with the app.
 * Update this when upgrading Bun. Check latest at: https://github.com/oven-sh/bun/releases
 * This should match or be close to the version used in CI (setup-bun action).
 */
export const BUN_VERSION = 'bun-v1.3.9';

/**
 * uv version to bundle with the app.
 * Update this when upgrading uv. Check latest at: https://github.com/astral-sh/uv/releases
 */
export const UV_VERSION = '0.10.6';

/**
 * Get platform key for resources/bin folder naming.
 */
export function getPlatformKey(platform: Platform, arch: Arch): string {
  return `${platform}-${arch}`;
}

/**
 * Get the Bun download filename for a platform/arch combination
 */
export function getBunDownloadName(platform: Platform, arch: Arch): string {
  const archMap: Record<Arch, string> = {
    x64: 'x64',
    arm64: 'aarch64',
  };

  const platformMap: Record<Platform, string> = {
    darwin: 'darwin',
    win32: 'windows',
    linux: 'linux',
  };

  const bunArch = archMap[arch];
  const bunPlatform = platformMap[platform];

  // Windows and Linux x64 use baseline build for broader CPU compatibility (no AVX2 requirement)
  if ((platform === 'win32' || platform === 'linux') && arch === 'x64') {
    return `bun-${bunPlatform}-x64-baseline`;
  }

  return `bun-${bunPlatform}-${bunArch}`;
}

/**
 * Get uv release artifact filename for a platform/arch combination.
 */
export function getUvDownloadName(platform: Platform, arch: Arch): string {
  if (platform === 'darwin' && arch === 'arm64') return 'uv-aarch64-apple-darwin.tar.gz';
  if (platform === 'darwin' && arch === 'x64') return 'uv-x86_64-apple-darwin.tar.gz';
  if (platform === 'linux' && arch === 'arm64') return 'uv-aarch64-unknown-linux-gnu.tar.gz';
  if (platform === 'linux' && arch === 'x64') return 'uv-x86_64-unknown-linux-gnu.tar.gz';
  if (platform === 'win32' && arch === 'arm64') return 'uv-aarch64-pc-windows-msvc.zip';
  if (platform === 'win32' && arch === 'x64') return 'uv-x86_64-pc-windows-msvc.zip';

  throw new Error(`Unsupported uv target: ${platform}-${arch}`);
}

/**
 * Verify SHA256 checksum of a file
 */
export async function verifySha256(filePath: string, expectedHash: string): Promise<boolean> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hash = createHash('sha256').update(Buffer.from(buffer)).digest('hex');
  return hash.toLowerCase() === expectedHash.toLowerCase();
}

/**
 * Download and verify Bun binary
 * Uses curl for downloads (more reliable in CI than fetch + Bun.write)
 */
export async function downloadBun(config: BuildConfig): Promise<void> {
  const { platform, arch, electronDir } = config;
  const bunDownload = getBunDownloadName(platform, arch);
  const vendorDir = join(electronDir, 'vendor', 'bun');

  console.log(`Downloading Bun ${BUN_VERSION} for ${platform}-${arch}...`);

  // Create vendor directory
  mkdirSync(vendorDir, { recursive: true });

  // Create temp directory
  const tempDir = join(electronDir, '.bun-download-temp');
  mkdirSync(tempDir, { recursive: true });

  try {
    const zipUrl = `https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${bunDownload}.zip`;
    const checksumUrl = `https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/SHASUMS256.txt`;

    // Download files using curl (more reliable in CI than fetch + Bun.write)
    const zipPath = join(tempDir, `${bunDownload}.zip`);
    const checksumPath = join(tempDir, 'SHASUMS256.txt');

    console.log(`  Downloading ${zipUrl}...`);
    await $`curl -fsSL --retry 3 --retry-delay 2 -o ${zipPath} ${zipUrl}`;
    console.log('  Download complete');

    console.log('  Downloading checksums...');
    await $`curl -fsSL --retry 3 --retry-delay 2 -o ${checksumPath} ${checksumUrl}`;

    // Verify checksum
    console.log('  Verifying checksum...');
    const checksumContent = await Bun.file(checksumPath).text();
    const expectedHash = checksumContent
      .split('\n')
      .find((line) => line.includes(`${bunDownload}.zip`))
      ?.split(' ')[0];

    if (!expectedHash) {
      throw new Error(`Checksum not found for ${bunDownload}.zip`);
    }

    const isValid = await verifySha256(zipPath, expectedHash);
    if (!isValid) {
      throw new Error('Checksum verification failed!');
    }
    console.log('  Checksum verified ✓');

    // Extract
    console.log('  Extracting...');
    await $`unzip -o ${zipPath} -d ${tempDir}`.quiet();

    // Copy binary
    const bunBinary = platform === 'win32' ? 'bun.exe' : 'bun';
    const sourcePath = join(tempDir, bunDownload, bunBinary);
    const destPath = join(vendorDir, bunBinary);

    copyFileSync(sourcePath, destPath);

    // Make executable on Unix
    if (platform !== 'win32') {
      await $`chmod +x ${destPath}`.quiet();
    }

    console.log(`  Bun installed to ${destPath} ✓`);
  } finally {
    // Cleanup temp directory
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Find the first matching file recursively under a directory.
 */
function findFileRecursive(root: string, fileName: string): string | null {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const nested = findFileRecursive(fullPath, fileName);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Download and verify uv binary, then install it to resources/bin/<platform-arch>/uv(.exe).
 */
export async function downloadUv(config: BuildConfig): Promise<void> {
  const { platform, arch, electronDir } = config;
  const uvDownload = getUvDownloadName(platform, arch);
  const uvBinaryName = platform === 'win32' ? 'uv.exe' : 'uv';
  const platformKey = getPlatformKey(platform, arch);

  const targetDir = join(electronDir, 'resources', 'bin', platformKey);
  const targetPath = join(targetDir, uvBinaryName);

  // Skip when already provisioned
  if (existsSync(targetPath)) {
    console.log(`uv already present at ${targetPath}`);
    return;
  }

  console.log(`Downloading uv ${UV_VERSION} for ${platformKey}...`);

  mkdirSync(targetDir, { recursive: true });
  const tempDir = join(electronDir, '.uv-download-temp');
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  try {
    const assetUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uvDownload}`;
    const checksumUrl = `${assetUrl}.sha256`;

    const assetPath = join(tempDir, uvDownload);
    const checksumPath = join(tempDir, `${uvDownload}.sha256`);
    const extractDir = join(tempDir, 'extract');

    console.log(`  Downloading ${assetUrl}...`);
    await $`curl -fsSL --retry 3 --retry-delay 2 -o ${assetPath} ${assetUrl}`;

    console.log('  Downloading checksum...');
    await $`curl -fsSL --retry 3 --retry-delay 2 -o ${checksumPath} ${checksumUrl}`;

    console.log('  Verifying checksum...');
    const checksumContent = await Bun.file(checksumPath).text();
    const hashMatch = checksumContent.match(/[a-fA-F0-9]{64}/);
    if (!hashMatch) {
      throw new Error(`Unable to parse checksum from ${checksumPath}`);
    }

    const isValid = await verifySha256(assetPath, hashMatch[0]);
    if (!isValid) {
      throw new Error('uv checksum verification failed');
    }
    console.log('  Checksum verified ✓');

    mkdirSync(extractDir, { recursive: true });

    if (uvDownload.endsWith('.zip')) {
      // Use PowerShell on Windows for consistent extraction support.
      await $`powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${assetPath}' -DestinationPath '${extractDir}' -Force"`;
    } else {
      await $`tar -xzf ${assetPath} -C ${extractDir}`;
    }

    const extractedUv = findFileRecursive(extractDir, uvBinaryName);
    if (!extractedUv) {
      throw new Error(`Unable to locate ${uvBinaryName} in extracted archive`);
    }

    copyFileSync(extractedUv, targetPath);
    if (platform !== 'win32') {
      await $`chmod +x ${targetPath}`.quiet();
    }

    console.log(`  uv installed to ${targetPath} ✓`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Clean previous build artifacts
 */
export function cleanBuildArtifacts(config: BuildConfig): void {
  const { electronDir } = config;

  console.log('Cleaning previous builds...');

  const foldersToClean = [
    join(electronDir, 'vendor'),
    join(electronDir, 'node_modules', '@vscode', 'ripgrep'),
    join(electronDir, 'packages'),
    join(electronDir, 'release'),
  ];

  for (const folder of foldersToClean) {
    if (existsSync(folder)) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

/**
 * Install dependencies
 * On Windows, uses hoisted linker to avoid .bun symlink directory
 */
export async function installDependencies(config: BuildConfig): Promise<void> {
  const { rootDir, platform } = config;

  if (platform === 'win32') {
    // Use hoisted linker on Windows - Bun's default isolated mode creates
    // node_modules/.bun/ with symlinks that esbuild can't traverse on Windows
    // ("Access is denied" errors with junction points)
    // Hoisted mode creates flat npm-style node_modules without .bun
    console.log('Installing dependencies (Windows hoisted mode)...');
    await $`cd ${rootDir} && bun install --linker=hoisted`.quiet();
  } else {
    console.log('Installing dependencies...');
    await $`cd ${rootDir} && bun install`.quiet();
  }
}

/**
 * Copy @vscode/ripgrep into the staged node_modules. Replaces the previous
 * `vendor/ripgrep/<platform>/rg` layout.
 */
export function copyRipgrep(config: BuildConfig): void {
  const { rootDir, electronDir } = config;
  const rgSource = join(rootDir, 'node_modules', '@vscode', 'ripgrep');
  const binaryName = config.platform === 'win32' ? 'rg.exe' : 'rg';
  const rgBinary = join(rgSource, 'bin', binaryName);

  if (!existsSync(rgSource) || !existsSync(rgBinary)) {
    throw new Error(
      `@vscode/ripgrep not installed or postinstall did not run. ` +
      `Run 'bun install' and 'bun pm trust @vscode/ripgrep'.`,
    );
  }

  const rgScope = join(electronDir, 'node_modules', '@vscode');
  const rgDest = join(rgScope, 'ripgrep');
  console.log('Copying @vscode/ripgrep...');
  mkdirSync(rgScope, { recursive: true });
  if (existsSync(rgDest)) {
    rmSync(rgDest, { recursive: true, force: true });
  }
  cpSync(rgSource, rgDest, { recursive: true, dereference: true });
}

const PI_RUNTIME_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_RUNTIME_BUNDLE_ENTRY = join('dist', 'cli.bundle.js');
const PI_RUNTIME_REQUIRED_DIST_FILES = [
  'dist/cli.bundle.js',
  'dist/cli.full.bundle.js',
  'dist/cli.interactive.bundle.js',
  'dist/index.js',
  'dist/config.js',
  'dist/core/output-guard.js',
  'dist/core/package-manager.js',
  'dist/utils/child-process.js',
  'dist/utils/git.js',
  'dist/utils/paths.js',
  'dist/core/export-html',
  'dist/modes/interactive/assets',
  'dist/modes/interactive/theme',
];
const PI_RUNTIME_OPTIONAL_PACKAGE_PATHS = [
  'docs',
  'examples',
];
const PI_RUNTIME_METADATA_FILES = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE.md',
  'npm-shrinkwrap.json',
];
const PI_RUNTIME_EXTERNAL_FALLBACKS = [
  '@earendil-works/pi-ai',
  '@silvia-odwyer/photon-node',
  'cross-spawn',
  'hosted-git-info',
  'ignore',
  'jiti',
  'minimatch',
  'proper-lockfile',
  'undici',
  'yaml',
];
const PI_RUNTIME_ADDITIONAL_EXTERNALS = [
  // cli.full.bundle.js imports npm undici even though recent Node versions may
  // list an internal undici module. Isolated runtime smoke tests need the npm
  // package present.
  'undici',
  // The bundle dynamically loads dist/core/package-manager.js, whose package
  // imports are not represented in the bundle metafile.
  'ignore',
  'minimatch',
  // Extensions may import @earendil-works/pi-coding-agent. The staged runtime
  // therefore ships the public dist/index.js surface, whose package imports are
  // not represented in the CLI bundle metafile.
  '@anthropic-ai/sdk',
  '@google/genai',
  '@mistralai/mistralai',
  'chalk',
  'diff',
  'get-east-asian-width',
  'openai',
  'partial-json',
  'typebox',
];

const NODE_BUILTIN_MODULES = new Set<string>();
for (const moduleName of builtinModules) {
  NODE_BUILTIN_MODULES.add(moduleName);
  if (!moduleName.startsWith('node:')) {
    NODE_BUILTIN_MODULES.add(`node:${moduleName}`);
  }
}

function packagePathParts(packageName: string): string[] {
  return packageName.split('/');
}

function resolvePackageDir(packageName: string, fromDir: string): string | undefined {
  const parts = packagePathParts(packageName);
  const logical = resolve(fromDir);
  const bases: string[] = [];
  try {
    bases.push(realpathSync(fromDir));
  } catch { /* keep logical path only */ }
  if (!bases.includes(logical)) bases.push(logical);

  for (const base of bases) {
    let current = base;
    while (true) {
      const candidate = join(current, 'node_modules', ...parts);
      if (existsSync(join(candidate, 'package.json'))) {
        return candidate;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return undefined;
}

function packageDestDir(destModules: string, packageName: string): string {
  return join(destModules, ...packagePathParts(packageName));
}

function packageSourceKey(packageDir: string): string {
  try {
    return realpathSync(packageDir);
  } catch {
    return resolve(packageDir);
  }
}

function readPackageJson(packageDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8'));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeDirectoryWithRetry(path: string, maxAttempts = 5): void {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      if (!existsSync(path)) return;
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts) {
      sleepSync(250 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to remove ${path}`);
}

function runtimeSourcePath(packageDir: string, relativePath: string): string {
  return join(packageDir, ...relativePath.split('/'));
}

function copyPackageSurfacePath(packageDir: string, destRoot: string, relativePath: string, required: boolean): void {
  const source = runtimeSourcePath(packageDir, relativePath);
  const dest = runtimeSourcePath(destRoot, relativePath);

  if (!existsSync(source)) {
    if (required) {
      throw new Error(`Pi runtime source is missing required path: ${source}`);
    }
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });
  const stat = statSync(source);
  if (stat.isDirectory()) {
    cpSync(source, dest, { recursive: true, dereference: true, force: true });
  } else {
    copyFileSync(source, dest);
  }
}

function shouldCopyPiRuntimeDistPath(sourcePath: string): boolean {
  const stat = statSync(sourcePath);
  if (stat.isDirectory()) return true;

  const normalized = sourcePath.replace(/\\/g, '/').toLowerCase();
  return !normalized.endsWith('.map') && !normalized.endsWith('.d.ts');
}

function copyPiRuntimeDist(packageDir: string, runtimeRoot: string): void {
  const source = join(packageDir, 'dist');
  const dest = join(runtimeRoot, 'dist');

  if (!existsSync(source)) {
    throw new Error(`Pi runtime source is missing required dist directory: ${source}`);
  }

  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, {
    recursive: true,
    dereference: true,
    force: true,
    filter: shouldCopyPiRuntimeDistPath,
  });
}

function requireStagedPiRuntimePath(runtimeRoot: string, relativePath: string): void {
  const path = runtimeSourcePath(runtimeRoot, relativePath);
  if (!existsSync(path)) {
    throw new Error(`Pi runtime staging missed required path: ${path}`);
  }
}

function piSidecarTarget(platform: Platform, arch: Arch): string {
  const sidecarPlatform = platform === 'win32' ? 'windows' : platform;
  return `${sidecarPlatform}-${arch}`;
}

function piSidecarBinaryName(platform: Platform): string {
  return platform === 'win32' ? 'pi-network-sidecar.exe' : 'pi-network-sidecar';
}

function copyPiRuntimePackageSurface(packageDir: string, runtimeRoot: string, config: BuildConfig): void {
  for (const file of PI_RUNTIME_METADATA_FILES) {
    copyPackageSurfacePath(packageDir, runtimeRoot, file, file === 'package.json');
  }

  copyPiRuntimeDist(packageDir, runtimeRoot);
  for (const file of PI_RUNTIME_REQUIRED_DIST_FILES) {
    requireStagedPiRuntimePath(runtimeRoot, file);
  }

  for (const assetPath of PI_RUNTIME_OPTIONAL_PACKAGE_PATHS) {
    copyPackageSurfacePath(packageDir, runtimeRoot, assetPath, false);
  }

  const sidecarTarget = piSidecarTarget(config.platform, config.arch);
  const sidecarRelativeDir = `sidecar/bin/${sidecarTarget}`;
  copyPackageSurfacePath(packageDir, runtimeRoot, sidecarRelativeDir, true);

  const sidecarBinary = join(
    runtimeRoot,
    'sidecar',
    'bin',
    sidecarTarget,
    piSidecarBinaryName(config.platform),
  );
  if (!existsSync(sidecarBinary)) {
    throw new Error(`Pi sidecar binary missing after runtime staging: ${sidecarBinary}`);
  }
  if (config.platform !== 'win32') {
    chmodSync(sidecarBinary, 0o755);
  }
}

interface EsbuildMetafile {
  inputs?: Record<string, { imports?: Array<{ path?: string; external?: boolean }> }>;
}

function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (PI_RUNTIME_ADDITIONAL_EXTERNALS.includes(specifier)) {
    return false;
  }
  const withoutPrefix = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return NODE_BUILTIN_MODULES.has(specifier) || NODE_BUILTIN_MODULES.has(withoutPrefix);
}

function packageNameFromImportSpecifier(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || isNodeBuiltinSpecifier(specifier)) {
    return undefined;
  }
  if (specifier.startsWith('node:') || specifier.includes(':')) {
    return undefined;
  }

  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return scope && name ? `${scope}/${name}` : undefined;
  }

  return specifier.split('/')[0];
}

function piRuntimeExternalPackages(packageDir: string): string[] {
  const packages = new Set<string>(PI_RUNTIME_ADDITIONAL_EXTERNALS);
  const metaPath = join(packageDir, 'dist', 'cli.bundle.meta.json');

  if (!existsSync(metaPath)) {
    for (const packageName of PI_RUNTIME_EXTERNAL_FALLBACKS) {
      packages.add(packageName);
    }
    return [...packages].sort();
  }

  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as EsbuildMetafile;
    for (const input of Object.values(meta.inputs ?? {})) {
      for (const imp of input.imports ?? []) {
        if (!imp.external || !imp.path) continue;
        const packageName = packageNameFromImportSpecifier(imp.path);
        if (packageName) {
          packages.add(packageName);
        }
      }
    }
  } catch (error) {
    console.warn(`Warning: unable to parse Pi runtime bundle metafile at ${metaPath}: ${(error as Error).message}`);
    for (const packageName of PI_RUNTIME_EXTERNAL_FALLBACKS) {
      packages.add(packageName);
    }
  }

  return [...packages].sort();
}

function topLevelPackageFile(entry: string): string {
  return entry
    .replace(/\\/g, '/')
    .replace(/\/\*\*.*$/, '')
    .replace(/\/\*.*$/, '')
    .split('/')[0]!;
}

function copyPiWorkspacePackage(packageDir: string, dest: string): void {
  const pkg = readPackageJson(packageDir);
  const files = Array.isArray(pkg.files) ? pkg.files.filter((entry): entry is string => typeof entry === 'string') : [];
  const entries = new Set(files.map(topLevelPackageFile));

  // Linked workspace packages are larger than the published npm package. Copy
  // the publishable/runtime surface so release builds do not pull src/tests in.
  entries.add('dist');
  for (const file of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'npm-shrinkwrap.json']) {
    const source = join(packageDir, file);
    if (existsSync(source)) {
      mkdirSync(dirname(join(dest, file)), { recursive: true });
      copyFileSync(source, join(dest, file));
    }
  }

  for (const entry of entries) {
    if (!entry || entry === 'package.json') continue;
    const source = join(packageDir, entry);
    if (!existsSync(source)) continue;
    cpSync(source, join(dest, entry), { recursive: true, dereference: true });
  }
}

function copyNpmPackage(packageDir: string, dest: string, packageName: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });

  if (packageName.startsWith('@earendil-works/pi-')) {
    copyPiWorkspacePackage(packageDir, dest);
    return;
  }

  const skipNames = new Set([
    '.git',
    '.hg',
    '.svn',
    '.cache',
    '.turbo',
    'coverage',
    'node_modules',
  ]);

  cpSync(packageDir, dest, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const rel = relative(packageDir, source);
      if (!rel) return true;
      return !rel.split(sep).some((part) => skipNames.has(part));
    },
  });
}

function dependencyNames(pkg: Record<string, unknown>): Array<{ name: string; required: boolean }> {
  const result: Array<{ name: string; required: boolean }> = [];
  const pushDeps = (value: unknown, required: boolean) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const name of Object.keys(value)) {
      result.push({ name, required });
    }
  };

  pushDeps(pkg.dependencies, true);
  pushDeps(pkg.optionalDependencies, false);
  pushDeps(pkg.peerDependencies, false);
  return result;
}

interface RuntimePackagePlacement {
  name: string;
  packageDir: string;
  sourceKey: string;
  dest: string;
  modulesDir: string;
}

type RuntimePlacementIndex = Map<string, Map<string, RuntimePackagePlacement>>;
type RuntimeModuleChains = Map<string, string[]>;

function placementMapFor(index: RuntimePlacementIndex, modulesDir: string): Map<string, RuntimePackagePlacement> {
  let map = index.get(modulesDir);
  if (!map) {
    map = new Map();
    index.set(modulesDir, map);
  }
  return map;
}

function findVisiblePlacement(
  index: RuntimePlacementIndex,
  modulesChain: string[],
  packageName: string,
): RuntimePackagePlacement | undefined {
  for (const modulesDir of modulesChain) {
    const placement = index.get(modulesDir)?.get(packageName);
    if (placement) return placement;
  }
  return undefined;
}

function copyPackageToRuntime(
  packageName: string,
  packageDir: string,
  targetModules: string,
  placements: RuntimePlacementIndex,
  moduleChains: RuntimeModuleChains,
): RuntimePackagePlacement {
  const sourceKey = packageSourceKey(packageDir);
  const map = placementMapFor(placements, targetModules);
  const existing = map.get(packageName);
  if (existing) {
    if (existing.sourceKey !== sourceKey) {
      throw new Error(
        `Cannot place ${packageName} from ${packageDir}; ` +
        `${targetModules} already contains ${existing.packageDir}`,
      );
    }
    return existing;
  }

  const dest = packageDestDir(targetModules, packageName);
  copyNpmPackage(packageDir, dest, packageName);

  const placement: RuntimePackagePlacement = {
    name: packageName,
    packageDir,
    sourceKey,
    dest,
    modulesDir: targetModules,
  };
  map.set(packageName, placement);

  const childModules = join(dest, 'node_modules');
  const parentChain = moduleChains.get(targetModules) ?? [targetModules];
  moduleChains.set(childModules, [childModules, ...parentChain]);

  return placement;
}

function processRuntimePackage(
  placement: RuntimePackagePlacement,
  rootModules: string,
  placements: RuntimePlacementIndex,
  moduleChains: RuntimeModuleChains,
  processed: Set<string>,
): void {
  const processedKey = `${placement.sourceKey}\0${placement.dest}`;
  if (processed.has(processedKey)) return;
  processed.add(processedKey);

  const pkg = readPackageJson(placement.packageDir);
  const childModules = join(placement.dest, 'node_modules');
  const modulesChain = moduleChains.get(childModules) ?? [childModules, placement.modulesDir];
  const directDependencies: RuntimePackagePlacement[] = [];

  for (const dep of dependencyNames(pkg)) {
    const dependency = placeRuntimeDependency(
      dep.name,
      placement.packageDir,
      rootModules,
      modulesChain,
      placements,
      moduleChains,
      dep.required,
    );
    if (dependency) {
      directDependencies.push(dependency);
    }
  }

  for (const dependency of directDependencies) {
    processRuntimePackage(dependency, rootModules, placements, moduleChains, processed);
  }
}

function placeRuntimeDependency(
  packageName: string,
  resolverDir: string,
  rootModules: string,
  requesterModulesChain: string[],
  placements: RuntimePlacementIndex,
  moduleChains: RuntimeModuleChains,
  required: boolean,
): RuntimePackagePlacement | undefined {
  const packageDir = resolvePackageDir(packageName, resolverDir);
  if (!packageDir) {
    if (required) {
      throw new Error(`Unable to resolve runtime dependency ${packageName} from ${resolverDir}`);
    }
    return undefined;
  }

  const sourceKey = packageSourceKey(packageDir);
  const visible = findVisiblePlacement(placements, requesterModulesChain, packageName);
  if (visible?.sourceKey === sourceKey) {
    return visible;
  }

  const targetModules = visible ? requesterModulesChain[0] : rootModules;
  return copyPackageToRuntime(packageName, packageDir, targetModules, placements, moduleChains);
}

function copyPackageDependencySet(packageNames: string[], resolverDir: string, destModules: string): number {
  const placements: RuntimePlacementIndex = new Map();
  const moduleChains: RuntimeModuleChains = new Map([[destModules, [destModules]]]);
  const processed = new Set<string>();
  const entries: RuntimePackagePlacement[] = [];

  for (const packageName of packageNames) {
    const packageDir = resolvePackageDir(packageName, resolverDir);
    if (!packageDir) {
      throw new Error(`Unable to resolve runtime dependency ${packageName} from ${resolverDir}`);
    }
    entries.push(copyPackageToRuntime(packageName, packageDir, destModules, placements, moduleChains));
  }

  for (const entry of entries) {
    processRuntimePackage(entry, destModules, placements, moduleChains, processed);
  }

  return processed.size;
}

/**
 * Assemble a private Pi CLI runtime into dist/resources. The Electron main
 * bundle imports the Pi SDK directly, but PiAgent starts a separate Node/Bun
 * process for RPC sessions; that subprocess needs the CLI package and its
 * runtime dependencies available in the packaged app.
 */
export function stagePiRuntime(config: BuildConfig, runtimeRoot: string): void {
  const destModules = join(runtimeRoot, 'node_modules');
  const packageDir = resolvePackageDir(PI_RUNTIME_PACKAGE, config.rootDir);

  if (!packageDir) {
    throw new Error(`Unable to resolve ${PI_RUNTIME_PACKAGE} from ${config.rootDir}`);
  }

  console.log('Staging Pi CLI runtime...');
  removeDirectoryWithRetry(runtimeRoot);
  mkdirSync(destModules, { recursive: true });

  copyPiRuntimePackageSurface(packageDir, runtimeRoot, config);

  const externalPackages = piRuntimeExternalPackages(packageDir);
  const copiedCount = copyPackageDependencySet(externalPackages, packageDir, destModules);

  const cliPath = join(runtimeRoot, PI_RUNTIME_BUNDLE_ENTRY);
  if (!existsSync(cliPath)) {
    throw new Error(`Pi CLI runtime copy failed; entrypoint missing at ${cliPath}`);
  }

  console.log(`  Pi CLI runtime staged (${copiedCount} dependency packages, entry ${PI_RUNTIME_BUNDLE_ENTRY})`);
}

export function copyPiRuntime(config: BuildConfig): void {
  stagePiRuntime(config, join(config.electronDir, 'dist', 'resources', 'pi-runtime'));
}

/**
 * Copy Session MCP Server to packaged app resources.
 * The session server provides session-scoped tools (config_validate, etc.) for agent sessions.
 */
export function copySessionServer(config: BuildConfig): void {
  const { rootDir, electronDir } = config;

  const sessionSource = join(rootDir, 'packages', 'session-mcp-server', 'dist', 'index.js');
  const sessionDest = join(electronDir, 'resources', 'session-mcp-server', 'index.js');

  if (!existsSync(sessionSource)) {
    console.warn(`Warning: Session server not found at ${sessionSource}. Session-scoped tools will not work.`);
    return;
  }

  console.log('Copying Session MCP Server...');
  mkdirSync(dirname(sessionDest), { recursive: true });
  copyFileSync(sessionSource, sessionDest);
}

/**
 * Build MCP servers (session).
 * Shared across all platforms to avoid drift.
 */
export function buildMcpServers(config: BuildConfig): void {
  const { rootDir } = config;

  const sessionDir = join(rootDir, 'packages', 'session-mcp-server');
  const sessionOut = join(sessionDir, 'dist', 'index.js');

  console.log('Building MCP servers...');

  mkdirSync(join(sessionDir, 'dist'), { recursive: true });

  execSync(
    `bun build ${join(sessionDir, 'src', 'index.ts')} --outfile ${sessionOut} --target node --format cjs`,
    { cwd: rootDir, stdio: 'inherit', shell: true }
  );

  if (!existsSync(sessionOut)) {
    throw new Error(`Session MCP server output not found at ${sessionOut}`);
  }
}

/**
 * Build the WhatsApp worker subprocess (Baileys + Node runtime bundle).
 * Output ships as an extraResource at resources/messaging-whatsapp-worker/worker.cjs
 * and is spawned by WhatsAppAdapter. See electron-builder.yml `extraResources`.
 */
export function buildWhatsAppWorker(config: BuildConfig): void {
  const { rootDir } = config;
  const workerOut = join(rootDir, 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs');

  console.log('Building WhatsApp worker...');

  execSync('bun run build:wa-worker', { cwd: rootDir, stdio: 'inherit', shell: true });

  if (!existsSync(workerOut)) {
    throw new Error(`WhatsApp worker output not found at ${workerOut}`);
  }
}

/**
 * Verify MCP helper servers are present in packaged resources.
 */
export function verifyMcpServersExist(config: BuildConfig): void {
  const { electronDir } = config;

  const sessionPath = join(electronDir, 'resources', 'session-mcp-server', 'index.js');

  if (!existsSync(sessionPath)) {
    throw new Error(`Session MCP server not found at ${sessionPath}`);
  }
}

/**
 * Build the Electron app (main, preload, renderer)
 */
export async function buildElectronApp(config: BuildConfig): Promise<void> {
  const { rootDir } = config;

  console.log('Building Electron app...');
  await $`cd ${rootDir} && bun run electron:build`;
}

/**
 * Create manifest.json for upload
 */
export async function createManifest(config: BuildConfig): Promise<string> {
  const { rootDir, electronDir } = config;

  const packageJson = await Bun.file(join(electronDir, 'package.json')).json();
  const version = packageJson.version;

  const uploadDir = join(rootDir, '.build', 'upload');
  mkdirSync(uploadDir, { recursive: true });

  const manifestPath = join(uploadDir, 'manifest.json');
  await Bun.write(manifestPath, JSON.stringify({ version }, null, 2));

  console.log(`Created manifest.json (version: ${version})`);
  return version;
}

/**
 * Upload to S3
 */
export async function uploadToS3(config: BuildConfig): Promise<void> {
  const { rootDir, upload, uploadLatest, uploadScript } = config;

  if (!upload) return;

  // Check for required env vars
  const required = [
    'S3_VERSIONS_BUCKET_ENDPOINT',
    'S3_VERSIONS_BUCKET_ACCESS_KEY_ID',
    'S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY',
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing S3 credentials: ${missing.join(', ')}`);
  }

  console.log('\n=== Uploading to S3 ===');

  const flags = ['--electron'];
  if (uploadLatest) flags.push('--latest');
  if (uploadScript) flags.push('--script');

  await $`cd ${rootDir} && bun run scripts/upload.ts ${flags}`;

  console.log('Upload complete ✓');
}

/**
 * Load environment variables from .env file
 */
export async function loadEnvFile(config: BuildConfig): Promise<void> {
  const envPath = join(config.rootDir, '.env');

  if (existsSync(envPath)) {
    const content = await Bun.file(envPath).text();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').replace(/^["']|["']$/g, '');
          process.env[key] = value;
        }
      }
    }
  }
}

/**
 * Get output artifact name for a platform/arch
 */
export function getArtifactName(platform: Platform, arch: Arch): string {
  switch (platform) {
    case 'darwin':
      return `Craft-Agents-${arch}.dmg`;
    case 'win32':
      return `Craft-Agents-${arch}.exe`;
    case 'linux':
      return `Craft-Agents-${arch}.AppImage`;
  }
}
