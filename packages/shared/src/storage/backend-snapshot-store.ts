import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../utils/files.ts'
import { withFileLock } from './file-lock.ts'
import type { BackendType } from '../protocol/capabilities.ts'

export type BackendSnapshotKey =
  | {
      kind: 'layout'
      workspaceId: string
      backendType: BackendType
    }
  | {
      kind: 'extension-state'
      workspaceId: string
      backendType: BackendType
      extensionId: string
    }

export type SnapshotValidator<T> = (value: unknown) => value is T

/**
 * Complete JSON snapshots shared only as a startup baseline by backends of the
 * same type. Domain owners remain responsible for schemas and migrations.
 */
export class BackendSnapshotStore {
  constructor(readonly rootDirectory: string) {}

  resolvePath(key: BackendSnapshotKey): string {
    const workspace = stablePathSegment(key.workspaceId)
    if (key.kind === 'layout') {
      return join(this.rootDirectory, 'layout', key.backendType, `${workspace}.json`)
    }
    return join(
      this.rootDirectory,
      'extension-state',
      key.backendType,
      workspace,
      `${stablePathSegment(key.extensionId)}.json`,
    )
  }

  read<T>(key: BackendSnapshotKey, validate: SnapshotValidator<T>): T | null {
    const path = this.resolvePath(key)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) return null
      throw error
    }
    return validate(parsed) ? parsed : null
  }

  async write<T>(
    key: BackendSnapshotKey,
    snapshot: T,
    validate: SnapshotValidator<T>,
  ): Promise<void> {
    if (!validate(snapshot)) {
      throw new Error(`Invalid complete ${key.kind} snapshot`)
    }
    const path = this.resolvePath(key)
    const contents = `${JSON.stringify(snapshot, null, 2)}\n`
    await withFileLock(path, () => atomicWriteFile(path, contents))
  }
}

function stablePathSegment(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('Snapshot identity must not be empty')
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(normalized)) return normalized
  return `id-${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && String((error as { code?: unknown }).code) === 'ENOENT'
}
