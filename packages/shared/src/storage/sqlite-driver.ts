import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

export type SqliteValue = string | number | bigint | Uint8Array | null

export interface SqliteRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface CraftSqliteStatement {
  run(...params: SqliteValue[]): SqliteRunResult
  get<T extends object>(...params: SqliteValue[]): T | undefined
  all<T extends object>(...params: SqliteValue[]): T[]
}

export interface CraftSqliteDatabase {
  readonly runtime: 'bun' | 'node'
  exec(sql: string): void
  prepare(sql: string): CraftSqliteStatement
  close(): void
}

type NativeDatabase = {
  exec(sql: string): void
  prepare(sql: string): NativeStatement
  close(): void
}

interface NativeStatement {
  run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: SqliteValue[]): object | null | undefined
  all(...params: SqliteValue[]): object[]
  finalize?(): void
}

function wrapStatement(statement: NativeStatement): CraftSqliteStatement {
  return {
    run(...params) {
      try {
        const result = statement.run(...params)
        return {
          changes: Number(result.changes),
          lastInsertRowid: result.lastInsertRowid,
        }
      } finally {
        statement.finalize?.()
      }
    },
    get<T extends object>(...params: SqliteValue[]) {
      try {
        return (statement.get(...params) ?? undefined) as T | undefined
      } finally {
        statement.finalize?.()
      }
    },
    all<T extends object>(...params: SqliteValue[]) {
      try {
        return statement.all(...params) as T[]
      } finally {
        statement.finalize?.()
      }
    },
  }
}

function isBunRuntime(): boolean {
  return typeof (process.versions as Record<string, string | undefined>).bun === 'string'
}

function openCraftSqliteDatabaseNative(
  databasePath: string,
  options: { busyTimeoutMs?: number } = {},
): CraftSqliteDatabase {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true })
  }

  // Use a filesystem anchor that survives the Electron CJS bundle. Using
  // import.meta.url here becomes `undefined` in the packaged main process.
  const require = createRequire(`${process.cwd()}/package.json`)
  let native: NativeDatabase
  let runtime: 'bun' | 'node'
  if (isBunRuntime()) {
    const { Database } = require('bun:sqlite') as {
      Database: new (path: string, options: { create: boolean; readwrite: boolean; strict: boolean }) => NativeDatabase
    }
    native = new Database(databasePath, { create: true, readwrite: true, strict: true })
    runtime = 'bun'
  } else {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => NativeDatabase
    }
    native = new DatabaseSync(databasePath)
    runtime = 'node'
  }

  const database: CraftSqliteDatabase = {
    runtime,
    exec(sql) {
      native.exec(sql)
    },
    prepare(sql) {
      return wrapStatement(native.prepare(sql))
    },
    close() {
      native.close()
    },
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? 30_000
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    database.close()
    throw new TypeError(`busyTimeoutMs must be a non-negative safe integer, received ${busyTimeoutMs}`)
  }

  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  database.exec('PRAGMA foreign_keys = ON')
  if (databasePath !== ':memory:') {
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA synchronous = NORMAL')
  }

  return database
}

/** Open the runtime-native SQLite adapter without introducing an async boundary. */
export function openCraftSqliteDatabaseSync(
  databasePath: string,
  options: { busyTimeoutMs?: number } = {},
): CraftSqliteDatabase {
  return openCraftSqliteDatabaseNative(databasePath, options)
}

export async function openCraftSqliteDatabase(
  databasePath: string,
  options: { busyTimeoutMs?: number } = {},
): Promise<CraftSqliteDatabase> {
  return openCraftSqliteDatabaseNative(databasePath, options)
}
