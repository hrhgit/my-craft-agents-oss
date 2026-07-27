import { AutomationSchedulerV3 } from '../scheduler/automation-scheduler.ts'
import { automationIdentity, AutomationV3Store, type AutomationV3StoreOptions } from './v3-store.ts'
import { AutomationV3Runtime, type AutomationEventDispatchResultV1 } from './v3-runtime.ts'
import type {
  AutomationDefinitionV3,
  AutomationExecutionCallbacksV1,
  AutomationRunV1,
  CloudEventV1,
  TrustedAutomationEventV1,
} from './v3-types.ts'

export interface AutomationWorkspaceHostV3Options extends AutomationV3StoreOptions {
  callbacks: AutomationExecutionCallbacksV1
  validateSession?: (sessionId: string, workspaceId: string) => boolean
  onChanged?: (change: { revision: number; historyCursor: number }) => void
  onError?: (error: Error) => void
}

export interface AutomationWorkspaceInterruptionResultV1 {
  selectedRunIds: string[]
  cancelledRunIds: string[]
}

/** Owns the canonical store, scheduler, claims, execution queue, and run ledger for one workspace. */
export class AutomationWorkspaceHostV3 {
  readonly store: AutomationV3Store
  readonly runtime: AutomationV3Runtime
  private readonly scheduler: AutomationSchedulerV3
  private readonly validateSession?: AutomationWorkspaceHostV3Options['validateSession']
  private readonly onChanged?: AutomationWorkspaceHostV3Options['onChanged']
  private readonly onError?: (error: Error) => void
  private readonly pending: string[] = []
  private readonly pendingIds = new Set<string>()
  private executionController = new AbortController()
  private executionGeneration = 0
  private processing: Promise<void> | null = null
  private topologyInterruption: Promise<AutomationWorkspaceInterruptionResultV1> | null = null
  private topologyInterruptionFailure: Error | null = null
  private resumeSchedulerAfterTopologyChange = false
  private started = false
  private stopped = false
  private schedulerStarted = false

  constructor(options: AutomationWorkspaceHostV3Options) {
    this.store = new AutomationV3Store(options)
    this.runtime = new AutomationV3Runtime({ workspaceId: options.workspaceId, store: this.store, callbacks: options.callbacks })
    this.validateSession = options.validateSession
    this.onChanged = options.onChanged
    this.onError = options.onError
    this.scheduler = new AutomationSchedulerV3({
      listDueOccurrences: now => this.store.listDueOccurrences(now),
      getNextDueAt: () => this.store.getNextDueAt(),
      onOccurrence: async due => {
        this.assertAcceptingRuns()
        this.enqueueAcceptedRun(this.runtime.acceptTimeTrigger(
          due.definition,
          due.trigger,
          due.occurrence,
          due.definitionRevision,
        ))
      },
      onError: error => this.report(error),
    })
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    let document = this.store.getDocument()
    if (!document && this.store.areCapabilitiesWritable(['automations.definitions', 'automations.history'])) {
      document = this.store.initialize()
    }
    if (document && this.store.areCapabilitiesWritable(['automations.runs', 'automations.history'])) {
      this.store.recoverExpiredExecutions()
      this.recoverQueuedRuns()
      this.scheduler.start()
      this.schedulerStarted = true
    }
  }

  refresh(): void {
    if (!this.started || this.stopped) return
    if (this.schedulerStarted) this.scheduler.refresh()
    this.publishChanged()
  }

  acceptManual(automationId: string, operationId: string, triggerId?: string): { run: AutomationRunV1; duplicate: boolean } {
    this.assertAcceptingRuns()
    const result = this.runtime.acceptManual(automationId, operationId, triggerId)
    if (!result.duplicate) {
      this.enqueueAcceptedRun(result.run)
      this.publishChanged()
    }
    return result
  }

  async acceptEvent(
    event: CloudEventV1,
    options: { sourceKind: TrustedAutomationEventV1['sourceKind']; matchValue?: string },
  ): Promise<AutomationEventDispatchResultV1> {
    this.assertAcceptingRuns()
    const result = await this.runtime.acceptEvent(event, {
      ...options,
      ...(this.validateSession ? { validateSession: this.validateSession } : {}),
    })
    if (result.status === 'duplicate' && result.event) {
      return { ...result, runs: this.store.listRuns({ eventId: result.event.eventId, limit: 500 }) }
    }
    for (const run of result.runs) this.enqueueAcceptedRun(run)
    if (!result.duplicate) this.publishChanged()
    return result
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.scheduler.stop()
    this.schedulerStarted = false
    this.executionController.abort(new Error('Automation workspace host stopped'))
    await this.topologyInterruption?.catch(() => {})
    await this.processing?.catch(() => {})
    this.store.close()
  }

  interruptForWorkspaceTopologyChange(): Promise<AutomationWorkspaceInterruptionResultV1> {
    this.assertRunning()
    if (this.topologyInterruptionFailure) return Promise.reject(this.topologyInterruptionFailure)
    if (this.topologyInterruption) return this.topologyInterruption

    const interruptedGeneration = this.executionGeneration
    this.resumeSchedulerAfterTopologyChange = this.schedulerStarted
    this.executionGeneration++
    this.scheduler.stop()
    this.schedulerStarted = false
    this.pending.length = 0
    this.pendingIds.clear()
    this.executionController.abort(new Error('Automation workspace topology changed'))

    let interruption!: Promise<AutomationWorkspaceInterruptionResultV1>
    interruption = this.performWorkspaceTopologyInterruption(interruptedGeneration)
      .catch(error => {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.topologyInterruptionFailure = failure
        this.report(failure)
        throw failure
      })
    this.topologyInterruption = interruption
    return interruption
  }

  /**
   * Release the pause only after the coordinating topology mutation has either
   * committed or definitively failed. This keeps old-topology runs out of the
   * interruption-to-commit window.
   */
  async resumeAfterWorkspaceTopologyChange(): Promise<void> {
    this.assertRunning()
    if (this.topologyInterruptionFailure) throw this.topologyInterruptionFailure
    const interruption = this.topologyInterruption
    if (!interruption) return
    await interruption
    if (this.topologyInterruption !== interruption || this.stopped) return

    this.topologyInterruption = null
    this.executionController = new AbortController()
    if (this.resumeSchedulerAfterTopologyChange) {
      this.scheduler.start()
      this.schedulerStarted = true
    }
    this.resumeSchedulerAfterTopologyChange = false
  }

  isReadOnly(): boolean {
    return !this.store.areCapabilitiesWritable(['automations.runs', 'automations.history'])
  }

  exportDefinitions(): AutomationDefinitionV3[] {
    this.assertRunning()
    const document = this.store.getDocument()
      ?? (this.store.areCapabilitiesWritable(['automations.definitions', 'automations.history'])
        ? this.store.initialize()
        : null)
    if (!document) throw new Error('Automation definitions are read-only and have not been initialized')
    return structuredClone(document.definitions)
  }

  importDefinitions(
    entries: AutomationDefinitionV3[],
    mode: 'skip' | 'overwrite',
    operationId = automationIdentity('op_resource_import', this.store.workspaceId, mode, entries),
  ): { imported: string[]; skipped: string[] } {
    this.assertRunning()
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = this.store.initialize()
      const byId = new Map(current.definitions.map(definition => [definition.id, definition]))
      const imported: string[] = []
      const skipped: string[] = []
      for (const entry of entries) {
        if (byId.has(entry.id) && mode === 'skip') {
          skipped.push(entry.name)
          continue
        }
        byId.set(entry.id, structuredClone(entry))
        imported.push(entry.name)
      }
      if (imported.length === 0) return { imported, skipped }
      const mutation = this.store.mutateDocument({
        operationId,
        expectedRevision: current.revision,
        document: { ...current, definitions: [...byId.values()] },
      })
      if (mutation.status === 'conflict') continue
      if (mutation.status !== 'ok' && mutation.status !== 'duplicate') {
        throw new Error(mutation.error?.message ?? `Automation import failed with status ${mutation.status}`)
      }
      this.refresh()
      return { imported, skipped }
    }
    throw new Error('Automation import conflicted after 3 attempts')
  }

  private assertRunning(): void {
    if (!this.started || this.stopped) throw new Error('Automation workspace host is not running')
  }

  private assertAcceptingRuns(): void {
    this.assertRunning()
    if (this.topologyInterruptionFailure) {
      throw new Error('Automation workspace host is blocked after topology interruption failed', {
        cause: this.topologyInterruptionFailure,
      })
    }
    if (this.topologyInterruption) throw new Error('Automation workspace topology interruption is in progress')
  }

  private enqueueAcceptedRun(run: AutomationRunV1): void {
    if (run.state !== 'queued' || run.reason === 'overlap-queued' || this.stopped || this.pendingIds.has(run.runId)) return
    this.pendingIds.add(run.runId)
    this.pending.push(run.runId)
    if (!this.processing) {
      const generation = this.executionGeneration
      const signal = this.executionController.signal
      this.processing = this.drain(generation, signal).finally(() => { this.processing = null })
    }
  }

  private recoverQueuedRuns(): void {
    const queued: AutomationRunV1[] = []
    let cursor
    do {
      const page = this.store.listRunsPage({ states: ['queued'], limit: 500, ...(cursor ? { cursor } : {}) })
      queued.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    const overlapByAutomation = new Map<string, AutomationRunV1[]>()
    for (const run of queued) {
      if (run.reason !== 'overlap-queued') {
        this.enqueueAcceptedRun(run)
        continue
      }
      const group = overlapByAutomation.get(run.automationId) ?? []
      group.push(run)
      overlapByAutomation.set(run.automationId, group)
    }
    for (const runs of overlapByAutomation.values()) {
      const [newest, ...older] = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const completedAt = new Date().toISOString()
      for (const stale of older) {
        this.store.updateRun({
          ...stale,
          state: 'skipped',
          reason: 'queue-one-coalesced',
          completedAt,
          actions: stale.actions.map(action => ({ ...action, state: 'skipped', completedAt })),
        }, `op_recover_queue_one:${stale.runId}`)
      }
      if (newest) this.enqueueAcceptedRun({ ...newest, reason: undefined })
    }
  }

  private async drain(generation: number, signal: AbortSignal): Promise<void> {
    while (!this.stopped && generation === this.executionGeneration && !signal.aborted) {
      const runId = this.pending.shift()
      if (!runId) break
      this.pendingIds.delete(runId)
      try {
        await this.runtime.executeClaimedRun(runId, signal)
        this.publishChanged()
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private async performWorkspaceTopologyInterruption(
    interruptedGeneration: number,
  ): Promise<AutomationWorkspaceInterruptionResultV1> {
    const firstPass = this.store.cancelNonTerminalRuns('workspace-topology-interrupted')
    await this.processing
    const residual = this.store.cancelNonTerminalRuns('workspace-topology-interrupted')
    if (this.executionGeneration !== interruptedGeneration + 1) {
      throw new Error('Automation workspace topology interruption generation changed unexpectedly')
    }
    this.publishChanged()
    return {
      selectedRunIds: [...new Set([...firstPass.selectedRunIds, ...residual.selectedRunIds])],
      cancelledRunIds: [...new Set([...firstPass.cancelledRunIds, ...residual.cancelledRunIds])],
    }
  }

  private report(error: Error): void {
    this.onError?.(error)
  }

  private publishChanged(): void {
    this.onChanged?.(this.store.getChangeToken())
  }
}
