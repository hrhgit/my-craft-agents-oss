import { evaluateConditions } from './conditions.ts'
import { automationIdentity, AutomationV3Store } from './v3-store.ts'
import type {
  AutomationActionExecutionResultV1,
  AutomationActionRunV1,
  AutomationDefinitionV3,
  AutomationExecutionCallbacksV1,
  AutomationRunStateV1,
  AutomationRunV1,
  AutomationTriggerV3,
  CloudEventV1,
  TimeTriggerV3,
  TrustedAutomationEventV1,
} from './v3-types.ts'
import type { ScheduledOccurrenceV1 } from '../scheduler/occurrences.ts'

const NON_TERMINAL = new Set<AutomationRunStateV1>(['queued', 'running'])

function actionRunId(runId: string, actionId: string): string {
  return automationIdentity('action', runId, actionId)
}

function initialRun(
  workspaceId: string,
  definition: AutomationDefinitionV3,
  definitionRevision: number,
  trigger: AutomationTriggerV3,
  occurrenceKey: string,
  options: { event?: TrustedAutomationEventV1; scheduledAt?: string; state?: AutomationRunStateV1; reason?: string },
): AutomationRunV1 {
  const occurrenceId = automationIdentity('occ', workspaceId, definition.id, trigger.id, occurrenceKey)
  const runId = automationIdentity('run', occurrenceId, 0)
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    runId,
    occurrenceId,
    occurrenceKey,
    automationId: definition.id,
    definitionRevision,
    definitionSnapshot: definition,
    triggerId: trigger.id,
    state: options.state ?? 'queued',
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.event ? { eventId: options.event.eventId } : {}),
    ...(options.scheduledAt ? { scheduledAt: options.scheduledAt } : {}),
    createdAt: now,
    ...((options.state === 'skipped') ? { completedAt: now } : {}),
    actions: definition.actions.map(action => ({
      actionRunId: actionRunId(runId, action.id),
      actionId: action.id,
      state: options.state === 'skipped' ? 'skipped' : 'queued',
      attempts: 0,
    })),
  }
}

function eventConditionPayload(event: TrustedAutomationEventV1): Record<string, unknown> {
  const data = event.cloudEvent.data
  return {
    ...event.cloudEvent,
    ...(data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}),
    data,
    trustedWorkspaceId: event.workspaceId,
    trustedSessionId: event.sessionId,
  }
}

function aggregate(actions: AutomationActionRunV1[]): AutomationRunStateV1 {
  const succeeded = actions.filter(action => action.state === 'succeeded').length
  const unsuccessful = actions.filter(action => ['failed', 'blocked', 'cancelled', 'skipped'].includes(action.state)).length
  if (succeeded === actions.length) return 'succeeded'
  if (succeeded > 0 && unsuccessful > 0) return 'partial'
  if (succeeded === 0 && actions.some(action => action.state === 'failed' || action.state === 'blocked')) return 'failed'
  if (actions.some(action => action.state === 'cancelled')) return 'cancelled'
  return 'failed'
}

export interface AutomationV3RuntimeOptions {
  workspaceId: string
  store: AutomationV3Store
  callbacks: AutomationExecutionCallbacksV1
}

export interface AutomationEventDispatchResultV1 {
  status: 'accepted' | 'duplicate' | 'conflict' | 'invalid' | 'denied' | 'unsupported'
  event?: TrustedAutomationEventV1
  duplicate: boolean
  runs: AutomationRunV1[]
  error?: { code: string; message: string; retryable: boolean }
}

export class AutomationV3Runtime {
  private readonly workspaceId: string
  private readonly store: AutomationV3Store
  private readonly callbacks: AutomationExecutionCallbacksV1

  constructor(options: AutomationV3RuntimeOptions) {
    this.workspaceId = options.workspaceId
    this.store = options.store
    this.callbacks = options.callbacks
  }

  async emitEvent(
    cloudEvent: CloudEventV1,
    options: {
      sourceKind: TrustedAutomationEventV1['sourceKind']
      matchValue?: string
      validateSession?: (sessionId: string, workspaceId: string) => boolean
      signal?: AbortSignal
    },
  ): Promise<AutomationEventDispatchResultV1> {
    const accepted = await this.acceptEvent(cloudEvent, options)
    if (accepted.status !== 'accepted') return accepted
    const runs: AutomationRunV1[] = []
    for (const run of accepted.runs) {
      runs.push(run.state === 'queued' && run.reason !== 'overlap-queued'
        ? await this.executeClaimedRun(run.runId, options.signal)
        : run)
    }
    return { ...accepted, runs }
  }

  async acceptEvent(
    cloudEvent: CloudEventV1,
    options: {
      sourceKind: TrustedAutomationEventV1['sourceKind']
      matchValue?: string
      validateSession?: (sessionId: string, workspaceId: string) => boolean
      signal?: AbortSignal
    },
  ): Promise<AutomationEventDispatchResultV1> {
    const accepted = this.store.acceptCloudEvent(cloudEvent, options)
    if (accepted.status === 'duplicate') return { status: 'duplicate', event: accepted.data, duplicate: true, runs: [] }
    if (accepted.status !== 'accepted' || !accepted.data) {
      const status = accepted.status === 'conflict' || accepted.status === 'denied' || accepted.status === 'unsupported'
        ? accepted.status
        : 'invalid'
      return {
        status,
        duplicate: false,
        runs: [],
        error: accepted.error ?? { code: 'event_rejected', message: `Event was not accepted (${accepted.status})`, retryable: false },
      }
    }
    const runs = this.claimEventRuns(accepted.data)
    return { status: 'accepted', event: accepted.data, duplicate: false, runs }
  }

  async dispatchEvent(event: TrustedAutomationEventV1, signal?: AbortSignal): Promise<AutomationRunV1[]> {
    const claimed = this.claimEventRuns(event)
    const runs: AutomationRunV1[] = []
    for (const run of claimed) {
      runs.push(run.state === 'queued' && run.reason !== 'overlap-queued'
        ? await this.executeClaimedRun(run.runId, signal)
        : run)
    }
    return runs
  }

  private claimEventRuns(event: TrustedAutomationEventV1): AutomationRunV1[] {
    const document = this.store.initializeOrMigrate().document
    const runs: AutomationRunV1[] = []
    for (const definition of document.definitions) {
      if (!definition.enabled) continue
      for (const trigger of definition.triggers) {
        if (trigger.type !== 'event' || trigger.source !== event.sourceKind || trigger.eventType !== event.cloudEvent.type) continue
        if (trigger.matcher) {
          try {
            if (!new RegExp(trigger.matcher).test(event.matchValue ?? '')) continue
          } catch { continue }
        }
        if (definition.conditions && !evaluateConditions(definition.conditions, { payload: eventConditionPayload(event) })) continue
        runs.push(this.claimRun(definition, document.revision, trigger, `${event.cloudEvent.source}\n${event.cloudEvent.id}`, { event }))
      }
    }
    return runs
  }

  async runTimeTrigger(
    definition: AutomationDefinitionV3,
    trigger: TimeTriggerV3,
    occurrence: ScheduledOccurrenceV1,
    signal?: AbortSignal,
  ): Promise<AutomationRunV1> {
    const run = this.acceptTimeTrigger(definition, trigger, occurrence)
    return run.state === 'queued' && run.reason !== 'overlap-queued'
      ? this.executeClaimedRun(run.runId, signal)
      : run
  }

  acceptTimeTrigger(
    definition: AutomationDefinitionV3,
    trigger: TimeTriggerV3,
    occurrence: ScheduledOccurrenceV1,
  ): AutomationRunV1 {
    const revision = this.store.initializeOrMigrate().document.revision
    if (occurrence.skipReason) {
      const reason = occurrence.skipReason === 'expired' ? 'expired' : 'misfire-skip'
      const run = initialRun(this.workspaceId, definition, revision, trigger, occurrence.occurrenceKey, { state: 'skipped', reason, scheduledAt: occurrence.scheduledAt })
      return this.store.claimRun(run, automationIdentity('op_claim', run.occurrenceId)).run
    }
    return this.claimRun(definition, revision, trigger, occurrence.occurrenceKey, { scheduledAt: occurrence.scheduledAt })
  }

  async runManual(automationId: string, operationId: string, triggerId?: string, signal?: AbortSignal): Promise<{ run: AutomationRunV1; duplicate: boolean }> {
    const accepted = this.acceptManual(automationId, operationId, triggerId)
    if (accepted.run.state !== 'queued' || accepted.run.reason === 'overlap-queued') return accepted
    return { ...accepted, run: await this.executeClaimedRun(accepted.run.runId, signal) }
  }

  acceptManual(automationId: string, operationId: string, triggerId?: string): { run: AutomationRunV1; duplicate: boolean } {
    const document = this.store.initializeOrMigrate().document
    const definition = document.definitions.find(item => item.id === automationId)
    if (!definition) throw new Error(`Automation not found: ${automationId}`)
    const trigger = triggerId
      ? definition.triggers.find(item => item.id === triggerId)
      : definition.triggers[0]
    if (!trigger) throw new Error(triggerId ? `Automation trigger not found: ${triggerId}` : 'Automation has no trigger')
    const occurrenceKey = `manual:${operationId}:${trigger.id}`
    const occurrenceId = automationIdentity('occ', this.workspaceId, definition.id, trigger.id, occurrenceKey)
    const runId = automationIdentity('run', occurrenceId, 0)
    const duplicate = this.store.getRun(runId) !== null
    const run = this.claimRun(definition, document.revision, trigger, occurrenceKey, {})
    return { run, duplicate }
  }

  private claimRun(
    definition: AutomationDefinitionV3,
    definitionRevision: number,
    trigger: AutomationTriggerV3,
    occurrenceKey: string,
    options: { event?: TrustedAutomationEventV1; scheduledAt?: string },
  ): AutomationRunV1 {
    const active = this.store.listRuns({ automationId: definition.id }).filter(run => NON_TERMINAL.has(run.state))
    const overlap = definition.runPolicy?.overlap ?? 'skip'
    const overlapping = active.length > 0
    const run = initialRun(this.workspaceId, definition, definitionRevision, trigger, occurrenceKey, {
      ...options,
      ...(overlapping && overlap === 'skip' ? { state: 'skipped' as const, reason: 'overlap' } : {}),
      ...(overlapping && overlap === 'queue-one' ? { state: 'queued' as const, reason: 'overlap-queued' } : {}),
    })
    const claim = this.store.claimRun(run, automationIdentity('op_claim', run.occurrenceId))
    return claim.run
  }

  private async drainQueue(definition: AutomationDefinitionV3, signal?: AbortSignal): Promise<void> {
    if ((definition.runPolicy?.overlap ?? 'skip') !== 'queue-one') return
    const queued = this.store.listRuns({ automationId: definition.id }).filter(run => run.state === 'queued' && run.reason === 'overlap-queued')
    if (queued.length === 0) return
    const [newest, ...older] = queued.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const stale of older) {
      const completedAt = new Date().toISOString()
      this.store.updateRun({ ...stale, state: 'skipped', reason: 'queue-one-coalesced', completedAt, actions: stale.actions.map(action => ({ ...action, state: 'skipped', completedAt })) }, automationIdentity('op_run', stale.runId, 'queue-one-coalesced'))
    }
    if (!newest) return
    const event = newest.eventId ? this.store.getEvent(newest.eventId) ?? undefined : undefined
    await this.executeClaimedRun(newest.runId, signal, event)
  }

  async executeClaimedRun(
    runId: string,
    signal?: AbortSignal,
    knownEvent?: TrustedAutomationEventV1,
  ): Promise<AutomationRunV1> {
    const claim = this.store.claimRunExecution(runId, {
      ownerId: this.store.writerId,
      leaseMs: 60_000,
    })
    if (!claim.claimed) return claim.run

    const definition = claim.run.definitionSnapshot
    const event = knownEvent ?? (claim.run.eventId ? this.store.getEvent(claim.run.eventId) ?? undefined : undefined)
    const heartbeat = setInterval(() => {
      try {
        this.store.renewRunExecution(runId, this.store.writerId, 60_000)
      } catch {
        // The next durable transition reports a lost execution claim.
      }
    }, 20_000)
    heartbeat.unref?.()
    try {
      const completed = await this.execute(definition, claim.run, event, signal)
      await this.drainQueue(definition, signal)
      return completed
    } finally {
      clearInterval(heartbeat)
    }
  }

  private async execute(
    definition: AutomationDefinitionV3,
    initial: AutomationRunV1,
    event?: TrustedAutomationEventV1,
    signal?: AbortSignal,
  ): Promise<AutomationRunV1> {
    let run = initial
    const stopOnFailure = (definition.runPolicy?.actionFailure ?? 'continue') === 'stop'

    for (let index = 0; index < definition.actions.length; index++) {
      const action = definition.actions[index]!
      if (signal?.aborted) {
        const completedAt = new Date().toISOString()
        run = this.store.updateRun({ ...run, state: 'cancelled', completedAt, actions: run.actions.map(item => item.state === 'queued' ? { ...item, state: 'cancelled', completedAt } : item) }, automationIdentity('op_run', run.runId, 'cancelled'))
        return run
      }
      const actionState = run.actions[index]!
      const actionStartedAt = new Date().toISOString()
      run = this.store.updateRun({ ...run, actions: run.actions.map((item, position) => position === index ? { ...item, state: 'running', attempts: item.attempts + 1, startedAt: actionStartedAt } : item) }, automationIdentity('op_action', actionState.actionRunId, 'running', actionState.attempts + 1))

      let result: AutomationActionExecutionResultV1
      try {
        const context = { workspaceId: this.workspaceId, definition, run, ...(event ? { event } : {}), ...(signal ? { signal } : {}) }
        result = action.type === 'prompt'
          ? await this.callbacks.prompt(action, context)
          : await this.callbacks.webhook(action, { ...context, attemptId: automationIdentity('attempt', actionState.actionRunId, actionState.attempts + 1) })
      } catch (error) {
        result = { status: 'failed', error: { code: 'executor_error', message: error instanceof Error ? error.message : String(error), retryable: false } }
      }

      const completedAt = new Date().toISOString()
      run = this.store.updateRun({
        ...run,
        actions: run.actions.map((item, position) => position === index ? {
          ...item,
          state: result.status,
          completedAt,
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result.details ? { details: result.details } : {}),
          ...(result.error ? { error: { ...result.error, retryable: result.error.retryable ?? false } } : {}),
        } : item),
      }, automationIdentity('op_action', actionState.actionRunId, result.status, actionState.attempts + 1))

      if (stopOnFailure && (result.status === 'failed' || result.status === 'blocked')) {
        run = this.store.updateRun({ ...run, actions: run.actions.map((item, position) => position > index && item.state === 'queued' ? { ...item, state: 'skipped', completedAt, error: { code: 'prior-action-failure', message: 'Skipped after prior action failure', retryable: false } } : item) }, automationIdentity('op_run', run.runId, 'stop-after', action.id))
        break
      }
    }

    const completedAt = new Date().toISOString()
    return this.store.updateRun({ ...run, state: aggregate(run.actions), completedAt }, automationIdentity('op_run', run.runId, 'terminal'))
  }
}
