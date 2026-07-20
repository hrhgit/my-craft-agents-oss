import { AutomationSchedulerV3 } from '../scheduler/automation-scheduler.ts'
import { AutomationV3Store, type AutomationV3StoreOptions } from './v3-store.ts'
import { AutomationV3Runtime, type AutomationEventDispatchResultV1 } from './v3-runtime.ts'
import type {
  AutomationExecutionCallbacksV1,
  AutomationRunV1,
  CloudEventV1,
  TrustedAutomationEventV1,
} from './v3-types.ts'

export interface AutomationWorkspaceHostV3Options extends AutomationV3StoreOptions {
  callbacks: AutomationExecutionCallbacksV1
  validateSession?: (sessionId: string, workspaceId: string) => boolean
  onChanged?: () => void
  onError?: (error: Error) => void
}

/** Owns the canonical store, scheduler, claims, execution queue, and run ledger for one workspace. */
export class AutomationWorkspaceHostV3 {
  readonly store: AutomationV3Store
  readonly runtime: AutomationV3Runtime
  private readonly scheduler: AutomationSchedulerV3
  private readonly validateSession?: AutomationWorkspaceHostV3Options['validateSession']
  private readonly onChanged?: () => void
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
      getDefinitions: () => this.store.initializeOrMigrate().document.definitions,
      listRuns: automationId => this.store.listRuns({ automationId, limit: 10_000 }),
      onOccurrence: async (definition, trigger, occurrence) => {
        this.enqueueAcceptedRun(this.runtime.acceptTimeTrigger(definition, trigger, occurrence))
      },
      onError: error => this.report(error),
    })
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.store.initializeOrMigrate()
    if (!this.store.isWritable()) {
      this.readOnly = true
      return
    }
    this.store.recoverExpiredExecutions()
    this.recoverQueuedRuns()
    this.scheduler.start()
  }

  refresh(): void {
    if (!this.started || this.stopped || this.readOnly) return
    this.scheduler.refresh()
    this.onChanged?.()
  }

  acceptManual(automationId: string, operationId: string, triggerId?: string): { run: AutomationRunV1; duplicate: boolean } {
    this.assertRunning()
    const result = this.runtime.acceptManual(automationId, operationId, triggerId)
    if (!result.duplicate) this.enqueueAcceptedRun(result.run)
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
      return { ...result, runs: this.store.listRuns({ limit: 10_000 }).filter(run => run.eventId === result.event!.eventId) }
    }
    for (const run of result.runs) this.enqueueAcceptedRun(run)
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
    const queued = this.store.listRuns({ limit: 10_000 }).filter(run => run.state === 'queued')
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
      const newest = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
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
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  private report(error: Error): void {
    this.onError?.(error)
  }
}
