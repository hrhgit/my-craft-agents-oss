import type { Session } from '../../shared/types'

type AsyncTask = () => Promise<void>
type FallbackHandle = ReturnType<typeof setTimeout>

export interface WorkspaceTransitionState {
  sourceWorkspaceId: string | null
  targetWorkspaceId: string
}

export type WorkspaceLayoutFlusher = () => void | Promise<void>
export type WorkspaceTransitionFlusher = WorkspaceLayoutFlusher

const workspaceLayoutFlushers = new Map<string, Set<WorkspaceLayoutFlusher>>()

/** Registers renderer layout state under the workspace that owns it. */
export function registerWorkspaceLayoutFlusher(
  workspaceId: string,
  flusher: WorkspaceLayoutFlusher,
): () => void {
  let workspaceFlushers = workspaceLayoutFlushers.get(workspaceId)
  if (!workspaceFlushers) {
    workspaceFlushers = new Set()
    workspaceLayoutFlushers.set(workspaceId, workspaceFlushers)
  }
  workspaceFlushers.add(flusher)
  return () => {
    workspaceFlushers?.delete(flusher)
    if (workspaceFlushers?.size === 0) workspaceLayoutFlushers.delete(workspaceId)
  }
}

/** Registers workspace-owned renderer state that must persist before switching away. */
export const registerWorkspaceTransitionFlusher = registerWorkspaceLayoutFlusher

/**
 * Flushes renderer state owned by the workspace being left. The caller must
 * await this before clearing workspace-scoped renderer atoms.
 */
export async function flushWorkspaceLayoutBeforeTransition(workspaceId: string): Promise<void> {
  const workspaceFlushers = workspaceLayoutFlushers.get(workspaceId)
  if (!workspaceFlushers?.size) return
  await Promise.all([...workspaceFlushers].map(flusher => Promise.resolve().then(flusher)))
}

export function isWorkspaceLayoutTransitioning(
  transition: WorkspaceTransitionState | null,
  workspaceId: string | null,
): boolean {
  if (!transition || !workspaceId) return false
  return transition.sourceWorkspaceId === workspaceId || transition.targetWorkspaceId === workspaceId
}

export interface WorkspaceTransitionCommit {
  rendererWorkspaceChanged: boolean
  restoreBaseline: boolean
}

/** Resolves the final renderer commit after intermediate targets were coalesced. */
export function resolveWorkspaceTransitionCommit(
  baselineWorkspaceId: string | null,
  rendererWorkspaceId: string | null,
  targetWorkspaceId: string,
): WorkspaceTransitionCommit {
  const rendererWorkspaceChanged = targetWorkspaceId !== rendererWorkspaceId
  return {
    rendererWorkspaceChanged,
    restoreBaseline: !rendererWorkspaceChanged && targetWorkspaceId === baselineWorkspaceId,
  }
}

interface RendererCommitScheduler {
  requestFrame: (callback: FrameRequestCallback) => number
  scheduleFallback: (callback: () => void, timeoutMs: number) => FallbackHandle
  cancelFallback: (handle: FallbackHandle) => void
}

const DEFAULT_RENDERER_COMMIT_FALLBACK_MS = 100

/**
 * Lets React commit transition state without depending indefinitely on RAF.
 * Chromium may pause animation frames for an unfocused Electron window.
 */
export function waitForRendererCommit(
  scheduler: RendererCommitScheduler = {
    requestFrame: callback => requestAnimationFrame(callback),
    scheduleFallback: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
    cancelFallback: handle => clearTimeout(handle),
  },
  fallbackMs = DEFAULT_RENDERER_COMMIT_FALLBACK_MS,
): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    let fallbackHandle: FallbackHandle | null = null
    const settle = () => {
      if (settled) return
      settled = true
      if (fallbackHandle !== null) scheduler.cancelFallback(fallbackHandle)
      resolve()
    }

    scheduler.requestFrame(() => settle())
    fallbackHandle = scheduler.scheduleFallback(settle, fallbackMs)
  })
}

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
