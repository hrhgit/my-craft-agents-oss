import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { immutableRuntimeRequiredAppPaths } from '@mortise/session-tools-core/runtime'
import { ELECTRON_BUILD_INPUTS } from '../build-inputs.ts'
import { resolveCachedUvToolchain, type Arch, type Platform } from '../common.ts'
import {
  ELECTRON_BUILD_PRODUCER_VERSION,
  ELECTRON_BUILD_SCHEMA_VERSION,
  acquireElectronBuild,
  cleanupElectronBuildCache,
  computeElectronBuildId,
  createElectronBuildRuntimeEnvironment,
  electronBuildExecutablePath,
  publishBuildBunToolchain,
  releaseElectronBuild,
  resolveReusableElectronBuildId,
  resolveElectronBuildExecutable,
  seedUvToolchainCacheFromCompletedBuild,
  withElectronBuildForPackaging,
  withStagedElectronBuild,
  writeElectronBuildProvenance,
} from '../electron-build-cache.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('mortise-ui immutable Electron build cache', () => {
  it('separates production, development, and UI-validation identities', () => {
    const sourceId = 'a'.repeat(64)
    expect(new Set([
      computeElectronBuildId(sourceId, 'production'),
      computeElectronBuildId(sourceId, 'development'),
      computeElectronBuildId(sourceId, 'ui-validation'),
    ]).size).toBe(3)
  }, 20_000)

  it('atomically deduplicates verified Bun toolchains and repairs corruption', async () => {
    const root = tempRoot('mortise-bun-toolchain-concurrent-')
    const buildRoot = join(root, 'cache')
    const sourceExecutable = join(root, process.platform === 'win32' ? 'producer-runtime.exe' : 'producer-runtime')
    copyFileSync(process.execPath, sourceExecutable)
    const abandonedStaging = join(buildRoot, 'toolchains', 'bun', 'old', 'platform', 'hash.staging-crashed')
    mkdirSync(abandonedStaging, { recursive: true })
    writeFileSync(join(abandonedStaging, 'staging-owner.json'), JSON.stringify({ schemaVersion: 1, pid: 999_999_999 }))
    const workers = Array.from({ length: 4 }, (_, index) => Bun.spawn([
      process.execPath,
      join(import.meta.dir, 'bun-toolchain-cache-worker.fixture.ts'),
      buildRoot,
      sourceExecutable,
      join(root, `result-${index}.json`),
    ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' }))

    const exits = await Promise.all(workers.map(worker => worker.exited))
    const errors = await Promise.all(workers.map(worker => new Response(worker.stderr).text()))
    expect(exits.map((exit, index) => ({ exit, error: errors[index] })).filter(item => item.exit !== 0)).toEqual([])
    const published = Array.from({ length: 4 }, (_, index) => (
      JSON.parse(readFileSync(join(root, `result-${index}.json`), 'utf8')) as { binary: string }
    ).binary)
    expect(new Set(published).size).toBe(1)
    expect(existsSync(abandonedStaging)).toBe(false)
    const binary = published[0]!
    const expectedSha256 = createHash('sha256').update(readFileSync(sourceExecutable)).digest('hex')
    expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(expectedSha256)
    expect(readdirSync(resolve(binary, '..')).sort()).toEqual([
      process.platform === 'win32' ? 'bun.exe' : 'bun',
      'bun.json',
    ].sort())

    writeFileSync(binary, 'tampered', 'utf8')
    expect(publishBuildBunToolchain(buildRoot, sourceExecutable)).toBe(binary)
    expect(createHash('sha256').update(readFileSync(binary)).digest('hex')).toBe(expectedSha256)
  }, 30_000)

  it('copies a provenance-verified uv binary into an isolated toolchain cache', () => {
    const root = tempRoot('mortise-uv-toolchain-cross-cache-')
    const sourceBuildRoot = join(root, 'electron-builds')
    const targetToolchainRoot = join(root, 'developer-kit-toolchains')
    const buildId = 'a'.repeat(64)
    const platform = process.platform as Platform
    const arch = process.arch as Arch
    const binaryName = platform === 'win32' ? 'uv.exe' : 'uv'
    const relativeUv = `dist/resources/bin/${platform}-${arch}/${binaryName}`
    const sourceBinary = join(sourceBuildRoot, 'builds', buildId, 'app', ...relativeUv.split('/'))
    const content = Buffer.from('provenance-verified uv fixture')
    const sha256 = createHash('sha256').update(content).digest('hex')
    mkdirSync(dirname(sourceBinary), { recursive: true })
    writeFileSync(sourceBinary, content)
    writeFileSync(join(sourceBuildRoot, 'builds', buildId, 'build.json'), JSON.stringify({
      schemaVersion: ELECTRON_BUILD_SCHEMA_VERSION,
      producerVersion: ELECTRON_BUILD_PRODUCER_VERSION,
      buildId,
      platform,
      arch,
      createdAt: new Date(0).toISOString(),
      artifacts: [{ path: relativeUv, sizeBytes: content.byteLength, sha256 }],
    }))

    expect(seedUvToolchainCacheFromCompletedBuild(sourceBuildRoot, targetToolchainRoot)).toBe(true)
    const cached = resolveCachedUvToolchain(targetToolchainRoot, { platform, arch })
    expect(cached).toBeDefined()
    expect(readFileSync(cached!)).toEqual(content)
  })

  it('keeps cross-identity publication staging visible to garbage collection', async () => {
    const root = tempRoot('mortise-bun-toolchain-cross-identity-')
    const buildRoot = join(root, 'cache')
    const workers = Array.from({ length: 6 }, (_, index) => {
      const sourceExecutable = join(root, `producer-${index}.bin`)
      writeFileSync(sourceExecutable, `canonical Bun identity ${index}\n`, 'utf8')
      return Bun.spawn([
        process.execPath,
        join(import.meta.dir, 'bun-toolchain-cache-worker.fixture.ts'),
        buildRoot,
        sourceExecutable,
        join(root, `result-${index}.json`),
      ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
    })

    const exits = await Promise.all(workers.map(worker => worker.exited))
    const errors = await Promise.all(workers.map(worker => new Response(worker.stderr).text()))
    expect(exits.map((exit, index) => ({ exit, error: errors[index] })).filter(item => item.exit !== 0)).toEqual([])
    const published = Array.from({ length: workers.length }, (_, index) => (
      JSON.parse(readFileSync(join(root, `result-${index}.json`), 'utf8')) as { binary: string }
    ).binary)
    expect(new Set(published).size).toBe(workers.length)
    for (const [index, binary] of published.entries()) {
      expect(readFileSync(binary, 'utf8')).toBe(`canonical Bun identity ${index}\n`)
      expect(readdirSync(resolve(binary, '..')).sort()).toEqual([
        process.platform === 'win32' ? 'bun.exe' : 'bun',
        'bun.json',
      ].sort())
    }
  }, 30_000)

  it('binds every source runtime process to one immutable build capsule', () => {
    const appDir = resolve('cache', 'build-id', 'app')
    const buildDir = resolve(appDir, '..')
    const lease = {
      buildId: 'build-id',
      buildDir,
      appDir,
      manifest: { sourceId: 'source-id' },
    }

    expect(createElectronBuildRuntimeEnvironment(lease)).toEqual({
      MORTISE_BUILD_ID: 'build-id',
      MORTISE_BUILD_SOURCE_ID: 'source-id',
      MORTISE_BUILD_DIR: buildDir,
      MORTISE_RUNTIME_APP_ROOT: appDir,
      MORTISE_RUNTIME_RESOURCES_DIR: join(appDir, 'dist', 'resources'),
      MORTISE_RUNTIME_RESOURCES_BASE: join(appDir, 'dist'),
      MORTISE_RUNTIME_BUNDLE_PATH: join(appDir, 'dist', 'packaging-inputs', 'runtime'),
      MORTISE_RUNTIME_ELECTRON_PATH: electronBuildExecutablePath(appDir),
      MORTISE_RUNTIME_NODE_PATH: electronBuildExecutablePath(appDir),
      MORTISE_RUNTIME_IMMUTABLE: '1',
    })
    expect(createElectronBuildRuntimeEnvironment(lease, { uiValidation: true })).toMatchObject({
      MORTISE_UI_BUILD_ID: 'build-id',
      MORTISE_UI_BUILD_DIR: buildDir,
    })
    expect(() => resolveElectronBuildExecutable(lease)).toThrow('runtime executable is missing')
  })

  it('consumes an isolated app staging directory without touching the working tree', () => {
    const root = tempRoot('mortise-ui-build-stage-restore-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    seedBuildOutputs(repoRoot, 'live-before')
    const lease = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'stage-restore',
      runDir: createRun(root, 'stage-restore'),
      build: sourceRoot => seedBuildOutputs(sourceRoot, 'immutable'),
    })
    const abandonedStage = join(buildRoot, 'packaging-staging', '.app-abandoned')
    mkdirSync(abandonedStage, { recursive: true })
    writeFileSync(join(abandonedStage, 'partial.txt'), 'partial', 'utf8')

    let successfulStage = ''
    withStagedElectronBuild(lease, staged => {
      successfulStage = staged.appDir
      expect(staged.appDir.startsWith(repoRoot)).toBe(false)
      expect(readFileSync(join(staged.distDir, 'resources', 'fixture.txt'), 'utf8')).toBe('immutable')
      writeFileSync(join(staged.distDir, 'resources', 'fixture.txt'), 'consumer mutation', 'utf8')
      expect(readFileSync(join(repoRoot, 'apps/electron/dist/resources/fixture.txt'), 'utf8')).toBe('live-before')
    })
    expect(existsSync(abandonedStage)).toBe(false)
    expect(existsSync(successfulStage)).toBe(false)
    expect(readFileSync(join(repoRoot, 'apps/electron/dist/resources/fixture.txt'), 'utf8')).toBe('live-before')

    let failedStage = ''
    expect(() => withStagedElectronBuild(lease, staged => {
      failedStage = staged.appDir
      expect(readFileSync(join(repoRoot, 'apps/electron/dist/resources/fixture.txt'), 'utf8')).toBe('live-before')
      throw new Error('consumer failed')
    })).toThrow('consumer failed')
    expect(existsSync(failedStage)).toBe(false)
    expect(readFileSync(join(repoRoot, 'apps/electron/dist/resources/fixture.txt'), 'utf8')).toBe('live-before')
    releaseElectronBuild(lease)
  }, 20_000)

  it('selects the newest valid immutable build for default reuse', () => {
    const root = tempRoot('mortise-ui-build-default-reuse-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)

    const first = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'reuse-first',
      runDir: createRun(root, 'reuse-first'),
      build: sourceRoot => seedBuildOutputs(sourceRoot, 'first'),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      retainCount: 4,
    })
    releaseElectronBuild(first)

    write(repoRoot, 'apps/electron/src/main.ts', 'export const value = 2\n')
    const second = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'reuse-second',
      runDir: createRun(root, 'reuse-second'),
      build: sourceRoot => seedBuildOutputs(sourceRoot, 'second'),
      now: () => new Date('2026-01-02T00:00:00.000Z'),
      retainCount: 4,
    })
    releaseElectronBuild(second)

    write(repoRoot, 'apps/electron/src/main.ts', 'export const value = 3\n')
    const development = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'reuse-development',
      runDir: createRun(root, 'reuse-development'),
      mode: 'development',
      build: sourceRoot => seedBuildOutputs(sourceRoot, 'development'),
      now: () => new Date('2026-01-03T00:00:00.000Z'),
      retainCount: 4,
    })
    releaseElectronBuild(development)

    expect(resolveReusableElectronBuildId({ buildRoot, mode: 'production' })).toBe(second.buildId)
    expect(resolveReusableElectronBuildId({ buildRoot, mode: 'development' })).toBe(development.buildId)

    rmSync(join(second.appDir, 'dist', 'main.cjs'), { force: true })
    expect(resolveReusableElectronBuildId({ buildRoot, mode: 'production' })).toBe(first.buildId)
  }, 30_000)

  it('packages directly from a leased immutable capsule and detects input mutation', () => {
    const root = tempRoot('mortise-electron-build-direct-package-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const lease = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'direct-package',
      runDir: createRun(root, 'direct-package'),
      build: sourceRoot => seedBuildOutputs(sourceRoot, 'immutable'),
    })

    expect(withElectronBuildForPackaging(lease, build => {
      expect(build.appDir).toBe(lease.appDir)
      expect(build.provenancePath).toBe(join(lease.runDir, 'electron-build-provenance.json'))
      expect(JSON.parse(readFileSync(build.provenancePath, 'utf8'))).toMatchObject({
        buildId: lease.buildId,
        sourceId: lease.manifest.sourceId,
      })
      return readFileSync(join(build.distDir, 'resources', 'fixture.txt'), 'utf8')
    })).toBe('immutable')

    expect(() => withElectronBuildForPackaging(lease, build => {
      writeFileSync(join(build.distDir, 'resources', 'fixture.txt'), 'mutated')
    })).toThrow('changed while it was being packaged')
    releaseElectronBuild(lease)
  }, 20_000)

  it('writes raw-build provenance for only package.json and dist', () => {
    const root = tempRoot('electron-build-provenance-')
    const appDir = join(root, 'apps', 'electron')
    seedBuildOutputs(root)
    write(root, 'apps/electron/node_modules/live-only/index.js', 'live dependency')

    const provenancePath = writeElectronBuildProvenance({
      appDir,
      sourceId: 'a'.repeat(64),
      mode: 'ui-validation',
      createdAt: new Date(0),
    })
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as { artifacts: Array<{ path: string }> }
    expect(provenance.artifacts.some(artifact => artifact.path.startsWith('node_modules/'))).toBe(false)
    expect(provenance.artifacts.map(artifact => artifact.path)).toContain('package.json')
    expect(provenance.artifacts.map(artifact => artifact.path)).toContain('dist/main.cjs')
    expect(provenance.artifacts.map(artifact => artifact.path)).not.toContain('dist/build-provenance.json')
  })

  it('rejects publication when a critical runtime asset is missing', () => {
    const root = tempRoot('electron-build-missing-runtime-')
    const appDir = join(root, 'apps', 'electron')
    seedBuildOutputs(root)
    rmSync(join(
      appDir,
      'dist',
      'resources',
      'bin',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'uv.exe' : 'uv',
    ), { force: true })

    expect(() => writeElectronBuildProvenance({
      appDir,
      sourceId: 'a'.repeat(64),
      mode: 'production',
    })).toThrow('dist/resources/bin')

    seedBuildOutputs(root)
    const sessionServerEntry = join(appDir, 'dist', 'resources', 'session-mcp-server', 'index.js')
    rmSync(sessionServerEntry, { force: true })
    mkdirSync(sessionServerEntry, { recursive: true })
    expect(() => writeElectronBuildProvenance({
      appDir,
      sourceId: 'a'.repeat(64),
      mode: 'production',
    })).toThrow('dist/resources/session-mcp-server/index.js')
  })

  it('changes the build identity when a source input changes', () => {
    const root = tempRoot('mortise-ui-build-fingerprint-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const build = (sourceRoot: string) => seedBuildOutputs(sourceRoot)
    const before = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'before', runDir: createRun(root, 'before'), build,
    })
    write(repoRoot, 'apps/electron/src/main.ts', 'export const value = 2\n')
    const after = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'after', runDir: createRun(root, 'after'), build,
    })
    expect(after.buildId).not.toBe(before.buildId)
    releaseElectronBuild(before)
    releaseElectronBuild(after)
  }, 20_000)

  it('retains and upgrades a valid Bun A build while Bun B is also cached', () => {
    const root = tempRoot('mortise-ui-build-cross-bun-cleanup-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const lease = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'bun-a',
      runDir: createRun(root, 'bun-a'),
      build: sourceRoot => seedBuildOutputs(sourceRoot),
      retainCount: 1,
    })
    releaseElectronBuild(lease, { retainCount: 1 })

    const manifestPath = join(lease.buildDir, 'build.json')
    const legacyManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    delete legacyManifest.producerBunVersion
    delete legacyManifest.producerBunExecutableSha256
    writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8')

    const bunB = join(root, process.platform === 'win32' ? 'bun-b.exe' : 'bun-b')
    writeFileSync(bunB, 'different producer bytes', 'utf8')
    publishBuildBunToolchain(buildRoot, bunB)

    const cleanup = cleanupElectronBuildCache({ buildRoot, retainCount: 1, maxBytes: 1_000_000 })
    expect(cleanup.removedBuildIds).not.toContain(lease.buildId)
    const pinned = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'pinned-bun-a',
      runDir: createRun(root, 'pinned-bun-a'),
      expectedBuildId: lease.buildId,
      skipBuild: true,
    })
    const upgraded = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    expect(upgraded.producerBunVersion).toBe(process.versions.bun)
    expect(upgraded.producerBunExecutableSha256).toMatch(/^[0-9a-f]{64}$/)
    releaseElectronBuild(pinned)
  }, 30_000)

  it('does not accept different producer bytes as an exact expected artifact', () => {
    const sourceId = 'a'.repeat(64)
    const producerA = { bunVersion: '1.0.0', bunExecutableSha256: '1'.repeat(64) }
    const producerB = { bunVersion: '1.0.0', bunExecutableSha256: '2'.repeat(64) }
    expect(computeElectronBuildId(sourceId, 'production', producerA))
      .not.toBe(computeElectronBuildId(sourceId, 'production', producerB))

    const root = tempRoot('mortise-ui-build-producer-tamper-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const lease = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'producer-a',
      runDir: createRun(root, 'producer-a'),
      build: sourceRoot => seedBuildOutputs(sourceRoot),
      retainCount: 1,
    })
    releaseElectronBuild(lease, { retainCount: 1 })
    const manifestPath = join(lease.buildDir, 'build.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.producerBunExecutableSha256 = '2'.repeat(64)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    expect(() => acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'expected-producer-a',
      runDir: createRun(root, 'expected-producer-a'),
      expectedBuildId: lease.buildId,
      skipBuild: true,
    })).toThrow('pinned acquisition will not rebuild')
  }, 30_000)

  it('fails closed instead of rebuilding an invalid pinned package build', () => {
    const root = tempRoot('mortise-ui-build-pinned-no-rebuild-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    let buildCount = 0
    const lease = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'original',
      runDir: createRun(root, 'original'),
      build: sourceRoot => {
        buildCount += 1
        seedBuildOutputs(sourceRoot)
      },
      retainCount: 1,
    })
    releaseElectronBuild(lease, { retainCount: 1 })
    rmSync(join(lease.appDir, 'dist', 'main.cjs'), { force: true })

    expect(() => acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'pinned-invalid',
      runDir: createRun(root, 'pinned-invalid'),
      expectedBuildId: lease.buildId,
      skipBuild: true,
    })).toThrow('pinned acquisition will not rebuild')
    expect(buildCount).toBe(1)
    expect(existsSync(join(lease.appDir, 'dist', 'main.cjs'))).toBe(false)
  }, 30_000)

  it('uses lightweight artifact verification for an explicitly pinned runtime build', () => {
    const root = tempRoot('mortise-ui-build-fast-pinned-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const original = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'fast-original',
      runDir: createRun(root, 'fast-original'),
      build: sourceRoot => seedBuildOutputs(sourceRoot, 'original'),
    })
    releaseElectronBuild(original)

    const mainPath = join(original.appDir, 'dist', 'main.cjs')
    const bytes = readFileSync(mainPath)
    writeFileSync(mainPath, Buffer.alloc(bytes.length, 120))

    const pinned = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'fast-pinned',
      runDir: createRun(root, 'fast-pinned'),
      expectedBuildId: original.buildId,
      skipBuild: true,
      verification: 'fast',
    })
    expect(pinned.buildId).toBe(original.buildId)
    expect(() => withStagedElectronBuild(pinned, () => undefined)).toThrow('changed while it was being staged')
    releaseElectronBuild(pinned)
  }, 30_000)

  it('defers cache pruning on ordinary lease release until cleanup is explicit', () => {
    const root = tempRoot('mortise-ui-build-deferred-prune-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const lease = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'deferred-prune',
      runDir: createRun(root, 'deferred-prune'),
      build: sourceRoot => seedBuildOutputs(sourceRoot),
      retainCount: 0,
      maxBytes: 1,
    })

    releaseElectronBuild(lease)
    expect(existsSync(lease.buildDir)).toBe(true)
    expect(cleanupElectronBuildCache({ buildRoot, retainCount: 0, maxBytes: 1 }).removedBuildIds).toContain(lease.buildId)
  }, 30_000)

  it('reuses one immutable build and removes it after the final lease is released', () => {
    const root = tempRoot('mortise-ui-build-reuse-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const builds: string[] = []
    const build = (sourceRoot: string) => { builds.push('built'); seedBuildOutputs(sourceRoot) }
    const first = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'run-a', runDir: createRun(root, 'run-a'), build,
      retainCount: 0, maxBytes: 1,
    })
    const second = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'run-b', runDir: createRun(root, 'run-b'), build,
      retainCount: 0, maxBytes: 1,
    })

    expect(builds).toEqual(['built'])
    expect(second.buildId).toBe(first.buildId)
    expect(existsSync(join(first.appDir, 'dist', 'renderer', 'index.html'))).toBe(true)
    releaseElectronBuild(first, { retainCount: 0, maxBytes: 1 })
    expect(existsSync(first.buildDir)).toBe(true)
    releaseElectronBuild(second, { retainCount: 0, maxBytes: 1 })
    expect(existsSync(first.buildDir)).toBe(false)
  }, 20_000)

  it('keeps active builds and automatically retains only the newest completed builds', () => {
    const root = tempRoot('mortise-ui-build-retention-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    let sequence = 0
    let clock = 0
    const now = () => new Date(++clock * 1_000)
    const build = (sourceRoot: string) => { sequence += 1; seedBuildOutputs(sourceRoot, `build-${sequence}`) }
    const active = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'active', runDir: createRun(root, 'active'), build,
      retainCount: 1, maxBytes: 1_000_000, now,
    })

    const completedBuildIds: string[] = []
    for (const [index, runId] of ['second', 'third'].entries()) {
      write(repoRoot, 'apps/electron/src/main.ts', `export const value = ${index + 2}\n`)
      const lease = acquireElectronBuild({
        repoRoot, buildRoot, runId, runDir: createRun(root, runId), build,
        retainCount: 1, maxBytes: 1_000_000, now,
      })
      completedBuildIds.push(lease.buildId)
      releaseElectronBuild(lease, { retainCount: 1, maxBytes: 1_000_000 })
    }

    const buildsWhileActive = buildIds(buildRoot)
    expect(buildsWhileActive).toContain(active.buildId)
    expect(buildsWhileActive).toContain(completedBuildIds[1])
    expect(buildsWhileActive).not.toContain(completedBuildIds[0])
    releaseElectronBuild(active, { retainCount: 1, maxBytes: 1_000_000 })
    expect(buildIds(buildRoot)).toEqual([completedBuildIds[1]])
  }, 30_000)

  it('retains the newest build per mode so validation caches are not evicted by production builds', () => {
    const root = tempRoot('mortise-ui-build-mode-retention-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    let sequence = 0
    const build = (sourceRoot: string) => { sequence += 1; seedBuildOutputs(sourceRoot, `build-${sequence}`) }
    const options = { repoRoot, buildRoot, retainCount: 1, maxBytes: 1_000_000 }

    write(repoRoot, 'apps/electron/src/main.ts', 'export const value = 1\n')
    const productionFirst = acquireElectronBuild({
      ...options, mode: 'production', runId: 'prod-a', runDir: createRun(root, 'prod-a'), build,
    })
    releaseElectronBuild(productionFirst, { retainCount: 1, maxBytes: 1_000_000 })

    write(repoRoot, 'apps/electron/src/main.ts', 'export const value = 2\n')
    const productionSecond = acquireElectronBuild({
      ...options, mode: 'production', runId: 'prod-b', runDir: createRun(root, 'prod-b'), build,
    })
    releaseElectronBuild(productionSecond, { retainCount: 1, maxBytes: 1_000_000 })

    write(repoRoot, 'apps/electron/src/main.ts', 'export const value = 3\n')
    const validationFirst = acquireElectronBuild({
      ...options, mode: 'ui-validation', runId: 'ui-a', runDir: createRun(root, 'ui-a'), build,
    })
    releaseElectronBuild(validationFirst, { retainCount: 1, maxBytes: 1_000_000 })

    write(repoRoot, 'apps/electron/src/main.ts', 'export const value = 4\n')
    const validationSecond = acquireElectronBuild({
      ...options, mode: 'ui-validation', runId: 'ui-b', runDir: createRun(root, 'ui-b'), build,
    })
    releaseElectronBuild(validationSecond, { retainCount: 1, maxBytes: 1_000_000 })

    const retained = buildIds(buildRoot)
    expect(retained).toContain(productionSecond.buildId)
    expect(retained).toContain(validationSecond.buildId)
    expect(retained).not.toContain(productionFirst.buildId)
    expect(retained).not.toContain(validationFirst.buildId)
  }, 30_000)

  it('publishes from an immutable snapshot while the live source keeps changing', () => {
    const root = tempRoot('mortise-ui-build-source-race-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    write(repoRoot, 'apps/electron/src/main.ts', 'export const value = "before"\n')
    let sourceRoot = ''
    const lease = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'race',
      runDir: createRun(root, 'race'),
      build: snapshotRoot => {
        sourceRoot = snapshotRoot
        expect(resolve(snapshotRoot)).not.toBe(resolve(repoRoot))
        expect(readFileSync(join(snapshotRoot, 'apps/electron/src/main.ts'), 'utf8')).toContain('before')
        write(repoRoot, 'apps/electron/src/main.ts', 'export const value = "after"\n')
        seedBuildOutputs(repoRoot, 'live')
        seedBuildOutputs(snapshotRoot, 'snapshot')
      },
    })
    expect(readFileSync(join(lease.appDir, 'dist/resources/fixture.txt'), 'utf8')).toBe('snapshot')
    expect(existsSync(sourceRoot)).toBe(false)
    releaseElectronBuild(lease)
  }, 20_000)

  it('rejects a tampered cached artifact and rebuilds the same source identity', () => {
    const root = tempRoot('mortise-ui-build-tamper-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    let buildCount = 0
    const build = (sourceRoot: string) => {
      buildCount += 1
      seedBuildOutputs(sourceRoot, `build-${buildCount}`)
    }
    const first = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'first', runDir: createRun(root, 'first'), build, retainCount: 1,
    })
    releaseElectronBuild(first, { retainCount: 1 })
    writeFileSync(join(first.appDir, 'dist', 'main.cjs'), '// tampered\n', 'utf8')

    const second = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'second', runDir: createRun(root, 'second'), build, retainCount: 1,
    })
    expect(second.buildId).toBe(first.buildId)
    expect(buildCount).toBe(2)
    expect(readFileSync(join(second.appDir, 'dist', 'main.cjs'), 'utf8')).toContain('build-2')
    releaseElectronBuild(second)
  }, 20_000)

  it('rejects a manifest whose byte total does not equal its artifact inventory', () => {
    const root = tempRoot('mortise-ui-build-size-tamper-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    let buildCount = 0
    const build = (sourceRoot: string) => {
      buildCount += 1
      seedBuildOutputs(sourceRoot, `build-${buildCount}`)
    }
    const first = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'size-first', runDir: createRun(root, 'size-first'), build,
    })
    releaseElectronBuild(first)
    const manifestPath = join(first.buildDir, 'build.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { sizeBytes: number }
    manifest.sizeBytes = 0
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const second = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'size-second', runDir: createRun(root, 'size-second'), build,
    })
    expect(second.buildId).toBe(first.buildId)
    expect(buildCount).toBe(2)
    releaseElectronBuild(second)
  }, 20_000)

  it('rejects cache manifests relabeled to another source, mode, or platform', () => {
    const root = tempRoot('mortise-ui-build-identity-tamper-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    let buildCount = 0
    const build = (sourceRoot: string) => {
      buildCount += 1
      seedBuildOutputs(sourceRoot, `build-${buildCount}`)
    }
    let lease = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'identity-source', runDir: createRun(root, 'identity-source'), build,
    })
    const buildId = lease.buildId
    const manifestPath = join(lease.buildDir, 'build.json')
    releaseElectronBuild(lease)

    const tamper = (field: string, value: unknown): void => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      manifest[field] = value
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    }

    tamper('sourceId', 'b'.repeat(64))
    lease = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'identity-mode', runDir: createRun(root, 'identity-mode'), build,
    })
    expect(lease.buildId).toBe(buildId)
    expect(buildCount).toBe(2)
    releaseElectronBuild(lease)

    tamper('mode', 'development')
    lease = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'identity-platform', runDir: createRun(root, 'identity-platform'), build,
    })
    expect(buildCount).toBe(3)
    releaseElectronBuild(lease)

    tamper('platform', process.platform === 'win32' ? 'linux' : 'win32')
    lease = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'identity-final', runDir: createRun(root, 'identity-final'), build,
    })
    expect(buildCount).toBe(4)
    releaseElectronBuild(lease)
  }, 30_000)

  it('deduplicates concurrent processes for the same build identity', async () => {
    const root = tempRoot('mortise-ui-build-concurrent-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const counterPath = join(root, 'build-count.txt')
    writeFileSync(counterPath, '', 'utf8')
    const workers = Array.from({ length: 4 }, (_, index) => {
      const runId = `worker-${index}`
      const runDir = createRun(root, runId)
      return Bun.spawn([
        process.execPath,
        join(import.meta.dir, 'electron-build-cache-worker.fixture.ts'),
        repoRoot,
        buildRoot,
        runDir,
        runId,
        counterPath,
        join(root, `${runId}.json`),
      ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
    })
    const exits = await Promise.all(workers.map(worker => worker.exited))
    const errors = await Promise.all(workers.map(worker => new Response(worker.stderr).text()))
    expect(exits.map((exit, index) => ({ exit, error: errors[index] })).filter(item => item.exit !== 0)).toEqual([])
    expect(readFileSync(counterPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1)
    const results = Array.from({ length: 4 }, (_, index) => JSON.parse(readFileSync(join(root, `worker-${index}.json`), 'utf8')) as { buildId: string; appDir: string })
    expect(new Set(results.map(result => result.buildId)).size).toBe(1)
    expect(new Set(results.map(result => result.appDir)).size).toBe(1)
    expect(buildIds(buildRoot)).toEqual([results[0]!.buildId])
    expect(cleanupElectronBuildCache({ buildRoot, retainCount: 0, maxBytes: 1 }).removedBuildIds).toContain(results[0]!.buildId)
  }, 30_000)

  it('lets different source identities compile at the same time', async () => {
    const root = tempRoot('mortise-ui-build-parallel-')
    const buildRoot = join(root, 'cache')
    const counterPath = join(root, 'build-count.txt')
    const releasePath = join(root, 'release')
    writeFileSync(counterPath, '', 'utf8')
    const repoRoots = [join(root, 'repo-a'), join(root, 'repo-b')]
    repoRoots.forEach((repoRoot, index) => {
      initGitRepo(repoRoot)
      write(repoRoot, 'apps/electron/src/main.ts', `export const value = ${index}\n`)
    })
    const workers = repoRoots.map((repoRoot, index) => {
      const runId = `parallel-${index}`
      return Bun.spawn([
        process.execPath,
        join(import.meta.dir, 'electron-build-cache-worker.fixture.ts'),
        repoRoot,
        buildRoot,
        createRun(root, runId),
        runId,
        counterPath,
        join(root, `${runId}.json`),
        join(root, `${runId}.started`),
        releasePath,
      ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
    })

    try {
      await waitFor(() => repoRoots.every((_, index) => existsSync(join(root, `parallel-${index}.started`))), 8_000)
    } finally {
      writeFileSync(releasePath, 'release', 'utf8')
    }
    const exits = await Promise.all(workers.map(worker => worker.exited))
    const errors = await Promise.all(workers.map(worker => new Response(worker.stderr).text()))
    expect(exits.map((exit, index) => ({ exit, error: errors[index] })).filter(item => item.exit !== 0)).toEqual([])
    expect(readFileSync(counterPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)).toHaveLength(2)
    expect(buildIds(buildRoot)).toHaveLength(2)
  }, 20_000)
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function createRun(root: string, runId: string): string {
  const runDir = join(root, 'runs', runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ status: 'ready', launcherPid: process.pid }), 'utf8')
  return runDir
}

function initGitRepo(repoRoot: string): void {
  mkdirSync(repoRoot, { recursive: true })
  const result = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  write(repoRoot, 'package.json', '{}\n')
  write(repoRoot, 'apps/electron/src/main.ts', 'export const value = 1\n')
  seedRequiredBuildInputs(repoRoot)
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for concurrent build workers')
    await Bun.sleep(20)
  }
}

function seedBuildOutputs(repoRoot: string, content = 'fixture'): void {
  write(repoRoot, 'apps/electron/package.json', JSON.stringify({ name: '@mortise/electron-test', main: 'dist/main.cjs', type: 'module' }))
  for (const path of immutableRuntimeRequiredAppPaths()) {
    write(repoRoot, `apps/electron/${path}`, `// ${content}: ${path}\n`)
  }
  write(repoRoot, 'apps/electron/dist/resources/fixture.txt', content)
}

function seedRequiredBuildInputs(repoRoot: string): void {
  for (const input of ELECTRON_BUILD_INPUTS) {
    if (!input.required) continue
    write(repoRoot, `${input.path}/package.json`, JSON.stringify({ name: `@mortise/${input.path.replaceAll('/', '-')}` }))
  }
}

function write(root: string, path: string, content: string): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function buildIds(buildRoot: string): string[] {
  const buildsDir = join(buildRoot, 'builds')
  if (!existsSync(buildsDir)) return []
  return readdirSync(buildsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.staging-'))
    .map(entry => entry.name)
    .sort()
}
