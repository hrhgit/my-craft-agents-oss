/**
 * Windows-specific build logic (Node.js only - no Bun dependencies)
 *
 * Note: This contains extensive workarounds for Windows Defender and file locking issues.
 * These are necessary for reliable CI builds on Windows.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, cpSync, readFileSync } from 'fs';
import { join } from 'path';
import { copyPiRuntime, type BuildConfig } from './common';
import { assertNoUiValidationProductionInputs, assertNoUiValidationProductionRuntime } from './ui-validation-boundary';

/**
 * Sleep helper (Node.js replacement for Bun.sleep)
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a shell command with proper Windows handling
 */
function run(command: string, cwd: string): void {
  console.log(`    > ${command}`);
  execSync(command, {
    cwd,
    stdio: 'inherit',
    shell: true,
  });
}

/**
 * Run a shell command silently, ignoring errors
 */
function runQuiet(command: string, cwd: string): void {
  try {
    execSync(command, {
      cwd,
      stdio: 'pipe',
      shell: true,
    });
  } catch {
    // Ignore errors
  }
}

/**
 * Kill processes that might lock files
 */
async function killLockingProcesses(): Promise<void> {
  const processesToKill = ['node', 'npm', 'electron', 'electron-builder'];

  for (const procName of processesToKill) {
    runQuiet(`taskkill /F /IM ${procName}.exe 2>nul`, process.cwd());
  }

  // Give processes time to fully terminate
  await sleep(2000);
}

/**
 * Safely remove a directory with exponential backoff retry
 * Windows file locking can cause transient failures
 */
async function safeRmDir(dir: string, maxRetries = 5): Promise<void> {
  if (!existsSync(dir)) return;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      // Verify it's actually gone
      if (!existsSync(dir)) {
        return;
      }
    } catch (error) {
      lastError = error as Error;
    }

    // Exponential backoff: 500ms, 1s, 2s, 4s, 8s
    const delay = 500 * Math.pow(2, attempt);
    console.log(`    Directory still locked, retrying in ${delay}ms...`);
    await sleep(delay);
  }

  if (existsSync(dir)) {
    throw new Error(`Failed to remove ${dir} after ${maxRetries} attempts: ${lastError?.message}`);
  }
}

/**
 * Build main process with OAuth defines (Windows-specific inline build)
 */
function buildMainProcess(config: BuildConfig): void {
  const { rootDir } = config;
  const metafile = join(rootDir, 'apps/electron/dist/.win32-main-build-meta.json');

  console.log('  Building main process...');

  const mainArgs = [
    'apps/electron/src/main/index.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--outfile=apps/electron/dist/main.cjs',
    '--external:electron',
    '--define:__CRAFT_UI_VALIDATION_BUILD__=false',
    `--metafile=${metafile}`,
    // Replace grammY's bundled polyfills (node-fetch@2 + abort-controller@3)
    // with native Node globals. Keeps parity with electron-dev.ts,
    // electron-build-main.ts, and apps/electron/package.json build:main.
    '--alias:node-fetch=./apps/electron/src/main/shims/node-fetch.cjs',
    '--alias:abort-controller=./apps/electron/src/main/shims/abort-controller.cjs',
    '--alias:@craft-agent/shared/protocol=./packages/shared/src/protocol/production.ts',
  ];

  // Add OAuth defines if env vars are set
  const oauthDefines = [
    ['GOOGLE_OAUTH_CLIENT_ID', process.env.GOOGLE_OAUTH_CLIENT_ID],
    ['GOOGLE_OAUTH_CLIENT_SECRET', process.env.GOOGLE_OAUTH_CLIENT_SECRET],
    ['SLACK_OAUTH_CLIENT_ID', process.env.SLACK_OAUTH_CLIENT_ID],
    ['SLACK_OAUTH_CLIENT_SECRET', process.env.SLACK_OAUTH_CLIENT_SECRET],
    ['MICROSOFT_OAUTH_CLIENT_ID', process.env.MICROSOFT_OAUTH_CLIENT_ID],
  ];

  for (const [key, value] of oauthDefines) {
    if (value) {
      mainArgs.push(`--define:process.env.${key}="'${value}'"`);
    }
  }

  // Use node to run esbuild directly
  run(`node ./node_modules/esbuild/bin/esbuild ${mainArgs.join(' ')}`, rootDir);
  try {
    const metadata = JSON.parse(readFileSync(metafile, 'utf-8')) as { inputs?: Record<string, unknown> };
    assertNoUiValidationProductionInputs(Object.keys(metadata.inputs ?? {}), 'Windows Electron main bundle');
  } finally {
    rmSync(metafile, { force: true });
  }
}

/**
 * Build Electron app for Windows (with OAuth injection)
 */
export async function buildElectronAppWindows(config: BuildConfig): Promise<void> {
  const { rootDir, electronDir } = config;
  const preloadOutput = join(rootDir, 'apps/electron/dist/bootstrap-preload.cjs');
  const preloadMetafile = join(rootDir, 'apps/electron/dist/.win32-preload-build-meta.json');
  const preloadMetafileArg = 'apps/electron/dist/.win32-preload-build-meta.json';

  console.log('Building Electron app...');
  // Packaging must never inherit an opt-in source-development validation build.
  process.env.CRAFT_UI_VALIDATION_BUILD = '0';

  // Build main process with OAuth defines
  buildMainProcess(config);

  // Build preload - invoke esbuild directly via node
  console.log('  Building preload...');
  run(
    `node ./node_modules/esbuild/bin/esbuild apps/electron/src/preload/bootstrap.ts --bundle --platform=node --format=cjs --outfile=apps/electron/dist/bootstrap-preload.cjs --external:electron --define:__CRAFT_UI_VALIDATION_BUILD__=false --define:process.env.CRAFT_UI_VALIDATION_BUILD=\"0\" --metafile=${preloadMetafileArg} --minify-syntax --alias:@craft-agent/shared/protocol=./packages/shared/src/protocol/production.ts`,
    rootDir
  );
  try {
    const metadata = JSON.parse(readFileSync(preloadMetafile, 'utf-8')) as { inputs?: Record<string, unknown> };
    assertNoUiValidationProductionInputs(Object.keys(metadata.inputs ?? {}), 'Windows Electron preload bundle');
  } finally {
    rmSync(preloadMetafile, { force: true });
  }
  assertNoUiValidationProductionRuntime(readFileSync(preloadOutput, 'utf-8'), 'Windows Electron preload bundle');

  // Build renderer - invoke vite directly via node
  console.log('  Building renderer...');
  const rendererDir = join(electronDir, 'dist', 'renderer');
  if (existsSync(rendererDir)) {
    rmSync(rendererDir, { recursive: true, force: true });
  }
  run('node --max-old-space-size=4096 ./node_modules/vite/bin/vite.js build --config apps/electron/vite.config.ts', rootDir);

  // Verify renderer was built
  if (!existsSync(join(rendererDir, 'index.html'))) {
    throw new Error('Renderer build verification failed: index.html not found');
  }
  console.log('  Renderer build verified ✓');

  // Copy resources
  console.log('  Copying resources...');
  const resourcesSrc = join(electronDir, 'resources');
  const resourcesDst = join(electronDir, 'dist', 'resources');
  if (existsSync(resourcesDst)) {
    rmSync(resourcesDst, { recursive: true, force: true });
  }
  cpSync(resourcesSrc, resourcesDst, { recursive: true });

  // Pi RpcClient starts a separate CLI subprocess; ship its package runtime in
  // dist/resources so packaged Windows builds can create sessions offline from
  // the development node_modules symlinks.
  copyPiRuntime(config);

  // Copy doc assets (matches electron:build:assets step used by Mac/Linux builds)
  // Without this, loadBundledDocs() can't find the docs and falls back to placeholders
  console.log('  Copying doc assets...');
  const docsSrc = join(rootDir, 'packages', 'shared', 'assets', 'docs');
  const docsDst = join(electronDir, 'dist', 'assets', 'docs');
  if (existsSync(docsSrc)) {
    mkdirSync(join(electronDir, 'dist', 'assets'), { recursive: true });
    cpSync(docsSrc, docsDst, { recursive: true, force: true });
    console.log('  Doc assets copied ✓');
  } else {
    console.warn('  ⚠️ No doc assets found at', docsSrc);
  }
}

/**
 * Package the Windows app with electron-builder (with retry logic)
 */
export async function packageWindows(config: BuildConfig): Promise<string> {
  const { electronDir } = config;

  console.log('Packaging app with electron-builder...');

  // Kill any lingering processes first
  await killLockingProcesses();

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`  electron-builder attempt ${attempt} of ${maxRetries}...`);

    // Clean release directory before each attempt
    const releaseDir = join(electronDir, 'release');
    if (existsSync(releaseDir)) {
      console.log('  Cleaning release directory...');
      await safeRmDir(releaseDir);
    }

    try {
      // Run electron-builder from electronDir using npx (npx traverses up to find it in root node_modules)
      run('npx electron-builder --win --x64', electronDir);
      console.log(`  electron-builder succeeded on attempt ${attempt} ✓`);
      lastError = null;
      break;
    } catch (error) {
      lastError = error as Error;
      console.log(`  electron-builder failed on attempt ${attempt}`);

      if (attempt < maxRetries) {
        console.log('  Waiting 10 seconds before retry...');
        await killLockingProcesses();
        await sleep(10000);
      }
    }
  }

  if (lastError) {
    throw new Error(`electron-builder failed after ${maxRetries} attempts: ${lastError.message}`);
  }

  // Find the built installer
  const releaseDir = join(electronDir, 'release');
  const files = readdirSync(releaseDir);
  const exeFile = files.find((f) => f.endsWith('.exe') && !f.includes('blockmap'));

  if (!exeFile) {
    console.error('Contents of release directory:');
    console.error(files.join('\n'));
    throw new Error('Installer not found in release directory');
  }

  const exePath = join(releaseDir, exeFile);

  // Get file size using Node.js fs
  const stats = statSync(exePath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

  console.log(`\n=== Build Complete ===`);
  console.log(`Installer: ${exePath}`);
  console.log(`Size: ${sizeMB} MB`);

  return exePath;
}
