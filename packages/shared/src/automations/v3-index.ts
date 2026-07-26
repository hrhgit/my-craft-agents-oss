import { createHash } from 'node:crypto'
import type {
  MultiWriterModuleMigration,
  MultiWriterReadTransaction,
  MultiWriterTransaction,
} from '../storage/index.ts'
import { calculateTimeOccurrence } from '../scheduler/occurrences.ts'
import type { ScheduledOccurrenceV1 } from '../scheduler/occurrences.ts'
import {
  AutomationRunV1Schema,
  AutomationsDocumentV3Schema,
  TrustedAutomationEventV1Schema,
  parseAutomationHistoryBackfillPayloadV1,
} from './v3-schemas.ts'
import { automationIdentity, canonicalAutomationValue } from './v3-identity.ts'
import type {
  AutomationDefinitionV3,
  AutomationRunStateV1,
  AutomationRunV1,
  AutomationsDocumentV3,
  TimeTriggerV3,
} from './v3-types.ts'

const INDEX_SCHEMA_VERSION = 1
const MAX_PAGE_SIZE = 500
const AUTOMATION_INDEX_BACKFILL_REVISION = 'automation-index-backfill-v3'

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

export function assertAutomationRunIdentity(workspaceId: string, run: AutomationRunV1): void {
  const expectedOccurrenceId = automationIdentity(
    'occ',
    workspaceId,
    run.automationId,
    run.definitionRevision,
    run.triggerId,
    run.occurrenceKey,
  )
  const expectedRunId = automationIdentity('run', expectedOccurrenceId, 0)
  if (run.occurrenceId !== expectedOccurrenceId || run.runId !== expectedRunId) {
    throw new Error(`Automation run identity does not match its workspace occurrence: ${run.runId}`)
  }
  for (const action of run.actions) {
    if (action.actionRunId !== automationIdentity('action', run.runId, action.actionId)) {
      throw new Error(`Automation action run identity does not match its canonical run: ${action.actionRunId}`)
    }
  }
}

function assertHistoryRelationships(
  transaction: MultiWriterTransaction,
  workspaceId: string,
  document: AutomationsDocumentV3 | null,
  runs: ReadonlyMap<string, AutomationRunV1>,
  row: { event_id: string; event_type: string; operation_id: string; schema_version: number },
  payload: Record<string, unknown>,
): void {
  if (Number(row.schema_version) !== 1) {
    throw new Error(`Unsupported automation history schema version for ${row.event_id}`)
  }
  const operationSuffix = `:ledger:${row.event_type}`
  if (!row.operation_id.endsWith(operationSuffix)) {
    throw new Error(`Automation history operation identity does not match its event type: ${row.event_id}`)
  }
  const sourceOperationId = row.operation_id.slice(0, -operationSuffix.length)
  let sourceEventId: string
  if (row.event_type === 'definitions.changed') {
    if (!document || Number(payload.revision) > document.revision) {
      throw new Error('Automation definition history revision exceeds the canonical document')
    }
    sourceEventId = sourceOperationId
  } else if (row.event_type === 'event.accepted') {
    if (payload.workspaceId !== workspaceId) {
      throw new Error(`Automation event history workspace does not match its stream: ${row.event_id}`)
    }
    const eventId = String(payload.eventId)
    const eventRecord = transaction.getRecord(`automations-events:${workspaceId}`, eventId)
    if (!eventRecord || eventRecord.version !== 1) {
      throw new Error(`Automation event history does not reference a canonical V1 event: ${eventId}`)
    }
    const event = TrustedAutomationEventV1Schema.parse(eventRecord.value)
    if (event.eventId !== eventId || event.workspaceId !== workspaceId
      || event.sourceKind !== payload.sourceKind || event.sessionId !== payload.sessionId
      || canonicalAutomationValue({
        specversion: event.cloudEvent.specversion,
        id: event.cloudEvent.id,
        source: event.cloudEvent.source,
        type: event.cloudEvent.type,
        time: event.cloudEvent.time,
      }) !== canonicalAutomationValue(payload.cloudEvent)
      || event.acceptedAt !== payload.acceptedAt) {
      throw new Error(`Automation event history does not match its canonical event: ${eventId}`)
    }
    sourceEventId = eventId
  } else {
    const runId = String(payload.runId)
    const run = runs.get(runId)
    if (!run) throw new Error(`Automation run history does not reference a canonical run: ${runId}`)
    const immutablePayload = {
      runId: payload.runId,
      occurrenceId: payload.occurrenceId,
      automationId: payload.automationId,
      definitionRevision: payload.definitionRevision,
      triggerId: payload.triggerId,
      eventId: payload.eventId,
      scheduledAt: payload.scheduledAt,
      createdAt: payload.createdAt,
      actions: (payload.actions as Array<Record<string, unknown>>).map(action => ({
        actionRunId: action.actionRunId,
        actionId: action.actionId,
      })),
    }
    const immutableRun = {
      runId: run.runId,
      occurrenceId: run.occurrenceId,
      automationId: run.automationId,
      definitionRevision: run.definitionRevision,
      triggerId: run.triggerId,
      eventId: run.eventId,
      scheduledAt: run.scheduledAt,
      createdAt: run.createdAt,
      actions: run.actions.map(action => ({ actionRunId: action.actionRunId, actionId: action.actionId })),
    }
    if (canonicalAutomationValue(immutablePayload) !== canonicalAutomationValue(immutableRun)) {
      throw new Error(`Automation run history immutable identity does not match its canonical run: ${runId}`)
    }
    sourceEventId = row.event_type === 'run.created'
      ? runId
      : automationIdentity('transition', runId, sourceOperationId)
  }
  const expectedLedgerEventId = automationIdentity('ledger', workspaceId, row.event_type, sourceEventId)
  if (row.event_id !== expectedLedgerEventId) {
    throw new Error(`Automation history event identity does not match its canonical source: ${row.event_id}`)
  }
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

export function assertAutomationProjectionWorkspace(
  transaction: MultiWriterReadTransaction,
  workspaceId: string,
): void {
  const rows = transaction.all<{ workspace_id: string }>(`
    SELECT workspace_id FROM automation_projection_meta ORDER BY workspace_id LIMIT 2
  `)
  if (rows.length !== 1 || rows[0]!.workspace_id !== workspaceId) {
    throw new Error(`Automation database workspace identity does not match ${workspaceId}`)
  }
}

export function createAutomationIndexMigration(workspaceId: string): MultiWriterModuleMigration {
  const checksum = createHash('sha256').update(`${INDEX_SCHEMA_SQL}\n${AUTOMATION_INDEX_BACKFILL_REVISION}`).digest('hex')
  return {
    id: '1001_automation_v3_index_projection',
    checksum,
    migrate(transaction) {
      transaction.exec(INDEX_SCHEMA_SQL)
      const foreignRecord = transaction.get<{ namespace: string }>(`
        SELECT namespace FROM mortise_records
        WHERE (namespace LIKE 'automations-document:%'
          OR namespace LIKE 'automations-events:%'
          OR namespace LIKE 'automations-runs:%')
          AND namespace NOT IN (?, ?, ?)
        ORDER BY namespace LIMIT 1
      `, `automations-document:${workspaceId}`, `automations-events:${workspaceId}`, `automations-runs:${workspaceId}`)
      const foreignStream = transaction.get<{ stream_id: string }>(`
        SELECT stream_id FROM mortise_events
        WHERE stream_id LIKE 'automations-history:%' AND stream_id <> ?
        ORDER BY stream_id LIMIT 1
      `, `automations-history:${workspaceId}`)
      if (foreignRecord || foreignStream) {
        throw new Error(`Automation database contains a foreign workspace authority: ${foreignRecord?.namespace ?? foreignStream?.stream_id}`)
      }
      const existingWorkspace = transaction.get<{ workspace_id: string }>(`
        SELECT workspace_id FROM automation_projection_meta ORDER BY workspace_id LIMIT 1
      `)
      if (existingWorkspace && existingWorkspace.workspace_id !== workspaceId) {
        throw new Error(`Automation database workspace identity does not match ${workspaceId}`)
      }
      transaction.run(`
        INSERT INTO automation_projection_meta (workspace_id, schema_version, definition_revision)
        VALUES (?, ?, 0)
        ON CONFLICT(workspace_id) DO NOTHING
      `, workspaceId, INDEX_SCHEMA_VERSION)
      const documentRecord = transaction.getRecord(`automations-document:${workspaceId}`, 'definitions')
      let document: AutomationsDocumentV3 | null = null
      if (documentRecord) {
        document = AutomationsDocumentV3Schema.parse(documentRecord.value) as AutomationsDocumentV3
        if (!Number.isSafeInteger(documentRecord.version) || documentRecord.version <= 0
          || document.revision !== documentRecord.version) {
          throw new Error('Automation document revision does not match its canonical record version during index migration')
        }
      }
      const runRows = transaction.all<{ record_key: string; version: number; value_json: string }>(`
        SELECT record_key, version, value_json FROM mortise_records
        WHERE namespace = ? ORDER BY record_key
      `, `automations-runs:${workspaceId}`)
      const runs = new Map<string, AutomationRunV1>()
      for (const row of runRows) {
        const run = AutomationRunV1Schema.parse(JSON.parse(row.value_json)) as AutomationRunV1
        if (!Number.isSafeInteger(row.version) || row.version <= 0) {
          throw new Error(`Automation run record version is invalid: ${row.record_key}`)
        }
        if (row.record_key !== run.runId) throw new Error(`Automation run record key does not match payload identity: ${row.record_key}`)
        assertAutomationRunIdentity(workspaceId, run)
        runs.set(run.runId, run)
        projectRun(transaction, workspaceId, run, Number(row.version))
      }
      const historyRows = transaction.all<{
        sequence: number
        event_id: string
        event_type: string
        schema_version: number
        operation_id: string
        payload_json: string
        occurred_at: number
      }>(`
        SELECT sequence, event_id, event_type, schema_version, operation_id, payload_json, occurred_at
        FROM mortise_events WHERE stream_id = ? ORDER BY sequence
      `, `automations-history:${workspaceId}`)
      for (const row of historyRows) {
        if (!Number.isSafeInteger(row.sequence) || row.sequence <= 0
          || !Number.isSafeInteger(row.occurred_at) || row.occurred_at < 0) {
          throw new Error(`Automation history sequence or timestamp is invalid: ${row.event_id}`)
        }
        const payload = parseAutomationHistoryBackfillPayloadV1(row.event_type, JSON.parse(row.payload_json)) as Record<string, unknown>
        assertHistoryRelationships(transaction, workspaceId, document, runs, row, payload)
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
      if (document) replaceDefinitionProjection(transaction, workspaceId, document)
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
  limit: number
  query: string
}

export interface AutomationHistoryCursorV1 {
  sequence: number
  afterSequence: number
  limit: number
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
  const requestedLimit = options.limit === undefined ? undefined : boundedLimit(options.limit)
  const limit = options.cursor?.limit ?? requestedLimit ?? 100
  if (requestedLimit !== undefined && options.cursor && requestedLimit !== options.cursor.limit) {
    throw new Error('Automation run cursor query does not match')
  }
  const states = [...new Set(options.states ?? [])].sort()
  const query = queryFingerprint({
    schema: 'automation-run-query/v1',
    workspaceId,
    automationId: options.automationId ?? null,
    states,
    eventId: options.eventId ?? null,
    createdAfter: options.createdAfter ?? null,
    createdBefore: options.createdBefore ?? null,
    limit,
    order: 'createdAtMs-desc-runId-desc',
  })
  if (options.cursor && options.cursor.query !== query) throw new Error('Automation run cursor query does not match')
  const clauses = ['i.workspace_id = ?', 'r.namespace = ?', 'r.record_key = i.run_id', 'r.version = i.record_version']
  const params: Array<string | number | null> = [workspaceId, runNamespace]
  if (options.automationId) { clauses.push('i.automation_id = ?'); params.push(options.automationId) }
  if (options.eventId) { clauses.push('i.event_id = ?'); params.push(options.eventId) }
  if (states.length) {
    clauses.push(`i.state IN (${states.map(() => '?').join(', ')})`)
    params.push(...states)
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
    ...(rows.length > limit && last ? { nextCursor: {
      createdAtMs: Number(last.created_at_ms),
      runId: last.run_id,
      limit,
      query,
    } } : {}),
  }
}

export interface ExpiredAutomationRunV1 {
  run: AutomationRunV1
  recordVersion: number
}

export function listExpiredRuns(
  transaction: MultiWriterReadTransaction,
  workspaceId: string,
  expiresAtOrBefore: number,
  limit = 100,
): ExpiredAutomationRunV1[] {
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
    return { run, recordVersion: Number(row.record_version) }
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
  options: {
    afterSequence?: number
    automationId?: string
    runId?: string
    limit?: number
    cursor?: AutomationHistoryCursorV1
  } = {},
): { items: Array<{ sequence: number; kind: string; payload: unknown; occurredAt: number }>; nextCursor?: AutomationHistoryCursorV1 } {
  const requestedLimit = options.limit === undefined ? undefined : boundedLimit(options.limit)
  const limit = options.cursor?.limit ?? requestedLimit ?? 100
  const requestedAfterSequence = options.afterSequence ?? 0
  const afterSequence = options.cursor?.sequence ?? requestedAfterSequence
  const initialAfterSequence = options.cursor?.afterSequence ?? requestedAfterSequence
  if (options.cursor && ((requestedLimit !== undefined && requestedLimit !== options.cursor.limit)
    || (options.afterSequence !== undefined && options.afterSequence !== options.cursor.afterSequence))) {
    throw new Error('Automation history cursor query does not match')
  }
  const query = queryFingerprint({
    schema: 'automation-history-query/v1',
    workspaceId,
    historyStream,
    automationId: options.automationId ?? null,
    runId: options.runId ?? null,
    afterSequence: initialAfterSequence,
    limit,
    order: 'sequence-asc',
  })
  if (options.cursor && options.cursor.query !== query) throw new Error('Automation history cursor query does not match')
  const rows = options.automationId || options.runId
    ? transaction.all<{
      sequence: number
      kind: string
      payload_json: string
      occurred_at: number
    }>(`
      SELECT i.sequence, i.kind, e.payload_json, e.occurred_at
      FROM automation_history_index i
      JOIN mortise_events e
      WHERE i.workspace_id = ? AND e.stream_id = ? AND e.sequence = i.sequence AND i.sequence > ?
        ${options.automationId ? 'AND i.automation_id = ?' : ''}
        ${options.runId ? 'AND i.run_id = ?' : ''}
      ORDER BY i.sequence LIMIT ?
    `, workspaceId, historyStream, afterSequence,
    ...(options.automationId ? [options.automationId] : []),
    ...(options.runId ? [options.runId] : []),
    limit + 1)
    : transaction.all<{
    sequence: number
    kind: string
    payload_json: string
    occurred_at: number
  }>(`
      SELECT sequence, event_type AS kind, payload_json, occurred_at
      FROM mortise_events
      WHERE stream_id = ? AND sequence > ?
      ORDER BY sequence LIMIT ?
    `, historyStream, afterSequence, limit + 1)
  const visible = rows.slice(0, limit)
  const last = visible[visible.length - 1]
  return {
    items: visible.map(row => ({ sequence: Number(row.sequence), kind: row.kind, payload: JSON.parse(row.payload_json), occurredAt: Number(row.occurred_at) })),
    ...(rows.length > limit && last ? { nextCursor: {
      sequence: Number(last.sequence),
      afterSequence: initialAfterSequence,
      limit,
      query,
    } } : {}),
  }
}
