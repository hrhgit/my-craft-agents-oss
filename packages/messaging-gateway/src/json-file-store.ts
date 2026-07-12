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
import { join } from 'node:path'
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
}
