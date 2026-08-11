import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  artifactInventoriesEqual,
  artifactInventorySize,
  collectArtifactInventory,
  type ElectronBuildArtifact,
} from './electron-build-cache.ts'
import { withFileLock } from './file-lock.ts'
import { writeJsonAtomic } from './files.ts'
import { getProcessStartTime, matchesProcessIdentity } from './process-identity.ts'

export const DEVELOPER_KIT_BUILD_SCHEMA_VERSION = 4

export interface DeveloperKitBuildManifest {
  schemaVersion: typeof DEVELOPER_KIT_BUILD_SCHEMA_VERSION
  buildId: string
  sourceId: string
  bunExecutableSha256: string
  archiveDisabled: boolean
  createdAt: string
  artifactDirectory: string
  archivePath?: string
  sizeBytes: number
  artifacts: ElectronBuildArtifact[]
  platform: NodeJS.Platform
  arch: string
  immutable: true
}

interface DeveloperKitBuildLease {
  schemaVersion: 1
  token: string
  runId: string
  buildId: string
  pid: number
  processStartedAt?: number
  createdAt: string
  path: string
  buildRoot: string
}

interface DeveloperKitStagingOwner {
  schemaVersion: 1
  pid: number
  processStartedAt?: number
  recordedAt: number
}

const DEVELOPER_KIT_STAGING_OWNER = 'staging-owner.json'

export function writeDeveloperKitStagingOwner(stagingDir: string): void {
  writeJsonAtomic(join(stagingDir, DEVELOPER_KIT_STAGING_OWNER), {
    schemaVersion: 1,
    pid: process.pid,
    processStartedAt: getProcessStartTime(process.pid),
    recordedAt: Date.now(),
  } satisfies DeveloperKitStagingOwner, 0o600)
}

export function cleanupDeveloperKitBuildCacheLocked(
  buildRootValue: string,
  protectedBuildIds: Set<string>,
  options: { retainCount?: number; staleMs?: number; nowMs?: number } = {},
): { removed: string[]; retained: string[] } {
  const buildRoot = resolve(buildRootValue)
  const buildsDir = join(buildRoot, 'builds')
  mkdirSync(buildsDir, { recursive: true })
  const retainCount = Number.isSafeInteger(options.retainCount) && options.retainCount! >= 0
    ? options.retainCount!
    : 2
  const staleBefore = (options.nowMs ?? Date.now()) - (options.staleMs ?? 60 * 60 * 1_000)
  const removed: string[] = []
  const builds: DeveloperKitBuildManifest[] = []

  for (const entry of readdirSync(buildsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(buildsDir, entry.name)
    if (entry.name.startsWith('.staging-')) {
      if (isActiveDeveloperKitStaging(path) || statSync(path).mtimeMs >= staleBefore) continue
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      removed.push(entry.name)
      continue
    }
    const manifest = readValidDeveloperKitBuildManifest(path, entry.name)
    if (manifest) {
      builds.push(manifest)
    } else if (!protectedBuildIds.has(entry.name)) {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      removed.push(entry.name)
    }
  }

  const keep = new Set(protectedBuildIds)
  for (const build of builds.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (keep.size >= Math.max(1, retainCount)) break
    keep.add(build.buildId)
  }
  for (const build of builds) {
    if (keep.has(build.buildId)) continue
    rmSync(join(buildsDir, build.buildId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    removed.push(build.buildId)
  }
  return {
    removed,
    retained: readdirSync(buildsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort(),
  }
}

function isActiveDeveloperKitStaging(stagingDir: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(stagingDir, DEVELOPER_KIT_STAGING_OWNER), 'utf8')) as Partial<DeveloperKitStagingOwner>
    return owner.schemaVersion === 1 && matchesProcessIdentity({
      pid: owner.pid,
      startedAt: owner.processStartedAt,
      recordedAt: owner.recordedAt,
    })
  } catch { return false }
}

export function computeDeveloperKitBuildId(
  sourceId: string,
  archiveDisabled: boolean,
  bunExecutableSha256: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (!/^[0-9a-f]{64}$/.test(bunExecutableSha256)) {
    throw new Error('Developer Kit build identity requires a canonical Bun executable SHA-256.')
  }
  const hash = createHash('sha256')
  hash.update(`mortise-developer-kit:${DEVELOPER_KIT_BUILD_SCHEMA_VERSION}\0${sourceId}\0${platform}\0${arch}\0${process.versions.bun ?? process.version}\0${bunExecutableSha256}\0${archiveDisabled}\0`)
  return hash.digest('hex')
}

export function readValidDeveloperKitBuildManifest(
  buildDir: string,
  buildId: string,
  verification: 'full' | 'fast' = 'full',
): DeveloperKitBuildManifest | undefined {
  try {
    const value = JSON.parse(readFileSync(join(buildDir, 'build.json'), 'utf8')) as DeveloperKitBuildManifest
    const artifactsRoot = join(buildDir, 'artifacts')
    if (
      value.schemaVersion !== DEVELOPER_KIT_BUILD_SCHEMA_VERSION
      || value.buildId !== buildId
      || !/^[0-9a-f]{64}$/.test(value.sourceId)
      || !/^[0-9a-f]{64}$/.test(value.bunExecutableSha256)
      || typeof value.archiveDisabled !== 'boolean'
      || computeDeveloperKitBuildId(value.sourceId, value.archiveDisabled, value.bunExecutableSha256) !== buildId
      || value.platform !== process.platform
      || value.arch !== process.arch
      || value.immutable !== true
      || !existsSync(value.artifactDirectory)
      || resolve(dirname(value.artifactDirectory)) !== resolve(artifactsRoot)
      || (value.archiveDisabled
        ? value.archivePath !== undefined
        : typeof value.archivePath !== 'string'
          || !existsSync(value.archivePath)
          || resolve(dirname(value.archivePath)) !== resolve(artifactsRoot))
      || !Array.isArray(value.artifacts)
      || value.sizeBytes !== artifactInventorySize(value.artifacts)
      || (verification === 'full'
        ? !artifactInventoriesEqual(value.artifacts, collectArtifactInventory(artifactsRoot))
        : !value.artifacts.every(artifact => {
            const path = join(artifactsRoot, ...artifact.path.split('/'))
            return existsSync(path) && statSync(path).isFile() && statSync(path).size === artifact.sizeBytes
          }))
    ) return undefined
    return value
  } catch { return undefined }
}

export function acquireDeveloperKitBuildLease(
  buildRootValue: string,
  buildId: string,
  runId: string,
): DeveloperKitBuildLease {
  const buildRoot = resolve(buildRootValue)
  const leasesRoot = join(buildRoot, 'leases')
  mkdirSync(leasesRoot, { recursive: true })
  return withFileLock(join(buildRoot, 'coordinator'), () => {
    activeDeveloperKitBuildIdsLocked(buildRoot)
    const token = randomUUID()
    const lease: DeveloperKitBuildLease = {
      schemaVersion: 1,
      token,
      runId,
      buildId,
      pid: process.pid,
      processStartedAt: getProcessStartTime(process.pid),
      createdAt: new Date().toISOString(),
      path: join(leasesRoot, `${token}.json`),
      buildRoot,
    }
    writeJsonAtomic(lease.path, lease, 0o600)
    return lease
  })
}

export function releaseDeveloperKitBuildLease(lease: DeveloperKitBuildLease): void {
  withFileLock(join(lease.buildRoot, 'coordinator'), () => {
    let current: Partial<DeveloperKitBuildLease> | undefined
    try {
      current = JSON.parse(readFileSync(lease.path, 'utf8')) as Partial<DeveloperKitBuildLease>
    } catch { /* already absent */ }
    if (current?.token === lease.token) rmSync(lease.path, { force: true })
    activeDeveloperKitBuildIdsLocked(lease.buildRoot)
  })
}

export function activeDeveloperKitBuildIdsLocked(buildRootValue: string): Set<string> {
  const buildRoot = resolve(buildRootValue)
  const leasesRoot = join(buildRoot, 'leases')
  mkdirSync(leasesRoot, { recursive: true })
  const active = new Set<string>()
  for (const entry of readdirSync(leasesRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const leasePath = join(leasesRoot, entry.name)
    let lease: Partial<DeveloperKitBuildLease>
    try {
      lease = JSON.parse(readFileSync(leasePath, 'utf8')) as Partial<DeveloperKitBuildLease>
    } catch {
      rmSync(leasePath, { force: true })
      continue
    }
    const valid = lease.schemaVersion === 1
      && typeof lease.token === 'string'
      && typeof lease.runId === 'string'
      && typeof lease.buildId === 'string'
      && /^[0-9a-f]{64}$/.test(lease.buildId)
      && matchesProcessIdentity({
        pid: lease.pid,
        startedAt: lease.processStartedAt,
        recordedAt: typeof lease.createdAt === 'string' ? Date.parse(lease.createdAt) : undefined,
      })
    if (!valid) {
      rmSync(leasePath, { force: true })
      continue
    }
    active.add(lease.buildId!)
  }
  return active
}
