/**
 * electron-builder afterPack hook
 *
 * Copies the pre-compiled macOS 26+ Liquid Glass icon (Assets.car) into the
 * app bundle. The Assets.car file is compiled locally using actool with the
 * macOS 26 SDK (not available in CI), then committed to the repo.
 *
 * To regenerate Assets.car after icon changes:
 *   cd apps/electron
 *   xcrun actool "resources/icon.icon" --compile "resources" \
 *     --app-icon AppIcon --minimum-deployment-target 26.0 \
 *     --platform macosx --output-partial-info-plist /dev/null
 *
 * For older macOS versions, the app falls back to icon.icns which is
 * included separately by electron-builder.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
};

function targetArch(context) {
  return typeof context.arch === 'string' ? context.arch : ARCH_NAMES[context.arch] ?? process.arch;
}

function resolvePackagedLayout(context) {
  const resourcesDir = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, 'Mortise.app', 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const appRoot = path.join(resourcesDir, 'app');
  const platform = context.electronPlatformName;
  const executableSuffix = platform === 'win32' ? '.exe' : '';
  const platformResources = platform === 'darwin' ? 'darwin' : platform;
  const arch = targetArch(context);
  const appExecutable = platform === 'win32'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
    : platform === 'darwin'
      ? path.join(context.appOutDir, 'Mortise.app', 'Contents', 'MacOS', context.packager.appInfo.productFilename)
      : path.join(
        context.appOutDir,
        context.packager.executableName
          ?? context.packager.appInfo.productFilename.toLowerCase().replace(/\s+/g, '-'),
      );

  return {
    platform,
    arch,
    resourcesDir,
    appRoot,
    appDist: path.join(appRoot, 'dist'),
    appResources: path.join(appRoot, 'resources'),
    appExecutable,
    piRuntimeRoot: path.join(resourcesDir, 'pi-runtime'),
    piExecutable: path.join(resourcesDir, 'pi-runtime', `pi${executableSuffix}`),
    bunExecutable: path.join(resourcesDir, 'vendor', 'bun', `bun${executableSuffix}`),
    workerEntry: path.join(resourcesDir, 'messaging-whatsapp-worker', 'worker.cjs'),
    ripgrepExecutable: path.join(resourcesDir, 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', `rg${executableSuffix}`),
    uvExecutable: path.join(appRoot, 'resources', 'bin', `${platformResources}-${arch}`, `uv${executableSuffix}`),
  };
}

function assertNonEmptyFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Packaged runtime asset missing: ${file}`);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
    throw new Error(`Packaged runtime asset is not a non-empty file: ${file}`);
  }
}

function findFilesNamed(root, filename, matches = []) {
  if (!fs.existsSync(root)) return matches;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) findFilesNamed(entryPath, filename, matches);
    else if (entry.isFile() && entry.name === filename) matches.push(entryPath);
  }
  return matches;
}

function validatePackagedLayout(layout) {
  const allowedAppEntries = new Set(['dist', 'node_modules', 'package.json', 'resources']);
  const unexpectedAppEntries = fs.readdirSync(layout.appRoot)
    .filter(entry => !allowedAppEntries.has(entry));
  if (unexpectedAppEntries.length > 0) {
    throw new Error(
      `Packaged app contains unexpected top-level source/build paths: ${unexpectedAppEntries.join(', ')}`,
    );
  }

  const requiredFiles = [
    path.join(layout.appDist, 'main.cjs'),
    path.join(layout.appDist, 'workspace-server.mjs'),
    path.join(layout.appDist, 'resources', 'pi-extensions', 'browser.js'),
    path.join(layout.appDist, 'resources', 'pi-extensions', 'messaging.js'),
    path.join(layout.appDist, 'resources', 'docs', 'mortise-cli.md'),
    path.join(layout.appResources, 'session-mcp-server', 'index.js'),
    path.join(layout.appResources, 'scripts', 'pdf_tool.py'),
    layout.bunExecutable,
    layout.workerEntry,
    layout.ripgrepExecutable,
    layout.uvExecutable,
    layout.appExecutable,
  ];

  if (fs.existsSync(layout.piExecutable)) {
    requiredFiles.push(layout.piExecutable);
  } else {
    requiredFiles.push(
      path.join(layout.piRuntimeRoot, 'package.json'),
      path.join(layout.piRuntimeRoot, 'dist', 'cli.bundle.js'),
      path.join(layout.piRuntimeRoot, 'node_modules', '@mortise', 'pi-ai', 'package.json'),
    );
  }

  for (const file of requiredFiles) assertNonEmptyFile(file);

  // The optional Developer Kit is a separately packaged product and its
  // Dev Host intentionally carries its own Bun runtime. Only enforce the
  // single-copy invariant for the Mortise application payload; an accidental
  // copy under app/dist must still fail validation.
  const developerKitRoot = path.join(layout.resourcesDir, 'developer-kit');
  const bunCopies = findFilesNamed(
    layout.resourcesDir,
    layout.platform === 'win32' ? 'bun.exe' : 'bun',
  ).filter(file => {
    const relative = path.relative(developerKitRoot, file);
    return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  });
  if (bunCopies.length !== 1 || path.resolve(bunCopies[0]) !== path.resolve(layout.bunExecutable)) {
    throw new Error(`Expected exactly one packaged Bun runtime at ${layout.bunExecutable}; found: ${bunCopies.join(', ')}`);
  }

  console.log(`Final packaged runtime layout validated (${requiredFiles.length} assets, one Bun copy)`);
}

function stopSmokeProcess(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* process already exited */ }
}

function probeWorkspaceHandshake(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Packaged workspace WebSocket handshake timed out: ${url}`));
    }, 10_000);
    const finish = (error) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    socket.once('open', () => {
      socket.send(JSON.stringify({
        id: randomUUID(),
        type: 'handshake',
        protocolVersion: '1.0',
        token,
      }));
    });
    socket.once('message', raw => {
      try {
        const envelope = JSON.parse(raw.toString());
        if (envelope.type !== 'handshake_ack') {
          finish(new Error(`Packaged workspace returned ${envelope.type} instead of handshake_ack`));
          return;
        }
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', finish);
  });
}

async function smokeWorkspaceServer(layout, context) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mortise-packaged-workspace-'));
  const cachedEntry = path.join(tempRoot, 'workspace-server.mjs');
  fs.copyFileSync(path.join(layout.appDist, 'workspace-server.mjs'), cachedEntry);
  fs.mkdirSync(path.join(tempRoot, 'config'), { recursive: true });

  let child;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let probing = false;
      let stdout = '';
      let stderr = '';
      const token = randomUUID();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopSmokeProcess(child);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error(
        `Packaged workspace server smoke timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      )), 60_000);

      child = spawn(layout.appExecutable, [cachedEntry], {
        cwd: tempRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MORTISE_CONFIG_DIR: path.join(tempRoot, 'config'),
          MORTISE_SERVER_TOKEN: token,
          MORTISE_RPC_HOST: '127.0.0.1',
          MORTISE_RPC_PORT: '0',
          MORTISE_SERVER_LOCK_NAME: '.packaged-workspace-smoke.lock',
          MORTISE_BUNDLED_ASSETS_ROOT: layout.appDist,
          MORTISE_APP_ROOT: layout.appRoot,
          MORTISE_RESOURCES_PATH: layout.resourcesDir,
          MORTISE_IS_PACKAGED: 'true',
          MORTISE_VERSION: context.packager.appInfo.version,
          MORTISE_BUN: layout.bunExecutable,
          MORTISE_MESSAGING_WA_WORKER: layout.workerEntry,
          MORTISE_MESSAGING_NODE_BIN: layout.appExecutable,
          ELECTRON_RUN_AS_NODE: '1',
          PI_CHECK_PACKAGE_UPDATES: '0',
          PI_OFFLINE: '1',
        },
      });

      child.stdout.on('data', chunk => {
        stdout = (stdout + chunk.toString()).slice(-16_384);
        const readyMatch = stdout.match(/^MORTISE_SERVER_URL=(.+)$/m);
        if (readyMatch && !probing && !settled) {
          probing = true;
          void probeWorkspaceHandshake(readyMatch[1].trim(), token)
            .then(() => finish())
            .catch(finish);
        }
      });
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-16_384);
      });
      child.once('error', finish);
      child.once('exit', (code, signal) => {
        if (!settled) finish(new Error(
          `Packaged workspace server exited before ready (code=${code}, signal=${signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ));
      });
    });
    console.log('Final packaged workspace server start + WebSocket handshake passed under Electron Node');
  } finally {
    if (child) stopSmokeProcess(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

module.exports = async function afterPack(context) {
  const layout = resolvePackagedLayout(context);
  const stagedModules = path.join(layout.piRuntimeRoot, 'runtime_modules');
  const nodeModules = path.join(layout.piRuntimeRoot, 'node_modules');
  const compiledBinary = layout.piExecutable;

  // electron-builder prunes directories named node_modules even when they are
  // extraResources. The staging step deliberately uses runtime_modules; once
  // files have been copied, restore the standard name expected by Bun.
  if (fs.existsSync(compiledBinary)) {
    console.log(`Compiled Pi runtime finalized: ${compiledBinary}`);
  } else if (fs.existsSync(stagedModules)) {
    fs.rmSync(nodeModules, { recursive: true, force: true });
    fs.renameSync(stagedModules, nodeModules);
    console.log(`Pi runtime modules finalized: ${nodeModules}`);
  } else {
    throw new Error(`Packaged Pi runtime modules missing: ${stagedModules}`);
  }

  // Only process the icon on macOS builds.
  if (context.electronPlatformName !== 'darwin') {
    console.log('Skipping Liquid Glass icon (not macOS)');
  } else {
    const precompiledAssets = path.join(context.packager.projectDir, 'resources', 'Assets.car');

    console.log(`afterPack: projectDir=${context.packager.projectDir}`);
    console.log(`afterPack: looking for Assets.car at ${precompiledAssets}`);

    if (!fs.existsSync(precompiledAssets)) {
      console.log('Warning: Pre-compiled Assets.car not found in resources/');
      console.log('The app will use the fallback icon.icns on all macOS versions');
    } else {
      const destAssetsCar = path.join(layout.resourcesDir, 'Assets.car');
      try {
        fs.copyFileSync(precompiledAssets, destAssetsCar);
        console.log(`Liquid Glass icon copied: ${destAssetsCar}`);
      } catch (err) {
        console.log(`Warning: Could not copy Assets.car: ${err.message}`);
        console.log('The app will use the fallback icon.icns on all macOS versions');
      }
    }
  }

  validatePackagedLayout(layout);
  await smokeWorkspaceServer(layout, context);
};

module.exports.resolvePackagedLayout = resolvePackagedLayout;
module.exports.validatePackagedLayout = validatePackagedLayout;
module.exports.smokeWorkspaceServer = smokeWorkspaceServer;
module.exports.probeWorkspaceHandshake = probeWorkspaceHandshake;
