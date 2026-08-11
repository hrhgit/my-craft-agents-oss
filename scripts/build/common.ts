/**
 * Common build utilities shared across all platforms
 */

import { $ } from 'bun';
import { execFileSync, execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  cpSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  chmodSync,
  writeFileSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { randomUUID } from 'crypto';
import { assertNoUiValidationProductionRuntime } from './ui-validation-boundary';
import { assertNoSourceRootReferences } from './bundle-portability';
import { withFileLock } from './file-lock';

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
export const BUN_VERSION = 'bun-v1.3.14';

/**
 * uv version to bundle with the app.
 * Update this when upgrading uv. Check latest at: https://github.com/astral-sh/uv/releases
 */
export const UV_VERSION = '0.10.6';
const UV_TOOLCHAIN_CACHE_SCHEMA_VERSION = 1;

interface CachedUvManifest {
  schemaVersion: typeof UV_TOOLCHAIN_CACHE_SCHEMA_VERSION;
  version: string;
  platform: Platform;
  arch: Arch;
  binary: string;
  sizeBytes: number;
  sha256: string;
}

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

  const toolchainCache = process.env.MORTISE_BUILD_TOOLCHAIN_CACHE_DIR;
  if (toolchainCache) {
    const cachedUv = ensureCachedUv(config, toolchainCache);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(cachedUv, targetPath);
    if (platform !== 'win32') chmodSync(targetPath, 0o755);
    console.log(`uv ${UV_VERSION} restored from verified toolchain cache to ${targetPath} ✓`);
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

const PI_RUNTIME_PACKAGE = '@mortise/pi-coding-agent';

function packagePathParts(packageName: string): string[] {
  return packageName.split('/');
}

function resolvePackageDir(packageName: string, fromDir: string): string | undefined {
  const parts = packagePathParts(packageName);
  const logical = resolve(fromDir);
  const bases: string[] = [];
  bases.push(logical);

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

function piSidecarTarget(platform: Platform, arch: Arch): string {
  const sidecarPlatform = platform === 'win32' ? 'windows' : platform;
  return `${sidecarPlatform}-${arch}`;
}

export function stageCompiledPiRuntime(config: BuildConfig, runtimeRoot: string): void {
  if (!/^[0-9a-f]{64}$/.test(process.env.MORTISE_BUILD_SOURCE_ID ?? '')) {
    throw new Error('Pi runtime staging requires a canonical immutable build source identity.');
  }
  const packageDir = resolvePackageDir(PI_RUNTIME_PACKAGE, config.rootDir);
  if (!packageDir) {
    throw new Error(`Unable to resolve ${PI_RUNTIME_PACKAGE} from ${config.rootDir}`);
  }

  const binaryDist = join(packageDir, 'dist');
  const binaryName = config.platform === 'win32' ? 'pi.exe' : 'pi';
  const binaryPath = join(binaryDist, binaryName);
  if (!existsSync(binaryPath)) {
    throw new Error(`Pi compiled binary missing: ${binaryPath}. Run the Pi build:binary script first.`);
  }

  console.log('Staging compiled Pi runtime...');
  removeDirectoryWithRetry(runtimeRoot);
  mkdirSync(runtimeRoot, { recursive: true });

  for (const entry of [
    binaryName,
    'package.json',
    'photon_rs_bg.wasm',
  ]) {
    copyPackageSurfacePath(binaryDist, runtimeRoot, entry, true);
  }

  const sidecarTarget = piSidecarTarget(config.platform, config.arch);
  const sidecarRelativePath = `sidecar/bin/${sidecarTarget}/${config.platform === 'win32' ? 'pi-network-sidecar.exe' : 'pi-network-sidecar'}`;
  copyPackageSurfacePath(binaryDist, runtimeRoot, sidecarRelativePath, true);
  if (config.platform !== 'win32') {
    chmodSync(join(runtimeRoot, ...sidecarRelativePath.split('/')), 0o755);
  }
  console.log(`  Compiled Pi runtime staged (entry ${binaryName})`);
}

export function publishVerifiedUvToolchain(
  cacheRoot: string,
  config: Pick<BuildConfig, 'platform' | 'arch'>,
  sourceBinary: string,
  expectedSha256: string,
): string {
  const cache = uvCachePaths(cacheRoot, config.platform, config.arch);
  return withFileLock(cache.lock, () => publishVerifiedUvToolchainLocked(
    cache,
    config,
    sourceBinary,
    expectedSha256,
  ), { timeoutMs: 600_000, staleMs: 600_000 });
}

function publishVerifiedUvToolchainLocked(
  cache: ReturnType<typeof uvCachePaths>,
  config: Pick<BuildConfig, 'platform' | 'arch'>,
  sourceBinary: string,
  expectedSha256: string,
): string {
  const existing = readValidCachedUv(cache.binary, cache.manifest, config.platform, config.arch);
  if (existing) return existing;
  if (!existsSync(sourceBinary)) throw new Error(`Verified uv source binary is missing: ${sourceBinary}`);
  const content = readFileSync(sourceBinary);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`Verified uv source hash mismatch: expected ${expectedSha256}, observed ${sha256}`);
  }
  mkdirSync(cache.directory, { recursive: true });
  const token = `${process.pid}-${randomUUID()}`;
  const stagingBinary = `${cache.binary}.${token}.tmp`;
  const stagingManifest = `${cache.manifest}.${token}.tmp`;
  try {
    copyFileSync(sourceBinary, stagingBinary);
    writeFileSync(stagingManifest, `${JSON.stringify({
      schemaVersion: UV_TOOLCHAIN_CACHE_SCHEMA_VERSION,
      version: UV_VERSION,
      platform: config.platform,
      arch: config.arch,
      binary: cache.binaryName,
      sizeBytes: content.byteLength,
      sha256,
    } satisfies CachedUvManifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(stagingBinary, cache.binary);
    renameSync(stagingManifest, cache.manifest);
  } finally {
    rmSync(stagingBinary, { force: true });
    rmSync(stagingManifest, { force: true });
  }
  return cache.binary;
}

function ensureCachedUv(config: BuildConfig, cacheRoot: string): string {
  const cache = uvCachePaths(cacheRoot, config.platform, config.arch);
  const existing = readValidCachedUv(cache.binary, cache.manifest, config.platform, config.arch);
  if (existing) return existing;

  return withFileLock(cache.lock, () => {
    const lockedExisting = readValidCachedUv(cache.binary, cache.manifest, config.platform, config.arch);
    if (lockedExisting) return lockedExisting;
    mkdirSync(cache.directory, { recursive: true });
    const stagingDir = join(cache.directory, `.download-${process.pid}-${randomUUID()}`);
    mkdirSync(stagingDir, { recursive: true });
    try {
      const uvDownload = getUvDownloadName(config.platform, config.arch);
      const assetUrl = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uvDownload}`;
      const assetPath = join(stagingDir, uvDownload);
      const checksumPath = join(stagingDir, `${uvDownload}.sha256`);
      const extractDir = join(stagingDir, 'extract');
      console.log(`Downloading uv ${UV_VERSION} for ${config.platform}-${config.arch} into toolchain cache...`);
      execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', assetPath, assetUrl], { stdio: 'inherit' });
      execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-o', checksumPath, `${assetUrl}.sha256`], { stdio: 'inherit' });
      const hashMatch = readFileSync(checksumPath, 'utf8').match(/[a-fA-F0-9]{64}/);
      if (!hashMatch) throw new Error(`Unable to parse checksum from ${checksumPath}`);
      const archiveSha256 = createHash('sha256').update(readFileSync(assetPath)).digest('hex');
      if (archiveSha256 !== hashMatch[0].toLowerCase()) throw new Error('uv checksum verification failed');
      mkdirSync(extractDir, { recursive: true });
      if (uvDownload.endsWith('.zip')) {
        execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${assetPath.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`], { stdio: 'inherit' });
      } else {
        execFileSync('tar', ['-xzf', assetPath, '-C', extractDir], { stdio: 'inherit' });
      }
      const extractedUv = findFileRecursive(extractDir, cache.binaryName);
      if (!extractedUv) throw new Error(`Unable to locate ${cache.binaryName} in extracted archive`);
      const binarySha256 = createHash('sha256').update(readFileSync(extractedUv)).digest('hex');
      return publishVerifiedUvToolchainLocked(cache, config, extractedUv, binarySha256);
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }, { timeoutMs: 600_000, staleMs: 600_000 });
}

/** Return the verified cached uv binary without downloading or scanning builds. */
export function resolveCachedUvToolchain(
  cacheRoot: string,
  config: Pick<BuildConfig, 'platform' | 'arch'>,
): string | undefined {
  const cache = uvCachePaths(cacheRoot, config.platform, config.arch)
  return readValidCachedUv(cache.binary, cache.manifest, config.platform, config.arch)
}

function uvCachePaths(cacheRoot: string, platform: Platform, arch: Arch) {
  const binaryName = platform === 'win32' ? 'uv.exe' : 'uv';
  const directory = join(resolve(cacheRoot), 'uv', UV_VERSION, getPlatformKey(platform, arch));
  return {
    directory,
    binaryName,
    binary: join(directory, binaryName),
    manifest: join(directory, 'uv.json'),
    lock: join(resolve(cacheRoot), 'locks', `uv-${UV_VERSION}-${getPlatformKey(platform, arch)}`),
  };
}

function readValidCachedUv(
  binaryPath: string,
  manifestPath: string,
  platform: Platform,
  arch: Arch,
): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CachedUvManifest;
    const content = readFileSync(binaryPath);
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (
      manifest.schemaVersion !== UV_TOOLCHAIN_CACHE_SCHEMA_VERSION
      || manifest.version !== UV_VERSION
      || manifest.platform !== platform
      || manifest.arch !== arch
      || manifest.binary !== (platform === 'win32' ? 'uv.exe' : 'uv')
      || manifest.sizeBytes !== content.byteLength
      || manifest.sha256 !== sha256
    ) return undefined;
    return binaryPath;
  } catch {
    return undefined;
  }
}

/**
 * Copy Session MCP Server to packaged app resources.
 * The session server provides session-scoped tools for agent sessions.
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
    `bun build ${join(sessionDir, 'src', 'index.ts')} --outfile ${sessionOut} --target node --format cjs --minify-syntax --define process.env.MORTISE_UI_VALIDATION_BUILD=\\\"0\\\" --define process.env.MORTISE_UI_TEST_HOST=\\\"0\\\"`,
    { cwd: rootDir, stdio: 'inherit', shell: true }
  );

  if (!existsSync(sessionOut)) {
    throw new Error(`Session MCP server output not found at ${sessionOut}`);
  }
  const sessionServerSource = readFileSync(sessionOut, 'utf8');
  assertNoUiValidationProductionRuntime(sessionServerSource, 'session-mcp-server/index.js');
  assertNoSourceRootReferences(sessionServerSource, 'session-mcp-server/index.js', rootDir);
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
  // Packaging must never inherit an opt-in source-development validation build.
  process.env.MORTISE_UI_VALIDATION_BUILD = '0';
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
      return `Mortise-${arch}.dmg`;
    case 'win32':
      return `Mortise-${arch}.exe`;
    case 'linux':
      return `Mortise-${arch}.AppImage`;
  }
}
