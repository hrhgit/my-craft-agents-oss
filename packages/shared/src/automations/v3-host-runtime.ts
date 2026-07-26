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

/** Owns the canonical store, scheduler, claims, execution queue, and run ledger for one workspace. */
export class AutomationWorkspaceHostV3 {
  readonly store: AutomationV3Store
  readonly runtime: AutomationV3Runtime
  private readonly scheduler: AutomationSchedulerV3
  private readonly validateSession?: AutomationWorkspaceHostV3Options['validateSession']
  private readonly onChanged?: AutomationWorkspaceHostV3Options['onChanged']
  private readonly onError?: (error: Error) => void
  private readonly abortController = new AbortController()
  private readonly pending: string[] = []
  private readonly pendingIds = new Set<string>()
  private processing: Promise<void> | null = null
  private started = false
  private stopped = false
  private readOnly = false

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
    if (!this.store.isWritable()) {
      this.readOnly = true
      return
    }
    this.store.initialize()
    this.store.recoverExpiredExecutions()
    this.recoverQueuedRuns()
    this.scheduler.start()
  }

  refresh(): void {
    if (!this.started || this.stopped || this.readOnly) return
    this.scheduler.refresh()
    this.publishChanged()
  }

  acceptManual(automationId: string, operationId: string, triggerId?: string): { run: AutomationRunV1; duplicate: boolean } {
    this.assertRunning()
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
    this.assertRunning()
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
    this.abortController.abort(new Error('Automation workspace host stopped'))
    await this.processing?.catch(() => {})
    this.store.close()
  }

  isReadOnly(): boolean {
    return this.readOnly
  }

  exportDefinitions(): AutomationDefinitionV3[] {
    this.assertRunning()
    return structuredClone(this.store.initialize().definitions)
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
    if (this.readOnly) throw new Error('Automation workspace host is read-only because its storage capabilities are incompatible')
  }

  private enqueueAcceptedRun(run: AutomationRunV1): void {
    if (run.state !== 'queued' || run.reason === 'overlap-queued' || this.stopped || this.pendingIds.has(run.runId)) return
    this.pendingIds.add(run.runId)
    this.pending.push(run.runId)
    if (!this.processing) this.processing = this.drain().finally(() => { this.processing = null })
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

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const runId = this.pending.shift()
      if (!runId) break
      this.pendingIds.delete(runId)
      try {
        await this.runtime.executeClaimedRun(runId, this.abortController.signal)
        this.publishChanged()
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private report(error: Error): void {
    this.onError?.(error)
  }

  private publishChanged(): void {
    this.onChanged?.(this.store.getChangeToken())
  }
}
