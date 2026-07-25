import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isProcessAlive, matchesProcessIdentity } from './process-identity.ts'

const FILE_LOCK_TIMEOUT_MS = 30_000
const FILE_LOCK_STALE_MS = 30_000
const FILE_LOCK_REAP_PROBE_INTERVAL_MS = 250
const FILE_LOCK_OWNER_FILE = 'owner.json'
const FILE_LOCK_REAPER_DIR = '.reaping'

interface FileLockOwner {
  token: string
  pid: number
  recordedAt?: number
}

interface FileLock {
  path: string
  owner: FileLockOwner
}

export interface FileLockOptions {
  timeoutMs?: number
  staleMs?: number
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function lockOwnerPath(lockPath: string): string {
  return join(lockPath, FILE_LOCK_OWNER_FILE)
}

function readLockOwner(lockPath: string): FileLockOwner | null {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const value = JSON.parse(readFileSync(lockOwnerPath(lockPath), 'utf8')) as Partial<FileLockOwner>
      return typeof value.token === 'string' && Number.isInteger(value.pid) && value.pid! > 0
        ? { token: value.token, pid: value.pid!, ...(typeof value.recordedAt === 'number' ? { recordedAt: value.recordedAt } : {}) }
        : null
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError) return null
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '')) throw error
      if (attempt < 8) sleepSync(Math.min(40, 2 ** attempt))
    }
  }
  return null
}

function removeWithRetry(path: string, remove: (path: string) => void): void {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
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

function renameWithRetry(source: string, destination: string): boolean {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      renameSync(source, destination)
      return true
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '') || attempt === 8) throw error
      sleepSync(Math.min(80, 5 * 2 ** (attempt - 1)))
    }
  }
  return false
}

function releaseFileLock(lock: FileLock): void {
  const current = readLockOwner(lock.path)
  if (!current || current.token !== lock.owner.token) return
  const releasedPath = `${lock.path}.released-${lock.owner.token}`
  if (!renameWithRetry(lock.path, releasedPath)) return
  removeWithRetry(lockOwnerPath(releasedPath), unlinkSync)
  removeWithRetry(join(releasedPath, FILE_LOCK_REAPER_DIR), rmdirSync)
  removeWithRetry(releasedPath, rmdirSync)
}

function tryReapStaleLock(lockPath: string, staleMs: number): boolean {
  const observedOwner = readLockOwner(lockPath)
  const observedMtime = statSync(lockPath).mtimeMs
  if (observedOwner) {
    if (isProcessAlive(observedOwner.pid)) {
      if (observedMtime >= Date.now() - staleMs) return false
      if (matchesProcessIdentity({ pid: observedOwner.pid, recordedAt: observedOwner.recordedAt ?? observedMtime })) return false
    }
  } else if (observedMtime >= Date.now() - staleMs) return false

  const reaperPath = join(lockPath, FILE_LOCK_REAPER_DIR)
  try {
    mkdirSync(reaperPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    if (errorCode(error) === 'EEXIST') return false
    throw error
  }

  try {
    const currentOwner = readLockOwner(lockPath)
    if (currentOwner && matchesProcessIdentity({ pid: currentOwner.pid, recordedAt: currentOwner.recordedAt ?? observedMtime })) return false
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

function acquireFileLock(path: string, options: FileLockOptions = {}): FileLock {
  const lockPath = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const timeoutMs = options.timeoutMs ?? FILE_LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? FILE_LOCK_STALE_MS
  const deadline = Date.now() + timeoutMs
  let nextReapProbeAt = 0

  while (true) {
    try {
      mkdirSync(lockPath)
      const owner = { token: randomUUID(), pid: process.pid, recordedAt: Date.now() }
      try {
        writeFileSync(lockOwnerPath(lockPath), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } catch (error) {
        removeWithRetry(lockOwnerPath(lockPath), unlinkSync)
        removeWithRetry(lockPath, rmdirSync)
        if (errorCode(error) === 'ENOENT') continue
        throw error
      }

      const reaperPath = join(lockPath, FILE_LOCK_REAPER_DIR)
      while (existsSync(reaperPath) && Date.now() < deadline) sleepSync(5)
      if (readLockOwner(lockPath)?.token === owner.token && !existsSync(reaperPath)) return { path: lockPath, owner }
      continue
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }

    const now = Date.now()
    if (now >= nextReapProbeAt) {
      try {
        if (tryReapStaleLock(lockPath, staleMs)) {
          nextReapProbeAt = 0
          continue
        }
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          nextReapProbeAt = 0
          continue
        }
        throw error
      }
      nextReapProbeAt = now + FILE_LOCK_REAP_PROBE_INTERVAL_MS
    }

    if (now >= deadline) {
      throw Object.assign(new Error(`Timed out waiting for file lock: ${path}`), { code: 'ELOCKED' })
    }
    sleepSync(10)
  }
}

export function withFileLock<T>(path: string, update: () => T, options: FileLockOptions = {}): T {
  const lock = acquireFileLock(path, options)
  try {
    return update()
  } finally {
    releaseFileLock(lock)
  }
}
