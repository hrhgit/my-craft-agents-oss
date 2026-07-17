import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

const ATOMIC_RENAME_ATTEMPTS = 8

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

function renameWithRetry(source: string, target: string): void {
  for (let attempt = 1; attempt <= ATOMIC_RENAME_ATTEMPTS; attempt++) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      if (!isTransientRenameError(error) || attempt === ATOMIC_RENAME_ATTEMPTS) throw error
      sleepSync(Math.min(80, 5 * 2 ** (attempt - 1)))
    }
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  ensureDir(dirname(path))
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  let renamed = false
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode, flag: 'wx' })
    renameWithRetry(tempPath, path)
    renamed = true
    if (mode !== undefined) {
      try { chmodSync(path, mode) } catch { /* Windows ACLs are managed by the containing user profile. */ }
    }
  } finally {
    if (!renamed) {
      try { unlinkSync(tempPath) } catch { /* The write or rename may have failed before the temp file existed. */ }
    }
  }
}
