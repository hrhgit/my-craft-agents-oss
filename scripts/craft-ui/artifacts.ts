import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { CRAFT_UI_PROTOCOL_VERSION, type CraftUiArtifact, type CraftUiArtifactManifest } from './protocol.ts'
import { writeJsonAtomic } from './files.ts'
import { redactValue } from './redaction.ts'

const MANIFEST_LOCK_TIMEOUT_MS = 10_000
const MANIFEST_LOCK_STALE_MS = 30_000
const MANIFEST_LOCK_OWNER_FILE = 'owner.json'
const MANIFEST_LOCK_REAPER_DIR = '.reaping'

interface ManifestLockOwner {
  token: string
  pid: number
}

interface ManifestLock {
  path: string
  owner: ManifestLockOwner
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function lockOwnerPath(lockPath: string): string {
  return join(lockPath, MANIFEST_LOCK_OWNER_FILE)
}

function readLockOwner(lockPath: string): ManifestLockOwner | null {
  try {
    const value = JSON.parse(readFileSync(lockOwnerPath(lockPath), 'utf8')) as Partial<ManifestLockOwner>
    return typeof value.token === 'string' && Number.isInteger(value.pid) && value.pid! > 0
      ? { token: value.token, pid: value.pid! }
      : null
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES'
  }
}

function removeWithRetry(path: string, remove: (path: string) => void): void {
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      remove(path)
      return
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(errorCode(error) ?? '') || attempt === 8) throw error
      sleepSync(Math.min(80, 5 * 2 ** (attempt - 1)))
    }
  }
}

function releaseManifestLock(lock: ManifestLock): void {
  const current = readLockOwner(lock.path)
  if (!current || current.token !== lock.owner.token) return
  removeWithRetry(lockOwnerPath(lock.path), unlinkSync)
  removeWithRetry(lock.path, rmdirSync)
}

function tryReapStaleLock(lockPath: string): boolean {
  const observedOwner = readLockOwner(lockPath)
  if (observedOwner && isProcessAlive(observedOwner.pid)) return false
  if (!observedOwner && statSync(lockPath).mtimeMs >= Date.now() - MANIFEST_LOCK_STALE_MS) return false

  const reaperPath = join(lockPath, MANIFEST_LOCK_REAPER_DIR)
  try {
    mkdirSync(reaperPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }

  try {
    const currentOwner = readLockOwner(lockPath)
    if (currentOwner && isProcessAlive(currentOwner.pid)) return false
    if (currentOwner?.token !== observedOwner?.token) return false
    removeWithRetry(lockOwnerPath(lockPath), unlinkSync)
    removeWithRetry(reaperPath, rmdirSync)
    removeWithRetry(lockPath, rmdirSync)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    throw error
  } finally {
    removeWithRetry(reaperPath, rmdirSync)
  }
}

function acquireManifestLock(manifestPath: string): ManifestLock {
  const lockPath = `${manifestPath}.lock`
  mkdirSync(dirname(manifestPath), { recursive: true })
  const deadline = Date.now() + MANIFEST_LOCK_TIMEOUT_MS

  while (true) {
    try {
      mkdirSync(lockPath)
      const owner = { token: randomUUID(), pid: process.pid }
      try {
        writeFileSync(lockOwnerPath(lockPath), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } catch (error) {
        removeWithRetry(lockOwnerPath(lockPath), unlinkSync)
        removeWithRetry(lockPath, rmdirSync)
        if (errorCode(error) === 'ENOENT') continue
        throw error
      }

      const reaperPath = join(lockPath, MANIFEST_LOCK_REAPER_DIR)
      while (existsSync(reaperPath) && Date.now() < deadline) sleepSync(5)
      if (readLockOwner(lockPath)?.token === owner.token && !existsSync(reaperPath)) {
        return { path: lockPath, owner }
      }
      continue
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }

    try {
      if (tryReapStaleLock(lockPath)) continue
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }

    if (Date.now() >= deadline) {
      throw Object.assign(new Error(`Timed out waiting for artifact manifest lock: ${manifestPath}`), {
        code: 'ELOCKED',
      })
    }
    sleepSync(10)
  }
}

function withManifestLock<T>(manifestPath: string, update: () => T): T {
  const lock = acquireManifestLock(manifestPath)
  try {
    return update()
  } finally {
    releaseManifestLock(lock)
  }
}

export function readArtifactManifest(path: string, runId: string): CraftUiArtifactManifest {
  if (!existsSync(path)) {
    return { protocolVersion: CRAFT_UI_PROTOCOL_VERSION, runId, updatedAt: new Date().toISOString(), artifacts: [] }
  }
  return JSON.parse(readFileSync(path, 'utf8')) as CraftUiArtifactManifest
}

export function recordArtifact(args: {
  manifestPath: string
  runId: string
  artifactsDir: string
  artifact: Omit<CraftUiArtifact, 'id' | 'createdAt' | 'path'> & { path: string }
  secrets?: readonly string[]
}): CraftUiArtifact {
  const absolutePath = resolve(args.artifact.path)
  const artifactsRoot = resolve(args.artifactsDir)
  if (absolutePath !== artifactsRoot && !absolutePath.startsWith(`${artifactsRoot}\\`) && !absolutePath.startsWith(`${artifactsRoot}/`)) {
    throw new Error('Artifact path must stay inside the run artifacts directory')
  }
  const artifact = redactValue({
    ...args.artifact,
    id: randomUUID(),
    path: absolutePath,
    createdAt: new Date().toISOString(),
  }, args.secrets) as CraftUiArtifact
  withManifestLock(args.manifestPath, () => {
    const manifest = readArtifactManifest(args.manifestPath, args.runId)
    manifest.updatedAt = new Date().toISOString()
    manifest.artifacts = manifest.artifacts.filter(item => item.path !== artifact.path)
    manifest.artifacts.push(artifact)
    writeJsonAtomic(args.manifestPath, manifest)
  })
  return artifact
}
