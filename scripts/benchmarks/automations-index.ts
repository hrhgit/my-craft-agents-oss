import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AutomationV3Store } from '../../packages/shared/src/automations/v3-store.ts'
import { calculateTimeOccurrence } from '../../packages/shared/src/scheduler/occurrences.ts'
import type { AutomationDefinitionV3, AutomationRunV1 } from '../../packages/shared/src/automations/v3-types.ts'

const WORKSPACE_ID = 'opt-015-index-workspace'
const DEFINITIONS = 500
const RUNS = 10_000
const EVENTS = 2_500
const WARM_SAMPLES = 10
const COLD_SAMPLES = 10
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
type Sample = Record<OperationName, number>
type Summary = Record<OperationName, { samplesMs: number[]; medianMs: number; p95Ms: number }>
type StrategySummary = { warm: Summary; coldProcess: Summary }

interface PerformancePolicy {
  operations: Array<{ name: OperationName }>
  noisePolicy?: string
  sampling: { timeoutMsPerOperation: number }
  budgets: {
    absoluteWarmP95Ms: number
    absoluteColdP95Ms: number
    relativeRegressionCeilingPercent: number
  }
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
  return {
    schemaVersion: 1,
    runId: `run-benchmark-${suffix}`,
    occurrenceId: `occurrence-benchmark-${suffix}`,
    occurrenceKey: `benchmark-${suffix}`,
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
      actionRunId: `action-run-benchmark-${suffix}`,
      actionId: definitionValue.actions[0]!.id,
      state: state === 'running' ? 'running' : state === 'queued' ? 'queued' : state === 'succeeded' ? 'succeeded' : 'skipped',
      attempts: state === 'queued' ? 0 : 1,
    }],
  }
}

function prepareFixture(root: string): string {
  const databasePath = join(root, 'automations-v3.sqlite')
  const store = new AutomationV3Store({
    workspaceId: WORKSPACE_ID,
    workspaceRootPath: root,
    databasePath,
    writerId: 'benchmark-seed',
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
  database.exec('BEGIN IMMEDIATE')
  try {
    const insertRecord = database.prepare(`
      INSERT INTO mortise_records
        (namespace, record_key, version, value_json, updated_at, writer_id)
      VALUES (?, ?, 1, ?, ?, 'benchmark-seed')
    `)
    const insertRun = database.prepare(`
      INSERT INTO automation_run_index
        (workspace_id, run_id, record_version, automation_id, trigger_id, event_id, state,
         created_at_ms, scheduled_at_ms, lease_expires_at_ms)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL, ?)
    `)
    const insertEvent = database.prepare(`
      INSERT INTO mortise_events
        (event_id, stream_id, sequence, event_type, schema_version, payload_json,
         writer_id, operation_id, occurred_at)
      VALUES (?, ?, ?, ?, 1, ?, 'benchmark-seed', ?, ?)
    `)
    const insertHistory = database.prepare(`
      INSERT INTO automation_history_index
        (workspace_id, sequence, event_id, kind, automation_id, run_id, occurred_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    let sequence = 2
    for (let index = 0; index < RUNS; index++) {
      const value = run(index, definitions)
      const createdAtMs = Date.parse(value.createdAt)
      insertRecord.run(`automations-runs:${WORKSPACE_ID}`, value.runId, JSON.stringify(value), createdAtMs)
      insertRun.run(
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
      const ledgerId = `ledger-run-${index}`
      const payload = JSON.stringify({
        runId: value.runId,
        automationId: value.automationId,
        state: value.state,
      })
      insertEvent.run(
        ledgerId,
        `automations-history:${WORKSPACE_ID}`,
        sequence,
        'run.created',
        payload,
        `benchmark-ledger-run-${index}`,
        createdAtMs,
      )
      insertHistory.run(WORKSPACE_ID, sequence, ledgerId, 'run.created', value.automationId, value.runId, createdAtMs)
    }
    for (let index = 0; index < EVENTS; index++) {
      sequence += 1
      const eventId = `event-benchmark-${index.toString().padStart(4, '0')}`
      const ledgerId = `ledger-event-${index}`
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
      insertHistory.run(WORKSPACE_ID, sequence, ledgerId, 'event.accepted', null, null, occurredAt)
    }
    database.prepare(`
      INSERT INTO mortise_stream_heads (stream_id, last_sequence) VALUES (?, ?)
      ON CONFLICT(stream_id) DO UPDATE SET last_sequence = excluded.last_sequence
    `).run(`automations-history:${WORKSPACE_ID}`, sequence)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.close()
  }
  return databasePath
}

function measure(operation: () => unknown): number {
  const startedAt = performance.now()
  const result = operation()
  if (result === undefined || result === null) throw new Error('Benchmark operation returned no result')
  return performance.now() - startedAt
}

class BenchmarkSession {
  readonly store: AutomationV3Store
  readonly database: Database
  private readonly definitions: AutomationDefinitionV3[]

  constructor(readonly databasePath: string, readonly strategy: 'baseline' | 'candidate') {
    this.store = new AutomationV3Store({
      workspaceId: WORKSPACE_ID,
      workspaceRootPath: dirname(databasePath),
      databasePath,
      writerId: `benchmark-${strategy}-${process.pid}`,
    })
    this.database = new Database(databasePath, { readonly: true })
    this.definitions = this.store.getDocument()!.definitions
  }

  close(): void {
    this.database.close()
    this.store.close()
  }

  sample(): Sample {
    return this.strategy === 'candidate' ? this.candidateSample() : this.baselineSample()
  }

  private allRuns(): AutomationRunV1[] {
    return this.database.query<{ value_json: string }, [string]>(`
      SELECT value_json FROM mortise_records WHERE namespace = ?
    `).all(`automations-runs:${WORKSPACE_ID}`).map(row => JSON.parse(row.value_json) as AutomationRunV1)
  }

  private candidateSample(): Sample {
    return {
      'definitions-page': measure(() => this.store.listDefinitionsPage({ limit: 100 }).items),
      'automation-runs-page': measure(() => this.store.listRunsPage({ automationId: definition(10).id, limit: 50 }).items),
      'queued-runs-page': measure(() => this.store.listRunsPage({ states: ['queued'], limit: 100 }).items),
      'event-runs-page': measure(() => this.store.listRunsPage({ eventId: 'event-benchmark-0010', limit: 50 }).items),
      'runs-time-range-page': measure(() => this.store.listRunsPage({
        createdAfter: Date.parse('2026-01-01T01:00:00.000Z'),
        createdBefore: Date.parse('2026-01-01T03:00:00.000Z'),
        limit: 100,
      }).items),
      'history-change-cursor-page': measure(() => this.store.readHistoryChanges({
        afterSequence: 5_000,
        limit: 100,
      }).items),
      'expired-leases-page': measure(() => this.store.listExpiredExecutionLeases(new Date('2026-07-26T00:00:00.000Z'), 100)),
      'due-occurrences-page': measure(() => this.store.listDueOccurrences(new Date('2026-07-26T00:00:00.000Z'), 100)),
    }
  }

  private baselineSample(): Sample {
    return {
      'definitions-page': measure(() => this.store.getDocument()!.definitions.slice(0, 100)),
      'automation-runs-page': measure(() => this.allRuns()
        .filter(value => value.automationId === definition(10).id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50)),
      'queued-runs-page': measure(() => this.allRuns()
        .filter(value => value.state === 'queued')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100)),
      'event-runs-page': measure(() => this.allRuns()
        .filter(value => value.eventId === 'event-benchmark-0010')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50)),
      'runs-time-range-page': measure(() => {
        const after = Date.parse('2026-01-01T01:00:00.000Z')
        const before = Date.parse('2026-01-01T03:00:00.000Z')
        return this.allRuns().filter(value => {
          const created = Date.parse(value.createdAt)
          return created >= after && created < before
        }).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100)
      }),
      'history-change-cursor-page': measure(() => this.database.query<{ payload_json: string }, [string]>(`
        SELECT payload_json FROM mortise_events WHERE stream_id = ? ORDER BY sequence
      `).all(`automations-history:${WORKSPACE_ID}`).slice(5_000, 5_100).map(row => JSON.parse(row.payload_json))),
      'expired-leases-page': measure(() => this.allRuns().filter(value => value.state === 'running'
        && value.executor && Date.parse(value.executor.leaseExpiresAt) <= Date.parse('2026-07-26T00:00:00.000Z')).slice(0, 100)),
      'due-occurrences-page': measure(() => {
        const allRuns = this.allRuns()
        const now = new Date('2026-07-26T00:00:00.000Z')
        return this.definitions.flatMap(definitionValue => definitionValue.triggers.flatMap(trigger => {
          if (trigger.type !== 'time') return []
          const last = allRuns.filter(value => value.automationId === definitionValue.id
            && value.triggerId === trigger.id && value.scheduledAt)
            .sort((left, right) => (right.scheduledAt ?? '').localeCompare(left.scheduledAt ?? ''))[0]
          return calculateTimeOccurrence(trigger, {
            now,
            ...(last?.scheduledAt ? { lastClaimedAt: new Date(last.scheduledAt) } : {}),
          }).due ?? []
        })).slice(0, 100)
      }),
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
  }))
}

function evaluate(
  strategies: Record<'baseline' | 'candidate', StrategySummary>,
  plans: Record<OperationName, Array<{ detail: string }>>,
  policy: PerformancePolicy,
) {
  const operationSetMatches = policy.operations.map(item => item.name).join('|') === operationNames.join('|')
  const expectedIndexes: Record<OperationName, string> = {
    'definitions-page': 'automation_definition_page',
    'automation-runs-page': 'automation_run_by_automation',
    'queued-runs-page': 'automation_run_by_state',
    'event-runs-page': 'automation_run_by_event',
    'runs-time-range-page': 'automation_run_by_created',
    'history-change-cursor-page': 'sqlite_autoindex_automation_history_index_1',
    'expired-leases-page': 'automation_run_expired_lease',
    'due-occurrences-page': 'automation_schedule_due',
  }
  const operations = Object.fromEntries(operationNames.map(name => {
    const warm = strategies.candidate.warm[name]
    const cold = strategies.candidate.coldProcess[name]
    const baselineWarm = strategies.baseline.warm[name]
    const baselineCold = strategies.baseline.coldProcess[name]
    const warmDeltaPercent = ((warm.p95Ms / baselineWarm.p95Ms) - 1) * 100
    const coldDeltaPercent = ((cold.p95Ms / baselineCold.p95Ms) - 1) * 100
    const planDetails = plans[name].map(row => row.detail)
    const planUsesIndex = planDetails.some(detail => detail.includes(`USING`) && detail.includes(expectedIndexes[name]))
      && planDetails.every(detail => !detail.includes('SCAN '))
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
      warmDeltaPercent: Number(warmDeltaPercent.toFixed(2)),
      coldDeltaPercent: Number(coldDeltaPercent.toFixed(2)),
      planUsesIndex,
      samplesWithinTimeout,
      planDetails,
    }]
  })) as Record<OperationName, { passed: boolean }>
  return {
    operationSetMatches,
    operations,
    overallPassed: operationSetMatches && Object.values(operations).every(result => result.passed),
  }
}

function queryPlans(databasePath: string) {
  const database = new Database(databasePath, { readonly: true })
  const runNamespace = `automations-runs:${WORKSPACE_ID}`
  const historyStream = `automations-history:${WORKSPACE_ID}`
  const plans = {
    'definitions-page': database.query('EXPLAIN QUERY PLAN SELECT automation_id FROM automation_definition_index WHERE workspace_id = ? ORDER BY ordinal, automation_id LIMIT 100').all(WORKSPACE_ID),
    'automation-runs-page': database.query(`EXPLAIN QUERY PLAN SELECT i.run_id, r.value_json FROM automation_run_index i INDEXED BY automation_run_by_automation JOIN mortise_records r WHERE i.workspace_id = ? AND r.namespace = ? AND r.record_key = i.run_id AND r.version = i.record_version AND i.automation_id = ? ORDER BY i.created_at_ms DESC, i.run_id DESC LIMIT 50`).all(WORKSPACE_ID, runNamespace, definition(10).id),
    'queued-runs-page': database.query(`EXPLAIN QUERY PLAN SELECT i.run_id, r.value_json FROM automation_run_index i INDEXED BY automation_run_by_state JOIN mortise_records r WHERE i.workspace_id = ? AND r.namespace = ? AND r.record_key = i.run_id AND r.version = i.record_version AND i.state = 'queued' ORDER BY i.created_at_ms DESC, i.run_id DESC LIMIT 100`).all(WORKSPACE_ID, runNamespace),
    'event-runs-page': database.query(`EXPLAIN QUERY PLAN SELECT i.run_id, r.value_json FROM automation_run_index i INDEXED BY automation_run_by_event JOIN mortise_records r WHERE i.workspace_id = ? AND r.namespace = ? AND r.record_key = i.run_id AND r.version = i.record_version AND i.event_id = ? ORDER BY i.created_at_ms DESC, i.run_id DESC LIMIT 50`).all(WORKSPACE_ID, runNamespace, 'event-benchmark-0010'),
    'runs-time-range-page': database.query(`EXPLAIN QUERY PLAN SELECT i.run_id, r.value_json FROM automation_run_index i INDEXED BY automation_run_by_created JOIN mortise_records r WHERE i.workspace_id = ? AND r.namespace = ? AND r.record_key = i.run_id AND r.version = i.record_version AND i.created_at_ms >= ? AND i.created_at_ms < ? ORDER BY i.created_at_ms DESC, i.run_id DESC LIMIT 100`).all(WORKSPACE_ID, runNamespace, 0, Date.now()),
    'history-change-cursor-page': database.query(`EXPLAIN QUERY PLAN SELECT i.sequence, e.payload_json FROM automation_history_index i JOIN mortise_events e WHERE i.workspace_id = ? AND e.stream_id = ? AND e.sequence = i.sequence AND i.sequence > ? ORDER BY i.sequence LIMIT 100`).all(WORKSPACE_ID, historyStream, 5_000),
    'expired-leases-page': database.query(`EXPLAIN QUERY PLAN SELECT i.run_id, r.version, r.value_json FROM automation_run_index i INDEXED BY automation_run_expired_lease LEFT JOIN mortise_records r ON r.namespace = ? AND r.record_key = i.run_id WHERE i.workspace_id = ? AND i.state = 'running' AND i.lease_expires_at_ms <= ? ORDER BY i.lease_expires_at_ms, i.run_id LIMIT 100`).all(runNamespace, WORKSPACE_ID, Date.now()),
    'due-occurrences-page': database.query(`EXPLAIN QUERY PLAN SELECT s.automation_id, d.definition_json FROM automation_schedule_index s INDEXED BY automation_schedule_due JOIN automation_definition_index d ON d.workspace_id = s.workspace_id AND d.automation_id = s.automation_id WHERE s.workspace_id = ? AND s.enabled = 1 AND s.next_due_at_ms <= ? ORDER BY s.next_due_at_ms, s.automation_id, s.trigger_id LIMIT 100`).all(WORKSPACE_ID, Date.now()),
  }
  database.close()
  return plans
}

function childSample(databasePath: string, strategy: 'baseline' | 'candidate'): Sample {
  const child = Bun.spawnSync([process.execPath, import.meta.path, '--sample', databasePath, strategy], {
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

async function main(): Promise<void> {
  if (process.argv[2] === '--sample') {
    const session = new BenchmarkSession(resolve(process.argv[3]!), process.argv[4] as 'baseline' | 'candidate')
    try {
      process.stdout.write(JSON.stringify(session.sample()))
    } finally {
      session.close()
    }
    return
  }

  const outputIndex = process.argv.indexOf('--output')
  const outputPath = outputIndex >= 0
    ? resolve(process.argv[outputIndex + 1]!)
    : resolve(repositoryRoot(), 'output/architecture-v2/opt015-index-performance.json')
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'mortise-opt015-index-'))
  try {
    const databasePath = prepareFixture(temporaryRoot)
    const policyPath = resolve(repositoryRoot(), 'docs/architecture/optimization-evidence/opt-015-performance-policy.json')
    const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as PerformancePolicy
    const plans = queryPlans(databasePath) as Record<OperationName, Array<{ detail: string }>>
    const strategies = {} as Record<'baseline' | 'candidate', StrategySummary>
    const report: Record<string, unknown> = {
      schema: 'mortise/automation-query-performance-evidence/v1',
      generatedAt: new Date().toISOString(),
      fixture: { definitions: DEFINITIONS, runs: RUNS, events: EVENTS, expiredLeases: 250, timeTriggers: 500 },
      policy: { path: policyPath, budgets: policy.budgets, timeoutMsPerOperation: policy.sampling.timeoutMsPerOperation },
      strategies,
      queryPlans: plans,
    }
    for (const strategy of ['baseline', 'candidate'] as const) {
      const warmSession = new BenchmarkSession(databasePath, strategy)
      let warm: Sample[]
      try {
        warmSession.sample()
        warm = Array.from({ length: WARM_SAMPLES }, () => warmSession.sample())
      } finally {
        warmSession.close()
      }
      const cold = Array.from({ length: COLD_SAMPLES }, () => childSample(databasePath, strategy))
      strategies[strategy] = {
        warm: summarize(warm),
        coldProcess: summarize(cold),
      }
    }
    const evaluation = evaluate(strategies, plans, policy)
    report.evaluation = evaluation
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
