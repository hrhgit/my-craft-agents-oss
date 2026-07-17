export type WorkspaceFileDraftMutation =
  | { type: 'set'; relativePath: string; content: string; baseContent: string }
  | { type: 'delete'; relativePath: string }

export interface WorkspaceFileDraftPersistence {
  set(relativePath: string, content: string, baseContent: string): Promise<unknown>
  delete(relativePath: string): Promise<unknown>
}

export interface WorkspaceFileDraftQueueOptions {
  onPendingChange?: (pending: boolean) => void
}

export class WorkspaceFileDraftQueue {
  private readonly pending = new Map<string, WorkspaceFileDraftMutation>()
  private inFlight: Promise<void> | null = null
  private lastReportedPending = false

  constructor(
    private readonly persistence: WorkspaceFileDraftPersistence,
    private readonly options: WorkspaceFileDraftQueueOptions = {},
  ) {}

  enqueue(mutation: WorkspaceFileDraftMutation): Promise<void> {
    this.pending.set(mutation.relativePath, mutation)
    this.reportPending()
    return this.drain()
  }

  async flush(latest?: WorkspaceFileDraftMutation): Promise<void> {
    if (latest) {
      this.pending.set(latest.relativePath, latest)
      this.reportPending()
    }
    while (this.inFlight || this.pending.size > 0) {
      await (this.inFlight ?? this.drain())
    }
  }

  private drain(): Promise<void> {
    if (this.inFlight) return this.inFlight

    const work = (async () => {
      while (this.pending.size > 0) {
        const next = this.pending.entries().next().value as
          | [string, WorkspaceFileDraftMutation]
          | undefined
        if (!next) return
        const [relativePath, mutation] = next
        this.pending.delete(relativePath)
        try {
          if (mutation.type === 'set') {
            await this.persistence.set(
              mutation.relativePath,
              mutation.content,
              mutation.baseContent,
            )
          } else {
            await this.persistence.delete(mutation.relativePath)
          }
        } catch (error) {
          // Retain the failed snapshot unless a newer mutation superseded it.
          if (!this.pending.has(relativePath)) this.pending.set(relativePath, mutation)
          this.reportPending()
          throw error
        }
      }
    })()
    this.inFlight = work
    void work.finally(() => {
      if (this.inFlight === work) this.inFlight = null
      this.reportPending()
    }).catch(() => {})
    return work
  }

  private reportPending(): void {
    const hasPending = this.pending.size > 0 || this.inFlight !== null
    if (hasPending === this.lastReportedPending) return
    this.lastReportedPending = hasPending
    this.options.onPendingChange?.(hasPending)
  }
}
