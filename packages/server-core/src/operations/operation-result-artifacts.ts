import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { atomicWriteFile } from '@mortise/shared/utils'

export type OperationResultArtifactKind = 'session-export' | 'remote-transfer' | 'first-turn' | 'session-execution'

export const OPERATION_RESULT_ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60_000

function artifactError(code: string, message: string, cause?: unknown): Error & { code: string; cause?: unknown } {
  return Object.assign(new Error(message), { code, ...(cause === undefined ? {} : { cause }) })
}

export class OperationResultArtifactStore {
  constructor(
    private readonly root: string,
    private readonly maxAgeMs = OPERATION_RESULT_ARTIFACT_MAX_AGE_MS,
  ) {}

  path(operationId: string, kind: OperationResultArtifactKind): string {
    if (!/^[A-Za-z0-9._-]+$/.test(operationId)) throw new Error('Invalid operationId')
    return join(this.root, `${kind}-${operationId}.json`)
  }

  async write(operationId: string, kind: OperationResultArtifactKind, value: unknown): Promise<void> {
    await atomicWriteFile(this.path(operationId, kind), JSON.stringify(value))
  }

  async read<T>(operationId: string, kind: OperationResultArtifactKind): Promise<T> {
    const path = this.path(operationId, kind)
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw artifactError('OPERATION_RESULT_MISSING', `Operation result artifact is unavailable: ${operationId}`, error)
      }
      throw error
    }
    try {
      return JSON.parse(source) as T
    } catch (error) {
      throw artifactError('OPERATION_RESULT_CORRUPT', `Operation result artifact is corrupt: ${operationId}`, error)
    }
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }

    let removed = 0
    await Promise.all(names.map(async name => {
      if (!/^(session-export|remote-transfer|first-turn|session-execution)-[A-Za-z0-9._-]+\.json$/.test(name)) return
      const path = join(this.root, name)
      const file = await stat(path).catch(() => null)
      if (!file?.isFile() || now - file.mtimeMs < this.maxAgeMs) return
      await rm(path, { force: true })
      removed += 1
    }))
    return removed
  }
}
