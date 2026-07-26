import { createHash } from 'node:crypto'
import type {
  MultiWriterModuleMigration,
  MultiWriterReadTransaction,
  MultiWriterTransaction,
} from '../storage/index.ts'
import { calculateTimeOccurrence } from '../scheduler/occurrences.ts'
import type { ScheduledOccurrenceV1 } from '../scheduler/occurrences.ts'
import { AutomationRunV1Schema, AutomationsDocumentV3Schema } from './v3-schemas.ts'
import type {
  AutomationDefinitionV3,
  AutomationRunStateV1,
  AutomationRunV1,
  AutomationsDocumentV3,
  TimeTriggerV3,
} from './v3-types.ts'

const INDEX_SCHEMA_VERSION = 1
const MAX_PAGE_SIZE = 500
const AUTOMATION_INDEX_BACKFILL_REVISION = 'automation-index-backfill-v2'

const INDEX_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS automation_projection_meta (
    workspace_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    definition_revision INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS automation_definition_index (
    workspace_id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    definition_revision INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, automation_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automation_definition_page
    ON automation_definition_index (workspace_id, ordinal, automation_id);

  CREATE TABLE IF NOT EXISTS automation_schedule_index (
    workspace_id TEXT NOT NULL,
    automation_id TEXT NOT NULL,
    trigger_id TEXT NOT NULL,
    definition_revision INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    next_due_at_ms INTEGER,
    last_claimed_at_ms INTEGER,
    trigger_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, automation_id, trigger_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automation_schedule_due
    ON automation_schedule_index (workspace_id, enabled, next_due_at_ms, automation_id, trigger_id);

  CREATE TABLE IF NOT EXISTS automation_run_index (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    record_version INTEGER NOT NULL,
    automation_id TEXT NOT NULL,
    trigger_id TEXT NOT NULL,
    event_id TEXT,
    state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    scheduled_at_ms INTEGER,
    lease_expires_at_ms INTEGER,
    PRIMARY KEY (workspace_id, run_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automation_run_by_automation
    ON automation_run_index (workspace_id, automation_id, created_at_ms DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS automation_run_by_automation_state
    ON automation_run_index (workspace_id, automation_id, state, created_at_ms DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS automation_run_by_state
    ON automation_run_index (workspace_id, state, created_at_ms DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS automation_run_by_event
    ON automation_run_index (workspace_id, event_id, created_at_ms DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS automation_run_by_created
    ON automation_run_index (workspace_id, created_at_ms DESC, run_id DESC);
  CREATE INDEX IF NOT EXISTS automation_run_expired_lease
    ON automation_run_index (workspace_id, lease_expires_at_ms, run_id)
    WHERE state = 'running' AND lease_expires_at_ms IS NOT NULL;

  CREATE TABLE IF NOT EXISTS automation_history_index (
    workspace_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    automation_id TEXT,
    run_id TEXT,
    occurred_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, sequence),
    UNIQUE (workspace_id, event_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automation_history_by_automation
    ON automation_history_index (workspace_id, automation_id, sequence);
  CREATE INDEX IF NOT EXISTS automation_history_by_run
    ON automation_history_index (workspace_id, run_id, sequence);
`

function ms(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PAGE_SIZE) {
    throw new TypeError(`Automation query limit must be between 1 and ${MAX_PAGE_SIZE}`)
  }
  return limit
}

function queryFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function validateHistoryProjection(eventType: string, payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Invalid automation history payload for ${eventType}`)
  }
  const value = payload as Record<string, unknown>
  if (eventType === 'definitions.changed') {
    if (!Number.isSafeInteger(value.revision) || !Array.isArray(value.definitionIds)
      || !value.definitionIds.every(id => typeof id === 'string')) {
      throw new Error('Invalid definitions.changed automation history payload')
    }
    return value
  }
  if (eventType === 'event.accepted') {
    if (typeof value.eventId !== 'string' || typeof value.workspaceId !== 'string'
      || !['mortise', 'agent', 'extension', 'external'].includes(String(value.sourceKind))
      || typeof value.acceptedAt !== 'string' || !Number.isFinite(Date.parse(value.acceptedAt))) {
      throw new Error('Invalid event.accepted automation history payload')
    }
    return value
  }
  if (eventType === 'run.created' || eventType === 'run.transition') {
    if (typeof value.runId !== 'string' || typeof value.automationId !== 'string'
      || !['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'skipped'].includes(String(value.state))
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || !Array.isArray(value.actions)) {
      throw new Error(`Invalid ${eventType} automation history payload`)
    }
    return value
  }
  throw new Error(`Unknown automation history event type: ${eventType}`)
}

function nextDueAt(trigger: TimeTriggerV3, lastClaimedAtMs: number | null, now: Date): number | null {
  const result = calculateTimeOccurrence(trigger, {
    now,
    ...(lastClaimedAtMs === null ? {} : { lastClaimedAt: new Date(lastClaimedAtMs) }),
  })
  const value = result.due?.scheduledAt ?? result.next?.scheduledAt
  return value ? Date.parse(value) : null
}

export function replaceDefinitionProjection(
  transaction: MultiWriterTransaction,
  workspaceId: string,
  document: AutomationsDocumentV3,
  now = new Date(),
): void {
  transaction.run('DELETE FROM automation_definition_index WHERE workspace_id = ?', workspaceId)
  transaction.run('DELETE FROM automation_schedule_index WHERE workspace_id = ?', workspaceId)
  for (const [ordinal, definition] of document.definitions.entries()) {
    transaction.run(`
      INSERT INTO automation_definition_index
        (workspace_id, automation_id, definition_revision, ordinal, enabled, updated_at_ms, definition_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, workspaceId, definition.id, document.revision, ordinal, definition.enabled ? 1 : 0,
    ms(definition.updatedAt) ?? 0, JSON.stringify(definition))
    for (const trigger of definition.triggers) {
      if (trigger.type !== 'time') continue
      const latest = transaction.get<{ scheduled_at_ms: number | null }>(`
        SELECT scheduled_at_ms
        FROM automation_run_index
        WHERE workspace_id = ? AND automation_id = ? AND trigger_id = ? AND scheduled_at_ms IS NOT NULL
        ORDER BY scheduled_at_ms DESC, run_id DESC
        LIMIT 1
      `, workspaceId, definition.id, trigger.id)
      const lastClaimedAtMs = latest?.scheduled_at_ms === null || latest?.scheduled_at_ms === undefined
        ? null
        : Number(latest.scheduled_at_ms)
      transaction.run(`
        INSERT INTO automation_schedule_index
          (workspace_id, automation_id, trigger_id, definition_revision, enabled,
           next_due_at_ms, last_claimed_at_ms, trigger_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, workspaceId, definition.id, trigger.id, document.revision, definition.enabled ? 1 : 0,
      nextDueAt(trigger, lastClaimedAtMs, now), lastClaimedAtMs, JSON.stringify(trigger))
    }
  }
  transaction.run(`
    INSERT INTO automation_projection_meta (workspace_id, schema_version, definition_revision)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      definition_revision = excluded.definition_revision
  `, workspaceId, INDEX_SCHEMA_VERSION, document.revision)
}

export function projectRun(
  transaction: MultiWriterTransaction,
  workspaceId: string,
  run: AutomationRunV1,
  recordVersion: number,
): void {
  transaction.run(`
    INSERT INTO automation_run_index
      (workspace_id, run_id, record_version, automation_id, trigger_id, event_id, state,
       created_at_ms, scheduled_at_ms, lease_expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, run_id) DO UPDATE SET
      record_version = excluded.record_version,
      state = excluded.state,
      scheduled_at_ms = excluded.scheduled_at_ms,
      lease_expires_at_ms = excluded.lease_expires_at_ms
  `, workspaceId, run.runId, recordVersion, run.automationId, run.triggerId, run.eventId ?? null,
  run.state, ms(run.createdAt) ?? 0, ms(run.scheduledAt), ms(run.executor?.leaseExpiresAt))
}

export function advanceScheduleProjection(
  transaction: MultiWriterTransaction,
  workspaceId: string,
  run: AutomationRunV1,
): void {
  if (!run.scheduledAt) return
  const row = transaction.get<{ trigger_json: string }>(`
    SELECT trigger_json FROM automation_schedule_index
    WHERE workspace_id = ? AND automation_id = ? AND trigger_id = ?
  `, workspaceId, run.automationId, run.triggerId)
  if (!row) throw new Error(`Missing automation schedule projection for ${run.automationId}/${run.triggerId}`)
  const trigger = JSON.parse(row.trigger_json) as TimeTriggerV3
  const claimedAtMs = Date.parse(run.scheduledAt)
  transaction.run(`
    UPDATE automation_schedule_index
    SET last_claimed_at_ms = ?, next_due_at_ms = ?
    WHERE workspace_id = ? AND automation_id = ? AND trigger_id = ?
  `, claimedAtMs, nextDueAt(trigger, claimedAtMs, new Date(claimedAtMs + 1)),
  workspaceId, run.automationId, run.triggerId)
}

export function projectHistory(
  transaction: MultiWriterTransaction,
  input: {
    workspaceId: string
    sequence: number
    eventId: string
    kind: string
    automationId?: string
    runId?: string
    occurredAtMs?: number
  },
): void {
  transaction.run(`
    INSERT INTO automation_history_index
      (workspace_id, sequence, event_id, kind, automation_id, run_id, occurred_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, input.workspaceId, input.sequence, input.eventId, input.kind,
  input.automationId ?? null, input.runId ?? null, input.occurredAtMs ?? Date.now())
}

function capabilityUpgrade(transaction: MultiWriterTransaction, capability: string, version: number): void {
  const current = transaction.getCapabilityVersion(capability)
  if (current !== null && current < version) transaction.setCapabilityVersion(capability, version)
}

export function createAutomationIndexMigration(workspaceId: string): MultiWriterModuleMigration {
  const checksum = createHash('sha256').update(`${INDEX_SCHEMA_SQL}\n${AUTOMATION_INDEX_BACKFILL_REVISION}`).digest('hex')
  return {
    id: '1001_automation_v3_index_projection',
    checksum,
    migrate(transaction) {
      transaction.exec(INDEX_SCHEMA_SQL)
      const documentRecord = transaction.getRecord(`automations-document:${workspaceId}`, 'definitions')
      if (documentRecord) {
        const document = AutomationsDocumentV3Schema.parse(documentRecord.value) as AutomationsDocumentV3
        if (document.revision !== documentRecord.version) {
          throw new Error('Automation document revision does not match its canonical record version during index migration')
        }
        replaceDefinitionProjection(transaction, workspaceId, document)
      }
      const runRows = transaction.all<{ record_key: string; version: number; value_json: string }>(`
        SELECT record_key, version, value_json FROM mortise_records
        WHERE namespace = ? ORDER BY record_key
      `, `automations-runs:${workspaceId}`)
      for (const row of runRows) {
        const run = AutomationRunV1Schema.parse(JSON.parse(row.value_json)) as AutomationRunV1
        if (row.record_key !== run.runId) throw new Error(`Automation run record key does not match payload identity: ${row.record_key}`)
        projectRun(transaction, workspaceId, run, Number(row.version))
      }
      const historyRows = transaction.all<{
        sequence: number
        event_id: string
        event_type: string
        payload_json: string
        occurred_at: number
      }>(`
        SELECT sequence, event_id, event_type, payload_json, occurred_at
        FROM mortise_events WHERE stream_id = ? ORDER BY sequence
      `, `automations-history:${workspaceId}`)
      for (const row of historyRows) {
        const payload = validateHistoryProjection(row.event_type, JSON.parse(row.payload_json))
        projectHistory(transaction, {
          workspaceId,
          sequence: Number(row.sequence),
          eventId: row.event_id,
          kind: row.event_type,
          ...(typeof payload.automationId === 'string' ? { automationId: payload.automationId } : {}),
          ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}),
          occurredAtMs: Number(row.occurred_at),
        })
      }
      if (documentRecord) replaceDefinitionProjection(transaction, workspaceId, documentRecord.value as unknown as AutomationsDocumentV3)
      capabilityUpgrade(transaction, 'automations.definitions', 4)
      capabilityUpgrade(transaction, 'automations.ingress', 2)
      capabilityUpgrade(transaction, 'automations.runs', 2)
      capabilityUpgrade(transaction, 'automations.history', 2)
    },
  }
}

export interface AutomationDefinitionCursorV1 {
  revision: number
  ordinal: number
  id: string
}

export interface AutomationRunCursorV1 {
  createdAtMs: number
  runId: string
  query: string
}

export interface AutomationHistoryCursorV1 {
  sequence: number
  query: string
}

export function listDefinitionsPage(
  transaction: MultiWriterReadTransaction,
  workspaceId: string,
  options: { limit?: number; cursor?: AutomationDefinitionCursorV1 } = {},
): { revision: number; items: AutomationDefinitionV3[]; nextCursor?: AutomationDefinitionCursorV1 } {
  const meta = transaction.get<{ definition_revision: number }>(`
    SELECT definition_revision FROM automation_projection_meta WHERE workspace_id = ?
  `, workspaceId)
  const revision = Number(meta?.definition_revision ?? 0)
  if (options.cursor && options.cursor.revision !== revision) throw new Error('Automation definition cursor is stale')
  const limit = boundedLimit(options.limit)
  const rows = transaction.all<{ ordinal: number; automation_id: string; definition_json: string }>(`
    SELECT ordinal, automation_id, definition_json
    FROM automation_definition_index
    WHERE workspace_id = ?
      AND (? IS NULL OR ordinal > ? OR (ordinal = ? AND automation_id > ?))
    ORDER BY ordinal, automation_id
    LIMIT ?
  `, workspaceId, options.cursor?.ordinal ?? null, options.cursor?.ordinal ?? 0,
  options.cursor?.ordinal ?? 0, options.cursor?.id ?? '', limit + 1)
  const visible = rows.slice(0, limit)
  const last = visible[visible.length - 1]
  return {
    revision,
    items: visible.map(row => JSON.parse(row.definition_json) as AutomationDefinitionV3),
    ...(rows.length > limit && last ? { nextCursor: { revision, ordinal: Number(last.ordinal), id: last.automation_id } } : {}),
  }
}

export function listRunsPage(
  transaction: MultiWriterReadTransaction,
  workspaceId: string,
  runNamespace: string,
  options: {
    automationId?: string
    states?: AutomationRunStateV1[]
    eventId?: string
    createdAfter?: number
    createdBefore?: number
    limit?: number
    cursor?: AutomationRunCursorV1
  } = {},
): { items: AutomationRunV1[]; nextCursor?: AutomationRunCursorV1 } {
  const limit = boundedLimit(options.limit)
  const query = queryFingerprint({
    workspaceId,
    automationId: options.automationId ?? null,
    states: [...(options.states ?? [])].sort(),
    eventId: options.eventId ?? null,
    createdAfter: options.createdAfter ?? null,
    createdBefore: options.createdBefore ?? null,
  })
  if (options.cursor && options.cursor.query !== query) throw new Error('Automation run cursor query does not match')
  const clauses = ['i.workspace_id = ?', 'r.namespace = ?', 'r.record_key = i.run_id', 'r.version = i.record_version']
  const params: Array<string | number | null> = [workspaceId, runNamespace]
  if (options.automationId) { clauses.push('i.automation_id = ?'); params.push(options.automationId) }
  if (options.eventId) { clauses.push('i.event_id = ?'); params.push(options.eventId) }
  if (options.states?.length) {
    clauses.push(`i.state IN (${options.states.map(() => '?').join(', ')})`)
    params.push(...options.states)
  }
  if (options.createdAfter !== undefined) { clauses.push('i.created_at_ms >= ?'); params.push(options.createdAfter) }
  if (options.createdBefore !== undefined) { clauses.push('i.created_at_ms < ?'); params.push(options.createdBefore) }
  if (options.cursor) {
    clauses.push('(i.created_at_ms < ? OR (i.created_at_ms = ? AND i.run_id < ?))')
    params.push(options.cursor.createdAtMs, options.cursor.createdAtMs, options.cursor.runId)
  }
  const rows = transaction.all<{ run_id: string; created_at_ms: number; value_json: string }>(`
    SELECT i.run_id, i.created_at_ms, r.value_json
    FROM automation_run_index i
    JOIN mortise_records r
    WHERE ${clauses.join(' AND ')}
    ORDER BY i.created_at_ms DESC, i.run_id DESC
    LIMIT ?
  `, ...params, limit + 1)
  const visible = rows.slice(0, limit)
  const last = visible[visible.length - 1]
  return {
    items: visible.map(row => JSON.parse(row.value_json) as AutomationRunV1),
    ...(rows.length > limit && last ? { nextCursor: { createdAtMs: Number(last.created_at_ms), runId: last.run_id, query } } : {}),
  }
}

export function listExpiredRunIds(
  transaction: MultiWriterReadTransaction,
  workspaceId: string,
  expiresAtOrBefore: number,
  limit = 100,
): string[] {
  const namespace = `automations-runs:${workspaceId}`
  return transaction.all<{
    run_id: string
    record_version: number
    lease_expires_at_ms: number
    canonical_version: number | null
    value_json: string | null
  }>(`
    SELECT i.run_id, i.record_version, i.lease_expires_at_ms,
           r.version AS canonical_version, r.value_json
    FROM automation_run_index i INDEXED BY automation_run_expired_lease
    LEFT JOIN mortise_records r
      ON r.namespace = ? AND r.record_key = i.run_id
    WHERE i.workspace_id = ? AND i.state = 'running' AND i.lease_expires_at_ms <= ?
    ORDER BY i.lease_expires_at_ms, i.run_id LIMIT ?
  `, namespace, workspaceId, expiresAtOrBefore, boundedLimit(limit)).map(row => {
    if (row.canonical_version === null || row.value_json === null
      || Number(row.canonical_version) !== Number(row.record_version)) {
      throw new Error(`Automation run projection version is inconsistent for ${row.run_id}`)
    }
    const run = AutomationRunV1Schema.parse(JSON.parse(row.value_json)) as AutomationRunV1
    if (run.runId !== row.run_id || run.state !== 'running' || !run.executor
      || Date.parse(run.executor.leaseExpiresAt) !== Number(row.lease_expires_at_ms)) {
      throw new Error(`Automation run lease projection is inconsistent for ${row.run_id}`)
    }
    return row.run_id
  })
}

export interface DueAutomationOccurrenceV1 {
  definition: AutomationDefinitionV3
  trigger: TimeTriggerV3
  definitionRevision: number
  occurrence: ScheduledOccurrenceV1
}

export function listDueOccurrences(
  transaction: MultiWriterReadTransaction,
  workspaceId: string,
  dueAtOrBefore: number,
  limit = 100,
): DueAutomationOccurrenceV1[] {
  return transaction.all<{
    definition_revision: number
    definition_json: string
    trigger_json: string
    next_due_at_ms: number
    last_claimed_at_ms: number | null
  }>(`
    SELECT s.definition_revision, d.definition_json, s.trigger_json, s.next_due_at_ms,
           s.last_claimed_at_ms
    FROM automation_schedule_index s INDEXED BY automation_schedule_due
    JOIN automation_definition_index d
      ON d.workspace_id = s.workspace_id AND d.automation_id = s.automation_id
    WHERE s.workspace_id = ? AND s.enabled = 1 AND s.next_due_at_ms <= ?
    ORDER BY s.next_due_at_ms, s.automation_id, s.trigger_id
    LIMIT ?
  `, workspaceId, dueAtOrBefore, boundedLimit(limit)).map(row => {
    const trigger = JSON.parse(row.trigger_json) as TimeTriggerV3
    const calculation = calculateTimeOccurrence(trigger, {
      now: new Date(dueAtOrBefore),
      ...(row.last_claimed_at_ms === null
        ? {}
        : { lastClaimedAt: new Date(Number(row.last_claimed_at_ms)) }),
    })
    if (!calculation.due) {
      throw new Error(`Automation schedule projection is inconsistent for ${trigger.id}`)
    }
    return {
      definition: JSON.parse(row.definition_json) as AutomationDefinitionV3,
      trigger,
      definitionRevision: Number(row.definition_revision),
      occurrence: calculation.due,
    }
  })
}

export function getNextDueAt(transaction: MultiWriterReadTransaction, workspaceId: string): number | null {
  const row = transaction.get<{ next_due_at_ms: number }>(`
    SELECT next_due_at_ms FROM automation_schedule_index INDEXED BY automation_schedule_due
    WHERE workspace_id = ? AND enabled = 1 AND next_due_at_ms IS NOT NULL
    ORDER BY next_due_at_ms, automation_id, trigger_id LIMIT 1
  `, workspaceId)
  return row ? Number(row.next_due_at_ms) : null
}

export function getLatestHistorySequence(
  transaction: MultiWriterReadTransaction,
  workspaceId: string,
): number {
  const row = transaction.get<{ sequence: number }>(`
    SELECT sequence FROM automation_history_index
    WHERE workspace_id = ? ORDER BY sequence DESC LIMIT 1
  `, workspaceId)
  return Number(row?.sequence ?? 0)
}

export function readHistoryChanges(
  transaction: MultiWriterReadTransaction,
  workspaceId: string,
  historyStream: string,
  options: { afterSequence?: number; automationId?: string; runId?: string; limit?: number } = {},
): { items: Array<{ sequence: number; kind: string; payload: unknown; occurredAt: number }>; nextCursor?: AutomationHistoryCursorV1 } {
  const limit = boundedLimit(options.limit)
  const query = queryFingerprint({
    workspaceId,
    automationId: options.automationId ?? null,
    runId: options.runId ?? null,
  })
  const clauses = ['i.workspace_id = ?', 'e.stream_id = ?', 'e.sequence = i.sequence', 'i.sequence > ?']
  const params: Array<string | number> = [workspaceId, historyStream, options.afterSequence ?? 0]
  if (options.automationId) { clauses.push('i.automation_id = ?'); params.push(options.automationId) }
  if (options.runId) { clauses.push('i.run_id = ?'); params.push(options.runId) }
  const rows = transaction.all<{
    sequence: number
    kind: string
    payload_json: string
    occurred_at: number
  }>(`
    SELECT i.sequence, i.kind, e.payload_json, e.occurred_at
    FROM automation_history_index i
    JOIN mortise_events e
    WHERE ${clauses.join(' AND ')}
    ORDER BY i.sequence LIMIT ?
  `, ...params, limit + 1)
  const visible = rows.slice(0, limit)
  const last = visible[visible.length - 1]
  return {
    items: visible.map(row => ({ sequence: Number(row.sequence), kind: row.kind, payload: JSON.parse(row.payload_json), occurredAt: Number(row.occurred_at) })),
    ...(rows.length > limit && last ? { nextCursor: { sequence: Number(last.sequence), query } } : {}),
  }
}
