/**
 * Generic JSON file store with load/save functionality.
 *
 * Eliminates duplicated boilerplate across binding-store, config-store,
 * pending-senders, and topic-registry. Subclasses inherit the raw file
 * I/O (parse / atomic write) and keep their own
 * business logic (validation, normalisation, change listeners, etc.).
 *
 * Writes go through `atomicWriteFileSync` (tmp + rename) so a crash mid-write
 * leaves the previous file intact instead of a truncated one.
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { atomicWriteFileSync } from '@craft-agent/shared/utils'
import {
  createJsonPatch,
  MultiWriterStore,
  type JsonValue,
} from '@craft-agent/shared/storage'
import type { MessagingLogger } from './types'

/**
 * Default no-op logger used when a caller doesn't supply one.
 * Subclass constructors still accept an explicit logger override.
 */
export const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

export class JsonFileStore<T> {
  protected readonly dirPath: string
  protected readonly filePath: string
  protected readonly log: MessagingLogger
  private readonly databasePath: string
  private readonly recordKey: string
  private readonly syncBaselinePath: string
  private recordVersion: number | null = null
  private recordValue: JsonValue | null = null

  constructor(dirPath: string, fileName: string, log: MessagingLogger = NOOP_LOGGER) {
    this.dirPath = dirPath
    this.filePath = join(dirPath, fileName)
    this.log = log
    this.databasePath = join(dirPath, 'state.sqlite')
    this.recordKey = fileName
    this.syncBaselinePath = `${this.filePath}.sync`
  }

  /**
   * Load and parse the JSON file. Returns `null` if the file doesn't exist
   * or can't be parsed — subclasses decide how to turn that into a default.
   */
  protected loadFile(): T | null {
    if (!existsSync(this.filePath) && !existsSync(this.databasePath)) return null
    try {
      if (!existsSync(this.dirPath)) mkdirSync(this.dirPath, { recursive: true })
      const store = this.openStore()
      try {
        let record = store.getRecord('messaging-json', this.recordKey)
        if (!record) {
          if (!existsSync(this.filePath)) return null
          const imported = JSON.parse(readFileSync(this.filePath, 'utf-8')) as T
          const importedJson = toJsonValue(imported)
          const result = store.mutateRecord({
            namespace: 'messaging-json',
            key: this.recordKey,
            value: importedJson,
            expectedVersion: null,
            operationId: `import-${this.recordKey}-${jsonHash(importedJson)}`,
          })
          if (result.status !== 'applied') return null
          record = {
            namespace: 'messaging-json',
            key: this.recordKey,
            version: result.version,
            value: result.value,
            updatedAt: Date.now(),
            writerId: 'import',
          }
        } else if (existsSync(this.filePath) && existsSync(this.syncBaselinePath)) {
          try {
            const fileJson = toJsonValue(JSON.parse(readFileSync(this.filePath, 'utf-8')))
            const baselineJson = toJsonValue(JSON.parse(readFileSync(this.syncBaselinePath, 'utf-8')))
            if (jsonHash(fileJson) !== jsonHash(baselineJson)) {
              const operations = createJsonPatch(baselineJson, fileJson)
              if (operations.length > 0) {
                const imported = store.mutateRecordPatch({
                  namespace: 'messaging-json',
                  key: this.recordKey,
                  operations,
                  expectedVersion: record.version,
                  operationId: `legacy-${this.recordKey}-${jsonHash(fileJson)}`,
                })
                if (imported.status === 'applied') {
                  record = { ...record, version: imported.version, value: imported.value }
                }
              }
            }
          } catch {
            // Preserve the SQLite authority when a compatibility file is corrupt.
          }
        }

        this.recordVersion = record.version
        this.recordValue = cloneJson(record.value)
        this.materialize(record.value)
        return cloneJson(record.value) as unknown as T
      } finally {
        store.close()
      }
    } catch (err) {
      this.log.error('failed to load json store', {
        event: 'json_store_load_failed',
        filePath: this.filePath,
        error: err,
      })
      return null
    }
  }

  /**
   * Atomically write `data` as JSON to the file. Creates the directory
   * tree on first write. Swallows errors after logging — persistence is
   * best-effort for these stores, the in-memory state stays authoritative.
   *
   * @returns `true` if the write succeeded, `false` if it failed (error
   *   already logged). Callers that fire change listeners should only fire
   *   on success — otherwise the UI shows state that will disappear on
   *   restart.
   */
  protected saveFile(data: T): boolean {
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true })
      }
      const next = toJsonValue(data)
      const store = this.openStore()
      try {
        const result = this.recordVersion === null || this.recordValue === null
          ? store.mutateRecord({
              namespace: 'messaging-json',
              key: this.recordKey,
              value: next,
              expectedVersion: null,
              operationId: `create-${this.recordKey}-${randomUUID()}`,
            })
          : (() => {
              const operations = createJsonPatch(this.recordValue!, next)
              if (operations.length === 0) return null
              return store.mutateRecordPatch({
                namespace: 'messaging-json',
                key: this.recordKey,
                operations,
                expectedVersion: this.recordVersion,
                operationId: `patch-${this.recordKey}-${randomUUID()}`,
              })
            })()
        if (result === null) return true
        if (result.status !== 'applied') {
          this.log.error('json store write conflict', {
            event: 'json_store_write_conflict',
            filePath: this.filePath,
            currentVersion: result.currentVersion,
          })
          return false
        }
        this.recordVersion = result.version
        this.recordValue = cloneJson(result.value)
        this.materialize(result.value)
      } finally {
        store.close()
      }
      return true
    } catch (err) {
      this.log.error('failed to save json store', {
        event: 'json_store_save_failed',
        filePath: this.filePath,
        error: err,
      })
      return false
    }
  }

  private openStore(): MultiWriterStore {
    return MultiWriterStore.openSync({
      databasePath: this.databasePath,
      writerId: `messaging-${process.pid}-${randomUUID()}`,
      writerVersion: 1,
    })
  }

  private materialize(value: JsonValue): void {
    atomicWriteFileSync(this.filePath, JSON.stringify(value, null, 2))
    atomicWriteFileSync(this.syncBaselinePath, JSON.stringify(value))
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function cloneJson(value: JsonValue): JsonValue {
  return toJsonValue(value)
}

function jsonHash(value: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
