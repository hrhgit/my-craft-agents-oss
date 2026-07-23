import type { AppLayout } from '../../../shared/app-layout'

export interface CoordinatedLayoutSaveQueue {
  enqueue<T>(write: () => Promise<T>): Promise<T>
  flush(): Promise<void>
}

export type LayoutPersistenceBoundary =
  | 'idle'
  | 'interaction-end'
  | 'workspace-transition'
  | 'window-close'
  | 'scope-dispose'

export interface LayoutPersistenceCoordinator<T> {
  markDirty(value: T): void
  flush(boundary: Exclude<LayoutPersistenceBoundary, 'idle'>, value?: T): Promise<void>
  discard(): void
}

interface LayoutPersistenceCoordinatorOptions<T> {
  persist: (value: T, boundary: LayoutPersistenceBoundary) => Promise<void>
  idleDelayMs?: number
  onError?: (error: unknown, boundary: LayoutPersistenceBoundary) => void
}

/** Keep capture and serialization outside model-change callbacks. */
export function createLayoutPersistenceCoordinator<T>({
  persist,
  idleDelayMs = 120,
  onError = () => undefined,
}: LayoutPersistenceCoordinatorOptions<T>): LayoutPersistenceCoordinator<T> {
  let pending: T | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let tail = Promise.resolve()

  const cancelIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = undefined
  }

  const enqueuePending = (boundary: LayoutPersistenceBoundary): Promise<void> => {
    cancelIdle()
    if (pending === undefined) return tail
    const value = pending
    pending = undefined
    const result = tail.then(() => persist(value, boundary))
    tail = result.catch(() => undefined)
    return result
  }

  const scheduleIdle = () => {
    cancelIdle()
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      void enqueuePending('idle').catch(error => onError(error, 'idle'))
    }, idleDelayMs)
  }

  return {
    markDirty(value) {
      pending = value
      scheduleIdle()
    },
    async flush(boundary, value) {
      if (value !== undefined) pending = value
      cancelIdle()
      while (true) {
        if (pending !== undefined) await enqueuePending(boundary)
        else await tail
        if (pending === undefined) {
          const observed = tail
          await observed
          if (pending === undefined && tail === observed) return
        }
      }
    },
    discard() {
      pending = undefined
      cancelIdle()
    },
  }
}

export function createCoordinatedLayoutSaveQueue(): CoordinatedLayoutSaveQueue {
  let tail = Promise.resolve()
  return {
    enqueue<T>(write: () => Promise<T>): Promise<T> {
      const result = tail.then(write)
      tail = result.then(() => undefined, () => undefined)
      return result
    },
    async flush(): Promise<void> {
      while (true) {
        const observed = tail
        await observed
        if (tail === observed) return
      }
    },
  }
}

export function shouldApplyCoordinatorRevision(
  currentRevision: number | null,
  incomingRevision: number,
): boolean {
  return currentRevision === null || incomingRevision >= currentRevision
}

export function recoverCoordinatedLayoutRetryFailure({
  currentScope,
  saveScope,
  latest,
  clearPendingSave,
  applyLatest,
}: {
  currentScope: string
  saveScope: string
  latest: AppLayout
  clearPendingSave: () => void
  applyLatest: (latest: AppLayout) => void
}): boolean {
  if (currentScope !== saveScope) return false
  clearPendingSave()
  applyLatest(latest)
  return true
}

interface CoordinatedLayoutSaveOptions {
  snapshot: AppLayout
  expectedRevision: number
  save: (snapshot: AppLayout, expectedRevision: number) => Promise<AppLayout>
  loadLatest: () => Promise<AppLayout>
  onRetryFailure: (latest: AppLayout, retryError: unknown, firstError: unknown) => void
}

export async function saveCoordinatedWindowLayout({
  snapshot,
  expectedRevision,
  save,
  loadLatest,
  onRetryFailure,
}: CoordinatedLayoutSaveOptions): Promise<AppLayout> {
  try {
    return await save(snapshot, expectedRevision)
  } catch (firstError) {
    const latest = await loadLatest()
    try {
      return await save({ ...snapshot, revision: latest.revision }, latest.revision)
    } catch (retryError) {
      onRetryFailure(latest, retryError, firstError)
      throw retryError
    }
  }
}

export async function runAuthoritativeLayoutMutation(
  mutate: () => Promise<AppLayout>,
  apply: (snapshot: AppLayout) => void,
): Promise<AppLayout> {
  const snapshot = await mutate()
  apply(snapshot)
  return snapshot
}
