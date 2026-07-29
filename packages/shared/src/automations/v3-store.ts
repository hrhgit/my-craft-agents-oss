import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  MultiWriterStore,
  OperationIdentityConflictError,
  type JsonValue,
  type MultiWriterTransaction,
} from '../storage/index.ts'
import {
  AutomationRunV1Schema,
  AutomationsDocumentV3Schema,
  CloudEventV1Schema,
  parseAutomationHistoryPayloadV1,
} from './v3-schemas.ts'
import { automationIdentity, canonicalAutomationValue } from './v3-identity.ts'
export { automationIdentity } from './v3-identity.ts'
import type {
  AutomationCapabilityResultV1,
  AutomationRunV1,
  AutomationsDocumentV3,
  CloudEventV1,
  TrustedAutomationEventV1,
} from './v3-types.ts'
import {
  advanceScheduleProjection,
  assertAutomationProjectionWorkspace,
  assertAutomationRunIdentity,
  createAutomationIndexMigration,
  getNextDueAt,
  getLatestHistorySequence,
  listDefinitionsPage,
  listDueOccurrences,
  listExpiredRuns,
  listRunsPage,
  projectHistory,
  projectRun,
  readHistoryChanges,
  replaceDefinitionProjection,
  type AutomationDefinitionCursorV1,
  type AutomationHistoryCursorV1,
  type AutomationRunCursorV1,
  type DueAutomationOccurrenceV1,
  type ExpiredAutomationRunV1,
} from './v3-index.ts'

const DATABASE_NAME = 'automations-v3.sqlite'
const DOCUMENT_KEY = 'definitions'
const AUTOMATION_CAPABILITIES = {
  'automations.definitions': { minWriteVersion: 4, maxWriteVersion: 4 },
  'automations.ingress': { minWriteVersion: 2, maxWriteVersion: 2 },
  'automations.runs': { minWriteVersion: 2, maxWriteVersion: 2 },
  'automations.history': { minWriteVersion: 2, maxWriteVersion: 2 },
} as const

function json<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function parseRun(value: JsonValue): AutomationRunV1 {
  return AutomationRunV1Schema.parse(value) as AutomationRunV1
}

function historyPayload(eventType: string, payload: unknown): JsonValue {
  if (!payload || typeof payload !== 'object') return json({})
  const value = payload as Record<string, unknown>
  if (eventType === 'definitions.changed') {
    return json(parseAutomationHistoryPayloadV1(eventType, {
      revision: value.revision,
      definitionIds: value.definitionIds,
    }))
  }
  if (eventType === 'event.accepted') {
    const event = payload as TrustedAutomationEventV1
    return json(parseAutomationHistoryPayloadV1(eventType, {
      eventId: event.eventId,
      sourceKind: event.sourceKind,
      workspaceId: event.workspaceId,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      cloudEvent: {
        specversion: event.cloudEvent.specversion,
        id: event.cloudEvent.id,
        source: event.cloudEvent.source,
        type: event.cloudEvent.type,
        time: event.cloudEvent.time,
      },
      acceptedAt: event.acceptedAt,
    }))
  }
  const run = payload as AutomationRunV1
  return json(parseAutomationHistoryPayloadV1(eventType, {
    runId: run.runId,
    occurrenceId: run.occurrenceId,
    automationId: run.automationId,
    definitionRevision: run.definitionRevision,
    triggerId: run.triggerId,
    state: run.state,
    ...(run.reason ? { reason: run.reason } : {}),
    ...(run.eventId ? { eventId: run.eventId } : {}),
    ...(run.scheduledAt ? { scheduledAt: run.scheduledAt } : {}),
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    actions: run.actions.map(action => ({
      actionRunId: action.actionRunId,
      actionId: action.actionId,
      state: action.state,
      attempts: action.attempts,
    })),
  }))
}

function sameAcceptedEvent(left: TrustedAutomationEventV1, right: TrustedAutomationEventV1): boolean {
  const { acceptedAt: _leftAcceptedAt, ...leftSemantic } = left
  const { acceptedAt: _rightAcceptedAt, ...rightSemantic } = right
  return canonicalAutomationValue(leftSemantic) === canonicalAutomationValue(rightSemantic)
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
    || current.schemaVersion !== next.schemaVersion || current.occurrenceKey !== next.occurrenceKey
    || current.automationId !== next.automationId || current.triggerId !== next.triggerId
    || current.definitionRevision !== next.definitionRevision
    || current.eventId !== next.eventId || current.scheduledAt !== next.scheduledAt
    || current.createdAt !== next.createdAt
    || canonicalAutomationValue(current.definitionSnapshot) !== canonicalAutomationValue(next.definitionSnapshot)) {
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
}

export interface AcceptCloudEventOptions {
  sourceKind: TrustedAutomationEventV1['sourceKind']
  matchValue?: string
  validateSession?: (sessionId: string, workspaceId: string) => boolean
}

export interface AutomationRunInterruptionResultV1 {
  selectedRunIds: string[]
  cancelledRunIds: string[]
}

export class AutomationV3Store {
  readonly workspaceId: string
  readonly workspaceRootPath: string
  readonly databasePath: string
  readonly writerId: string
  private readonly store: MultiWriterStore

  constructor(options: AutomationV3StoreOptions) {
    this.workspaceId = options.workspaceId
    this.workspaceRootPath = options.workspaceRootPath
    this.databasePath = options.databasePath ?? join(options.workspaceRootPath, '.mortise', DATABASE_NAME)
    mkdirSync(dirname(this.databasePath), { recursive: true })
    this.writerId = options.writerId ?? `automations-${process.pid}-${randomUUID()}`
    this.store = MultiWriterStore.openSync({
      databasePath: this.databasePath,
      writerId: this.writerId,
      writerVersion: 1,
      capabilities: AUTOMATION_CAPABILITIES,
      moduleMigrations: [createAutomationIndexMigration(this.workspaceId)],
    })
    try {
      this.store.readTransaction(transaction => assertAutomationProjectionWorkspace(transaction, this.workspaceId))
    } catch (error) {
      this.store.close()
      throw error
    }
  }

  isWritable(): boolean {
    return Object.keys(AUTOMATION_CAPABILITIES).every(capability => this.store.isCapabilityWritable(capability))
  }

  areCapabilitiesWritable(capabilities: readonly (keyof typeof AUTOMATION_CAPABILITIES)[]): boolean {
    return capabilities.every(capability => this.store.isCapabilityWritable(capability))
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

  initialize(): AutomationsDocumentV3 {
    const current = this.getDocument()
    if (current) return current
    const document: AutomationsDocumentV3 = { schemaVersion: 3, revision: 1, definitions: [] }
    const operationId = automationIdentity('op_initialize', this.workspaceId, document)
    const result = this.mutateDocument({ operationId, expectedRevision: null, document })
    if (result.status === 'conflict') {
      const raced = this.getDocument()
      if (!raced) throw new Error('Automation document initialization conflicted without a current document')
      return raced
    }
    if (!result.data) throw new Error(`Automation document initialization failed: ${result.status}`)
    return result.data
  }

  mutateDocument(input: {
    operationId: string
    expectedRevision: number | null
    document: AutomationsDocumentV3
  }): AutomationCapabilityResultV1<AutomationsDocumentV3> {
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
      const result = this.store.writeTransaction({
        requiredCapabilities: ['automations.definitions', 'automations.history'],
      }, transaction => {
        const mutation = transaction.mutateRecord({
          capability: 'automations.definitions',
          namespace: this.documentNamespace(),
          key: DOCUMENT_KEY,
          value: json(candidate.data),
          expectedVersion: expected,
          operationId: input.operationId,
        })
        if (mutation.status !== 'applied' || mutation.replayed) return mutation
        replaceDefinitionProjection(transaction, this.workspaceId, candidate.data as AutomationsDocumentV3)
        this.appendHistoryInTransaction(transaction, 'definitions.changed', input.operationId, input.operationId, {
          revision: candidate.data.revision,
          definitionIds: candidate.data.definitions.map(definition => definition.id),
        })
        return mutation
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
      const result = this.store.writeTransaction({
        requiredCapabilities: ['automations.ingress', 'automations.history'],
      }, transaction => {
        const mutation = transaction.mutateRecord({
          capability: 'automations.ingress',
          namespace: this.eventNamespace(),
          key: eventId,
          value: json(trusted),
          expectedVersion: null,
          operationId,
        })
        if (mutation.status === 'applied' && !mutation.replayed) {
          this.appendHistoryInTransaction(transaction, 'event.accepted', eventId, operationId, trusted)
        }
        return mutation
      })
      if (result.status === 'conflict') {
        const existing = this.store.getRecord(this.eventNamespace(), eventId)
        if (existing && sameAcceptedEvent(existing.value as unknown as TrustedAutomationEventV1, trusted)) {
          return { schemaVersion: 1, operationId, status: 'duplicate', data: existing.value as unknown as TrustedAutomationEventV1 }
        }
        return { schemaVersion: 1, operationId, status: 'conflict', error: { code: 'identity_conflict', message: 'CloudEvents source/id was reused with a different payload', retryable: false } }
      }
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
    const parsedRun = AutomationRunV1Schema.parse(run) as AutomationRunV1
    assertAutomationRunIdentity(this.workspaceId, parsedRun)
    let result
    try {
      result = this.mutateRun({
        run: parsedRun,
        expectedVersion: null,
        operationId,
        historyType: 'run.created',
        advanceSchedule: true,
      })
    } catch (error) {
      if (error instanceof OperationIdentityConflictError) {
        const existing = this.getRun(parsedRun.runId)
        if (existing) return { run: existing, duplicate: true }
      }
      throw error
    }
    if (result.status === 'conflict') {
      const existing = this.getRun(parsedRun.runId)
      if (!existing) throw new Error('Run claim conflicted without a current run')
      return { run: existing, duplicate: true }
    }
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
    const result = this.mutateRun({
      run: next,
      expectedVersion: current.version,
      operationId,
      historyType: 'run.transition',
    })
    if (result.status === 'conflict') {
      const latest = this.getRun(runId)
      if (!latest) throw new Error(`Automation run disappeared during claim: ${runId}`)
      return { run: latest, claimed: false }
    }
    return { run: parseRun(result.value), claimed: !result.replayed }
  }

  renewRunExecution(runId: string, ownerId: string, leaseMs: number, now = new Date()): AutomationRunV1 | null {
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
    const result = this.mutateRun({
      run: next,
      expectedVersion: current.version,
      operationId,
      historyType: 'run.transition',
    })
    return result.status === 'applied' ? parseRun(result.value) : null
  }

  recoverExpiredExecutions(now = new Date()): AutomationRunV1[] {
    const recovered: AutomationRunV1[] = []
    for (;;) {
      const expired = this.listExpiredExecutionLeaseObservations(now, 100)
      if (expired.length === 0) break
      for (const observed of expired) {
        let candidate = observed
        let resolved = false
        for (let attempt = 0; attempt < 3; attempt++) {
          const { run, recordVersion } = candidate
          if (run.state !== 'running' || !run.executor
            || Date.parse(run.executor.leaseExpiresAt) > now.getTime()) {
            resolved = true
            break
          }
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
          const result = this.mutateRun({
            run: next,
            expectedVersion: recordVersion,
            operationId: automationIdentity(
              'op_execution_expired',
              run.runId,
              run.executor.leaseExpiresAt,
              recordVersion,
            ),
            historyType: 'run.transition',
          })
          if (result.status === 'applied') {
            if (!result.replayed) recovered.push(parseRun(result.value))
            resolved = true
            break
          }
          const latest = this.store.getRecord(this.runNamespace(), run.runId)
          if (!latest) {
            throw new Error(`Automation run disappeared during expired-lease recovery: ${run.runId}`)
          }
          const latestRun = parseRun(latest.value)
          if (latestRun.state !== 'running' || !latestRun.executor
            || Date.parse(latestRun.executor.leaseExpiresAt) > now.getTime()) {
            resolved = true
            break
          }
          candidate = { run: latestRun, recordVersion: latest.version }
        }
        if (!resolved) {
          throw new Error(`Automation expired-lease recovery could not make CAS progress: ${candidate.run.runId}`)
        }
      }
    }
    return recovered
  }

  cancelNonTerminalRuns(reason: string, now = new Date()): AutomationRunInterruptionResultV1 {
    const selectedRunIds = new Set<string>()
    const cancelledRunIds = new Set<string>()
    for (;;) {
      const runs = this.listRunsPage({ states: ['queued', 'running'], limit: 500 }).items
      if (runs.length === 0) break
      for (const run of runs) {
        selectedRunIds.add(run.runId)
        const result = this.cancelRunIfNonTerminal(run.runId, reason, now)
        if (result.cancelled) cancelledRunIds.add(run.runId)
      }
    }
    return {
      selectedRunIds: [...selectedRunIds],
      cancelledRunIds: [...cancelledRunIds],
    }
  }

  cancelRunIfNonTerminal(
    runId: string,
    reason: string,
    now = new Date(),
  ): { run: AutomationRunV1; cancelled: boolean } {
    for (let retry = 0; retry < 3; retry++) {
      const current = this.store.getRecord(this.runNamespace(), runId)
      if (!current) throw new Error(`Automation run not found: ${runId}`)
      const run = parseRun(current.value)
      if (run.state !== 'queued' && run.state !== 'running') return { run, cancelled: false }
      const completedAt = now.toISOString()
      const { executor: _executor, ...withoutExecutor } = run
      const next: AutomationRunV1 = {
        ...withoutExecutor,
        state: 'cancelled',
        reason,
        completedAt,
        actions: run.actions.map(action => (
          action.state === 'queued' || action.state === 'running'
            ? { ...action, state: 'cancelled' as const, completedAt }
            : action
        )),
      }
      const result = this.mutateRun({
        run: next,
        expectedVersion: current.version,
        operationId: automationIdentity('op_run_cancel', runId, reason, current.version),
        historyType: 'run.transition',
      })
      if (result.status === 'conflict') continue
      return { run: parseRun(result.value), cancelled: !result.replayed }
    }
    throw new Error(`Automation run cancellation could not make CAS progress: ${runId}`)
  }

  updateRun(run: AutomationRunV1, operationId: string): AutomationRunV1 {
    const requestedRun = AutomationRunV1Schema.parse(run) as AutomationRunV1
    assertAutomationRunIdentity(this.workspaceId, requestedRun)
    for (let retry = 0; retry < 3; retry++) {
      const current = this.store.getRecord(this.runNamespace(), requestedRun.runId)
      if (!current) throw new Error(`Automation run not found: ${requestedRun.runId}`)
      const currentRun = parseRun(current.value)
      const candidate = requestedRun.state === 'running' && currentRun.executor?.ownerId === requestedRun.executor?.ownerId
        ? { ...requestedRun, executor: currentRun.executor }
        : requestedRun
      if (canonicalAutomationValue(currentRun) === canonicalAutomationValue(candidate)) return currentRun
      assertMonotonicRunTransition(currentRun, candidate)
      const versionedOperationId = automationIdentity('run_update', operationId, current.version)
      const result = this.mutateRun({
        run: candidate,
        expectedVersion: current.version,
        operationId: versionedOperationId,
        historyType: 'run.transition',
      })
      if (result.status === 'conflict') continue
      return parseRun(result.value)
    }
    throw new Error(`Concurrent automation run update: ${requestedRun.runId}`)
  }

  listRuns(options: { automationId?: string; states?: AutomationRunV1['state'][]; eventId?: string; limit?: number } = {}): AutomationRunV1[] {
    return this.listRunsPage(options).items
  }

  listDefinitionsPage(options: { limit?: number; cursor?: AutomationDefinitionCursorV1 } = {}) {
    return this.store.readTransaction(transaction => listDefinitionsPage(transaction, this.workspaceId, options))
  }

  listRunsPage(options: {
    automationId?: string
    states?: AutomationRunV1['state'][]
    eventId?: string
    createdAfter?: number
    createdBefore?: number
    limit?: number
    cursor?: AutomationRunCursorV1
  } = {}) {
    return this.store.readTransaction(transaction => listRunsPage(
      transaction,
      this.workspaceId,
      this.runNamespace(),
      options,
    ))
  }

  listExpiredExecutionLeases(expiresAtOrBefore: Date, limit = 100): string[] {
    return this.listExpiredExecutionLeaseObservations(expiresAtOrBefore, limit)
      .map(observation => observation.run.runId)
  }

  private listExpiredExecutionLeaseObservations(
    expiresAtOrBefore: Date,
    limit: number,
  ): ExpiredAutomationRunV1[] {
    return this.store.readTransaction(transaction => listExpiredRuns(
      transaction,
      this.workspaceId,
      expiresAtOrBefore.getTime(),
      limit,
    ))
  }

  listDueOccurrences(dueAtOrBefore: Date, limit = 100, activeSince = dueAtOrBefore): DueAutomationOccurrenceV1[] {
    return this.store.readTransaction(transaction => listDueOccurrences(
      transaction,
      this.workspaceId,
      dueAtOrBefore.getTime(),
      activeSince.getTime(),
      limit,
    ))
  }

  recordMissedTimeOccurrence(due: DueAutomationOccurrenceV1): void {
    if (due.occurrence.skipReason !== 'missed') {
      throw new TypeError('Only missed time occurrences can be recorded without a run claim')
    }
    const namespace = `automations-schedule-observations:${this.workspaceId}`
    const key = `${due.definition.id}:${due.trigger.id}`
    const operationId = automationIdentity(
      'op_schedule_missed',
      this.workspaceId,
      due.definition.id,
      due.trigger.id,
      due.occurrence.occurrenceKey,
    )
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = this.store.writeTransaction({ requiredCapabilities: ['automations.runs'] }, transaction => {
        const current = transaction.getRecord<Record<string, string>>(namespace, key)
        const currentScheduledAt = current?.value.scheduledAt
        if (currentScheduledAt && Date.parse(currentScheduledAt) >= Date.parse(due.occurrence.scheduledAt)) {
          advanceScheduleProjection(
            transaction,
            this.workspaceId,
            due.definition.id,
            due.trigger.id,
            currentScheduledAt,
          )
          return { status: 'observed' as const }
        }
        const mutation = transaction.mutateRecord({
          capability: 'automations.runs',
          namespace,
          key,
          value: json({
            automationId: due.definition.id,
            triggerId: due.trigger.id,
            occurrenceKey: due.occurrence.occurrenceKey,
            scheduledAt: due.occurrence.scheduledAt,
            reason: 'missed',
          }),
          expectedVersion: current?.version ?? null,
          operationId,
        })
        if (mutation.status === 'applied') {
          advanceScheduleProjection(
            transaction,
            this.workspaceId,
            due.definition.id,
            due.trigger.id,
            due.occurrence.scheduledAt,
          )
        }
        return mutation
      })
      if (result.status === 'observed' || result.status === 'applied') return
    }
    throw new Error(`Failed to record missed occurrence ${due.occurrence.occurrenceKey}`)
  }

  getNextDueAt(): Date | null {
    const value = this.store.readTransaction(transaction => getNextDueAt(transaction, this.workspaceId))
    return value === null ? null : new Date(value)
  }

  getChangeToken(): { revision: number; historyCursor: number } {
    return this.store.readTransaction(transaction => {
      const document = transaction.getRecord(this.documentNamespace(), DOCUMENT_KEY)
      return {
        revision: document?.version ?? 0,
        historyCursor: getLatestHistorySequence(transaction, this.workspaceId),
      }
    })
  }

  readHistoryChanges(options: {
    afterSequence?: number
    automationId?: string
    runId?: string
    limit?: number
    cursor?: AutomationHistoryCursorV1
  } = {}) {
    return this.store.readTransaction(transaction => readHistoryChanges(
      transaction,
      this.workspaceId,
      this.historyStream(),
      options,
    ))
  }

  private mutateRun(input: {
    run: AutomationRunV1
    expectedVersion: number | null
    operationId: string
    historyType: 'run.created' | 'run.transition'
    advanceSchedule?: boolean
  }) {
    const run = AutomationRunV1Schema.parse(input.run) as AutomationRunV1
    assertAutomationRunIdentity(this.workspaceId, run)
    return this.store.writeTransaction({
      requiredCapabilities: ['automations.runs', 'automations.history'],
    }, transaction => {
      const result = transaction.mutateRecord({
        capability: 'automations.runs',
        namespace: this.runNamespace(),
        key: run.runId,
        value: json(run),
        expectedVersion: input.expectedVersion,
        operationId: input.operationId,
      })
      if (result.status !== 'applied' || result.replayed) return result
      projectRun(transaction, this.workspaceId, run, result.version)
      if (input.advanceSchedule && run.scheduledAt) {
        advanceScheduleProjection(transaction, this.workspaceId, run.automationId, run.triggerId, run.scheduledAt)
      }
      this.appendHistoryInTransaction(
        transaction,
        input.historyType,
        input.historyType === 'run.created'
          ? run.runId
          : automationIdentity('transition', run.runId, input.operationId),
        input.operationId,
        run,
      )
      return result
    })
  }

  private appendHistoryInTransaction(
    transaction: MultiWriterTransaction,
    eventType: string,
    eventId: string,
    operationId: string,
    payload: unknown,
  ): void {
    const ledgerEventId = automationIdentity('ledger', this.workspaceId, eventType, eventId)
    const redactedPayload = historyPayload(eventType, payload)
    const result = transaction.appendEvent({
      capability: 'automations.history',
      streamId: this.historyStream(),
      eventId: ledgerEventId,
      eventType,
      schemaVersion: 1,
      payload: redactedPayload,
      operationId: `${operationId}:ledger:${eventType}`,
    })
    if (result.status === 'conflict' && result.reason !== 'duplicate_event') {
      throw new Error(`Automation history sequence conflict at ${result.currentSequence}`)
    }
    if (result.status === 'applied' && !result.replayed) {
      const summary = redactedPayload as Record<string, JsonValue>
      projectHistory(transaction, {
        workspaceId: this.workspaceId,
        sequence: result.sequence,
        eventId: ledgerEventId,
        kind: eventType,
        ...(typeof summary.automationId === 'string' ? { automationId: summary.automationId } : {}),
        ...(typeof summary.runId === 'string' ? { runId: summary.runId } : {}),
      })
    }
  }

  private documentNamespace(): string { return `automations-document:${this.workspaceId}` }
  private eventNamespace(): string { return `automations-events:${this.workspaceId}` }
  private runNamespace(): string { return `automations-runs:${this.workspaceId}` }
  private historyStream(): string { return `automations-history:${this.workspaceId}` }
}
