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

import { cpSync, copyFileSync, mkdirSync, rmSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  copyPiRuntime,
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

copyPiRuntime(getCurrentBuildConfig());
