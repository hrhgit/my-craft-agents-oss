import type { Session } from '../../shared/types'

type AsyncTask = () => Promise<void>

interface PendingTask {
  task: AsyncTask
  waiters: Array<{
    resolve: () => void
    reject: (error: unknown) => void
  }>
}

/**
 * Runs one transition at a time while coalescing queued requests to the latest.
 * Callers queued behind the active task settle with the final coalesced task.
 */
export class LatestTaskQueue {
  private pending: PendingTask | null = null
  private draining = false

  get isRunning(): boolean {
    return this.draining || this.pending !== null
  }

  get hasPending(): boolean {
    return this.pending !== null
  }

  enqueue(task: AsyncTask): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      if (this.pending) {
        this.pending.task = task
        this.pending.waiters.push({ resolve, reject })
      } else {
        this.pending = { task, waiters: [{ resolve, reject }] }
      }
    })

    if (!this.draining) void this.drain()
    return promise
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (this.pending) {
        const current = this.pending
        this.pending = null
        try {
          await current.task()
          for (const waiter of current.waiters) waiter.resolve()
        } catch (error) {
          for (const waiter of current.waiters) waiter.reject(error)
        }
      }
    } finally {
      this.draining = false
    }
  }
}

export class WorkspaceSessionMismatchError extends Error {
  constructor(
    readonly expectedWorkspaceIds: string[],
    readonly returnedWorkspaceIds: string[],
  ) {
    super(`Session response belongs to ${returnedWorkspaceIds.join(', ') || '<missing>'}; expected ${expectedWorkspaceIds.join(', ')}`)
    this.name = 'WorkspaceSessionMismatchError'
  }
}

/** Rejects a transport response before it can populate a different workspace. */
export function assertWorkspaceSessionBatch(
  sessions: Array<Pick<Session, 'workspaceId'>>,
  expectedWorkspaceIds: Array<string | null | undefined>,
): void {
  const expected = Array.from(new Set(expectedWorkspaceIds.filter((id): id is string => !!id)))
  const returned = Array.from(new Set(sessions.map(session => session.workspaceId).filter(Boolean)))
  if (sessions.every(session => expected.includes(session.workspaceId))) return
  throw new WorkspaceSessionMismatchError(expected, returned)
}
