/**
 * Shared SQLite record persistence for workspace-scoped messaging state.
 *
 * Each logical store owns one record in `state.sqlite`. Writes use the shared
 * multi-writer store so current Mortise backends retain atomic compare-and-set,
 * operation identity, schema negotiation, and disjoint-patch merging.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  createJsonPatch,
  MultiWriterStore,
  type JsonValue,
} from '@mortise/shared/storage'
import type { MessagingLogger } from './types'

export const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

export class SqliteRecordStore<T> {
  protected readonly databasePath: string
  protected readonly recordKey: string
  protected readonly log: MessagingLogger
  private recordVersion: number | null = null
  private recordValue: JsonValue | null = null

  constructor(dirPath: string, recordKey: string, log: MessagingLogger = NOOP_LOGGER) {
    this.databasePath = join(dirPath, 'state.sqlite')
    this.recordKey = recordKey
    this.log = log
  }

  /** Load the current SQLite record, or `null` when it has not been created. */
  protected loadRecord(): T | null {
    if (!existsSync(this.databasePath)) return null
    try {
      const store = this.openStore()
      try {
        const record = store.getRecord('messaging', this.recordKey)
        if (!record) return null
        this.recordVersion = record.version
        this.recordValue = cloneJson(record.value)
        return cloneJson(record.value) as unknown as T
      } finally {
        store.close()
      }
    } catch (err) {
      this.log.error('failed to load messaging record', {
        event: 'messaging_record_load_failed',
        databasePath: this.databasePath,
        recordKey: this.recordKey,
        error: err,
      })
      return null
    }
  }

  /**
   * Atomically persist a current messaging record.
   *
   * Returns `false` after a logged storage error or conflicting mutation so
   * callers can avoid publishing a change notification that did not persist.
   */
  protected saveRecord(data: T): boolean {
    try {
      const dirPath = dirname(this.databasePath)
      if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true })

      const next = toJsonValue(data)
      const store = this.openStore()
      try {
        const result = this.recordVersion === null || this.recordValue === null
          ? store.mutateRecord({
              namespace: 'messaging',
              key: this.recordKey,
              value: next,
              expectedVersion: null,
              operationId: `create-${this.recordKey}-${randomUUID()}`,
            })
          : (() => {
              const operations = createJsonPatch(this.recordValue!, next)
              if (operations.length === 0) return null
              return store.mutateRecordPatch({
                namespace: 'messaging',
                key: this.recordKey,
                operations,
                expectedVersion: this.recordVersion,
                operationId: `patch-${this.recordKey}-${randomUUID()}`,
              })
            })()

        if (result === null) return true
        if (result.status !== 'applied') {
          this.log.error('messaging record write conflict', {
            event: 'messaging_record_write_conflict',
            databasePath: this.databasePath,
            recordKey: this.recordKey,
            currentVersion: result.currentVersion,
          })
          return false
        }
        this.recordVersion = result.version
        this.recordValue = cloneJson(result.value)
      } finally {
        store.close()
      }
      return true
    } catch (err) {
      this.log.error('failed to save messaging record', {
        event: 'messaging_record_save_failed',
        databasePath: this.databasePath,
        recordKey: this.recordKey,
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
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function cloneJson(value: JsonValue): JsonValue {
  return toJsonValue(value)
}
