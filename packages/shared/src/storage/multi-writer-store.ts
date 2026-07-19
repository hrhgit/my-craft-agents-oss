import { createHash } from 'node:crypto'
import type { MortiseSqliteDatabase } from './sqlite-driver.ts'
import { openCraftSqliteDatabase, openCraftSqliteDatabaseSync } from './sqlite-driver.ts'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface CapabilityRange {
  minWriteVersion: number
  maxWriteVersion: number
}

export interface MultiWriterStoreOptions {
  databasePath: string
  writerId: string
  writerVersion: number
  capabilities?: Record<string, CapabilityRange>
  busyTimeoutMs?: number
}

export interface StoredRecord<T extends JsonValue = JsonValue> {
  namespace: string
  key: string
  version: number
  value: T
  updatedAt: number
  writerId: string
}

export interface RecordMutation<T extends JsonValue = JsonValue> {
  namespace: string
  key: string
  value: T
  expectedVersion: number | null
  operationId: string
}

export interface RecordPatchOperation {
  path: string
  expectedExists: boolean
  expectedValue?: JsonValue
  value?: JsonValue
  remove?: boolean
}

export interface RecordPatchMutation {
  namespace: string
  key: string
  operations: RecordPatchOperation[]
  expectedVersion: number | null
  operationId: string
}

export type RecordMutationResult<T extends JsonValue = JsonValue> =
  | { status: 'applied'; version: number; value: T; replayed: boolean }
  | { status: 'conflict'; currentVersion: number | null; currentValue: JsonValue | null; replayed: boolean }

export interface AppendEventInput<T extends JsonValue = JsonValue> {
  streamId: string
  eventId: string
  eventType: string
  schemaVersion: number
  payload: T
  operationId: string
  expectedSequence?: number
}

export type AppendEventResult =
  | { status: 'applied'; sequence: number; replayed: boolean }
  | { status: 'conflict'; reason: 'sequence_mismatch' | 'duplicate_event'; currentSequence: number; replayed: boolean }

export interface StoredEvent<T extends JsonValue = JsonValue> {
  streamId: string
  sequence: number
  eventId: string
  eventType: string
  schemaVersion: number
  payload: T
  writerId: string
  operationId: string
  occurredAt: number
}

interface Migration {
  id: string
  sql: string
}

interface OperationRow {
  capability: string
  payload_hash: string
  result_json: string
}

interface RecordRow {
  version: number
  value_json: string
  updated_at: number
  writer_id: string
}

interface CapabilityRow {
  version: number
}

interface StreamHeadRow {
  last_sequence: number
}

interface EventIdentityRow {
  sequence: number
}

interface EventRow {
  stream_id: string
  sequence: number
  event_id: string
  event_type: string
  schema_version: number
  payload_json: string
  writer_id: string
  operation_id: string
  occurred_at: number
}

const DEFAULT_CAPABILITIES: Record<string, CapabilityRange> = {
  records: { minWriteVersion: 1, maxWriteVersion: 1 },
  events: { minWriteVersion: 1, maxWriteVersion: 1 },
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_multi_writer_core',
    sql: `
      CREATE TABLE IF NOT EXISTS mortise_capabilities (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS mortise_operations (
        operation_id TEXT PRIMARY KEY,
        capability TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        writer_id TEXT NOT NULL,
        writer_version INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS mortise_records (
        namespace TEXT NOT NULL,
        record_key TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        writer_id TEXT NOT NULL,
        PRIMARY KEY (namespace, record_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS mortise_stream_heads (
        stream_id TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS mortise_events (
        event_id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        payload_json TEXT NOT NULL,
        writer_id TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE,
        occurred_at INTEGER NOT NULL,
        UNIQUE (stream_id, sequence)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS mortise_events_stream_sequence
        ON mortise_events (stream_id, sequence);

      INSERT OR IGNORE INTO mortise_capabilities (name, version, updated_at)
        VALUES ('records', 1, 0), ('events', 1, 0);
    `,
  },
]

function assertIdentifier(value: string, label: string): void {
  if (!value.trim()) throw new TypeError(`${label} must not be empty`)
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

function encodePointerPart(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

/** Build field-level JSON Pointer operations; arrays are treated atomically. */
export function createJsonPatch(
  base: JsonValue,
  next: JsonValue,
  path = '',
): RecordPatchOperation[] {
  if (canonicalJson(base) === canonicalJson(next)) return []
  const baseObject = base !== null && typeof base === 'object' && !Array.isArray(base)
    ? base as { [key: string]: JsonValue }
    : null
  const nextObject = next !== null && typeof next === 'object' && !Array.isArray(next)
    ? next as { [key: string]: JsonValue }
    : null
  if (baseObject && nextObject) {
    const keys = new Set([...Object.keys(baseObject), ...Object.keys(nextObject)])
    return [...keys].sort().flatMap(key => {
      const childPath = `${path}/${encodePointerPart(key)}`
      const inBase = Object.prototype.hasOwnProperty.call(baseObject, key)
      const inNext = Object.prototype.hasOwnProperty.call(nextObject, key)
      if (!inNext) {
        return [{
          path: childPath,
          expectedExists: true,
          expectedValue: baseObject[key],
          remove: true,
        }]
      }
      if (!inBase) {
        return [{
          path: childPath,
          expectedExists: false,
          value: nextObject[key],
        }]
      }
      return createJsonPatch(baseObject[key]!, nextObject[key]!, childPath)
    })
  }
  return [{
    path,
    expectedExists: true,
    expectedValue: base,
    value: next,
  }]
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function decodePointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new TypeError(`Invalid JSON Pointer: ${pointer}`)
  return pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function readPointer(value: JsonValue, pointer: string): { exists: boolean; value?: JsonValue } {
  const parts = decodePointer(pointer)
  let current: JsonValue = value
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { exists: false }
      current = current[index]!
    } else if (current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part]!
    } else {
      return { exists: false }
    }
  }
  return { exists: true, value: current }
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function applyPointerOperation(root: JsonValue, operation: RecordPatchOperation): JsonValue {
  const parts = decodePointer(operation.path)
  if (parts.length === 0) {
    if (operation.remove) throw new TypeError('The root record cannot be removed')
    if (operation.value === undefined) throw new TypeError(`Missing value for ${operation.path}`)
    return cloneJson(operation.value)
  }

  const parentParts = parts.slice(0, -1)
  const leaf = parts[parts.length - 1]!
  const parentPointer = parentParts.length === 0
    ? ''
    : `/${parentParts.map(part => part.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`
  const parent = readPointer(root, parentPointer)
  if (!parent.exists || parent.value === undefined || parent.value === null || typeof parent.value !== 'object') {
    throw new TypeError(`Cannot apply patch below missing parent ${parentPointer}`)
  }
  const container = parent.value as JsonValue[] | { [key: string]: JsonValue }
  if (Array.isArray(container)) {
    const index = leaf === '-' ? container.length : Number(leaf)
    if (!Number.isInteger(index) || index < 0 || index > container.length) throw new TypeError(`Invalid array index ${leaf}`)
    if (operation.remove) container.splice(index, 1)
    else {
      if (operation.value === undefined) throw new TypeError(`Missing value for ${operation.path}`)
      container[index] = cloneJson(operation.value)
    }
  } else if (operation.remove) {
    delete container[leaf]
  } else {
    if (operation.value === undefined) throw new TypeError(`Missing value for ${operation.path}`)
    container[leaf] = cloneJson(operation.value)
  }
  return root
}

export class MigrationChecksumError extends Error {
  readonly migrationId: string

  constructor(migrationId: string) {
    super(`Migration checksum mismatch for ${migrationId}`)
    this.name = 'MigrationChecksumError'
    this.migrationId = migrationId
  }
}

export class OperationIdentityConflictError extends Error {
  readonly operationId: string

  constructor(operationId: string) {
    super(`Operation ${operationId} was already used with a different payload`)
    this.name = 'OperationIdentityConflictError'
    this.operationId = operationId
  }
}

export class CapabilityReadOnlyError extends Error {
  readonly capability: string
  readonly databaseVersion: number | null
  readonly supportedRange: CapabilityRange | undefined

  constructor(
    capability: string,
    databaseVersion: number | null,
    supportedRange: CapabilityRange | undefined,
  ) {
    const actual = databaseVersion === null ? 'missing' : String(databaseVersion)
    const supported = supportedRange
      ? `${supportedRange.minWriteVersion}-${supportedRange.maxWriteVersion}`
      : 'none'
    super(`Capability ${capability} is read-only: database=${actual}, writer=${supported}`)
    this.name = 'CapabilityReadOnlyError'
    this.capability = capability
    this.databaseVersion = databaseVersion
    this.supportedRange = supportedRange
  }
}

export class MultiWriterStore {
  private readonly database: MortiseSqliteDatabase
  private readonly writerId: string
  private readonly writerVersion: number
  private readonly capabilities: Record<string, CapabilityRange>

  private constructor(
    database: MortiseSqliteDatabase,
    writerId: string,
    writerVersion: number,
    capabilities: Record<string, CapabilityRange>,
  ) {
    this.database = database
    this.writerId = writerId
    this.writerVersion = writerVersion
    this.capabilities = capabilities
  }

  static async open(options: MultiWriterStoreOptions): Promise<MultiWriterStore> {
    assertIdentifier(options.writerId, 'writerId')
    if (!Number.isSafeInteger(options.writerVersion) || options.writerVersion <= 0) {
      throw new TypeError('writerVersion must be a positive safe integer')
    }

    const database = await openCraftSqliteDatabase(options.databasePath, {
      busyTimeoutMs: options.busyTimeoutMs,
    })
    const store = new MultiWriterStore(
      database,
      options.writerId,
      options.writerVersion,
      { ...DEFAULT_CAPABILITIES, ...options.capabilities },
    )
    try {
      store.applyMigrations()
      return store
    } catch (error) {
      database.close()
      throw error
    }
  }

  static openSync(options: MultiWriterStoreOptions): MultiWriterStore {
    assertIdentifier(options.writerId, 'writerId')
    if (!Number.isSafeInteger(options.writerVersion) || options.writerVersion <= 0) {
      throw new TypeError('writerVersion must be a positive safe integer')
    }

    const database = openCraftSqliteDatabaseSync(options.databasePath, {
      busyTimeoutMs: options.busyTimeoutMs,
    })
    const store = new MultiWriterStore(
      database,
      options.writerId,
      options.writerVersion,
      { ...DEFAULT_CAPABILITIES, ...options.capabilities },
    )
    try {
      store.applyMigrations()
      return store
    } catch (error) {
      database.close()
      throw error
    }
  }

  get runtime(): 'bun' | 'node' {
    return this.database.runtime
  }

  close(): void {
    this.database.close()
  }

  getRecord<T extends JsonValue = JsonValue>(namespace: string, key: string): StoredRecord<T> | null {
    const row = this.database.prepare(`
      SELECT version, value_json, updated_at, writer_id
      FROM mortise_records
      WHERE namespace = ? AND record_key = ?
    `).get<RecordRow>(namespace, key)
    if (!row) return null
    return {
      namespace,
      key,
      version: Number(row.version),
      value: parseJson<T>(row.value_json),
      updatedAt: Number(row.updated_at),
      writerId: row.writer_id,
    }
  }

  mutateRecord<T extends JsonValue>(mutation: RecordMutation<T>): RecordMutationResult<T> {
    assertIdentifier(mutation.namespace, 'namespace')
    assertIdentifier(mutation.key, 'key')
    assertIdentifier(mutation.operationId, 'operationId')
    if (mutation.expectedVersion !== null
      && (!Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion <= 0)) {
      throw new TypeError('expectedVersion must be null or a positive safe integer')
    }

    const payloadHash = sha256(canonicalJson({
      namespace: mutation.namespace,
      key: mutation.key,
      value: mutation.value,
      expectedVersion: mutation.expectedVersion,
    }))

    return this.transaction(() => {
      const replay = this.readOperation<RecordMutationResult<T>>(
        mutation.operationId,
        'records',
        payloadHash,
      )
      if (replay) return { ...replay, replayed: true }
      this.assertWritable('records')

      const current = this.getRecord<T>(mutation.namespace, mutation.key)
      const versionMatches = current === null
        ? mutation.expectedVersion === null
        : current.version === mutation.expectedVersion
      if (!versionMatches) {
        const conflict: RecordMutationResult<T> = {
          status: 'conflict',
          currentVersion: current?.version ?? null,
          currentValue: current?.value ?? null,
          replayed: false,
        }
        this.saveOperation(mutation.operationId, 'records', payloadHash, conflict)
        return conflict
      }

      const nextVersion = (current?.version ?? 0) + 1
      const valueJson = canonicalJson(mutation.value)
      const updatedAt = Date.now()
      if (current) {
        const updated = this.database.prepare(`
          UPDATE mortise_records
          SET version = ?, value_json = ?, updated_at = ?, writer_id = ?
          WHERE namespace = ? AND record_key = ? AND version = ?
        `).run(
          nextVersion,
          valueJson,
          updatedAt,
          this.writerId,
          mutation.namespace,
          mutation.key,
          current.version,
        )
        if (updated.changes !== 1) throw new Error('Record CAS invariant failed inside write transaction')
      } else {
        this.database.prepare(`
          INSERT INTO mortise_records
            (namespace, record_key, version, value_json, updated_at, writer_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          mutation.namespace,
          mutation.key,
          nextVersion,
          valueJson,
          updatedAt,
          this.writerId,
        )
      }

      const result: RecordMutationResult<T> = {
        status: 'applied',
        version: nextVersion,
        value: mutation.value,
        replayed: false,
      }
      this.saveOperation(mutation.operationId, 'records', payloadHash, result)
      return result
    })
  }

  mutateRecordPatch(mutation: RecordPatchMutation): RecordMutationResult {
    assertIdentifier(mutation.namespace, 'namespace')
    assertIdentifier(mutation.key, 'key')
    assertIdentifier(mutation.operationId, 'operationId')
    if (!Array.isArray(mutation.operations) || mutation.operations.length === 0) {
      throw new TypeError('operations must contain at least one patch operation')
    }
    if (mutation.expectedVersion !== null
      && (!Number.isSafeInteger(mutation.expectedVersion) || mutation.expectedVersion <= 0)) {
      throw new TypeError('expectedVersion must be null or a positive safe integer')
    }

    const payloadHash = sha256(canonicalJson(JSON.parse(JSON.stringify({
      namespace: mutation.namespace,
      key: mutation.key,
      operations: mutation.operations,
      expectedVersion: mutation.expectedVersion,
    })) as JsonValue))

    return this.transaction(() => {
      const replay = this.readOperation<RecordMutationResult>(mutation.operationId, 'records', payloadHash)
      if (replay) return { ...replay, replayed: true }
      this.assertWritable('records')

      const current = this.getRecord(mutation.namespace, mutation.key)
      if (current === null || mutation.expectedVersion === null) {
        const conflict: RecordMutationResult = {
          status: 'conflict',
          currentVersion: current?.version ?? null,
          currentValue: current?.value ?? null,
          replayed: false,
        }
        this.saveOperation(mutation.operationId, 'records', payloadHash, conflict)
        return conflict
      }

      let nextValue = cloneJson(current.value)
      for (const operation of mutation.operations) {
        const actual = readPointer(nextValue, operation.path)
        if (actual.exists !== operation.expectedExists
          || (actual.exists && canonicalJson(actual.value!) !== canonicalJson(operation.expectedValue!))) {
          const conflict: RecordMutationResult = {
            status: 'conflict',
            currentVersion: current.version,
            currentValue: current.value,
            replayed: false,
          }
          this.saveOperation(mutation.operationId, 'records', payloadHash, conflict)
          return conflict
        }
        nextValue = applyPointerOperation(nextValue, operation)
      }

      const nextVersion = current.version + 1
      const updated = this.database.prepare(`
        UPDATE mortise_records
        SET version = ?, value_json = ?, updated_at = ?, writer_id = ?
        WHERE namespace = ? AND record_key = ? AND version = ?
      `).run(
        nextVersion,
        canonicalJson(nextValue),
        Date.now(),
        this.writerId,
        mutation.namespace,
        mutation.key,
        current.version,
      )
      if (updated.changes !== 1) throw new Error('Record patch CAS invariant failed inside write transaction')
      const result: RecordMutationResult = {
        status: 'applied',
        version: nextVersion,
        value: nextValue,
        replayed: false,
      }
      this.saveOperation(mutation.operationId, 'records', payloadHash, result)
      return result
    })
  }

  appendEvent<T extends JsonValue>(input: AppendEventInput<T>): AppendEventResult {
    assertIdentifier(input.streamId, 'streamId')
    assertIdentifier(input.eventId, 'eventId')
    assertIdentifier(input.eventType, 'eventType')
    assertIdentifier(input.operationId, 'operationId')
    if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion <= 0) {
      throw new TypeError('schemaVersion must be a positive safe integer')
    }
    if (input.expectedSequence !== undefined
      && (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0)) {
      throw new TypeError('expectedSequence must be a non-negative safe integer')
    }

    const payloadHash = sha256(canonicalJson({
      streamId: input.streamId,
      eventId: input.eventId,
      eventType: input.eventType,
      schemaVersion: input.schemaVersion,
      payload: input.payload,
      expectedSequence: input.expectedSequence ?? null,
    }))

    return this.transaction(() => {
      const replay = this.readOperation<AppendEventResult>(input.operationId, 'events', payloadHash)
      if (replay) return { ...replay, replayed: true }
      this.assertWritable('events')

      const head = this.database.prepare(`
        SELECT last_sequence FROM mortise_stream_heads WHERE stream_id = ?
      `).get<StreamHeadRow>(input.streamId)
      const currentSequence = Number(head?.last_sequence ?? 0)

      const existingEvent = this.database.prepare(`
        SELECT sequence FROM mortise_events WHERE event_id = ?
      `).get<EventIdentityRow>(input.eventId)
      if (existingEvent) {
        const conflict: AppendEventResult = {
          status: 'conflict',
          reason: 'duplicate_event',
          currentSequence: Number(existingEvent.sequence),
          replayed: false,
        }
        this.saveOperation(input.operationId, 'events', payloadHash, conflict)
        return conflict
      }

      if (input.expectedSequence !== undefined && input.expectedSequence !== currentSequence) {
        const conflict: AppendEventResult = {
          status: 'conflict',
          reason: 'sequence_mismatch',
          currentSequence,
          replayed: false,
        }
        this.saveOperation(input.operationId, 'events', payloadHash, conflict)
        return conflict
      }

      const sequence = currentSequence + 1
      const occurredAt = Date.now()
      this.database.prepare(`
        INSERT INTO mortise_events
          (event_id, stream_id, sequence, event_type, schema_version, payload_json,
           writer_id, operation_id, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.eventId,
        input.streamId,
        sequence,
        input.eventType,
        input.schemaVersion,
        canonicalJson(input.payload),
        this.writerId,
        input.operationId,
        occurredAt,
      )
      this.database.prepare(`
        INSERT INTO mortise_stream_heads (stream_id, last_sequence)
        VALUES (?, ?)
        ON CONFLICT (stream_id) DO UPDATE SET last_sequence = excluded.last_sequence
      `).run(input.streamId, sequence)

      const result: AppendEventResult = { status: 'applied', sequence, replayed: false }
      this.saveOperation(input.operationId, 'events', payloadHash, result)
      return result
    })
  }

  listEvents<T extends JsonValue = JsonValue>(streamId: string): StoredEvent<T>[] {
    return this.database.prepare(`
      SELECT stream_id, sequence, event_id, event_type, schema_version, payload_json,
             writer_id, operation_id, occurred_at
      FROM mortise_events
      WHERE stream_id = ?
      ORDER BY sequence
    `).all<EventRow>(streamId).map(row => ({
      streamId: row.stream_id,
      sequence: Number(row.sequence),
      eventId: row.event_id,
      eventType: row.event_type,
      schemaVersion: Number(row.schema_version),
      payload: parseJson<T>(row.payload_json),
      writerId: row.writer_id,
      operationId: row.operation_id,
      occurredAt: Number(row.occurred_at),
    }))
  }

  getCapabilityVersion(capability: string): number | null {
    const row = this.database.prepare(`
      SELECT version FROM mortise_capabilities WHERE name = ?
    `).get<CapabilityRow>(capability)
    return row ? Number(row.version) : null
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mortise_schema_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT
    `)

    this.transaction(() => {
      for (const migration of MIGRATIONS) {
        const checksum = sha256(migration.sql)
        const existing = this.database.prepare(`
          SELECT checksum FROM mortise_schema_migrations WHERE id = ?
        `).get<{ checksum: string }>(migration.id)
        if (existing) {
          if (existing.checksum !== checksum) throw new MigrationChecksumError(migration.id)
          continue
        }
        this.database.exec(migration.sql)
        this.database.prepare(`
          INSERT INTO mortise_schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)
        `).run(migration.id, checksum, Date.now())
      }
    })
  }

  private assertWritable(capability: string): void {
    const databaseVersion = this.getCapabilityVersion(capability)
    const supportedRange = this.capabilities[capability]
    if (databaseVersion === null
      || !supportedRange
      || databaseVersion < supportedRange.minWriteVersion
      || databaseVersion > supportedRange.maxWriteVersion) {
      throw new CapabilityReadOnlyError(capability, databaseVersion, supportedRange)
    }
  }

  private readOperation<T>(operationId: string, capability: string, payloadHash: string): T | null {
    const existing = this.database.prepare(`
      SELECT capability, payload_hash, result_json
      FROM mortise_operations
      WHERE operation_id = ?
    `).get<OperationRow>(operationId)
    if (!existing) return null
    if (existing.capability !== capability || existing.payload_hash !== payloadHash) {
      throw new OperationIdentityConflictError(operationId)
    }
    return parseJson<T>(existing.result_json)
  }

  private saveOperation(operationId: string, capability: string, payloadHash: string, result: object): void {
    this.database.prepare(`
      INSERT INTO mortise_operations
        (operation_id, capability, payload_hash, writer_id, writer_version, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      operationId,
      capability,
      payloadHash,
      this.writerId,
      this.writerVersion,
      JSON.stringify(result),
      Date.now(),
    )
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK')
      } catch {
        // Preserve the original transaction error.
      }
      throw error
    }
  }
}
