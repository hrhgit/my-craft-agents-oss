/**
 * Cross-platform asset copy script.
 *
 * Copies the resources/ directory to dist/resources/.
 * All bundled assets (docs, themes, permissions, tool-icons) now live in resources/
 * which electron-builder handles natively via directories.buildResources.
 *
 * At Electron startup, setBundledAssetsRoot(__dirname) is called, and then
 * getBundledAssetsDir('docs') resolves to <__dirname>/resources/docs/, etc.
 *
 * Run: bun scripts/copy-assets.ts
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import {
  stageCompiledPiRuntime,
  type Arch,
  type BuildConfig,
  type Platform,
} from '../../../scripts/build/common.ts';

const ELECTRON_DIR = resolve(import.meta.dir, '..');
const ROOT_DIR = resolve(ELECTRON_DIR, '..', '..');

function getCurrentBuildConfig(): BuildConfig {
  const platform = process.platform;
  const arch = process.arch;

  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new Error(`Unsupported Electron build platform: ${platform}`);
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported Electron build arch: ${arch}`);
  }

  return {
    platform: platform as Platform,
    arch: arch as Arch,
    upload: false,
    uploadLatest: false,
    uploadScript: false,
    rootDir: ROOT_DIR,
    electronDir: ELECTRON_DIR,
  };
}

// Copy all resources (icons, themes, docs, permissions, tool-icons, etc.)
const resourcesSrc = join(ELECTRON_DIR, 'resources');
const resourcesDest = join(ELECTRON_DIR, 'dist', 'resources');
buildBundledExtensionFrontends(join(resourcesSrc, 'pi-extensions'));
mkdirSync(dirname(resourcesDest), { recursive: true });
rmSync(resourcesDest, { recursive: true, force: true });
cpSync(resourcesSrc, resourcesDest, { recursive: true, force: true });

console.log('✓ Copied resources/ → dist/resources/');

// Copy PowerShell parser script (for Windows command validation in Explore mode)
// Source: packages/shared/src/agent/powershell-parser.ps1
// Destination: dist/resources/powershell-parser.ps1
const psParserSrc = join(ROOT_DIR, 'packages', 'shared', 'src', 'agent', 'powershell-parser.ps1');
const psParserDest = join(resourcesDest, 'powershell-parser.ps1');
try {
  copyFileSync(psParserSrc, psParserDest);
  console.log('✓ Copied powershell-parser.ps1 → dist/resources/');
} catch (err) {
  // Only warn - PowerShell validation is optional on non-Windows platforms
  console.log('⚠ powershell-parser.ps1 copy skipped (not critical on non-Windows)');
}

stageCompiledPiRuntime(getCurrentBuildConfig(), join(resourcesDest, 'pi-runtime'));

/** Build ignored frontend artifacts before the source capsule is staged. */
function buildBundledExtensionFrontends(extensionsRoot: string): void {
  if (!existsSync(extensionsRoot)) return;
  for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = join(extensionsRoot, entry.name);
    const packagePath = join(packageRoot, 'package.json');
    if (!existsSync(packagePath)) continue;
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    } catch {
      continue;
    }
    if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) continue;
    const packageRecord = packageJson as { scripts?: { build?: unknown }; pi?: { extensions?: unknown[] } };
    const hasV2Frontend = Array.isArray(packageRecord.pi?.extensions)
      && packageRecord.pi.extensions.some((extension) => {
        if (!extension || typeof extension !== 'object' || Array.isArray(extension)) return false;
        return (extension as { ui?: { schemaVersion?: unknown } }).ui?.schemaVersion === 2;
      });
    if (!hasV2Frontend || typeof packageRecord.scripts?.build !== 'string') continue;
    if (!statSync(packageRoot).isDirectory()) continue;
    const result = spawnSync(process.execPath, ['run', 'build'], {
      cwd: packageRoot,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(`Bundled extension frontend build failed: ${entry.name}`);
  }
}
