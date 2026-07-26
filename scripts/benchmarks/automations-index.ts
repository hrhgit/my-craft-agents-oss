import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AutomationDefinitionV3, AutomationRunV1 } from '../../packages/shared/src/automations/v3-types.ts'

const WORKSPACE_ID = 'opt-015-index-workspace'
const DEFINITIONS = 500
const RUNS = 10_000
const EVENTS = 2_500
const FIXTURE_NOW = '2026-07-26T00:00:00.000Z'
const operationNames = [
  'definitions-page',
  'automation-runs-page',
  'queued-runs-page',
  'event-runs-page',
  'runs-time-range-page',
  'history-change-cursor-page',
  'expired-leases-page',
  'due-occurrences-page',
] as const

type OperationName = typeof operationNames[number]
type Strategy = 'baseline' | 'candidate'
type Sample = Record<OperationName, number>
type Summary = Record<OperationName, { samplesMs: number[]; medianMs: number; p95Ms: number }>
type StrategySummary = { warm: Summary; coldProcess: Summary }
type StoreInstance = {
  close(): void
  initialize(): { revision: number; definitions: AutomationDefinitionV3[] }
  mutateDocument(input: unknown): { status: string; error?: { message?: string } }
  getDocument(): { definitions: AutomationDefinitionV3[] } | null
  listRuns(options?: { automationId?: string; limit?: number }): AutomationRunV1[]
  listDefinitionsPage?(options?: { limit?: number }): { items: AutomationDefinitionV3[] }
  listRunsPage?(options?: Record<string, unknown>): { items: AutomationRunV1[] }
  readHistoryChanges?(options?: Record<string, unknown>): { items: unknown[] }
  listExpiredExecutionLeases?(expiresAtOrBefore: Date, limit?: number): string[]
  listDueOccurrences?(dueAtOrBefore: Date, limit?: number): unknown[]
}

interface PerformancePolicy {
  baselineRevision: string
  environment: { platform: string; arch: string; runtime: string; storage: string }
  fixture: {
    workspaces: number
    definitions: number
    runs: number
    events: number
    expiredLeases: number
    timeTriggers: number
    seed: string
  }
  operations: Array<{ name: OperationName; limit: number }>
  sampling: {
    warmup: number
    warmSamples: number
    coldProcessSamples: number
    statistics: string[]
    timeoutMsPerOperation: number
    noisePolicy: string
  }
  budgets: {
    absoluteWarmP95Ms: number
    absoluteColdP95Ms: number
    relativeRegressionCeilingPercent: number
    queryPlan: string
  }
}

interface CheckoutIdentity {
  path: string
  revision: string
  clean: boolean
  storeSha256: string
}

interface QueryPlanEvidence {
  sql: string[]
  details: string[]
  expectedIndex: string | null
  usesExpectedIndex: boolean
  scansFullCollection: boolean
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}

function automationIdentity(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${createHash('sha256').update(canonical(parts)).digest('hex')}`
}

function definition(index: number): AutomationDefinitionV3 {
  const suffix = index.toString().padStart(4, '0')
  return {
    id: `automation-benchmark-${suffix}`,
    name: `Benchmark ${suffix}`,
    enabled: true,
    triggers: [{
      id: `trigger-benchmark-${suffix}`,
      type: 'time',
      schedule: { kind: 'once', at: '2026-01-01T00:00:00.000Z', misfire: 'run-once' },
    }],
    actions: [{
      id: `action-benchmark-${suffix}`,
      type: 'prompt',
      prompt: `benchmark-${suffix}`,
      target: { kind: 'new-session' },
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function run(index: number, definitions: AutomationDefinitionV3[]): AutomationRunV1 {
  const definitionValue = definitions[index % definitions.length]!
  const suffix = index.toString().padStart(5, '0')
  const createdAtMs = Date.parse('2026-01-01T00:00:00.000Z') + index * 1_000
  const state = index < 250
    ? 'running'
    : (['queued', 'succeeded', 'failed', 'cancelled', 'skipped'] as const)[index % 5]!
  const occurrenceKey = `benchmark-${suffix}`
  const occurrenceId = automationIdentity(
    'occ',
    WORKSPACE_ID,
    definitionValue.id,
    2,
    definitionValue.triggers[0]!.id,
    occurrenceKey,
  )
  const runId = automationIdentity('run', occurrenceId, 0)
  return {
    schemaVersion: 1,
    runId,
    occurrenceId,
    occurrenceKey,
    automationId: definitionValue.id,
    definitionRevision: 2,
    definitionSnapshot: definitionValue,
    triggerId: definitionValue.triggers[0]!.id,
    state,
    eventId: `event-benchmark-${(index % EVENTS).toString().padStart(4, '0')}`,
    createdAt: new Date(createdAtMs).toISOString(),
    ...(state === 'running' ? {
      startedAt: new Date(createdAtMs).toISOString(),
      executor: {
        ownerId: 'expired-benchmark-owner',
        claimedAt: new Date(createdAtMs).toISOString(),
        leaseExpiresAt: '2026-01-02T00:00:00.000Z',
      },
    } : {}),
    actions: [{
      actionRunId: automationIdentity('action', runId, definitionValue.actions[0]!.id),
      actionId: definitionValue.actions[0]!.id,
      state: state === 'running' ? 'running' : state === 'queued' ? 'queued' : state === 'succeeded' ? 'succeeded' : 'skipped',
      attempts: state === 'queued' ? 0 : 1,
    }],
  }
}

function runGit(checkout: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', checkout, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function checkoutIdentity(path: string, allowDirty: boolean): CheckoutIdentity {
  const checkout = resolve(path)
  const revision = runGit(checkout, ['rev-parse', 'HEAD'])
  const clean = runGit(checkout, ['status', '--porcelain=v1', '--untracked-files=all']) === ''
  if (!clean && !allowDirty) throw new Error(`Benchmark checkout must be clean: ${checkout}`)
  const storePath = join(checkout, 'packages/shared/src/automations/v3-store.ts')
  if (!existsSync(storePath)) throw new Error(`Automation store is missing from checkout: ${checkout}`)
  if (!existsSync(join(checkout, 'node_modules'))) {
    throw new Error(`Benchmark checkout dependencies are missing; run a frozen install first: ${checkout}`)
  }
  return { path: checkout, revision, clean, storeSha256: sha256File(storePath) }
}

async function loadCheckout(checkout: string): Promise<{
  AutomationV3Store: new (options: Record<string, unknown>) => StoreInstance
  calculateTimeOccurrence: (trigger: unknown, options: unknown) => { due?: unknown }
}> {
  const nonce = `${process.pid}-${Date.now()}-${Math.random()}`
  const storeModule = await import(`${pathToFileURL(join(checkout, 'packages/shared/src/automations/v3-store.ts')).href}?benchmark=${nonce}`)
  const schedulerModule = await import(`${pathToFileURL(join(checkout, 'packages/shared/src/scheduler/occurrences.ts')).href}?benchmark=${nonce}`)
  return {
    AutomationV3Store: storeModule.AutomationV3Store,
    calculateTimeOccurrence: schedulerModule.calculateTimeOccurrence,
  }
}

async function prepareFixture(checkout: string, root: string, strategy: Strategy): Promise<string> {
  const databasePath = join(root, `${strategy}-automations-v3.sqlite`)
  const { AutomationV3Store } = await loadCheckout(checkout)
  const store = new AutomationV3Store({
    workspaceId: WORKSPACE_ID,
    workspaceRootPath: root,
    databasePath,
    writerId: `benchmark-seed-${strategy}`,
  })
  const definitions = Array.from({ length: DEFINITIONS }, (_, index) => definition(index))
  try {
    const initial = store.initialize()
    const mutation = store.mutateDocument({
      operationId: 'benchmark-definitions',
      expectedRevision: initial.revision,
      document: { ...initial, definitions },
    })
    if (mutation.status !== 'ok') {
      throw new Error(`Benchmark definition seed failed: ${mutation.status}: ${mutation.error?.message ?? ''}`)
    }
  } finally {
    store.close()
  }

  const database = new Database(databasePath)
  const hasProjection = Boolean(database.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_run_index'
  `).get())
  if ((strategy === 'candidate') !== hasProjection) {
    throw new Error(`${strategy} checkout did not expose the expected query architecture`)
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    database.run('DELETE FROM mortise_events WHERE stream_id = ?', [`automations-history:${WORKSPACE_ID}`])
    database.run('DELETE FROM mortise_stream_heads WHERE stream_id = ?', [`automations-history:${WORKSPACE_ID}`])
    if (hasProjection) database.run('DELETE FROM automation_history_index WHERE workspace_id = ?', [WORKSPACE_ID])
    const insertRecord = database.prepare(`
      INSERT INTO mortise_records
        (namespace, record_key, version, value_json, updated_at, writer_id)
      VALUES (?, ?, 1, ?, ?, 'benchmark-seed')
    `)
    const insertRun = hasProjection ? database.prepare(`
      INSERT INTO automation_run_index
        (workspace_id, run_id, record_version, automation_id, trigger_id, event_id, state,
         created_at_ms, scheduled_at_ms, lease_expires_at_ms)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL, ?)
    `) : null
    const insertEvent = database.prepare(`
      INSERT INTO mortise_events
        (event_id, stream_id, sequence, event_type, schema_version, payload_json,
         writer_id, operation_id, occurred_at)
      VALUES (?, ?, ?, ?, 1, ?, 'benchmark-seed', ?, ?)
    `)
    const insertHistory = hasProjection ? database.prepare(`
      INSERT INTO automation_history_index
        (workspace_id, sequence, event_id, kind, automation_id, run_id, occurred_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `) : null
    let sequence = 0
    for (let index = 0; index < RUNS; index++) {
      const value = run(index, definitions)
      const createdAtMs = Date.parse(value.createdAt)
      insertRecord.run(`automations-runs:${WORKSPACE_ID}`, value.runId, JSON.stringify(value), createdAtMs)
      insertRun?.run(
        WORKSPACE_ID,
        value.runId,
        value.automationId,
        value.triggerId,
        value.eventId!,
        value.state,
        createdAtMs,
        value.executor ? Date.parse(value.executor.leaseExpiresAt) : null,
      )
      sequence += 1
      const ledgerId = `ledger-benchmark-run-${index.toString().padStart(5, '0')}`
      insertEvent.run(
        ledgerId,
        `automations-history:${WORKSPACE_ID}`,
        sequence,
        'run.created',
        JSON.stringify({ runId: value.runId, automationId: value.automationId, state: value.state }),
        `benchmark-ledger-run-${index}`,
        createdAtMs,
      )
      insertHistory?.run(WORKSPACE_ID, sequence, ledgerId, 'run.created', value.automationId, value.runId, createdAtMs)
    }
    for (let index = 0; index < EVENTS; index++) {
      sequence += 1
      const eventId = `event-benchmark-${index.toString().padStart(4, '0')}`
      const ledgerId = `ledger-benchmark-event-${index.toString().padStart(4, '0')}`
      const occurredAt = Date.parse('2026-01-02T00:00:00.000Z') + index
      insertEvent.run(
        ledgerId,
        `automations-history:${WORKSPACE_ID}`,
        sequence,
        'event.accepted',
        JSON.stringify({ eventId, sourceKind: 'external', workspaceId: WORKSPACE_ID }),
        `benchmark-ledger-event-${index}`,
        occurredAt,
      )
      insertHistory?.run(WORKSPACE_ID, sequence, ledgerId, 'event.accepted', null, null, occurredAt)
    }
    database.run('INSERT INTO mortise_stream_heads (stream_id, last_sequence) VALUES (?, ?)', [
      `automations-history:${WORKSPACE_ID}`,
      sequence,
    ])
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.close()
  }
  return databasePath
}

function measure(operation: () => unknown, minimumItems = 1): number {
  const startedAt = performance.now()
  const result = operation()
  const elapsed = performance.now() - startedAt
  if (!Array.isArray(result) || result.length < minimumItems) {
    throw new Error(`Benchmark operation returned ${Array.isArray(result) ? result.length : 'a non-array'} items`)
  }
  return elapsed
}

class BenchmarkSession {
  private constructor(
    readonly store: StoreInstance,
    readonly database: Database,
    readonly strategy: Strategy,
    readonly calculateTimeOccurrence: (trigger: unknown, options: unknown) => { due?: unknown },
  ) {}

  static async open(checkout: string, databasePath: string, strategy: Strategy): Promise<BenchmarkSession> {
    const { AutomationV3Store, calculateTimeOccurrence } = await loadCheckout(checkout)
    const store = new AutomationV3Store({
      workspaceId: WORKSPACE_ID,
      workspaceRootPath: dirname(databasePath),
      databasePath,
      writerId: `benchmark-${strategy}-${process.pid}`,
    })
    return new BenchmarkSession(store, new Database(databasePath, { readonly: true }), strategy, calculateTimeOccurrence)
  }

  close(): void {
    this.database.close()
    this.store.close()
  }

  sample(): Sample {
    return this.strategy === 'candidate' ? this.candidateSample() : this.baselineSample()
  }

  private allRuns(): AutomationRunV1[] {
    return this.store.listRuns({ limit: RUNS })
  }

  private candidateSample(): Sample {
    if (!this.store.listDefinitionsPage || !this.store.listRunsPage || !this.store.readHistoryChanges
      || !this.store.listExpiredExecutionLeases || !this.store.listDueOccurrences) {
      throw new Error('Candidate checkout does not expose the indexed Automations query contract')
    }
    return {
      'definitions-page': measure(() => this.store.listDefinitionsPage!({ limit: 100 }).items, 100),
      'automation-runs-page': measure(() => this.store.listRunsPage!({ automationId: definition(10).id, limit: 50 }).items, 20),
      'queued-runs-page': measure(() => this.store.listRunsPage!({ states: ['queued'], limit: 100 }).items, 100),
      'event-runs-page': measure(() => this.store.listRunsPage!({ eventId: 'event-benchmark-0010', limit: 50 }).items, 4),
      'runs-time-range-page': measure(() => this.store.listRunsPage!({
        createdAfter: Date.parse('2026-01-01T01:00:00.000Z'),
        createdBefore: Date.parse('2026-01-01T03:00:00.000Z'),
        limit: 100,
      }).items, 100),
      'history-change-cursor-page': measure(() => this.store.readHistoryChanges!({ afterSequence: 5_000, limit: 100 }).items, 100),
      'expired-leases-page': measure(() => this.store.listExpiredExecutionLeases!(new Date(FIXTURE_NOW), 100), 100),
      'due-occurrences-page': measure(() => this.store.listDueOccurrences!(new Date(FIXTURE_NOW), 100), 100),
    }
  }

  private baselineSample(): Sample {
    const allRunsFor = (predicate: (value: AutomationRunV1) => boolean, limit: number) => this.allRuns()
      .filter(predicate)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId))
      .slice(0, limit)
    return {
      'definitions-page': measure(() => this.store.getDocument()!.definitions.slice(0, 100), 100),
      'automation-runs-page': measure(() => this.store.listRuns({ automationId: definition(10).id, limit: 50 }), 20),
      'queued-runs-page': measure(() => allRunsFor(value => value.state === 'queued', 100), 100),
      'event-runs-page': measure(() => allRunsFor(value => value.eventId === 'event-benchmark-0010', 50), 4),
      'runs-time-range-page': measure(() => {
        const after = Date.parse('2026-01-01T01:00:00.000Z')
        const before = Date.parse('2026-01-01T03:00:00.000Z')
        return allRunsFor(value => {
          const created = Date.parse(value.createdAt)
          return created >= after && created < before
        }, 100)
      }, 100),
      'history-change-cursor-page': measure(() => this.database.query<{ payload_json: string }, [string]>(`
        SELECT payload_json FROM mortise_events WHERE stream_id = ? ORDER BY sequence
      `).all(`automations-history:${WORKSPACE_ID}`).slice(5_000, 5_100)
        .map(row => JSON.parse(row.payload_json)), 100),
      'expired-leases-page': measure(() => allRunsFor(value => value.state === 'running'
        && Boolean(value.executor) && Date.parse(value.executor!.leaseExpiresAt) <= Date.parse(FIXTURE_NOW), 100), 100),
      'due-occurrences-page': measure(() => {
        const allRuns = this.allRuns()
        const now = new Date(FIXTURE_NOW)
        return this.store.getDocument()!.definitions.flatMap(definitionValue => definitionValue.triggers.flatMap(trigger => {
          if (trigger.type !== 'time') return []
          const last = allRuns.filter(value => value.automationId === definitionValue.id
            && value.triggerId === trigger.id && value.scheduledAt)
            .sort((left, right) => (right.scheduledAt ?? '').localeCompare(left.scheduledAt ?? ''))[0]
          return this.calculateTimeOccurrence(trigger, {
            now,
            ...(last?.scheduledAt ? { lastClaimedAt: new Date(last.scheduledAt) } : {}),
          }).due ?? []
        })).slice(0, 100)
      }, 100),
    }
  }
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0
}

function summarize(samples: Sample[]): Summary {
  return Object.fromEntries(operationNames.map(name => {
    const values = samples.map(sample => sample[name])
    return [name, {
      samplesMs: values.map(value => Number(value.toFixed(3))),
      medianMs: Number(percentile(values, 0.5).toFixed(3)),
      p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    }]
  })) as Summary
}

function explain(database: Database, sql: string, bindings: Array<string | number | null>): string[] {
  return database.query<{ detail: string }, Array<string | number | null>>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...bindings).map(row => row.detail)
}

function planEvidence(
  database: Database,
  sql: string[],
  bindings: Array<Array<string | number | null>>,
  expectedIndex: string | null,
  scansFullCollection: boolean,
): QueryPlanEvidence {
  const details = sql.flatMap((statement, index) => explain(database, statement, bindings[index]!))
  return {
    sql,
    details,
    expectedIndex,
    usesExpectedIndex: expectedIndex === null || details.some(detail => detail.includes(expectedIndex)),
    scansFullCollection,
  }
}

function queryPlans(databasePath: string, strategy: Strategy): Record<OperationName, QueryPlanEvidence> {
  const database = new Database(databasePath, { readonly: true })
  const runNamespace = `automations-runs:${WORKSPACE_ID}`
  const historyStream = `automations-history:${WORKSPACE_ID}`
  const baselineHistorySql = `SELECT stream_id, sequence, event_id, event_type, schema_version, payload_json,
    writer_id, operation_id, occurred_at FROM mortise_events WHERE stream_id = ? ORDER BY sequence`
  const baselineRecordSql = `SELECT namespace, record_key, version, value_json, updated_at, writer_id
    FROM mortise_records WHERE namespace = ? AND record_key = ?`
  const baselineScan = (operationSql = baselineHistorySql, operationBindings: Array<string | number> = [historyStream]) =>
    planEvidence(database, [operationSql, baselineRecordSql], [operationBindings, [runNamespace, 'representative-run-id']], null, true)
  try {
    if (strategy === 'baseline') {
      return {
        'definitions-page': planEvidence(database, [baselineRecordSql], [[`automations-document:${WORKSPACE_ID}`, 'definitions']], 'sqlite_autoindex_mortise_records_1', false),
        'automation-runs-page': baselineScan(),
        'queued-runs-page': baselineScan(),
        'event-runs-page': baselineScan(),
        'runs-time-range-page': baselineScan(),
        'history-change-cursor-page': baselineScan(),
        'expired-leases-page': baselineScan(),
        'due-occurrences-page': baselineScan(),
      }
    }
    return {
      'definitions-page': planEvidence(database, [`SELECT ordinal, automation_id, definition_json
        FROM automation_definition_index WHERE workspace_id = ?
        AND (? IS NULL OR ordinal > ? OR (ordinal = ? AND automation_id > ?))
        ORDER BY ordinal, automation_id LIMIT ?`], [[WORKSPACE_ID, null, 0, 0, '', 101]], 'automation_definition_page', false),
      'automation-runs-page': planEvidence(database, [`SELECT i.run_id, i.created_at_ms, r.value_json
        FROM automation_run_index i JOIN mortise_records r
        WHERE i.workspace_id = ? AND r.namespace = ? AND r.record_key = i.run_id
        AND r.version = i.record_version AND i.automation_id = ?
        ORDER BY i.created_at_ms DESC, i.run_id DESC LIMIT ?`], [[WORKSPACE_ID, runNamespace, definition(10).id, 51]], 'automation_run_by_automation', false),
      'queued-runs-page': planEvidence(database, [`SELECT i.run_id, i.created_at_ms, r.value_json
        FROM automation_run_index i JOIN mortise_records r
        WHERE i.workspace_id = ? AND r.namespace = ? AND r.record_key = i.run_id
        AND r.version = i.record_version AND i.state IN (?)
        ORDER BY i.created_at_ms DESC, i.run_id DESC LIMIT ?`], [[WORKSPACE_ID, runNamespace, 'queued', 101]], 'automation_run_by_state', false),
      'event-runs-page': planEvidence(database, [`SELECT i.run_id, i.created_at_ms, r.value_json
        FROM automation_run_index i JOIN mortise_records r
        WHERE i.workspace_id = ? AND r.namespace = ? AND r.record_key = i.run_id
        AND r.version = i.record_version AND i.event_id = ?
        ORDER BY i.created_at_ms DESC, i.run_id DESC LIMIT ?`], [[WORKSPACE_ID, runNamespace, 'event-benchmark-0010', 51]], 'automation_run_by_event', false),
      'runs-time-range-page': planEvidence(database, [`SELECT i.run_id, i.created_at_ms, r.value_json
        FROM automation_run_index i JOIN mortise_records r
        WHERE i.workspace_id = ? AND r.namespace = ? AND r.record_key = i.run_id
        AND r.version = i.record_version AND i.created_at_ms >= ? AND i.created_at_ms < ?
        ORDER BY i.created_at_ms DESC, i.run_id DESC LIMIT ?`], [[WORKSPACE_ID, runNamespace,
        Date.parse('2026-01-01T01:00:00.000Z'), Date.parse('2026-01-01T03:00:00.000Z'), 101]], 'automation_run_by_created', false),
      'history-change-cursor-page': planEvidence(database, [`SELECT sequence, event_type AS kind, payload_json, occurred_at
        FROM mortise_events WHERE stream_id = ? AND sequence > ?
        ORDER BY sequence LIMIT ?`], [[historyStream, 5_000, 101]], 'mortise_events_stream_sequence', false),
      'expired-leases-page': planEvidence(database, [`SELECT i.run_id, i.record_version, i.lease_expires_at_ms,
        r.version AS canonical_version, r.value_json FROM automation_run_index i INDEXED BY automation_run_expired_lease
        LEFT JOIN mortise_records r ON r.namespace = ? AND r.record_key = i.run_id
        WHERE i.workspace_id = ? AND i.state = 'running' AND i.lease_expires_at_ms <= ?
        ORDER BY i.lease_expires_at_ms, i.run_id LIMIT ?`], [[runNamespace, WORKSPACE_ID, Date.parse(FIXTURE_NOW), 100]], 'automation_run_expired_lease', false),
      'due-occurrences-page': planEvidence(database, [`SELECT s.definition_revision, d.definition_json, s.trigger_json,
        s.next_due_at_ms, s.last_claimed_at_ms FROM automation_schedule_index s INDEXED BY automation_schedule_due
        JOIN automation_definition_index d ON d.workspace_id = s.workspace_id AND d.automation_id = s.automation_id
        WHERE s.workspace_id = ? AND s.enabled = 1 AND s.next_due_at_ms <= ?
        ORDER BY s.next_due_at_ms, s.automation_id, s.trigger_id LIMIT ?`], [[WORKSPACE_ID, Date.parse(FIXTURE_NOW), 100]], 'automation_schedule_due', false),
    }
  } finally {
    database.close()
  }
}

function evaluate(
  strategies: Record<Strategy, StrategySummary>,
  plans: Record<Strategy, Record<OperationName, QueryPlanEvidence>>,
  policy: PerformancePolicy,
) {
  const operationSetMatches = policy.operations.map(item => item.name).join('|') === operationNames.join('|')
  const operations = Object.fromEntries(operationNames.map(name => {
    const warm = strategies.candidate.warm[name]
    const cold = strategies.candidate.coldProcess[name]
    const baselineWarm = strategies.baseline.warm[name]
    const baselineCold = strategies.baseline.coldProcess[name]
    const warmDeltaPercent = ((warm.p95Ms / baselineWarm.p95Ms) - 1) * 100
    const coldDeltaPercent = ((cold.p95Ms / baselineCold.p95Ms) - 1) * 100
    const candidatePlan = plans.candidate[name]
    const planUsesIndex = candidatePlan.usesExpectedIndex && !candidatePlan.scansFullCollection
    const samplesWithinTimeout = [
      ...strategies.baseline.warm[name].samplesMs,
      ...strategies.baseline.coldProcess[name].samplesMs,
      ...warm.samplesMs,
      ...cold.samplesMs,
    ].every(value => value <= policy.sampling.timeoutMsPerOperation)
    const passed = warm.p95Ms <= policy.budgets.absoluteWarmP95Ms
      && cold.p95Ms <= policy.budgets.absoluteColdP95Ms
      && warmDeltaPercent <= policy.budgets.relativeRegressionCeilingPercent
      && coldDeltaPercent <= policy.budgets.relativeRegressionCeilingPercent
      && planUsesIndex
      && samplesWithinTimeout
    return [name, {
      passed,
      candidateWarmP95Ms: warm.p95Ms,
      candidateColdP95Ms: cold.p95Ms,
      baselineWarmP95Ms: baselineWarm.p95Ms,
      baselineColdP95Ms: baselineCold.p95Ms,
      warmDeltaPercent: Number(warmDeltaPercent.toFixed(2)),
      coldDeltaPercent: Number(coldDeltaPercent.toFixed(2)),
      planUsesIndex,
      samplesWithinTimeout,
    }]
  })) as Record<OperationName, { passed: boolean }>
  return {
    operationSetMatches,
    operations,
    overallPassed: operationSetMatches && Object.values(operations).every(result => result.passed),
  }
}

function childSample(scriptPath: string, checkout: string, databasePath: string, strategy: Strategy): Sample {
  const child = Bun.spawnSync([process.execPath, scriptPath, '--sample', checkout, databasePath, strategy], {
    cwd: repositoryRoot(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (child.exitCode !== 0) throw new Error(child.stderr.toString())
  return JSON.parse(child.stdout.toString()) as Sample
}

function repositoryRoot(): string {
  return resolve(import.meta.dir, '../..')
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function sampleMode(): Promise<boolean> {
  if (process.argv[2] !== '--sample') return false
  const checkout = resolve(process.argv[3]!)
  const databasePath = resolve(process.argv[4]!)
  const strategy = process.argv[5] as Strategy
  const session = await BenchmarkSession.open(checkout, databasePath, strategy)
  try {
    process.stdout.write(JSON.stringify(session.sample()))
  } finally {
    session.close()
  }
  return true
}

async function main(): Promise<void> {
  if (await sampleMode()) return
  const root = repositoryRoot()
  const policyPath = resolve(root, 'docs/architecture/optimization-evidence/opt-015-performance-policy.json')
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as PerformancePolicy
  const baselinePath = argument('--baseline-checkout')
  if (!baselinePath) {
    throw new Error('A frozen base worktree is required: --baseline-checkout <path>')
  }
  const candidatePath = argument('--candidate-checkout') ?? root
  const allowDirtyCandidate = process.argv.includes('--allow-dirty-candidate')
  const allowRuntimeVersionMismatch = process.argv.includes('--allow-runtime-version-mismatch')
  const baseline = checkoutIdentity(baselinePath, false)
  const candidate = checkoutIdentity(candidatePath, allowDirtyCandidate)
  if (baseline.path === candidate.path) throw new Error('Base and final benchmark checkouts must be different')
  if (baseline.revision !== policy.baselineRevision) {
    throw new Error(`Benchmark baseline must be frozen at ${policy.baselineRevision}; received ${baseline.revision}`)
  }
  const pinnedBunMatch = readFileSync(join(candidate.path, 'scripts/build/common.ts'), 'utf8')
    .match(/export const BUN_VERSION = 'bun-v([^']+)'/)
  if (!pinnedBunMatch) throw new Error('Unable to resolve the repository-pinned Bun version')
  const pinnedBunVersion = pinnedBunMatch[1]!
  if (Bun.version !== pinnedBunVersion && !allowRuntimeVersionMismatch) {
    throw new Error(`Benchmark requires repository-pinned Bun ${pinnedBunVersion}; running ${Bun.version}`)
  }
  const fixtureMatches = policy.fixture.workspaces === 1
    && policy.fixture.definitions === DEFINITIONS
    && policy.fixture.runs === RUNS
    && policy.fixture.events === EVENTS
    && policy.fixture.expiredLeases === 250
    && policy.fixture.timeTriggers === DEFINITIONS
  if (!fixtureMatches) throw new Error('Benchmark constants do not match the frozen OPT-015 fixture policy')
  if (policy.sampling.warmup !== 1 || policy.sampling.warmSamples !== 10
    || policy.sampling.coldProcessSamples !== 10) {
    throw new Error('Benchmark sampling does not match the frozen OPT-015 policy')
  }

  const outputPath = resolve(argument('--output') ?? join(root, 'output/architecture-v2/opt015-index-performance.json'))
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'mortise-opt015-index-'))
  try {
    const databasePaths = {
      baseline: await prepareFixture(baseline.path, temporaryRoot, 'baseline'),
      candidate: await prepareFixture(candidate.path, temporaryRoot, 'candidate'),
    }
    const plans = {
      baseline: queryPlans(databasePaths.baseline, 'baseline'),
      candidate: queryPlans(databasePaths.candidate, 'candidate'),
    }
    const strategies = {} as Record<Strategy, StrategySummary>
    for (const strategy of ['baseline', 'candidate'] as const) {
      const checkout = strategy === 'baseline' ? baseline.path : candidate.path
      const warmSession = await BenchmarkSession.open(checkout, databasePaths[strategy], strategy)
      let warm: Sample[]
      try {
        for (let index = 0; index < policy.sampling.warmup; index++) warmSession.sample()
        warm = Array.from({ length: policy.sampling.warmSamples }, () => warmSession.sample())
      } finally {
        warmSession.close()
      }
      const cold = Array.from({ length: policy.sampling.coldProcessSamples }, () => childSample(
        import.meta.path,
        checkout,
        databasePaths[strategy],
        strategy,
      ))
      strategies[strategy] = { warm: summarize(warm), coldProcess: summarize(cold) }
    }
    const evaluation = evaluate(strategies, plans, policy)
    const report = {
      schema: 'mortise/automation-query-performance-evidence/v2',
      generatedAt: new Date().toISOString(),
      policy: {
        path: policyPath,
        sha256: sha256File(policyPath),
        baselineRevision: policy.baselineRevision,
        sampling: policy.sampling,
        budgets: policy.budgets,
      },
      environment: {
        platform: process.platform,
        arch: process.arch,
        bunVersion: Bun.version,
        pinnedBunVersion,
        bunExecutable: process.execPath,
        bunExecutableSha256: sha256File(process.execPath),
        runtimeVersionOverride: Bun.version !== pinnedBunVersion,
      },
      fixture: policy.fixture,
      checkouts: { baseline, candidate },
      strategies,
      queryPlans: plans,
      evaluation,
    }
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(outputPath)
    if (!evaluation.overallPassed) throw new Error(`Automation index benchmark failed its frozen policy: ${outputPath}`)
  } finally {
    Bun.gc(true)
    let cleanupError: unknown
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(temporaryRoot, { recursive: true, force: true })
        cleanupError = undefined
        break
      } catch (error) {
        cleanupError = error
        await Bun.sleep(100)
      }
    }
    if (cleanupError) console.error(`Benchmark fixture cleanup failed: ${String(cleanupError)}`)
  }
}

await main()
