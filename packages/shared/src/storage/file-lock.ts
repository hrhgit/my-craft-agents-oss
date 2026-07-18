import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'

const LOCK_OPTIONS = {
  realpath: false,
  stale: 120_000,
  update: 10_000,
  retries: {
    retries: 120,
    factor: 1,
    minTimeout: 25,
    maxTimeout: 100,
  },
} as const

const SYNC_LOCK_OPTIONS = {
  realpath: false,
  stale: 120_000,
  update: 10_000,
} as const

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

export async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(filePath), { recursive: true })
  const release = await lockfile.lock(filePath, LOCK_OPTIONS)
  try {
    return await operation()
  } finally {
    await release()
  }
}

export function withFileLockSync<T>(filePath: string, operation: () => T): T {
  mkdirSync(dirname(filePath), { recursive: true })
  let release: (() => void) | null = null
  let lastError: unknown
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      release = lockfile.lockSync(filePath, SYNC_LOCK_OPTIONS)
      break
    } catch (error) {
      lastError = error
      if (!isLockConflict(error)) throw error
      Atomics.wait(sleepBuffer, 0, 0, 25)
    }
  }
  if (!release) throw lastError ?? new Error(`Failed to lock ${filePath}`)
  try {
    return operation()
  } finally {
    release()
  }
}

function isLockConflict(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && String((error as { code?: unknown }).code) === 'ELOCKED'
}
