import type { DueAutomationOccurrenceV1 } from '../automations/v3-index.ts'

const MAX_TIMEOUT_MS = 2_147_000_000

export interface AutomationSchedulerOptionsV1 {
  listDueOccurrences(dueAtOrBefore: Date, activeSince: Date): DueAutomationOccurrenceV1[]
  getNextDueAt(): Date | null
  onOccurrence(due: DueAutomationOccurrenceV1): Promise<void>
  now?: () => Date
  onError?: (error: Error) => void
}

export class AutomationSchedulerV3 {
  private readonly options: AutomationSchedulerOptionsV1
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private scanning = false
  private activeSince: Date | undefined

  constructor(options: AutomationSchedulerOptionsV1) {
    this.options = options
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.activeSince = this.options.now?.() ?? new Date()
    void this.scan()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.activeSince = undefined
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
      const activeSince = this.activeSince ?? now
      for (const due of this.options.listDueOccurrences(now, activeSince)) await this.options.onOccurrence(due)
      this.activeSince = now
      if (!this.stopped) {
        const nearest = this.options.getNextDueAt()?.getTime()
        const delay = nearest === undefined
          ? 60_000
          : Math.max(1, Math.min(MAX_TIMEOUT_MS, nearest - (this.options.now?.() ?? new Date()).getTime()))
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
