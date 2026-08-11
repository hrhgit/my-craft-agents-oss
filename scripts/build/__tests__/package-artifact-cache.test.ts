import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computePackageArtifactId,
  computePackageArtifactIdentity,
  materializePackageArtifactCache,
  publishPackageArtifactCache,
  readValidPackageArtifactManifest,
  resolvePackageArtifactCachePolicy,
} from '../package-artifact-cache.ts'

const temporaryRoots: string[] = []
const builderConfig = `
appId: io.github.hrhgit.mortise
afterSign: dist/packaging-inputs/hooks/afterSign.cjs
win:
  target: nsis
`

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mortise-package-cache-'))
  temporaryRoots.push(root)
  return root
}

function createIdentity(overrides: Partial<Parameters<typeof computePackageArtifactIdentity>[0]> = {}) {
  const policy = resolvePackageArtifactCachePolicy({
    target: 'win',
    builderConfigContent: builderConfig,
    environment: {},
  })
  return computePackageArtifactIdentity({
    electronBuildId: 'a'.repeat(64),
    developerKitBuildId: 'b'.repeat(64),
    target: 'win',
    arch: 'x64',
    mode: 'production',
    builderConfigContent: builderConfig,
    builderToolchainId: 'c'.repeat(64),
    policy,
    ...overrides,
  })
}

describe('final Electron package artifact cache', () => {
  test('enables only stable unsigned and local-only packaging', () => {
    expect(resolvePackageArtifactCachePolicy({
      target: 'win',
      builderConfigContent: builderConfig,
      environment: {},
    })).toEqual({ enabled: true, signingMode: 'unsigned', publicationMode: 'local-only' })

    expect(resolvePackageArtifactCachePolicy({
      target: 'win',
      builderConfigContent: builderConfig,
      environment: { CSC_LINK: 'certificate' },
    })).toMatchObject({ enabled: false, reason: expect.stringContaining('CSC_LINK') })
    expect(resolvePackageArtifactCachePolicy({
      target: 'win',
      builderConfigContent: builderConfig,
      environment: { GH_TOKEN: 'token' },
    })).toMatchObject({ enabled: false, reason: expect.stringContaining('GH_TOKEN') })
    expect(resolvePackageArtifactCachePolicy({
      target: 'mac',
      builderConfigContent: builderConfig,
      environment: {},
    })).toMatchObject({ enabled: false, reason: expect.stringContaining('auto-discovery') })
    expect(resolvePackageArtifactCachePolicy({
      target: 'mac',
      builderConfigContent: builderConfig,
      environment: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    })).toMatchObject({ enabled: true })
    expect(resolvePackageArtifactCachePolicy({
      target: 'win',
      builderConfigContent: `${builderConfig}\npublish:\n  provider: github\n`,
      environment: {},
    })).toMatchObject({ enabled: false, reason: expect.stringContaining('publish') })
    expect(resolvePackageArtifactCachePolicy({
      target: 'win',
      builderConfigContent: builderConfig.replace('  target: nsis', '  target: nsis\n  certificateFile: release.pfx'),
      environment: {},
    })).toMatchObject({ enabled: false, reason: expect.stringContaining('certificateFile') })
  })

  test('binds package identity to every packaging input domain', () => {
    const base = createIdentity()
    const baseId = computePackageArtifactId(base)
    for (const changed of [
      createIdentity({ electronBuildId: 'd'.repeat(64) }),
      createIdentity({ developerKitBuildId: 'e'.repeat(64) }),
      createIdentity({ target: 'linux', developerKitBuildId: undefined }),
      createIdentity({ arch: 'arm64' }),
      createIdentity({ mode: 'development' }),
      createIdentity({ builderConfigContent: `${builderConfig}\ncompression: store\n` }),
      createIdentity({ builderToolchainId: 'f'.repeat(64) }),
    ]) {
      expect(computePackageArtifactId(changed)).not.toBe(baseId)
    }
  })

  test('atomically publishes, validates, and materializes cached package outputs', () => {
    const root = createRoot()
    const cacheRoot = join(root, 'cache')
    const sourceDir = join(root, 'builder-output')
    mkdirSync(join(sourceDir, 'win-unpacked'), { recursive: true })
    writeFileSync(join(sourceDir, 'Mortise-x64.exe'), 'installer', 'utf8')
    writeFileSync(join(sourceDir, 'win-unpacked', 'Mortise.exe'), 'application', 'utf8')

    const identity = createIdentity()
    const manifest = publishPackageArtifactCache({ cacheRoot, identity, sourceDir, consumeSource: true })
    expect(manifest.packageId).toBe(computePackageArtifactId(identity))
    expect(existsSync(sourceDir)).toBe(false)
    expect(readValidPackageArtifactManifest(cacheRoot, manifest.packageId, 'strict')).toBeDefined()

    const destinationDir = join(root, 'another-release')
    materializePackageArtifactCache({
      cacheRoot,
      packageId: manifest.packageId,
      destinationDir,
      verification: 'strict',
    })
    expect(readFileSync(join(destinationDir, 'Mortise-x64.exe'), 'utf8')).toBe('installer')
    expect(readFileSync(join(destinationDir, 'win-unpacked', 'Mortise.exe'), 'utf8')).toBe('application')
  })

  test('uses size checks for fast validation and content hashes plus inventory for strict validation', () => {
    const root = createRoot()
    const cacheRoot = join(root, 'cache')
    const sourceDir = join(root, 'builder-output')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'Mortise-x64.exe'), 'original', 'utf8')
    const manifest = publishPackageArtifactCache({ cacheRoot, identity: createIdentity(), sourceDir })
    const cachedFile = join(cacheRoot, 'builds', manifest.packageId, 'artifacts', 'Mortise-x64.exe')

    writeFileSync(cachedFile, 'modified', 'utf8')
    expect(readValidPackageArtifactManifest(cacheRoot, manifest.packageId, 'fast')).toBeDefined()
    expect(readValidPackageArtifactManifest(cacheRoot, manifest.packageId, 'strict')).toBeUndefined()

    writeFileSync(cachedFile, 'original', 'utf8')
    writeFileSync(join(cacheRoot, 'builds', manifest.packageId, 'artifacts', 'unexpected.txt'), 'extra', 'utf8')
    expect(readValidPackageArtifactManifest(cacheRoot, manifest.packageId, 'fast')).toBeDefined()
    expect(readValidPackageArtifactManifest(cacheRoot, manifest.packageId, 'strict')).toBeUndefined()
  })
})
