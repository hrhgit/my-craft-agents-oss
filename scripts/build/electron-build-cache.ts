import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { UI_VALIDATION_MAX_WAIT_MS } from '@mortise/shared/ui-validation'
import {
  immutableElectronExecutableRelativePath,
  immutableRuntimeRequiredAppPaths,
} from '@mortise/session-tools-core/runtime'
import { captureBuildSource, type CapturedBuildSource } from '../build-source-snapshot.ts'
import { getPlatformKey, publishVerifiedUvToolchain, UV_VERSION, type Arch, type Platform } from './common.ts'
import { withFileLock } from './file-lock.ts'
import { writeJsonAtomic } from './files.ts'
import { matchesProcessIdentity } from './process-identity.ts'

export const ELECTRON_BUILD_SCHEMA_VERSION = 5
export const ELECTRON_BUILD_PRODUCER_VERSION = 'electron-production-v4'
const DEFAULT_REPO_ROOT = resolve(import.meta.dir, '..', '..')
const DEFAULT_BUILD_ROOT = resolve(DEFAULT_REPO_ROOT, 'output', 'electron-builds')
const DEFAULT_RETAIN_COUNT = 2
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024
const BUILD_LOCK_STALE_MS = 60_000
const STAGING_STALE_MS = 60 * 60 * 1_000
const ACTIVE_RUN_STATUSES = new Set(['starting', 'ready', 'stopping'])
const BUILD_MODES = ['production', 'development', 'ui-validation'] as const

export type ElectronBuildMode = typeof BUILD_MODES[number]

export interface ElectronBuildArtifact {
  path: string
  sizeBytes: number
  sha256: string
  authenticodeSha256?: string
}

export interface MortiseUiBuildManifest {
  schemaVersion: typeof ELECTRON_BUILD_SCHEMA_VERSION
  producerVersion: typeof ELECTRON_BUILD_PRODUCER_VERSION
  buildId: string
  fingerprint: string
  sourceId: string
  mode: ElectronBuildMode
  createdAt: string
  appDir: string
  sizeBytes: number
  artifacts: ElectronBuildArtifact[]
  platform: NodeJS.Platform
  arch: string
  immutable: true
}

interface MortiseUiBuildLeaseFile {
  schemaVersion: typeof ELECTRON_BUILD_SCHEMA_VERSION
  token: string
  runId: string
  runDir: string
  buildId: string
  buildDir: string
  appDir: string
  pid: number
  createdAt: string
}

export interface MortiseUiBuildLease extends MortiseUiBuildLeaseFile {
  buildRoot: string
  manifest: MortiseUiBuildManifest
}

export interface StagedElectronBuild {
  buildId: string
  sourceId: string
  appDir: string
  distDir: string
  provenancePath: string
}

export interface WriteElectronBuildProvenanceOptions {
  appDir: string
  sourceId: string
  mode: ElectronBuildMode
  createdAt?: Date
}

export interface AcquireElectronBuildOptions {
  runId: string
  runDir: string
  repoRoot?: string
  buildRoot?: string
  mode?: ElectronBuildMode
  skipBuild?: boolean
  retainCount?: number
  maxBytes?: number
  lockTimeoutMs?: number
  build?: (sourceRoot: string) => void
  prepareDependencies?: boolean
  pid?: number
  now?: () => Date
  capturedSource?: CapturedBuildSource
}

export interface CleanupElectronBuildOptions {
  buildRoot?: string
  retainCount?: number
  maxBytes?: number
  protectBuildIds?: Iterable<string>
  now?: () => Date
}

export interface MortiseUiBuildCleanupResult {
  removedBuildIds: string[]
  retainedBuildIds: string[]
  activeBuildIds: string[]
  failedBuildIds: string[]
  totalBytes: number
}

export function computeElectronBuildId(sourceId: string, mode: ElectronBuildMode): string {
  const hash = createHash('sha256')
  hash.update(`mortise-electron-build:${ELECTRON_BUILD_SCHEMA_VERSION}\0${ELECTRON_BUILD_PRODUCER_VERSION}\0${mode}\0${process.platform}\0${process.arch}\0${process.versions.bun ?? process.version}\0${toolchainExecutableSha256()}\0${sourceId}\0`)
  return hash.digest('hex')
}

export function captureElectronBuildSource(options: {
  repoRoot?: string
  buildRoot?: string
} = {}): CapturedBuildSource {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT)
  const buildRoot = resolve(options.buildRoot ?? process.env.MORTISE_BUILD_ROOT ?? DEFAULT_BUILD_ROOT)
  return captureBuildSource({
    repoRoot,
    scratchRoot: join(buildRoot, 'sources'),
  })
}

export function electronExecutableRelativePath(platform: NodeJS.Platform = process.platform): string {
  return immutableElectronExecutableRelativePath(platform)
}

export function electronBuildExecutablePath(appDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(
    appDir,
    'dist',
    'packaging-inputs',
    'runtime',
    ...electronExecutableRelativePath(platform).split('/'),
  )
}

export function resolveElectronBuildExecutable(
  lease: Pick<MortiseUiBuildLease, 'appDir'>,
  platform: NodeJS.Platform = process.platform,
): string {
  const executable = electronBuildExecutablePath(lease.appDir, platform)
  if (!existsSync(executable)) {
    throw new Error(`Immutable Electron runtime executable is missing: ${executable}`)
  }
  return executable
}

export function createElectronBuildRuntimeEnvironment(
  lease: Pick<MortiseUiBuildLease, 'buildId' | 'buildDir' | 'appDir'> & {
    manifest: Pick<MortiseUiBuildManifest, 'sourceId'>
  },
  options: { uiValidation?: boolean } = {},
): Record<string, string> {
  const electronExecutable = electronBuildExecutablePath(lease.appDir)
  const runtimeEnvironment: Record<string, string> = {
    MORTISE_BUILD_ID: lease.buildId,
    MORTISE_BUILD_SOURCE_ID: lease.manifest.sourceId,
    MORTISE_BUILD_DIR: lease.buildDir,
    MORTISE_RUNTIME_APP_ROOT: lease.appDir,
    MORTISE_RUNTIME_RESOURCES_DIR: join(lease.appDir, 'dist', 'resources'),
    MORTISE_RUNTIME_RESOURCES_BASE: join(lease.appDir, 'dist'),
    MORTISE_RUNTIME_BUNDLE_PATH: join(lease.appDir, 'dist', 'packaging-inputs', 'runtime'),
    MORTISE_RUNTIME_ELECTRON_PATH: electronExecutable,
    MORTISE_RUNTIME_NODE_PATH: electronExecutable,
    MORTISE_RUNTIME_IMMUTABLE: '1',
  }
  if (options.uiValidation) {
    runtimeEnvironment.MORTISE_UI_BUILD_ID = lease.buildId
    runtimeEnvironment.MORTISE_UI_BUILD_DIR = lease.buildDir
  }
  return runtimeEnvironment
}

export function acquireElectronBuild(options: AcquireElectronBuildOptions): MortiseUiBuildLease {
  const repoRoot = resolve(options.repoRoot ?? options.capturedSource?.repoRoot ?? DEFAULT_REPO_ROOT)
  const buildRoot = resolve(options.buildRoot ?? process.env.MORTISE_BUILD_ROOT ?? DEFAULT_BUILD_ROOT)
  const coordinatorPath = join(buildRoot, 'coordinator')
  const mode = options.mode ?? 'production'
  const now = options.now ?? (() => new Date())
  const pid = options.pid ?? process.pid
  const retainCount = nonNegativeInteger(options.retainCount, envNumber('MORTISE_BUILD_RETAIN_COUNT', DEFAULT_RETAIN_COUNT))
  const maxBytes = positiveInteger(options.maxBytes, envNumber('MORTISE_BUILD_MAX_BYTES', DEFAULT_MAX_BYTES))
  let capturedSourceId = ''
  const build = options.build ?? ((sourceRoot: string) => runElectronBuild(sourceRoot, mode, capturedSourceId, buildRoot))

  mkdirSync(join(buildRoot, 'builds'), { recursive: true })
  mkdirSync(join(buildRoot, 'leases'), { recursive: true })
  mkdirSync(join(buildRoot, 'locks'), { recursive: true })
  mkdirSync(join(buildRoot, 'sources'), { recursive: true })
  seedUvToolchainCacheFromCompletedBuild(buildRoot)

  if (options.capturedSource && resolve(options.capturedSource.repoRoot) !== repoRoot) {
    throw new Error('Electron build source capture does not belong to the requested repository root.')
  }
  const capturedSource = options.capturedSource ?? captureElectronBuildSource({
    repoRoot,
    buildRoot,
  })
  const ownsCapturedSource = options.capturedSource === undefined
  capturedSourceId = capturedSource.sourceId
  const fingerprint = computeElectronBuildId(capturedSource.sourceId, mode)
  const buildId = fingerprint
  const buildDir = join(buildRoot, 'builds', buildId)
  try {
    return withFileLock(join(buildRoot, 'locks', buildId), () => {
      let manifest = readValidBuildManifest(buildDir, fingerprint)

      if (!manifest) {
        if (options.skipBuild) {
          throw new Error(`MORTISE_UI_SKIP_BUILD requires a completed immutable build for fingerprint ${shortBuildId(buildId)}.`)
        }
        if (existsSync(buildDir)) removeDirectory(buildDir)

        const source = capturedSource.materialize({
          parentDir: join(buildRoot, 'sources'),
          prepareDependencies: options.prepareDependencies ?? options.build === undefined,
        })
        try {
          build(source.sourceRoot)
          manifest = publishBuildCapsule({
            repoRoot: source.sourceRoot,
            buildRoot,
            buildId,
            fingerprint,
            sourceId: capturedSource.sourceId,
            mode,
            now: now(),
          })
        } finally {
          source.dispose()
        }
      }

      return withFileLock(coordinatorPath, () => {
        cleanupElectronBuildCacheLocked({ buildRoot, retainCount, maxBytes, protectBuildIds: [buildId], now })
        if (!manifest || manifest.mode !== mode) throw new Error(`Immutable Electron build ${shortBuildId(buildId)} has the wrong build mode.`)
        const lease: MortiseUiBuildLease = {
          schemaVersion: ELECTRON_BUILD_SCHEMA_VERSION,
          token: randomUUID(),
          runId: options.runId,
          runDir: resolve(options.runDir),
          buildId,
          buildDir,
          appDir: manifest.appDir,
          pid,
          createdAt: now().toISOString(),
          buildRoot,
          manifest,
        }
        writeJsonAtomic(leasePath(buildRoot, options.runId), leaseFile(lease), 0o600)
        cleanupElectronBuildCacheLocked({ buildRoot, retainCount, maxBytes, protectBuildIds: [buildId], now })
        return lease
      }, { timeoutMs: options.lockTimeoutMs ?? UI_VALIDATION_MAX_WAIT_MS, staleMs: BUILD_LOCK_STALE_MS })
    }, { timeoutMs: options.lockTimeoutMs ?? UI_VALIDATION_MAX_WAIT_MS, staleMs: BUILD_LOCK_STALE_MS })
  } finally {
    if (ownsCapturedSource) capturedSource.dispose()
  }
}

export function releaseElectronBuild(lease: MortiseUiBuildLease, options: Omit<CleanupElectronBuildOptions, 'buildRoot'> = {}): MortiseUiBuildCleanupResult {
  const buildRoot = resolve(lease.buildRoot)
  return withFileLock(join(buildRoot, 'coordinator'), () => {
    const path = leasePath(buildRoot, lease.runId)
    const current = readLease(path)
    if (current?.token === lease.token) {
      try { unlinkSync(path) } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
    }
    return cleanupElectronBuildCacheLocked({ ...options, buildRoot })
  }, { timeoutMs: UI_VALIDATION_MAX_WAIT_MS, staleMs: BUILD_LOCK_STALE_MS })
}

export function cleanupElectronBuildCache(options: CleanupElectronBuildOptions = {}): MortiseUiBuildCleanupResult {
  const buildRoot = resolve(options.buildRoot ?? process.env.MORTISE_BUILD_ROOT ?? DEFAULT_BUILD_ROOT)
  mkdirSync(buildRoot, { recursive: true })
  return withFileLock(join(buildRoot, 'coordinator'), () => cleanupElectronBuildCacheLocked({ ...options, buildRoot }), {
    timeoutMs: UI_VALIDATION_MAX_WAIT_MS,
    staleMs: BUILD_LOCK_STALE_MS,
  })
}

export function withStagedElectronBuild<T>(
  lease: MortiseUiBuildLease,
  use: (staged: StagedElectronBuild) => T,
): T {
  return withFileLock(join(lease.buildRoot, 'packaging-stage'), () => {
    const manifest = lease.manifest
    if (manifest.mode === 'ui-validation') {
      throw new Error(`Electron build ${shortBuildId(lease.buildId)} is ui-validation; validation builds may not be staged for packaging.`)
    }

    const stagingParent = join(lease.buildRoot, 'packaging-staging')
    reapPackagingStagingDirectories(stagingParent)
    const stagingApp = join(stagingParent, `.app-${shortBuildId(lease.buildId)}-${process.pid}-${randomUUID().slice(0, 8)}`)
    mkdirSync(stagingParent, { recursive: true })
    cpSync(manifest.appDir, stagingApp, { recursive: true, force: true, dereference: true })

    const stagedArtifacts = collectArtifactInventory(stagingApp)
    if (!artifactInventoriesEqual(manifest.artifacts, stagedArtifacts)) {
      removeDirectory(stagingApp)
      throw new Error(`Immutable Electron build ${shortBuildId(lease.buildId)} changed while it was being staged.`)
    }

    const stagingDist = join(stagingApp, 'dist')
    writeBuildProvenance(join(stagingDist, 'build-provenance.json'), manifest)

    try {
      return use({
        buildId: manifest.buildId,
        sourceId: manifest.sourceId,
        appDir: stagingApp,
        distDir: stagingDist,
        provenancePath: join(stagingDist, 'build-provenance.json'),
      })
    } finally {
      removeDirectory(stagingApp)
    }
  }, { timeoutMs: UI_VALIDATION_MAX_WAIT_MS, staleMs: BUILD_LOCK_STALE_MS })
}

function reapPackagingStagingDirectories(stagingParent: string): void {
  mkdirSync(stagingParent, { recursive: true })
  for (const entry of readdirSync(stagingParent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.app-')) continue
    removeDirectory(join(stagingParent, entry.name))
  }
}

export function writeElectronBuildProvenance(options: WriteElectronBuildProvenanceOptions): string {
  if (!/^[0-9a-f]{64}$/.test(options.sourceId)) throw new Error('Electron build provenance requires a canonical source identity.')
  const appDir = resolve(options.appDir)
  const provenancePath = join(appDir, 'dist', 'build-provenance.json')
  rmSync(provenancePath, { force: true })
  assertSourceBuildOutputs(appDir)
  const artifacts = collectAppCapsuleInventory(appDir)
  const buildId = computeElectronBuildId(options.sourceId, options.mode)
  const manifest: MortiseUiBuildManifest = {
    schemaVersion: ELECTRON_BUILD_SCHEMA_VERSION,
    producerVersion: ELECTRON_BUILD_PRODUCER_VERSION,
    buildId,
    fingerprint: buildId,
    sourceId: options.sourceId,
    mode: options.mode,
    createdAt: (options.createdAt ?? new Date()).toISOString(),
    appDir,
    sizeBytes: artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
    artifacts,
    platform: process.platform,
    arch: process.arch,
    immutable: true,
  }
  writeBuildProvenance(provenancePath, manifest)
  return provenancePath
}

function publishBuildCapsule(args: {
  repoRoot: string
  buildRoot: string
  buildId: string
  fingerprint: string
  sourceId: string
  mode: ElectronBuildMode
  now: Date
}): MortiseUiBuildManifest {
  const sourceAppDir = join(args.repoRoot, 'apps', 'electron')
  const sourceDistDir = join(sourceAppDir, 'dist')
  assertSourceBuildOutputs(sourceAppDir)

  const stagingDir = join(args.buildRoot, 'builds', `.staging-${shortBuildId(args.buildId)}-${process.pid}-${randomUUID().slice(0, 8)}`)
  const stagingAppDir = join(stagingDir, 'app')
  mkdirSync(stagingAppDir, { recursive: true })
  try {
    cpSync(join(sourceAppDir, 'package.json'), join(stagingAppDir, 'package.json'), { force: true })
    cpSync(sourceDistDir, join(stagingAppDir, 'dist'), { recursive: true, force: true, dereference: true })
    const finalBuildDir = join(args.buildRoot, 'builds', args.buildId)
    const finalAppDir = join(finalBuildDir, 'app')
    const artifacts = collectArtifactInventory(stagingAppDir)
    const manifest: MortiseUiBuildManifest = {
      schemaVersion: ELECTRON_BUILD_SCHEMA_VERSION,
      producerVersion: ELECTRON_BUILD_PRODUCER_VERSION,
      buildId: args.buildId,
      fingerprint: args.fingerprint,
      sourceId: args.sourceId,
      mode: args.mode,
      createdAt: args.now.toISOString(),
      appDir: finalAppDir,
      sizeBytes: artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
      artifacts,
      platform: process.platform,
      arch: process.arch,
      immutable: true,
    }
    writeJsonAtomic(join(stagingDir, 'build.json'), manifest)
    renameDirectoryWithRetry(stagingDir, finalBuildDir)
    return manifest
  } catch (error) {
    removeDirectory(stagingDir)
    throw error
  }
}

function cleanupElectronBuildCacheLocked(options: CleanupElectronBuildOptions & { buildRoot: string }): MortiseUiBuildCleanupResult {
  const buildRoot = resolve(options.buildRoot)
  const now = options.now ?? (() => new Date())
  const retainCount = nonNegativeInteger(options.retainCount, envNumber('MORTISE_BUILD_RETAIN_COUNT', DEFAULT_RETAIN_COUNT))
  const maxBytes = positiveInteger(options.maxBytes, envNumber('MORTISE_BUILD_MAX_BYTES', DEFAULT_MAX_BYTES))
  mkdirSync(join(buildRoot, 'builds'), { recursive: true })
  mkdirSync(join(buildRoot, 'leases'), { recursive: true })
  const active = reapStaleLeases(buildRoot)
  const building = activeBuildLocks(buildRoot)
  if (!hasBuildLockDirectories(buildRoot)) {
    reapStaleStagingDirectories(buildRoot, now().getTime())
    reapStaleSourceDirectories(buildRoot, now().getTime())
  }
  const protectedIds = new Set([...active, ...building, ...(options.protectBuildIds ?? [])])
  const invalid = removeInvalidBuildDirectories(buildRoot, protectedIds)
  const builds = listBuilds(buildRoot)
  const newestFirst = [...builds].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const retainedUnreferenced = new Set(newestFirst.filter(build => !protectedIds.has(build.buildId)).slice(0, retainCount).map(build => build.buildId))
  const removedBuildIds: string[] = [...invalid.removed]
  const failedBuildIds: string[] = [...invalid.failed]
  let totalBytes = builds.reduce((sum, build) => sum + build.sizeBytes, 0)

  for (const build of [...builds].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (protectedIds.has(build.buildId)) continue
    const overRetention = !retainedUnreferenced.has(build.buildId)
    const overBudget = totalBytes > maxBytes
    if (!overRetention && !overBudget) continue
    try {
      removeDirectory(join(buildRoot, 'builds', build.buildId))
      removedBuildIds.push(build.buildId)
      retainedUnreferenced.delete(build.buildId)
      totalBytes -= build.sizeBytes
    } catch {
      failedBuildIds.push(build.buildId)
    }
  }

  const retainedBuildIds = builds.map(build => build.buildId).filter(id => !removedBuildIds.includes(id))
  return {
    removedBuildIds,
    retainedBuildIds,
    activeBuildIds: [...active],
    failedBuildIds,
    totalBytes,
  }
}

function removeInvalidBuildDirectories(buildRoot: string, protectedIds: Set<string>): { removed: string[]; failed: string[] } {
  const buildsDir = join(buildRoot, 'builds')
  const removed: string[] = []
  const failed: string[] = []
  for (const entry of readdirSync(buildsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.staging-') || protectedIds.has(entry.name)) continue
    const path = join(buildsDir, entry.name)
    if (readValidBuildManifest(path, entry.name)) continue
    try {
      removeDirectory(path)
      removed.push(entry.name)
    } catch {
      failed.push(entry.name)
    }
  }
  return { removed, failed }
}

function assertSourceBuildOutputs(sourceAppDir: string): void {
  const required = [
    ...immutableRuntimeRequiredAppPaths(),
    'package.json',
  ]
  const missing = required.filter(path => {
    const requiredPath = join(sourceAppDir, ...path.split('/'))
    return !existsSync(requiredPath) || !statSync(requiredPath).isFile()
  })
  if (missing.length > 0) throw new Error(`Electron validation build is incomplete: ${missing.join(', ')}`)
}

function readValidBuildManifest(buildDir: string, fingerprint: string): MortiseUiBuildManifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(buildDir, 'build.json'), 'utf8')) as MortiseUiBuildManifest
    if (
      manifest.schemaVersion !== ELECTRON_BUILD_SCHEMA_VERSION
      || manifest.producerVersion !== ELECTRON_BUILD_PRODUCER_VERSION
      || !BUILD_MODES.includes(manifest.mode)
      || !/^[0-9a-f]{64}$/.test(manifest.sourceId)
      || manifest.buildId !== fingerprint
      || manifest.fingerprint !== fingerprint
      || computeElectronBuildId(manifest.sourceId, manifest.mode) !== fingerprint
      || manifest.platform !== process.platform
      || manifest.arch !== process.arch
      || manifest.immutable !== true
      || resolve(manifest.appDir) !== resolve(buildDir, 'app')
      || !Array.isArray(manifest.artifacts)
      || manifest.sizeBytes !== artifactInventorySize(manifest.artifacts)
    ) return undefined
    assertSourceBuildOutputs(manifest.appDir)
    if (!artifactInventoriesEqual(manifest.artifacts, collectArtifactInventory(manifest.appDir))) return undefined
    return manifest
  } catch { return undefined }
}

function listBuilds(buildRoot: string): MortiseUiBuildManifest[] {
  const buildsDir = join(buildRoot, 'builds')
  if (!existsSync(buildsDir)) return []
  const builds: MortiseUiBuildManifest[] = []
  for (const entry of readdirSync(buildsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.staging-')) continue
    try {
      const manifest = JSON.parse(readFileSync(join(buildsDir, entry.name, 'build.json'), 'utf8')) as MortiseUiBuildManifest
      if (
        manifest.schemaVersion === ELECTRON_BUILD_SCHEMA_VERSION
        && manifest.producerVersion === ELECTRON_BUILD_PRODUCER_VERSION
        && manifest.buildId === entry.name
        && /^[0-9a-f]{64}$/.test(manifest.sourceId)
        && BUILD_MODES.includes(manifest.mode)
        && computeElectronBuildId(manifest.sourceId, manifest.mode) === entry.name
        && manifest.platform === process.platform
        && manifest.arch === process.arch
        && Number.isSafeInteger(manifest.sizeBytes)
        && manifest.sizeBytes === artifactInventorySize(manifest.artifacts)
      ) builds.push(manifest)
    } catch { /* Incomplete unreferenced builds are removed by later acquisition or manual cache deletion. */ }
  }
  return builds
}

function reapStaleLeases(buildRoot: string): Set<string> {
  const leasesDir = join(buildRoot, 'leases')
  const active = new Set<string>()
  for (const entry of readdirSync(leasesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(leasesDir, entry.name)
    const lease = readLease(path)
    if (lease && isLeaseActive(lease)) {
      active.add(lease.buildId)
      continue
    }
    try { unlinkSync(path) } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
  }
  return active
}

function isLeaseActive(lease: MortiseUiBuildLeaseFile): boolean {
  if (matchesProcessIdentity({ pid: lease.pid, recordedAt: Date.parse(lease.createdAt) })) return true
  try {
    const run = JSON.parse(readFileSync(join(lease.runDir, 'run.json'), 'utf8')) as {
      status?: string
      createdAt?: string
      launcherPid?: number
      launcherStartedAt?: number
      hostPid?: number
      hostStartedAt?: number
    }
    const recordedAt = typeof run.createdAt === 'string' ? Date.parse(run.createdAt) : undefined
    return ACTIVE_RUN_STATUSES.has(run.status ?? '') && (
      matchesProcessIdentity({ pid: run.launcherPid, startedAt: run.launcherStartedAt, recordedAt })
      || matchesProcessIdentity({ pid: run.hostPid, startedAt: run.hostStartedAt, recordedAt })
    )
  } catch { return false }
}

function activeBuildLocks(buildRoot: string): Set<string> {
  const locksDir = join(buildRoot, 'locks')
  const active = new Set<string>()
  if (!existsSync(locksDir)) return active
  for (const entry of readdirSync(locksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lock')) continue
    try {
      const owner = JSON.parse(readFileSync(join(locksDir, entry.name, 'owner.json'), 'utf8')) as { pid?: number; recordedAt?: number }
      if (matchesProcessIdentity({ pid: owner.pid, recordedAt: owner.recordedAt })) active.add(entry.name.slice(0, -'.lock'.length))
    } catch { /* A lock may be between directory creation and owner publication. */ }
  }
  return active
}

function hasBuildLockDirectories(buildRoot: string): boolean {
  const locksDir = join(buildRoot, 'locks')
  return existsSync(locksDir) && readdirSync(locksDir, { withFileTypes: true })
    .some(entry => entry.isDirectory() && entry.name.endsWith('.lock'))
}

function reapStaleSourceDirectories(buildRoot: string, nowMs: number): void {
  const sourcesDir = join(buildRoot, 'sources')
  if (!existsSync(sourcesDir)) return
  for (const entry of readdirSync(sourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.source-')) continue
    const path = join(sourcesDir, entry.name)
    try {
      if (statSync(path).mtimeMs < nowMs - STAGING_STALE_MS) removeDirectory(path)
    } catch { /* A completing build may have already removed it. */ }
  }
}

function reapStaleStagingDirectories(buildRoot: string, nowMs: number): void {
  const buildsDir = join(buildRoot, 'builds')
  for (const entry of readdirSync(buildsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.staging-')) continue
    const path = join(buildsDir, entry.name)
    try {
      if (statSync(path).mtimeMs < nowMs - STAGING_STALE_MS) removeDirectory(path)
    } catch { /* A concurrent filesystem observer may have already removed it. */ }
  }
}

function readLease(path: string): MortiseUiBuildLeaseFile | undefined {
  try {
    const lease = JSON.parse(readFileSync(path, 'utf8')) as MortiseUiBuildLeaseFile
    if (
      lease.schemaVersion !== ELECTRON_BUILD_SCHEMA_VERSION
      || typeof lease.token !== 'string'
      || typeof lease.runId !== 'string'
      || typeof lease.runDir !== 'string'
      || typeof lease.buildId !== 'string'
      || typeof lease.pid !== 'number'
    ) return undefined
    return lease
  } catch { return undefined }
}

function leasePath(buildRoot: string, runId: string): string {
  const safeRunId = basename(runId)
  if (safeRunId !== runId) throw new Error('Mortise UI run ID cannot contain path separators.')
  return join(buildRoot, 'leases', `${safeRunId}.json`)
}

function leaseFile(lease: MortiseUiBuildLease): MortiseUiBuildLeaseFile {
  const { buildRoot: _buildRoot, manifest: _manifest, ...file } = lease
  return file
}

function runElectronBuild(repoRoot: string, mode: ElectronBuildMode, sourceId: string, buildRoot: string): void {
  runBuildCommand(repoRoot, ['run', 'pi:build'], 'Pi workspace build', mode, sourceId, buildRoot)
  runBuildCommand(repoRoot, ['run', 'pi:build:binary'], 'Pi binary build', mode, sourceId, buildRoot)
  runBuildCommand(repoRoot, ['run', 'electron:build:source'], 'Electron source build', mode, sourceId, buildRoot)
}

export function createElectronBuildCommandEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  mode: ElectronBuildMode,
  sourceId: string,
  buildRoot: string,
  bunExecutable = process.execPath,
): NodeJS.ProcessEnv {
  const inheritedPath = Object.entries(baseEnv)
    .find(([name]) => name.toLowerCase() === 'path')?.[1]
  const envWithoutPath = Object.fromEntries(
    Object.entries(baseEnv).filter(([name]) => name.toLowerCase() !== 'path'),
  )
  return {
    ...envWithoutPath,
    PATH: [dirname(bunExecutable), inheritedPath].filter(Boolean).join(delimiter),
    MORTISE_UI_VALIDATION_BUILD: mode === 'ui-validation' ? '1' : '0',
    MORTISE_UI_TEST_HOST: mode === 'ui-validation' ? '1' : '0',
    MORTISE_DEV_HOST_BUILD: '0',
    MORTISE_DEV_RUNTIME: mode === 'development' ? '1' : '0',
    MORTISE_BUILD_SOURCE_ID: sourceId,
    MORTISE_BUILD_TOOLCHAIN_CACHE_DIR: join(buildRoot, 'toolchains'),
  }
}

function runBuildCommand(repoRoot: string, args: string[], label: string, mode: ElectronBuildMode, sourceId: string, buildRoot: string): void {
  const startedAt = Date.now()
  process.stdout.write(`[electron-build] Starting ${label}...\n`)
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: createElectronBuildCommandEnvironment(process.env, mode, sourceId, buildRoot),
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`)
  process.stdout.write(`[electron-build] Completed ${label} in ${Date.now() - startedAt}ms.\n`)
}

export function seedUvToolchainCacheFromCompletedBuild(buildRootValue: string): boolean {
  if (!['darwin', 'win32', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) return false
  const buildRoot = resolve(buildRootValue)
  const platform = process.platform as Platform
  const arch = process.arch as Arch
  const relativeUv = `dist/resources/bin/${getPlatformKey(platform, arch)}/${platform === 'win32' ? 'uv.exe' : 'uv'}`
  const candidates = listBuilds(buildRoot)
    .filter(build => build.platform === platform && build.arch === arch)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  for (const build of candidates) {
    const artifact = build.artifacts.find(item => item.path === relativeUv)
    if (!artifact) continue
    const sourceBinary = join(build.appDir, ...relativeUv.split('/'))
    if (!existsSync(sourceBinary)) continue
    publishVerifiedUvToolchain(join(buildRoot, 'toolchains'), { platform, arch }, sourceBinary, artifact.sha256)
    process.stdout.write(`[electron-build] Seeded uv ${UV_VERSION} toolchain cache from build ${shortBuildId(build.buildId)}.\n`)
    return true
  }
  return false
}

function directorySize(path: string): number {
  if (!existsSync(path)) return 0
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return 0
  if (stat.isFile()) return stat.size
  return readdirSync(path).reduce((sum, name) => sum + directorySize(join(path, name)), 0)
}

export function collectArtifactInventory(root: string): ElectronBuildArtifact[] {
  const resolvedRoot = resolve(root)
  const artifacts: ElectronBuildArtifact[] = []
  const visit = (path: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`Immutable build artifact cannot be a symbolic link: ${path}`)
    if (stat.isFile()) {
      const content = readFileSync(path)
      const authenticodeSha256 = authenticodeContentSha256(content)
      artifacts.push({
        path: relative(resolvedRoot, path).replaceAll('\\', '/'),
        sizeBytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        ...(authenticodeSha256 ? { authenticodeSha256 } : {}),
      })
      return
    }
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      visit(join(path, entry.name))
    }
  }
  visit(resolvedRoot)
  return artifacts.sort((a, b) => a.path.localeCompare(b.path))
}

function collectAppCapsuleInventory(appDir: string): ElectronBuildArtifact[] {
  const packagePath = join(appDir, 'package.json')
  const packageContent = readFileSync(packagePath)
  const distArtifacts = collectArtifactInventory(join(appDir, 'dist')).map(artifact => ({
    ...artifact,
    path: `dist/${artifact.path}`,
  }))
  return [
    {
      path: 'package.json',
      sizeBytes: packageContent.byteLength,
      sha256: createHash('sha256').update(packageContent).digest('hex'),
    },
    ...distArtifacts,
  ].sort((a, b) => a.path.localeCompare(b.path))
}

export function artifactInventoriesEqual(expected: ElectronBuildArtifact[], actual: ElectronBuildArtifact[]): boolean {
  return expected.length === actual.length && expected.every((artifact, index) => {
    const observed = actual[index]
    return observed?.path === artifact.path
      && observed.sizeBytes === artifact.sizeBytes
      && observed.sha256 === artifact.sha256
      && observed.authenticodeSha256 === artifact.authenticodeSha256
  })
}

export function artifactInventorySize(artifacts: ElectronBuildArtifact[]): number {
  if (!Array.isArray(artifacts)) return -1
  let total = 0
  for (const artifact of artifacts) {
    if (!artifact || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) return -1
    total += artifact.sizeBytes
    if (!Number.isSafeInteger(total)) return -1
  }
  return total
}

export function authenticodeContentSha256(content: Uint8Array): string | undefined {
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return undefined
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset + 24 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return undefined
  const optionalHeader = peOffset + 24
  if (optionalHeader + 68 > bytes.length) return undefined
  const magic = bytes.readUInt16LE(optionalHeader)
  const dataDirectory = optionalHeader + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1)
  if (dataDirectory < optionalHeader || dataDirectory + 40 > bytes.length) return undefined
  const checksumOffset = optionalHeader + 64
  const securityDirectoryOffset = dataDirectory + 32
  const certificateOffset = bytes.readUInt32LE(securityDirectoryOffset)
  const certificateSize = bytes.readUInt32LE(securityDirectoryOffset + 4)
  const certificateEnd = certificateOffset + certificateSize
  if (
    checksumOffset + 4 > securityDirectoryOffset
    || securityDirectoryOffset + 8 > bytes.length
    || (certificateOffset !== 0 && (
      certificateOffset < securityDirectoryOffset + 8
      || certificateEnd < certificateOffset
      || certificateEnd > bytes.length
    ))
  ) return undefined

  const hash = createHash('sha256')
  hash.update(bytes.subarray(0, checksumOffset))
  hash.update(bytes.subarray(checksumOffset + 4, securityDirectoryOffset))
  const contentEnd = certificateOffset === 0 ? bytes.length : certificateOffset
  hash.update(bytes.subarray(securityDirectoryOffset + 8, contentEnd))
  if (certificateOffset !== 0 && certificateEnd < bytes.length) hash.update(bytes.subarray(certificateEnd))
  return hash.digest('hex')
}

function writeBuildProvenance(path: string, manifest: MortiseUiBuildManifest): void {
  writeJsonAtomic(path, {
    schemaVersion: manifest.schemaVersion,
    producerVersion: manifest.producerVersion,
    buildId: manifest.buildId,
    sourceId: manifest.sourceId,
    mode: manifest.mode,
    platform: manifest.platform,
    arch: manifest.arch,
    createdAt: manifest.createdAt,
    artifacts: manifest.artifacts,
  })
}

function renameDirectoryWithRetry(source: string, target: string): void {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '') || attempt === 8) throw error
      sleepSync(Math.min(250, 10 * 2 ** (attempt - 1)))
    }
  }
}

function removeDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}

function shortBuildId(buildId: string): string {
  return buildId.slice(0, 12)
}

let cachedToolchainExecutableSha256: string | undefined
function toolchainExecutableSha256(): string {
  cachedToolchainExecutableSha256 ??= createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
  return cachedToolchainExecutableSha256
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
