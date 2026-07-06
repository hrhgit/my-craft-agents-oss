/**
 * Generic JSON file store with load/save/migrate-legacy functionality.
 *
 * Eliminates duplicated boilerplate across binding-store, config-store,
 * pending-senders, and topic-registry. Subclasses inherit the raw file
 * I/O (parse / atomic write / one-shot legacy copy) and keep their own
 * business logic (validation, normalisation, change listeners, etc.).
 *
 * Writes go through `atomicWriteFileSync` (tmp + rename) so a crash mid-write
 * leaves the previous file intact instead of a truncated one.
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { atomicWriteFileSync } from '@craft-agent/shared/utils'
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

  constructor(dirPath: string, fileName: string, log: MessagingLogger = NOOP_LOGGER) {
    this.dirPath = dirPath
    this.filePath = join(dirPath, fileName)
    this.log = log
  }

  /**
   * Load and parse the JSON file. Returns `null` if the file doesn't exist
   * or can't be parsed — subclasses decide how to turn that into a default.
   */
  protected loadFile(): T | null {
    if (!existsSync(this.filePath)) return null
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as T
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
      atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2))
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

  /**
   * One-shot migration: if `legacyDir` exists and contains a file named
   * `legacyFileName` (defaults to the same basename as `filePath`), and
   * the current `filePath` does NOT exist, copy the legacy file forward.
   *
   * Safe to call on every construction — it's a no-op once the new file
   * exists or if the legacy file is absent.
   */
  protected migrateLegacy(legacyDir: string | undefined, legacyFileName?: string): void {
    if (!legacyDir) return
    if (existsSync(this.filePath)) return
    const legacyFile = join(legacyDir, legacyFileName ?? basename(this.filePath))
    if (!existsSync(legacyFile)) return
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true })
      }
      copyFileSync(legacyFile, this.filePath)
      this.log.info('json store migrated from legacy location', {
        event: 'json_store_migrated',
        legacyFile,
        filePath: this.filePath,
      })
    } catch (err) {
      this.log.error('json store migration failed', {
        event: 'json_store_migration_failed',
        legacyFile,
        filePath: this.filePath,
        error: err,
      })
    }
  }
}
