import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const {
  assertPackagedArtifactMatches,
  authenticodeContentSha256,
  restoreRuntimePackageManifest,
  validatePackagedLayout,
} = require('./afterPack.cjs') as {
  assertPackagedArtifactMatches: (
    artifact: { path: string; sizeBytes: number; sha256: string; authenticodeSha256?: string },
    path: string,
    options?: { getAuthenticodeStatus?: () => string },
  ) => void
  authenticodeContentSha256: (content: Uint8Array) => string | undefined
  restoreRuntimePackageManifest: (
    layout: Record<string, string>,
    context: { packager: { projectDir: string } },
  ) => void
  validatePackagedLayout: (layout: Record<string, string>) => void
}
const roots: string[] = []
const originalBinaryRuntimeOverride = process.env.MORTISE_PI_BINARY_RUNTIME
const originalCodeSigningRequirement = process.env.MORTISE_REQUIRE_CODE_SIGNING

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalBinaryRuntimeOverride === undefined) delete process.env.MORTISE_PI_BINARY_RUNTIME
  else process.env.MORTISE_PI_BINARY_RUNTIME = originalBinaryRuntimeOverride
  if (originalCodeSigningRequirement === undefined) delete process.env.MORTISE_REQUIRE_CODE_SIGNING
  else process.env.MORTISE_REQUIRE_CODE_SIGNING = originalCodeSigningRequirement
})

function createLayout() {
  const root = mkdtempSync(join(tmpdir(), 'mortise-after-pack-'))
  roots.push(root)
  const resourcesDir = join(root, 'resources')
  const appRoot = join(resourcesDir, 'app')
  const appDist = join(appRoot, 'dist')
  const appResources = join(appRoot, 'resources')
  const write = (file: string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'fixture')
  }

  for (const file of [
    join(appRoot, 'package.json'),
    join(appDist, 'main.cjs'),
    join(appDist, 'bootstrap-preload.cjs'),
    join(appDist, 'browser-toolbar-preload.cjs'),
    join(appDist, 'workspace-server.mjs'),
    join(appDist, 'renderer', 'index.html'),
    join(appDist, 'resources', 'pi-extensions', 'browser.js'),
    join(appDist, 'resources', 'pi-extensions', 'messaging.js'),
    join(appDist, 'resources', 'pi-extensions', 'permissions.js'),
    join(appDist, 'resources', 'pi-extensions', 'package.json'),
    join(appDist, 'resources', 'docs', 'mortise-cli.md'),
    join(appResources, 'session-mcp-server', 'index.js'),
    join(appResources, 'scripts', 'pdf_tool.py'),
    join(resourcesDir, 'vendor', 'bun', 'bun.exe'),
    join(resourcesDir, 'messaging-whatsapp-worker', 'worker.cjs'),
    join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
    join(appRoot, 'resources', 'bin', 'win32-x64', 'uv.exe'),
    join(resourcesDir, 'pi-runtime', 'pi.exe'),
    join(root, 'Mortise.exe'),
  ]) write(file)

  const hash = createHash('sha256').update('fixture').digest('hex')
  const artifactPaths = [
    ['package.json', join(appRoot, 'package.json')],
    ['dist/packaging-inputs/runtime-package.json', join(appRoot, 'package.json')],
    ['dist/main.cjs', join(appDist, 'main.cjs')],
    ['dist/bootstrap-preload.cjs', join(appDist, 'bootstrap-preload.cjs')],
    ['dist/browser-toolbar-preload.cjs', join(appDist, 'browser-toolbar-preload.cjs')],
    ['dist/workspace-server.mjs', join(appDist, 'workspace-server.mjs')],
    ['dist/renderer/index.html', join(appDist, 'renderer', 'index.html')],
    ['dist/resources/pi-extensions/browser.js', join(appDist, 'resources', 'pi-extensions', 'browser.js')],
    ['dist/resources/pi-extensions/messaging.js', join(appDist, 'resources', 'pi-extensions', 'messaging.js')],
    ['dist/resources/pi-extensions/permissions.js', join(appDist, 'resources', 'pi-extensions', 'permissions.js')],
    ['dist/resources/pi-extensions/package.json', join(appDist, 'resources', 'pi-extensions', 'package.json')],
    ['dist/resources/docs/mortise-cli.md', join(appDist, 'resources', 'docs', 'mortise-cli.md')],
    ['dist/resources/pi-extensions/messaging.d.ts', undefined],
    ['dist/resources/session-mcp-server/index.js', join(appResources, 'session-mcp-server', 'index.js')],
    ['dist/resources/scripts/pdf_tool.py', join(appResources, 'scripts', 'pdf_tool.py')],
    ['dist/packaging-inputs/runtime/bun/bun.exe', join(resourcesDir, 'vendor', 'bun', 'bun.exe')],
    ['dist/packaging-inputs/runtime/messaging-whatsapp-worker/worker.cjs', join(resourcesDir, 'messaging-whatsapp-worker', 'worker.cjs')],
    ['dist/packaging-inputs/runtime/ripgrep/bin/rg.exe', join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe')],
    ['dist/resources/bin/win32-x64/uv.exe', join(appRoot, 'resources', 'bin', 'win32-x64', 'uv.exe')],
    ['dist/resources/pi-runtime/pi.exe', join(resourcesDir, 'pi-runtime', 'pi.exe')],
  ] as const
  writeFileSync(join(appDist, 'build-provenance.json'), JSON.stringify({
    schemaVersion: 5,
    producerVersion: 'electron-production-v4',
    buildId: 'a'.repeat(64),
    sourceId: 'b'.repeat(64),
    platform: 'win32',
    arch: 'x64',
    artifacts: artifactPaths.map(([path]) => ({ path, sizeBytes: 7, sha256: hash })),
  }))

  return {
    platform: 'win32',
    arch: 'x64',
    productFilename: 'Mortise Developer Host',
    resourcesDir,
    appRoot,
    appDist,
    appResources,
    appExecutable: join(root, 'Mortise.exe'),
    piRuntimeRoot: join(resourcesDir, 'pi-runtime'),
    piExecutable: join(resourcesDir, 'pi-runtime', 'pi.exe'),
    bunExecutable: join(resourcesDir, 'vendor', 'bun', 'bun.exe'),
    workerEntry: join(resourcesDir, 'messaging-whatsapp-worker', 'worker.cjs'),
    ripgrepExecutable: join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
    uvExecutable: join(appRoot, 'resources', 'bin', 'win32-x64', 'uv.exe'),
  }
}

describe('packaged Electron layout', () => {
  it('accepts only a valid Authenticode transformation of a provenanced PE file', () => {
    const layout = createLayout()
    const source = createPortableExecutable()
    const certificate = Buffer.alloc(16, 0x7f)
    const signed = Buffer.concat([source, certificate])
    const optionalHeader = 0x80 + 24
    const securityDirectory = optionalHeader + 96 + 32
    signed.writeUInt32LE(0x12345678, optionalHeader + 64)
    signed.writeUInt32LE(source.length, securityDirectory)
    signed.writeUInt32LE(certificate.length, securityDirectory + 4)
    const packagedPath = join(dirname(layout.appRoot), 'signed-fixture.exe')
    writeFileSync(packagedPath, signed)
    const artifact = {
      path: 'dist/resources/pi-runtime/pi.exe',
      sizeBytes: source.length,
      sha256: createHash('sha256').update(source).digest('hex'),
      authenticodeSha256: authenticodeContentSha256(source),
    }

    expect(() => assertPackagedArtifactMatches(artifact, packagedPath, {
      getAuthenticodeStatus: () => 'Valid',
    })).not.toThrow()
    expect(() => assertPackagedArtifactMatches(artifact, packagedPath, {
      getAuthenticodeStatus: () => 'NotSigned',
    })).toThrow('Packaged Authenticode artifact is not valid')
  })

  it('restores the frozen runtime package manifest after Builder rewrites it', () => {
    const layout = createLayout()
    const projectDir = join(dirname(layout.resourcesDir), 'frozen-project')
    const frozenManifest = join(projectDir, 'dist', 'packaging-inputs', 'runtime-package.json')
    mkdirSync(dirname(frozenManifest), { recursive: true })
    writeFileSync(frozenManifest, '{"name":"@mortise/electron","main":"dist/main.cjs"}\n')
    writeFileSync(join(layout.appRoot, 'package.json'), '{"main":"dist/main.cjs","builder":"rewritten"}\n')

    restoreRuntimePackageManifest(layout, { packager: { projectDir } })

    expect(readFileSync(join(layout.appRoot, 'package.json'), 'utf8'))
      .toBe('{"name":"@mortise/electron","main":"dist/main.cjs"}\n')
  })

  it('allows the Developer Kit to carry its own Bun runtime', () => {
    const layout = createLayout()
    addDeveloperKit(layout)

    expect(() => validatePackagedLayout(layout)).not.toThrow()
  })

  it('rejects a tampered or source-mismatched Developer Kit', () => {
    const tamperedLayout = createLayout()
    const kitBun = addDeveloperKit(tamperedLayout)
    writeFileSync(kitBun, 'tampered')
    expect(() => validatePackagedLayout(tamperedLayout)).toThrow('Developer Kit artifact does not match provenance')

    const mismatchedLayout = createLayout()
    addDeveloperKit(mismatchedLayout, 'd'.repeat(64))
    expect(() => validatePackagedLayout(mismatchedLayout)).toThrow('Developer Kit provenance is invalid')
  })

  it('requires the source-matched Developer Kit in a Windows Mortise package', () => {
    const layout = createLayout()
    layout.productFilename = 'Mortise'

    expect(() => validatePackagedLayout(layout)).toThrow('missing the Developer Kit')
  })

  it('rejects a build capsule for another platform architecture', () => {
    const layout = createLayout()
    const provenancePath = join(layout.appDist, 'build-provenance.json')
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as { arch: string }
    provenance.arch = 'arm64'
    writeFileSync(provenancePath, JSON.stringify(provenance))

    expect(() => validatePackagedLayout(layout)).toThrow('Packaged build provenance is invalid')
  })

  it('rejects an extra Bun copied into the application payload', () => {
    const layout = createLayout()
    const duplicate = join(layout.appDist, 'installer-developer-kit', 'dev-host', 'resources', 'vendor', 'bun', 'bun.exe')
    mkdirSync(dirname(duplicate), { recursive: true })
    writeFileSync(duplicate, 'fixture')

    expect(() => validatePackagedLayout(layout)).toThrow('files without build provenance')
  })

  it('rejects the legacy JS Pi runtime even when the old fallback environment variable is set', () => {
    const layout = createLayout()
    rmSync(layout.piExecutable, { force: true })
    const legacyCli = join(layout.piRuntimeRoot, 'dist', 'cli.bundle.js')
    const legacyPackage = join(layout.piRuntimeRoot, 'runtime_modules', '@mortise', 'pi-ai', 'package.json')
    mkdirSync(dirname(legacyCli), { recursive: true })
    mkdirSync(dirname(legacyPackage), { recursive: true })
    writeFileSync(legacyCli, 'legacy fixture')
    writeFileSync(legacyPackage, '{}')
    process.env.MORTISE_PI_BINARY_RUNTIME = '0'

    expect(() => validatePackagedLayout(layout)).toThrow('Packaged runtime asset missing')
  })

  it('rejects legacy JS candidates beside the compiled Pi runtime', () => {
    const layout = createLayout()
    const legacyCli = join(layout.piRuntimeRoot, 'dist', 'cli.full.bundle.js')
    mkdirSync(dirname(legacyCli), { recursive: true })
    writeFileSync(legacyCli, 'legacy fixture')
    process.env.MORTISE_PI_BINARY_RUNTIME = '0'

    expect(() => validatePackagedLayout(layout)).toThrow('Electron package contains legacy Pi runtime candidates')
  })

  it('rejects a compiled Pi runtime that does not match build provenance', () => {
    const layout = createLayout()
    writeFileSync(layout.piExecutable, 'tampered')

    expect(() => validatePackagedLayout(layout)).toThrow('Packaged artifact does not match build provenance')
  })

  for (const [name, field] of [
    ['worker', 'workerEntry'],
    ['Bun runtime', 'bunExecutable'],
    ['ripgrep runtime', 'ripgrepExecutable'],
    ['uv runtime', 'uvExecutable'],
  ] as const) {
    it(`rejects a stale ${name} packaging input`, () => {
      const layout = createLayout()
      writeFileSync(layout[field], 'tampered')

      expect(() => validatePackagedLayout(layout)).toThrow('Packaged artifact does not match build provenance')
    })
  }

  it('rejects application payload files that have no build provenance', () => {
    const layout = createLayout()
    const stale = join(layout.appResources, 'scripts', 'stale.py')
    mkdirSync(dirname(stale), { recursive: true })
    writeFileSync(stale, 'stale')

    expect(() => validatePackagedLayout(layout)).toThrow('files without build provenance')
  })
})

function createPortableExecutable(): Buffer {
  const bytes = Buffer.alloc(512)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80, 'ascii')
  const optionalHeader = 0x80 + 24
  bytes.writeUInt16LE(0x10b, optionalHeader)
  bytes.fill(0x41, 0x180)
  return bytes
}

function addDeveloperKit(layout: ReturnType<typeof createLayout>, sourceId = 'b'.repeat(64)): string {
  const kitBun = join(layout.resourcesDir, 'developer-kit', 'dev-host', 'resources', 'vendor', 'bun', 'bun.exe')
  mkdirSync(dirname(kitBun), { recursive: true })
  writeFileSync(kitBun, 'fixture')
  writeFileSync(join(layout.resourcesDir, 'developer-kit', 'build-provenance.json'), JSON.stringify({
    schemaVersion: 1,
    buildId: 'c'.repeat(64),
    sourceId,
    sizeBytes: 7,
    artifacts: [{
      path: 'dev-host/resources/vendor/bun/bun.exe',
      sizeBytes: 7,
      sha256: createHash('sha256').update('fixture').digest('hex'),
    }],
  }))
  return kitBun
}
