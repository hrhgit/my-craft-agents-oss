import type { AutomationDefinitionV3, AutomationRunV1, TimeTriggerV3 } from '../automations/v3-types.ts'
import { calculateTimeOccurrence, type ScheduledOccurrenceV1 } from './occurrences.ts'

const MAX_TIMEOUT_MS = 2_147_000_000

export interface AutomationSchedulerOptionsV1 {
  getDefinitions(): AutomationDefinitionV3[]
  listRuns(automationId: string): AutomationRunV1[]
  onOccurrence(definition: AutomationDefinitionV3, trigger: TimeTriggerV3, occurrence: ScheduledOccurrenceV1): Promise<void>
  now?: () => Date
  onError?: (error: Error) => void
}

export class AutomationSchedulerV3 {
  private readonly options: AutomationSchedulerOptionsV1
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private scanning = false

  constructor(options: AutomationSchedulerOptionsV1) {
    this.options = options
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.scan()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  refresh(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    void this.scan()
  }

  private async scan(): Promise<void> {
    if (this.stopped || this.scanning) return
    this.scanning = true
    try {
      const now = this.options.now?.() ?? new Date()
      let nearest: number | undefined
      for (const definition of this.options.getDefinitions()) {
        if (!definition.enabled) continue
        for (const trigger of definition.triggers) {
          if (trigger.type !== 'time') continue
          const runs = this.options.listRuns(definition.id).filter(run => run.triggerId === trigger.id && run.scheduledAt)
          const last = runs.sort((a, b) => (b.scheduledAt ?? '').localeCompare(a.scheduledAt ?? ''))[0]
          const calculation = calculateTimeOccurrence(trigger, {
            now,
            ...(last?.scheduledAt ? { lastClaimedAt: new Date(last.scheduledAt) } : {}),
          })
          if (calculation.due) await this.options.onOccurrence(definition, trigger, calculation.due)
          if (calculation.next) {
            const nextMs = Date.parse(calculation.next.scheduledAt)
            nearest = nearest === undefined ? nextMs : Math.min(nearest, nextMs)
          }
        }
      }
      if (!this.stopped) {
        const delay = nearest === undefined ? 60_000 : Math.max(1, Math.min(MAX_TIMEOUT_MS, nearest - (this.options.now?.() ?? new Date()).getTime()))
        this.timer = setTimeout(() => { this.timer = undefined; void this.scan() }, delay)
      }
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      if (!this.stopped) this.timer = setTimeout(() => { this.timer = undefined; void this.scan() }, 1_000)
    } finally {
      this.scanning = false
    }
  }
}
