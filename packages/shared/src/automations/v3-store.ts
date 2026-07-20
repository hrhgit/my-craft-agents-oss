import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CapabilityReadOnlyError,
  MultiWriterStore,
  OperationIdentityConflictError,
  type JsonValue,
} from '../storage/index.ts'
import { resolveAutomationsConfigPath } from './resolve-config-path.ts'
import { validateAutomationsConfig } from './validation.ts'
import { migrateAutomationsConfigV2 } from './v3-migration.ts'
import { commitLegacyPromptAutomationMigration, planLegacyPromptAutomationMigration } from './v3-prompt-automation-migration.ts'
import { AutomationsDocumentV3Schema, CloudEventV1Schema } from './v3-schemas.ts'
import type {
  AutomationCapabilityResultV1,
  AutomationMigrationResultV1,
  AutomationRunV1,
  AutomationsDocumentV3,
  CloudEventV1,
  TrustedAutomationEventV1,
} from './v3-types.ts'

const DATABASE_NAME = 'automations-v3.sqlite'
const DOCUMENT_KEY = 'definitions'
const AUTOMATION_CAPABILITIES = {
  'automations.definitions': { minWriteVersion: 3, maxWriteVersion: 3 },
  'automations.ingress': { minWriteVersion: 1, maxWriteVersion: 1 },
  'automations.runs': { minWriteVersion: 1, maxWriteVersion: 1 },
  'automations.history': { minWriteVersion: 1, maxWriteVersion: 1 },
} as const

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

export function automationIdentity(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${createHash('sha256').update(canonical(parts)).digest('hex')}`
}

function json<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function parseRun(value: JsonValue): AutomationRunV1 {
  return value as unknown as AutomationRunV1
}

function sameAcceptedEvent(left: TrustedAutomationEventV1, right: TrustedAutomationEventV1): boolean {
  const { acceptedAt: _leftAcceptedAt, ...leftSemantic } = left
  const { acceptedAt: _rightAcceptedAt, ...rightSemantic } = right
  return canonical(leftSemantic) === canonical(rightSemantic)
}

const RUN_TRANSITIONS: Record<AutomationRunV1['state'], ReadonlySet<AutomationRunV1['state']>> = {
  queued: new Set(['queued', 'running', 'cancelled', 'skipped']),
  running: new Set(['running', 'succeeded', 'partial', 'failed', 'cancelled']),
  succeeded: new Set(['succeeded']),
  partial: new Set(['partial']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
  skipped: new Set(['skipped']),
}

const ACTION_TRANSITIONS: Record<AutomationRunV1['actions'][number]['state'], ReadonlySet<AutomationRunV1['actions'][number]['state']>> = {
  queued: new Set(['queued', 'running', 'skipped', 'cancelled']),
  running: new Set(['running', 'succeeded', 'failed', 'blocked', 'cancelled']),
  succeeded: new Set(['succeeded']),
  failed: new Set(['failed']),
  blocked: new Set(['blocked']),
  cancelled: new Set(['cancelled']),
  skipped: new Set(['skipped']),
}

function assertMonotonicRunTransition(current: AutomationRunV1, next: AutomationRunV1): void {
  if (current.runId !== next.runId || current.occurrenceId !== next.occurrenceId
    || current.automationId !== next.automationId || current.triggerId !== next.triggerId
    || current.definitionRevision !== next.definitionRevision
    || canonical(current.definitionSnapshot) !== canonical(next.definitionSnapshot)) {
    throw new Error('Automation run immutable identities cannot change')
  }
  if (!RUN_TRANSITIONS[current.state].has(next.state)) throw new Error(`Invalid automation run transition: ${current.state} -> ${next.state}`)
  if (current.actions.length !== next.actions.length) throw new Error('Automation action run set cannot change')
  for (let index = 0; index < current.actions.length; index++) {
    const before = current.actions[index]!
    const after = next.actions[index]!
    if (before.actionRunId !== after.actionRunId || before.actionId !== after.actionId) throw new Error('Automation action immutable identities cannot change')
    if (!ACTION_TRANSITIONS[before.state].has(after.state)) throw new Error(`Invalid automation action transition: ${before.state} -> ${after.state}`)
  }
}

export interface AutomationV3StoreOptions {
  workspaceId: string
  workspaceRootPath: string
  databasePath?: string
  writerId?: string
  legacyGlobalConfigPath?: string | null
}

export interface AcceptCloudEventOptions {
  sourceKind: TrustedAutomationEventV1['sourceKind']
  matchValue?: string
  validateSession?: (sessionId: string, workspaceId: string) => boolean
}

export class AutomationV3Store {
  readonly workspaceId: string
  readonly workspaceRootPath: string
  readonly databasePath: string
  readonly writerId: string
  private readonly legacyGlobalConfigPath: string | null | undefined
  private readonly store: MultiWriterStore

  constructor(options: AutomationV3StoreOptions) {
    this.workspaceId = options.workspaceId
    this.workspaceRootPath = options.workspaceRootPath
    this.databasePath = options.databasePath ?? join(options.workspaceRootPath, '.mortise', DATABASE_NAME)
    mkdirSync(dirname(this.databasePath), { recursive: true })
    this.writerId = options.writerId ?? `automations-${process.pid}-${randomUUID()}`
    this.legacyGlobalConfigPath = options.legacyGlobalConfigPath
    this.store = MultiWriterStore.openSync({
      databasePath: this.databasePath,
      writerId: this.writerId,
      writerVersion: 1,
      capabilities: AUTOMATION_CAPABILITIES,
    })
  }

  isWritable(): boolean {
    return Object.keys(AUTOMATION_CAPABILITIES).every(capability => this.store.isCapabilityWritable(capability))
  }

  private assertWritable(): void {
    for (const [capability, range] of Object.entries(AUTOMATION_CAPABILITIES)) {
      if (!this.store.isCapabilityWritable(capability)) {
        throw new CapabilityReadOnlyError(capability, this.store.getCapabilityVersion(capability), range)
      }
    }
  }

  close(): void {
    this.store.close()
  }

  getDocument(): AutomationsDocumentV3 | null {
    const record = this.store.getRecord(this.documentNamespace(), DOCUMENT_KEY)
    if (!record) return null
    const parsed = AutomationsDocumentV3Schema.parse(record.value) as AutomationsDocumentV3
    if (parsed.revision !== record.version) throw new Error('Automation document revision does not match canonical store version')
    return parsed
  }

  initializeOrMigrate(): { document: AutomationsDocumentV3; migration?: AutomationMigrationResultV1 } {
    const current = this.getDocument()
    if (current) return { document: current }
    this.assertWritable()

    const configPath = resolveAutomationsConfigPath(this.workspaceRootPath)
    let migration: AutomationMigrationResultV1 | undefined
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
      const v3 = AutomationsDocumentV3Schema.safeParse(raw)
      if (v3.success) {
        migration = { document: { ...v3.data, revision: 1 } as AutomationsDocumentV3, aliases: {}, diagnostics: [] }
      } else {
        const v2 = validateAutomationsConfig(raw)
        if (!v2.valid || !v2.config) throw new Error(`Cannot migrate invalid automations config: ${v2.errors.join('; ')}`)
        migration = migrateAutomationsConfigV2(v2.config, { workspaceId: this.workspaceId, initialRevision: 1 })
      }
    }
    const legacyPlan = planLegacyPromptAutomationMigration(this.workspaceId, this.workspaceRootPath, new Date(), {
      globalConfigPath: this.legacyGlobalConfigPath,
    })
    const baseDocument = migration?.document ?? { schemaVersion: 3 as const, revision: 1, definitions: [] }
    const existingIds = new Set(baseDocument.definitions.map(item => item.id))
    const legacyDefinitions = legacyPlan.definitions.filter(item => !existingIds.has(item.id))
    const document: AutomationsDocumentV3 = {
      ...baseDocument,
      definitions: [...baseDocument.definitions, ...legacyDefinitions],
    }
    if (legacyPlan.sources.length > 0) {
      migration = {
        document,
        aliases: migration?.aliases ?? {},
        diagnostics: [...(migration?.diagnostics ?? []), ...legacyPlan.diagnostics],
      }
    }
    const operationId = automationIdentity('op_migration', this.workspaceId, migration ?? document)
    const result = this.store.mutateRecord({
      capability: 'automations.definitions',
      namespace: this.documentNamespace(),
      key: DOCUMENT_KEY,
      value: json(document),
      expectedVersion: null,
      operationId,
    })
    if (result.status === 'conflict') {
      const raced = this.getDocument()
      if (!raced) throw new Error('Automation document initialization conflicted without a current document')
      if (legacyPlan.definitions.every(item => raced.definitions.some(definition => definition.id === item.id))) {
        commitLegacyPromptAutomationMigration(this.workspaceRootPath, legacyPlan)
      }
      return { document: raced }
    }
    const committed = AutomationsDocumentV3Schema.parse(result.value) as AutomationsDocumentV3
    commitLegacyPromptAutomationMigration(this.workspaceRootPath, legacyPlan)
    return { document: committed, ...(migration ? { migration } : {}) }
  }

  mutateDocument(input: {
    operationId: string
    expectedRevision: number | null
    document: AutomationsDocumentV3
  }): AutomationCapabilityResultV1<AutomationsDocumentV3> {
    this.assertWritable()
    const current = this.getDocument()
    const expected = input.expectedRevision
    const nextRevision = (expected ?? 0) + 1
    const candidate = AutomationsDocumentV3Schema.safeParse({ ...input.document, revision: nextRevision })
    if (!candidate.success) {
      return {
        schemaVersion: 1,
        operationId: input.operationId,
        status: 'invalid',
        revision: current?.revision,
        error: { code: 'invalid_document', message: candidate.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), retryable: false },
      }
    }
    try {
      const result = this.store.mutateRecord({
        capability: 'automations.definitions',
        namespace: this.documentNamespace(),
        key: DOCUMENT_KEY,
        value: json(candidate.data),
        expectedVersion: expected,
        operationId: input.operationId,
      })
      if (result.status === 'conflict') {
        const latest = this.getDocument()
        return { schemaVersion: 1, operationId: input.operationId, status: 'conflict', revision: latest?.revision, ...(latest ? { data: latest } : {}) }
      }
      return {
        schemaVersion: 1,
        operationId: input.operationId,
        status: result.replayed ? 'duplicate' : 'ok',
        revision: result.version,
        data: AutomationsDocumentV3Schema.parse(result.value) as AutomationsDocumentV3,
      }
    } catch (error) {
      if (error instanceof OperationIdentityConflictError) {
        return { schemaVersion: 1, operationId: input.operationId, status: 'conflict', revision: current?.revision, error: { code: 'operation_identity_conflict', message: error.message, retryable: false } }
      }
      throw error
    }
  }

  acceptCloudEvent(input: unknown, options: AcceptCloudEventOptions): AutomationCapabilityResultV1<TrustedAutomationEventV1> {
    this.assertWritable()
    const parsed = CloudEventV1Schema.safeParse(input)
    if (!parsed.success) return {
      schemaVersion: 1,
      status: 'invalid',
      error: { code: 'invalid_cloudevent', message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), retryable: false },
    }

    const suppliedSession = parsed.data.mortisesessionid
    if (suppliedSession && options.validateSession && !options.validateSession(suppliedSession, this.workspaceId)) {
      return { schemaVersion: 1, status: 'invalid', error: { code: 'invalid_event_session', message: 'Event Session does not belong to the ingress workspace', retryable: false } }
    }
    const cloudEvent: CloudEventV1 = {
      ...parsed.data,
      mortiseworkspaceid: this.workspaceId,
      ...(suppliedSession ? { mortisesessionid: suppliedSession } : {}),
    }
    const eventId = automationIdentity('evt', cloudEvent.source, cloudEvent.id)
    const trusted: TrustedAutomationEventV1 = {
      eventId,
      sourceKind: options.sourceKind,
      workspaceId: this.workspaceId,
      ...(suppliedSession ? { sessionId: suppliedSession } : {}),
      ...(options.matchValue ? { matchValue: options.matchValue } : {}),
      cloudEvent,
      acceptedAt: new Date().toISOString(),
    }
    const operationId = automationIdentity('op_event', cloudEvent.source, cloudEvent.id)
    const existingBeforeWrite = this.store.getRecord(this.eventNamespace(), eventId)
    if (existingBeforeWrite) {
      const existing = existingBeforeWrite.value as unknown as TrustedAutomationEventV1
      return sameAcceptedEvent(existing, trusted)
        ? { schemaVersion: 1, operationId, status: 'duplicate', data: existing }
        : { schemaVersion: 1, operationId, status: 'conflict', error: { code: 'identity_conflict', message: 'CloudEvents source/id was reused with a different payload', retryable: false } }
    }
    try {
      const result = this.store.mutateRecord({
        capability: 'automations.ingress',
        namespace: this.eventNamespace(),
        key: eventId,
        value: json(trusted),
        expectedVersion: null,
        operationId,
      })
      if (result.status === 'conflict') {
        const existing = this.store.getRecord(this.eventNamespace(), eventId)
        if (existing && sameAcceptedEvent(existing.value as unknown as TrustedAutomationEventV1, trusted)) {
          return { schemaVersion: 1, operationId, status: 'duplicate', data: existing.value as unknown as TrustedAutomationEventV1 }
        }
        return { schemaVersion: 1, operationId, status: 'conflict', error: { code: 'identity_conflict', message: 'CloudEvents source/id was reused with a different payload', retryable: false } }
      }
      this.appendHistory('event.accepted', eventId, operationId, trusted)
      return { schemaVersion: 1, operationId, status: result.replayed ? 'duplicate' : 'accepted', data: trusted }
    } catch (error) {
      if (error instanceof OperationIdentityConflictError) {
        const existing = this.store.getRecord(this.eventNamespace(), eventId)
        if (existing && sameAcceptedEvent(existing.value as unknown as TrustedAutomationEventV1, trusted)) {
          return { schemaVersion: 1, operationId, status: 'duplicate', data: existing.value as unknown as TrustedAutomationEventV1 }
        }
        return { schemaVersion: 1, operationId, status: 'conflict', error: { code: 'identity_conflict', message: error.message, retryable: false } }
      }
      throw error
    }
  }

  getEvent(eventId: string): TrustedAutomationEventV1 | null {
    return this.store.getRecord(this.eventNamespace(), eventId)?.value as unknown as TrustedAutomationEventV1 ?? null
  }

  claimRun(run: AutomationRunV1, operationId: string): { run: AutomationRunV1; duplicate: boolean } {
    this.assertWritable()
    let result
    try {
      result = this.store.mutateRecord({
        capability: 'automations.runs',
        namespace: this.runNamespace(),
        key: run.runId,
        value: json(run),
        expectedVersion: null,
        operationId,
      })
    } catch (error) {
      if (error instanceof OperationIdentityConflictError) {
        const existing = this.getRun(run.runId)
        if (existing) return { run: existing, duplicate: true }
      }
      throw error
    }
    if (result.status === 'conflict') {
      const existing = this.getRun(run.runId)
      if (!existing) throw new Error('Run claim conflicted without a current run')
      return { run: existing, duplicate: true }
    }
    if (!result.replayed) this.appendHistory('run.created', run.runId, operationId, run)
    return { run: parseRun(result.value), duplicate: result.replayed }
  }

  getRun(runId: string): AutomationRunV1 | null {
    const record = this.store.getRecord(this.runNamespace(), runId)
    return record ? parseRun(record.value) : null
  }

  claimRunExecution(
    runId: string,
    options: { ownerId: string; leaseMs: number; now?: Date },
  ): { run: AutomationRunV1; claimed: boolean } {
    this.assertWritable()
    const current = this.store.getRecord(this.runNamespace(), runId)
    if (!current) throw new Error(`Automation run not found: ${runId}`)
    const run = parseRun(current.value)
    if (run.state !== 'queued') return { run, claimed: false }

    const now = options.now ?? new Date()
    const claimedAt = now.toISOString()
    const next: AutomationRunV1 = {
      ...run,
      state: 'running',
      startedAt: run.startedAt ?? claimedAt,
      executor: {
        ownerId: options.ownerId,
        claimedAt,
        leaseExpiresAt: new Date(now.getTime() + options.leaseMs).toISOString(),
      },
    }
    const operationId = automationIdentity('op_execution_claim', runId, options.ownerId, current.version)
    const result = this.store.mutateRecord({
      capability: 'automations.runs',
      namespace: this.runNamespace(),
      key: runId,
      value: json(next),
      expectedVersion: current.version,
      operationId,
    })
    if (result.status === 'conflict') {
      const latest = this.getRun(runId)
      if (!latest) throw new Error(`Automation run disappeared during claim: ${runId}`)
      return { run: latest, claimed: false }
    }
    if (!result.replayed) this.appendHistory('run.transition', automationIdentity('transition', runId, operationId), operationId, next)
    return { run: parseRun(result.value), claimed: !result.replayed }
  }

  renewRunExecution(runId: string, ownerId: string, leaseMs: number, now = new Date()): AutomationRunV1 | null {
    this.assertWritable()
    const current = this.store.getRecord(this.runNamespace(), runId)
    if (!current) return null
    const run = parseRun(current.value)
    if (run.state !== 'running' || run.executor?.ownerId !== ownerId) return null
    const next: AutomationRunV1 = {
      ...run,
      executor: {
        ...run.executor,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      },
    }
    const operationId = automationIdentity('op_execution_renew', runId, ownerId, current.version)
    const result = this.store.mutateRecord({
      capability: 'automations.runs',
      namespace: this.runNamespace(),
      key: runId,
      value: json(next),
      expectedVersion: current.version,
      operationId,
    })
    return result.status === 'applied' ? parseRun(result.value) : null
  }

  recoverExpiredExecutions(now = new Date()): AutomationRunV1[] {
    this.assertWritable()
    const recovered: AutomationRunV1[] = []
    for (const run of this.listRuns({ limit: 10_000 })) {
      if (run.state !== 'running' || !run.executor) continue
      if (Date.parse(run.executor.leaseExpiresAt) > now.getTime()) continue
      const completedAt = now.toISOString()
      const next: AutomationRunV1 = {
        ...run,
        state: 'failed',
        reason: 'execution-lease-expired',
        completedAt,
        actions: run.actions.map(action => {
          if (action.state === 'running') return {
            ...action,
            state: 'failed' as const,
            completedAt,
            error: {
              code: 'unknown_outcome_after_crash',
              message: 'The host stopped while this action was running; it was not replayed automatically.',
              retryable: false,
            },
          }
          if (action.state === 'queued') return { ...action, state: 'skipped' as const, completedAt }
          return action
        }),
      }
      try {
        recovered.push(this.updateRun(next, automationIdentity('op_execution_expired', run.runId, run.executor.leaseExpiresAt)))
      } catch {
        // Another compatible host renewed or completed the run first.
      }
    }
    return recovered
  }

  updateRun(run: AutomationRunV1, operationId: string): AutomationRunV1 {
    this.assertWritable()
    for (let retry = 0; retry < 3; retry++) {
      const current = this.store.getRecord(this.runNamespace(), run.runId)
      if (!current) throw new Error(`Automation run not found: ${run.runId}`)
      const currentRun = parseRun(current.value)
      const candidate = run.state === 'running' && currentRun.executor?.ownerId === run.executor?.ownerId
        ? { ...run, executor: currentRun.executor }
        : run
      if (canonical(currentRun) === canonical(candidate)) return currentRun
      assertMonotonicRunTransition(currentRun, candidate)
      const versionedOperationId = automationIdentity('run_update', operationId, current.version)
      const result = this.store.mutateRecord({
        capability: 'automations.runs',
        namespace: this.runNamespace(),
        key: run.runId,
        value: json(candidate),
        expectedVersion: current.version,
        operationId: versionedOperationId,
      })
      if (result.status === 'conflict') continue
      if (!result.replayed) this.appendHistory('run.transition', automationIdentity('transition', run.runId, operationId), versionedOperationId, candidate)
      return parseRun(result.value)
    }
    throw new Error(`Concurrent automation run update: ${run.runId}`)
  }

  listRuns(options: { automationId?: string; limit?: number } = {}): AutomationRunV1[] {
    const ids = this.store.listEvents(this.historyStream()).filter(event => event.eventType === 'run.created').map(event => {
      const payload = event.payload as { runId?: JsonValue }
      return typeof payload.runId === 'string' ? payload.runId : null
    }).filter((id): id is string => id !== null)
    const unique = [...new Set(ids)].reverse()
    const runs: AutomationRunV1[] = []
    for (const id of unique) {
      const run = this.getRun(id)
      if (!run || (options.automationId && run.automationId !== options.automationId)) continue
      runs.push(run)
      if (runs.length >= (options.limit ?? 100)) break
    }
    return runs
  }

  private appendHistory(eventType: string, eventId: string, operationId: string, payload: unknown): void {
    this.assertWritable()
    const result = this.store.appendEvent({
      capability: 'automations.history',
      streamId: this.historyStream(),
      eventId: automationIdentity('ledger', this.workspaceId, eventType, eventId),
      eventType,
      schemaVersion: 1,
      payload: json(payload),
      operationId: `${operationId}:ledger:${eventType}`,
    })
    if (result.status === 'conflict' && result.reason !== 'duplicate_event') {
      throw new Error(`Automation history sequence conflict at ${result.currentSequence}`)
    }
  }

  private documentNamespace(): string { return `automations-document:${this.workspaceId}` }
  private eventNamespace(): string { return `automations-events:${this.workspaceId}` }
  private runNamespace(): string { return `automations-runs:${this.workspaceId}` }
  private historyStream(): string { return `automations-history:${this.workspaceId}` }
}
