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
const { createHash } = require('crypto');
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

function resolvePackagedLayout(context, options = {}) {
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
    isDeveloperHost: options.isDeveloperHost === true,
    productFilename: context.packager.appInfo.productFilename,
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

function legacyPiRuntimeCandidates(layout) {
  return [
    path.join(layout.piRuntimeRoot, 'runtime_modules'),
    path.join(layout.piRuntimeRoot, 'node_modules'),
    path.join(layout.piRuntimeRoot, 'dist', 'cli.bundle.js'),
    path.join(layout.piRuntimeRoot, 'dist', 'cli.full.bundle.js'),
    path.join(layout.piRuntimeRoot, 'dist', 'cli.interactive.bundle.js'),
    path.join(layout.appDist, 'resources', 'pi-runtime'),
    path.join(layout.appResources, 'pi-runtime'),
  ];
}

function assertCanonicalPiRuntime(layout) {
  assertNonEmptyFile(layout.piExecutable);
  const legacyCandidates = legacyPiRuntimeCandidates(layout)
    .filter(candidate => fs.existsSync(candidate));
  if (legacyCandidates.length > 0) {
    throw new Error(`Electron package contains legacy Pi runtime candidates: ${legacyCandidates.join(', ')}`);
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function authenticodeContentSha256(content) {
  const bytes = Buffer.from(content);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return undefined;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return undefined;
  const optionalHeader = peOffset + 24;
  if (optionalHeader + 68 > bytes.length) return undefined;
  const magic = bytes.readUInt16LE(optionalHeader);
  const dataDirectory = optionalHeader + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  if (dataDirectory < optionalHeader || dataDirectory + 40 > bytes.length) return undefined;
  const checksumOffset = optionalHeader + 64;
  const securityDirectoryOffset = dataDirectory + 32;
  const certificateOffset = bytes.readUInt32LE(securityDirectoryOffset);
  const certificateSize = bytes.readUInt32LE(securityDirectoryOffset + 4);
  const certificateEnd = certificateOffset + certificateSize;
  if (
    checksumOffset + 4 > securityDirectoryOffset
    || securityDirectoryOffset + 8 > bytes.length
    || (certificateOffset !== 0 && (
      certificateOffset < securityDirectoryOffset + 8
      || certificateEnd < certificateOffset
      || certificateEnd > bytes.length
    ))
  ) return undefined;

  const hash = createHash('sha256');
  hash.update(bytes.subarray(0, checksumOffset));
  hash.update(bytes.subarray(checksumOffset + 4, securityDirectoryOffset));
  const contentEnd = certificateOffset === 0 ? bytes.length : certificateOffset;
  hash.update(bytes.subarray(securityDirectoryOffset + 8, contentEnd));
  if (certificateOffset !== 0 && certificateEnd < bytes.length) hash.update(bytes.subarray(certificateEnd));
  return hash.digest('hex');
}

function getAuthenticodeStatus(file) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-AuthenticodeSignature -LiteralPath $env:MORTISE_AUTHENTICODE_FILE).Status.ToString()',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, MORTISE_AUTHENTICODE_FILE: file },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not verify Authenticode signature for ${file}: ${String(result.stderr ?? '').trim()}`);
  }
  return String(result.stdout ?? '').trim();
}

function assertPackagedArtifactMatches(artifact, packagedPath, options = {}) {
  assertNonEmptyFile(packagedPath);
  const content = fs.readFileSync(packagedPath);
  const packagedHash = createHash('sha256').update(content).digest('hex');
  const exactMatch = content.byteLength === artifact.sizeBytes && packagedHash === artifact.sha256;
  const signingRequired = process.env.MORTISE_REQUIRE_CODE_SIGNING === '1';
  if (exactMatch && (!signingRequired || artifact.authenticodeSha256 === undefined)) return;
  if (artifact.authenticodeSha256 === undefined) {
    throw new Error(`Packaged artifact does not match build provenance: ${artifact.path}`);
  }

  const normalizedHash = authenticodeContentSha256(content);
  if (normalizedHash !== artifact.authenticodeSha256) {
    throw new Error(`Packaged artifact does not match build provenance: ${artifact.path}`);
  }
  const status = (options.getAuthenticodeStatus ?? getAuthenticodeStatus)(packagedPath);
  if (status !== 'Valid') {
    throw new Error(`Packaged Authenticode artifact is not valid (${status}): ${artifact.path}`);
  }
}

function restoreRuntimePackageManifest(layout, context) {
  const frozenManifest = path.join(
    context.packager.projectDir,
    'dist',
    'packaging-inputs',
    'runtime-package.json',
  );
  assertNonEmptyFile(frozenManifest);
  fs.copyFileSync(frozenManifest, path.join(layout.appRoot, 'package.json'));
  console.log('Frozen runtime package manifest restored after Electron Builder metadata rewriting');
}

function assertBuildProvenance(layout) {
  const provenancePath = path.join(layout.appDist, 'build-provenance.json');
  assertNonEmptyFile(provenancePath);
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  if (
    provenance.schemaVersion !== 5
    || provenance.producerVersion !== 'electron-production-v4'
    || !/^[0-9a-f]{64}$/.test(provenance.buildId ?? '')
    || !/^[0-9a-f]{64}$/.test(provenance.sourceId ?? '')
    || provenance.platform !== layout.platform
    || provenance.arch !== layout.arch
    || !Array.isArray(provenance.artifacts)
  ) {
    throw new Error(`Packaged build provenance is invalid: ${provenancePath}`);
  }

  const packagedPaths = new Set();
  let excluded = 0;
  for (const artifact of provenance.artifacts) {
    if (
      !artifact
      || typeof artifact.path !== 'string'
      || !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? '')
      || !Number.isSafeInteger(artifact.sizeBytes)
      || artifact.sizeBytes < 0
      || (artifact.authenticodeSha256 !== undefined && !/^[0-9a-f]{64}$/.test(artifact.authenticodeSha256))
    ) {
      throw new Error(`Packaged build provenance has an invalid artifact: ${String(artifact?.path)}`);
    }
    const classification = classifyBuildArtifact(layout, artifact.path);
    if (classification.excluded) {
      excluded += 1;
      continue;
    }
    const packagedPath = classification.packagedPath;
    assertPackagedArtifactMatches(artifact, packagedPath);
    packagedPaths.add(path.resolve(packagedPath));
  }

  const provenancePathResolved = path.resolve(provenancePath);
  const unexpected = [
    ...filesUnder(layout.appRoot),
    ...filesUnder(layout.piRuntimeRoot),
    ...filesUnder(path.join(layout.resourcesDir, 'vendor', 'bun')),
    ...filesUnder(path.join(layout.resourcesDir, 'messaging-whatsapp-worker')),
  ].map(file => path.resolve(file)).filter(file => file !== provenancePathResolved && !packagedPaths.has(file));
  if (unexpected.length > 0) {
    throw new Error(`Packaged application contains files without build provenance: ${unexpected.join(', ')}`);
  }

  console.log(`Complete build provenance verified (${provenance.buildId.slice(0, 12)}, ${packagedPaths.size} packaged, ${excluded} build-only)`);
  return provenance;
}

const DEV_HOST_DEDUP_MANIFEST = 'dev-host-dedup.json';
const DEV_HOST_LINK_SCRIPT = 'link-dev-host.ps1';

function filesEqualSync(a, b) {
  const statA = fs.statSync(a);
  const statB = fs.statSync(b);
  if (statA.size !== statB.size) return false;
  const fdA = fs.openSync(a, 'r');
  const fdB = fs.openSync(b, 'r');
  const bufferA = Buffer.alloc(1024 * 1024);
  const bufferB = Buffer.alloc(1024 * 1024);
  try {
    let offset = 0;
    while (offset < statA.size) {
      const readA = fs.readSync(fdA, bufferA, 0, bufferA.length, offset);
      const readB = fs.readSync(fdB, bufferB, 0, bufferB.length, offset);
      if (readA !== readB || !bufferA.subarray(0, readA).equals(bufferB.subarray(0, readB))) return false;
      offset += readA;
    }
    return true;
  } finally {
    fs.closeSync(fdA);
    fs.closeSync(fdB);
  }
}

/**
 * Removes Developer Host runtime files that are byte-identical to the Mortise
 * host runtime inside the packaged layout. The installer re-links them to the
 * host files on the same volume, so the Developer Host keeps a complete runtime
 * without doubling the payload. Returns the deduplicated relative paths.
 */
function dedupeDeveloperKitAgainstHost(layout) {
  const developerKitRoot = path.join(layout.resourcesDir, 'developer-kit');
  const devHostRoot = path.join(developerKitRoot, 'dev-host');
  if (!fs.existsSync(devHostRoot)) return [];
  const entries = [];
  let removedBytes = 0;
  for (const file of filesUnder(devHostRoot)) {
    const relative = path.relative(devHostRoot, file);
    if (relative.startsWith(`resources${path.sep}developer-kit`)) continue;
    const hostFile = path.join(path.dirname(layout.resourcesDir), relative);
    if (!fs.existsSync(hostFile) || !fs.statSync(hostFile).isFile()) continue;
    if (!filesEqualSync(file, hostFile)) continue;
    fs.rmSync(file, { force: true });
    removedBytes += fs.statSync(hostFile).size;
    entries.push({ relative: relative.split(path.sep).join('/') });
  }
  const manifestPath = path.join(developerKitRoot, DEV_HOST_DEDUP_MANIFEST);
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    hostProductFilename: layout.productFilename,
    sizeBytes: removedBytes,
    entries,
  }, null, 2));
  console.log(`Developer Kit deduplicated against host runtime (${entries.length} files, ${(removedBytes / 1024 / 1024).toFixed(1)} MB)`);
  return entries;
}

function assertDeveloperKitProvenance(layout, sourceId) {
  // The Developer Host becomes one artifact inside the Developer Kit. It is
  // not an installer and must not validate the kit that will later contain it.
  if (layout.isDeveloperHost) return;
  const developerKitRoot = path.join(layout.resourcesDir, 'developer-kit');
  const required = layout.platform === 'win32';
  if (!fs.existsSync(developerKitRoot)) {
    if (required) throw new Error(`Packaged Windows application is missing the Developer Kit: ${developerKitRoot}`);
    return;
  }
  const provenancePath = path.join(developerKitRoot, 'build-provenance.json');
  assertNonEmptyFile(provenancePath);
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  if (
    provenance.schemaVersion !== 1
    || !/^[0-9a-f]{64}$/.test(provenance.buildId ?? '')
    || provenance.sourceId !== sourceId
    || !Array.isArray(provenance.artifacts)
  ) throw new Error(`Packaged Developer Kit provenance is invalid: ${provenancePath}`);

  const dedupManifestPath = path.join(developerKitRoot, DEV_HOST_DEDUP_MANIFEST);
  const dedupRelatives = new Set(
    fs.existsSync(dedupManifestPath)
      ? (JSON.parse(fs.readFileSync(dedupManifestPath, 'utf8')).entries ?? []).map(entry => `dev-host/${entry.relative}`)
      : [],
  );
  const expectedPaths = new Set();
  let totalBytes = 0;
  for (const artifact of provenance.artifacts) {
    if (
      !artifact
      || typeof artifact.path !== 'string'
      || path.isAbsolute(artifact.path)
      || artifact.path.split('/').includes('..')
      || !Number.isSafeInteger(artifact.sizeBytes)
      || artifact.sizeBytes < 0
      || !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? '')
      || (artifact.authenticodeSha256 !== undefined && !/^[0-9a-f]{64}$/.test(artifact.authenticodeSha256))
    ) throw new Error(`Packaged Developer Kit provenance has an invalid artifact: ${String(artifact?.path)}`);
    if (dedupRelatives.has(artifact.path)) {
      const hostRelative = artifact.path.startsWith('dev-host/') ? artifact.path.slice('dev-host/'.length) : artifact.path;
      const hostFile = path.join(path.dirname(layout.resourcesDir), ...hostRelative.split('/'));
      try {
        assertPackagedArtifactMatches(artifact, hostFile);
      } catch (error) {
        throw new Error(`Deduplicated Developer Kit artifact does not match the host runtime: ${artifact.path}`, { cause: error });
      }
    } else {
      const packagedPath = path.join(developerKitRoot, ...artifact.path.split('/'));
      try {
        assertPackagedArtifactMatches(artifact, packagedPath);
      } catch (error) {
        throw new Error(`Packaged Developer Kit artifact does not match provenance: ${artifact.path}`, { cause: error });
      }
      expectedPaths.add(path.resolve(packagedPath));
    }
    totalBytes += artifact.sizeBytes;
  }
  if (provenance.sizeBytes !== totalBytes) throw new Error('Packaged Developer Kit provenance size is invalid.');
  const allowedExtraFiles = new Set([
    path.resolve(dedupManifestPath),
    path.resolve(path.join(developerKitRoot, DEV_HOST_LINK_SCRIPT)),
  ]);
  const unexpected = filesUnder(developerKitRoot)
    .map(file => path.resolve(file))
    .filter(file => file !== path.resolve(provenancePath) && !expectedPaths.has(file) && !allowedExtraFiles.has(file));
  if (unexpected.length > 0) {
    throw new Error(`Packaged Developer Kit contains files without provenance: ${unexpected.join(', ')}`);
  }
  console.log(`Developer Kit provenance verified (${provenance.buildId.slice(0, 12)}, ${expectedPaths.size} files, ${dedupRelatives.size} deduplicated)`);
}

function classifyBuildArtifact(layout, artifactPath) {
  if (artifactPath === 'package.json') {
    return { excluded: true };
  }
  if (!artifactPath.startsWith('dist/')) {
    throw new Error(`Build provenance contains an unclassified artifact: ${artifactPath}`);
  }

  const relativeDist = artifactPath.slice('dist/'.length);
  if (
    relativeDist.startsWith('renderer/src/')
    || relativeDist.endsWith('.map')
    || relativeDist.endsWith('.d.ts')
    || relativeDist.startsWith('.')
    || relativeDist.startsWith('installer-developer-kit/')
  ) return { excluded: true };

  const packagingPrefix = 'packaging-inputs/';
  if (relativeDist === `${packagingPrefix}runtime-package.json`) {
    return { packagedPath: path.join(layout.appRoot, 'package.json') };
  }
  if (relativeDist.startsWith(`${packagingPrefix}runtime/ripgrep/`)) {
    return {
      packagedPath: path.join(
        layout.appRoot,
        'node_modules',
        '@vscode',
        'ripgrep',
        ...relativeDist.slice(`${packagingPrefix}runtime/ripgrep/`.length).split('/'),
      ),
    };
  }
  const bunPrefix = `${packagingPrefix}runtime/bun/`;
  if (relativeDist.startsWith(bunPrefix)) {
    return { packagedPath: path.join(layout.resourcesDir, 'vendor', 'bun', ...relativeDist.slice(bunPrefix.length).split('/')) };
  }
  const workerPath = `${packagingPrefix}runtime/messaging-whatsapp-worker/worker.cjs`;
  if (relativeDist === workerPath) {
    return { packagedPath: layout.workerEntry };
  }
  if (relativeDist.startsWith(packagingPrefix)) return { excluded: true };

  const resourceMappings = [
    ['resources/pi-runtime/', layout.piRuntimeRoot],
    ['resources/session-mcp-server/', path.join(layout.appResources, 'session-mcp-server')],
    ['resources/scripts/', path.join(layout.appResources, 'scripts')],
    ['resources/bin/', path.join(layout.appResources, 'bin')],
  ];
  for (const [prefix, root] of resourceMappings) {
    if (relativeDist.startsWith(prefix)) {
      return { packagedPath: path.join(root, ...relativeDist.slice(prefix.length).split('/')) };
    }
  }
  return { packagedPath: path.join(layout.appDist, ...relativeDist.split('/')) };
}

function filesUnder(root, result = []) {
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) filesUnder(entryPath, result);
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

function validatePackagedLayout(layout) {
  assertCanonicalPiRuntime(layout);
  const provenance = assertBuildProvenance(layout);
  assertDeveloperKitProvenance(layout, provenance.sourceId);
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
    path.join(layout.appDist, 'resources', 'pi-extensions', 'package.json'),
    path.join(layout.appDist, 'resources', 'docs', 'mortise-cli.md'),
    path.join(layout.appResources, 'session-mcp-server', 'index.js'),
    path.join(layout.appResources, 'scripts', 'pdf_tool.py'),
    layout.bunExecutable,
    layout.workerEntry,
    layout.ripgrepExecutable,
    layout.uvExecutable,
    layout.appExecutable,
  ];

  requiredFiles.push(layout.piExecutable);

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

function readWorkspaceProtocolContract(projectDir) {
  const contractPath = path.join(projectDir, 'dist', 'packaging-inputs', 'workspace-rpc-protocol.json');
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    throw new Error(`Packaged workspace protocol contract is unreadable at ${contractPath}: ${error.message}`);
  }
  if (
    contract?.schemaVersion !== 1
    || typeof contract.protocolVersion !== 'string'
    || contract.protocolVersion.length === 0
    || !Array.isArray(contract.protocolCapabilities)
    || contract.protocolCapabilities.some(capability => typeof capability !== 'string' || capability.length === 0)
  ) {
    throw new Error(`Packaged workspace protocol contract is invalid: ${contractPath}`);
  }
  return {
    schemaVersion: 1,
    protocolVersion: contract.protocolVersion,
    protocolCapabilities: [...new Set(contract.protocolCapabilities)],
  };
}

function createWorkspaceHandshakeEnvelope(id, token, protocolContract) {
  return {
    id,
    type: 'handshake',
    protocolVersion: protocolContract.protocolVersion,
    protocolCapabilities: [...protocolContract.protocolCapabilities],
    token,
  };
}

function assertWorkspaceHandshakeAck(envelope, protocolContract) {
  if (!envelope || envelope.type !== 'handshake_ack') {
    const responseType = typeof envelope?.type === 'string' ? envelope.type : 'invalid';
    const errorCode = typeof envelope?.error?.code === 'string' ? envelope.error.code : undefined;
    const errorMessage = typeof envelope?.error?.message === 'string' ? envelope.error.message : undefined;
    const detail = [errorCode, errorMessage].filter(Boolean).join(': ');
    throw new Error(
      `Packaged workspace handshake rejected (${responseType})${detail ? `: ${detail}` : ''}`,
    );
  }
  if (envelope.protocolVersion !== protocolContract.protocolVersion) {
    throw new Error(
      `Packaged workspace handshake_ack protocol mismatch: expected ${protocolContract.protocolVersion}, received ${envelope.protocolVersion ?? '(missing)'}`,
    );
  }
  const advertisedCapabilities = new Set(
    Array.isArray(envelope.protocolCapabilities) ? envelope.protocolCapabilities : [],
  );
  const missingCapabilities = protocolContract.protocolCapabilities.filter(
    capability => !advertisedCapabilities.has(capability),
  );
  if (missingCapabilities.length > 0) {
    throw new Error(
      `Packaged workspace handshake_ack is missing protocol capabilities: ${missingCapabilities.join(', ')}`,
    );
  }
}

function probeWorkspaceHandshake(url, token, protocolContract) {
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
      socket.send(JSON.stringify(createWorkspaceHandshakeEnvelope(randomUUID(), token, protocolContract)));
    });
    socket.once('message', raw => {
      try {
        const envelope = JSON.parse(raw.toString());
        assertWorkspaceHandshakeAck(envelope, protocolContract);
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once('error', finish);
  });
}

async function smokeWorkspaceServer(layout, context) {
  const protocolContract = readWorkspaceProtocolContract(context.packager.projectDir);
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
          void probeWorkspaceHandshake(readyMatch[1].trim(), token, protocolContract)
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

module.exports = async function afterPack(context, options = {}) {
  const layout = resolvePackagedLayout(context, options);
  const compiledBinary = layout.piExecutable;

  assertCanonicalPiRuntime(layout);
  console.log(`Canonical compiled Pi runtime finalized: ${compiledBinary}`);

  // Only process the icon on macOS builds.
  if (context.electronPlatformName !== 'darwin') {
    console.log('Skipping Liquid Glass icon (not macOS)');
  } else {
    const precompiledAssets = path.join(context.packager.projectDir, 'dist', 'resources', 'Assets.car');

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

  restoreRuntimePackageManifest(layout, context);
  if (layout.platform === 'win32' && layout.productFilename === 'Mortise') {
    dedupeDeveloperKitAgainstHost(layout);
  }
  validatePackagedLayout(layout);
  await smokeWorkspaceServer(layout, context);
};

module.exports.resolvePackagedLayout = resolvePackagedLayout;
module.exports.validatePackagedLayout = validatePackagedLayout;
module.exports.assertCanonicalPiRuntime = assertCanonicalPiRuntime;
module.exports.assertBuildProvenance = assertBuildProvenance;
module.exports.classifyBuildArtifact = classifyBuildArtifact;
module.exports.restoreRuntimePackageManifest = restoreRuntimePackageManifest;
module.exports.authenticodeContentSha256 = authenticodeContentSha256;
module.exports.assertPackagedArtifactMatches = assertPackagedArtifactMatches;
module.exports.assertDeveloperKitProvenance = assertDeveloperKitProvenance;
module.exports.filesEqualSync = filesEqualSync;
module.exports.dedupeDeveloperKitAgainstHost = dedupeDeveloperKitAgainstHost;
module.exports.smokeWorkspaceServer = smokeWorkspaceServer;
module.exports.probeWorkspaceHandshake = probeWorkspaceHandshake;
module.exports.readWorkspaceProtocolContract = readWorkspaceProtocolContract;
module.exports.createWorkspaceHandshakeEnvelope = createWorkspaceHandshakeEnvelope;
module.exports.assertWorkspaceHandshakeAck = assertWorkspaceHandshakeAck;
