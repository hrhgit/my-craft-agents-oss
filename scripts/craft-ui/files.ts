import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  ensureDir(dirname(path))
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
  renameSync(tempPath, path)
  if (mode !== undefined) {
    try { chmodSync(path, mode) } catch { /* Windows ACLs are managed by the containing user profile. */ }
  }
}
