import type { AppLayout } from '../../../shared/app-layout'

export interface CoordinatedLayoutSaveQueue {
  enqueue<T>(write: () => Promise<T>): Promise<T>
  flush(): Promise<void>
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
