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
import { basename, dirname, join, relative, resolve } from 'node:path'
import { UI_VALIDATION_MAX_WAIT_MS } from '@mortise/shared/ui-validation'
import { captureBuildSource } from '../build-source-snapshot.ts'
import { withFileLock } from './artifacts.ts'
import { writeJsonAtomic } from './files.ts'

const BUILD_SCHEMA_VERSION = 1
const DEFAULT_REPO_ROOT = resolve(import.meta.dir, '..', '..')
const DEFAULT_BUILD_ROOT = resolve(DEFAULT_REPO_ROOT, 'output', 'mortise-ui-builds')
const DEFAULT_RETAIN_COUNT = 2
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024
const BUILD_LOCK_STALE_MS = 60_000
const STAGING_STALE_MS = 60 * 60 * 1_000
const ACTIVE_RUN_STATUSES = new Set(['starting', 'ready', 'stopping'])
const BUILD_ENV_KEYS = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'SLACK_OAUTH_CLIENT_ID',
  'SLACK_OAUTH_CLIENT_SECRET',
  'MICROSOFT_OAUTH_CLIENT_ID',
] as const
const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git', 'node_modules', 'dist', 'out', 'output', 'release', 'release-devhost', 'coverage', '.cache',
])
const EXCLUDED_ELECTRON_RESOURCE_NAMES = new Set(['session-mcp-server', 'pi-agent-server'])
const PI_RUNTIME_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs', '.node', '.wasm'])

export interface MortiseUiBuildManifest {
  schemaVersion: typeof BUILD_SCHEMA_VERSION
  buildId: string
  fingerprint: string
  createdAt: string
  appDir: string
  sizeBytes: number
  platform: NodeJS.Platform
  arch: string
  immutable: true
}

interface MortiseUiBuildLeaseFile {
  schemaVersion: typeof BUILD_SCHEMA_VERSION
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
}

export interface AcquireElectronBuildOptions {
  runId: string
  runDir: string
  repoRoot?: string
  buildRoot?: string
  skipBuild?: boolean
  retainCount?: number
  maxBytes?: number
  lockTimeoutMs?: number
  computeFingerprint?: () => string
  build?: (sourceRoot: string) => void
  prepareDependencies?: boolean
  pid?: number
  now?: () => Date
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

export function computeElectronBuildFingerprint(repoRoot = DEFAULT_REPO_ROOT): string {
  const root = resolve(repoRoot)
  const hash = createHash('sha256')
  hash.update(`mortise-ui-build:${BUILD_SCHEMA_VERSION}\0${process.platform}\0${process.arch}\0${process.versions.bun ?? process.version}\0`)
  for (const key of BUILD_ENV_KEYS) {
    hash.update(`${key}\0`)
    hash.update(createHash('sha256').update(process.env[key] ?? '').digest())
  }

  const files = collectBuildInputFiles(root)
  for (const path of files) {
    const name = relative(root, path).replaceAll('\\', '/')
    hash.update(`file\0${name}\0`)
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function acquireElectronBuild(options: AcquireElectronBuildOptions): MortiseUiBuildLease {
  const repoRoot = resolve(options.repoRoot ?? DEFAULT_REPO_ROOT)
  const buildRoot = resolve(options.buildRoot ?? process.env.MORTISE_UI_BUILD_ROOT ?? DEFAULT_BUILD_ROOT)
  const coordinatorPath = join(buildRoot, 'coordinator')
  const now = options.now ?? (() => new Date())
  const pid = options.pid ?? process.pid
  const retainCount = nonNegativeInteger(options.retainCount, envNumber('MORTISE_UI_BUILD_RETAIN_COUNT', DEFAULT_RETAIN_COUNT))
  const maxBytes = positiveInteger(options.maxBytes, envNumber('MORTISE_UI_BUILD_MAX_BYTES', DEFAULT_MAX_BYTES))
  const build = options.build ?? runElectronBuild

  mkdirSync(join(buildRoot, 'builds'), { recursive: true })
  mkdirSync(join(buildRoot, 'leases'), { recursive: true })
  mkdirSync(join(buildRoot, 'locks'), { recursive: true })
  mkdirSync(join(buildRoot, 'sources'), { recursive: true })

  const capturedSource = captureBuildSource({ repoRoot, scratchRoot: join(buildRoot, 'sources') })
  const fingerprint = options.computeFingerprint?.() ?? electronFingerprintForSource(capturedSource.sourceId)
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
          linkDependencies: options.prepareDependencies ?? options.build === undefined,
        })
        try {
          build(source.sourceRoot)
          manifest = publishBuildCapsule({ repoRoot: source.sourceRoot, buildRoot, buildId, fingerprint, now: now() })
        } finally {
          source.dispose()
        }
      }

      return withFileLock(coordinatorPath, () => {
        cleanupElectronBuildCacheLocked({ buildRoot, retainCount, maxBytes, protectBuildIds: [buildId], now })
        const completedManifest = readValidBuildManifest(buildDir, fingerprint)
        if (!completedManifest) throw new Error(`Immutable Mortise UI build ${shortBuildId(buildId)} disappeared before its lease was created.`)
        const lease: MortiseUiBuildLease = {
          schemaVersion: BUILD_SCHEMA_VERSION,
          token: randomUUID(),
          runId: options.runId,
          runDir: resolve(options.runDir),
          buildId,
          buildDir,
          appDir: completedManifest.appDir,
          pid,
          createdAt: now().toISOString(),
          buildRoot,
        }
        writeJsonAtomic(leasePath(buildRoot, options.runId), leaseFile(lease), 0o600)
        cleanupElectronBuildCacheLocked({ buildRoot, retainCount, maxBytes, protectBuildIds: [buildId], now })
        return lease
      }, { timeoutMs: options.lockTimeoutMs ?? UI_VALIDATION_MAX_WAIT_MS, staleMs: BUILD_LOCK_STALE_MS })
    }, { timeoutMs: options.lockTimeoutMs ?? UI_VALIDATION_MAX_WAIT_MS, staleMs: BUILD_LOCK_STALE_MS })
  } finally {
    capturedSource.dispose()
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
  const buildRoot = resolve(options.buildRoot ?? process.env.MORTISE_UI_BUILD_ROOT ?? DEFAULT_BUILD_ROOT)
  mkdirSync(buildRoot, { recursive: true })
  return withFileLock(join(buildRoot, 'coordinator'), () => cleanupElectronBuildCacheLocked({ ...options, buildRoot }), {
    timeoutMs: UI_VALIDATION_MAX_WAIT_MS,
    staleMs: BUILD_LOCK_STALE_MS,
  })
}

function publishBuildCapsule(args: {
  repoRoot: string
  buildRoot: string
  buildId: string
  fingerprint: string
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
    const manifest: MortiseUiBuildManifest = {
      schemaVersion: BUILD_SCHEMA_VERSION,
      buildId: args.buildId,
      fingerprint: args.fingerprint,
      createdAt: args.now.toISOString(),
      appDir: finalAppDir,
      sizeBytes: directorySize(stagingAppDir),
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
  const retainCount = nonNegativeInteger(options.retainCount, envNumber('MORTISE_UI_BUILD_RETAIN_COUNT', DEFAULT_RETAIN_COUNT))
  const maxBytes = positiveInteger(options.maxBytes, envNumber('MORTISE_UI_BUILD_MAX_BYTES', DEFAULT_MAX_BYTES))
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

function collectBuildInputFiles(repoRoot: string): string[] {
  const files = new Set<string>()
  const add = (path: string, options: { excludeDirs?: Set<string>; include?: (path: string) => boolean } = {}): void => {
    if (!existsSync(path)) return
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) {
      if (!options.include || options.include(path)) files.add(resolve(path))
      return
    }
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && (options.excludeDirs?.has(entry.name) || EXCLUDED_DIRECTORY_NAMES.has(entry.name))) continue
      add(join(path, entry.name), options)
    }
  }

  for (const name of ['package.json', 'bun.lock', 'tsconfig.json']) add(join(repoRoot, name))
  add(join(repoRoot, 'apps', 'electron'), { excludeDirs: EXCLUDED_ELECTRON_RESOURCE_NAMES })
  add(join(repoRoot, 'apps', 'webui', 'src'))
  add(join(repoRoot, 'apps', 'webui', 'package.json'))
  add(join(repoRoot, 'apps', 'webui', 'vite.config.ts'))
  add(join(repoRoot, 'packages'))
  add(join(repoRoot, 'scripts'))

  const piPackages = join(repoRoot, 'pi', 'packages')
  if (existsSync(piPackages)) {
    for (const entry of readdirSync(piPackages, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const packageRoot = join(piPackages, entry.name)
      add(join(packageRoot, 'package.json'))
      add(join(packageRoot, 'dist'), { include: path => PI_RUNTIME_EXTENSIONS.has(extension(path)) })
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b))
}

function assertSourceBuildOutputs(sourceAppDir: string): void {
  const required = [
    'dist/main.cjs',
    'dist/bootstrap-preload.cjs',
    'dist/browser-toolbar-preload.cjs',
    'dist/workspace-server.mjs',
    'dist/renderer/index.html',
    'dist/resources',
    'package.json',
  ]
  const missing = required.filter(path => !existsSync(join(sourceAppDir, ...path.split('/'))))
  if (missing.length > 0) throw new Error(`Electron validation build is incomplete: ${missing.join(', ')}`)
}

function readValidBuildManifest(buildDir: string, fingerprint: string): MortiseUiBuildManifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(buildDir, 'build.json'), 'utf8')) as MortiseUiBuildManifest
    if (
      manifest.schemaVersion !== BUILD_SCHEMA_VERSION
      || manifest.buildId !== fingerprint
      || manifest.fingerprint !== fingerprint
      || manifest.immutable !== true
      || resolve(manifest.appDir) !== resolve(buildDir, 'app')
    ) return undefined
    assertSourceBuildOutputs(manifest.appDir)
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
      if (manifest.schemaVersion === BUILD_SCHEMA_VERSION && manifest.buildId === entry.name && Number.isFinite(manifest.sizeBytes)) builds.push(manifest)
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
  if (isPidAlive(lease.pid)) return true
  try {
    const run = JSON.parse(readFileSync(join(lease.runDir, 'run.json'), 'utf8')) as { status?: string; launcherPid?: number; hostPid?: number }
    return ACTIVE_RUN_STATUSES.has(run.status ?? '') && (isPidAlive(run.launcherPid) || isPidAlive(run.hostPid))
  } catch { return false }
}

function activeBuildLocks(buildRoot: string): Set<string> {
  const locksDir = join(buildRoot, 'locks')
  const active = new Set<string>()
  if (!existsSync(locksDir)) return active
  for (const entry of readdirSync(locksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lock')) continue
    try {
      const owner = JSON.parse(readFileSync(join(locksDir, entry.name, 'owner.json'), 'utf8')) as { pid?: number }
      if (isPidAlive(owner.pid)) active.add(entry.name.slice(0, -'.lock'.length))
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
      lease.schemaVersion !== BUILD_SCHEMA_VERSION
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
  const { buildRoot: _buildRoot, ...file } = lease
  return file
}

function runElectronBuild(repoRoot: string): void {
  runBuildCommand(repoRoot, ['run', 'pi:build'], 'Pi workspace build')
  runBuildCommand(repoRoot, ['run', 'pi:build:binary'], 'Pi binary build')
  runBuildCommand(repoRoot, ['run', 'electron:build'], 'Electron validation build')
}

function runBuildCommand(repoRoot: string, args: string[], label: string): void {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, MORTISE_UI_VALIDATION_BUILD: '1', MORTISE_UI_TEST_HOST: '1' },
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`)
}

function electronFingerprintForSource(sourceId: string): string {
  const hash = createHash('sha256')
  hash.update(`mortise-ui-build:${BUILD_SCHEMA_VERSION}\0${process.platform}\0${process.arch}\0${process.versions.bun ?? process.version}\0${sourceId}\0`)
  for (const key of BUILD_ENV_KEYS) {
    hash.update(`${key}\0`)
    hash.update(createHash('sha256').update(process.env[key] ?? '').digest())
  }
  return hash.digest('hex')
}

function directorySize(path: string): number {
  if (!existsSync(path)) return 0
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) return 0
  if (stat.isFile()) return stat.size
  return readdirSync(path).reduce((sum, name) => sum + directorySize(join(path, name)), 0)
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

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    return errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES'
  }
}

function extension(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
