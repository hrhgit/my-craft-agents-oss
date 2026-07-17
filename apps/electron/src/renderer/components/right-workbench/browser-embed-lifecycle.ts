import type { BrowserEmbedBounds } from '../../../shared/types'

export interface BrowserEmbedApi {
  embed(id: string, bounds: BrowserEmbedBounds): Promise<void>
  updateEmbedBounds(id: string, bounds: BrowserEmbedBounds): Promise<void>
  detach(id: string): Promise<void>
}

export interface BrowserEmbedLifecycle {
  update(bounds: BrowserEmbedBounds | null): void
  dispose(): void
}

function serializeBounds(bounds: BrowserEmbedBounds): string {
  return `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
}

const MAX_RECONCILE_ATTEMPTS = 3
const RECONCILE_RETRY_DELAYS_MS = [10, 30] as const

export function getVisibleBrowserEmbedBounds(
  element: HTMLElement,
  getStyle: (element: Element) => Pick<CSSStyleDeclaration, 'display' | 'visibility'> =
    elementToMeasure => window.getComputedStyle(elementToMeasure),
): BrowserEmbedBounds | null {
  if (!element.isConnected) return null

  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = getStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return null
    }
  }

  const rect = element.getBoundingClientRect()
  if (
    !Number.isFinite(rect.left)
    || !Number.isFinite(rect.top)
    || !Number.isFinite(rect.width)
    || !Number.isFinite(rect.height)
    || rect.width <= 0
    || rect.height <= 0
  ) return null

  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

export function createBrowserEmbedLifecycle(
  instanceId: string,
  api: BrowserEmbedApi,
  onError: (operation: 'embed' | 'resize' | 'detach', error: unknown) => void,
): BrowserEmbedLifecycle {
  let desiredBounds: BrowserEmbedBounds | null = null
  let desiredVersion = 0
  let appliedBoundsKey = ''
  let embedded = false
  let attachmentUncertain = false
  let running = false
  let disposed = false
  let blockedDesiredVersion = -1
  let failureVersion = -1
  let failureCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const needsReconcile = (): boolean => {
    if (blockedDesiredVersion === desiredVersion) return false
    if (!desiredBounds) return embedded || attachmentUncertain
    const desiredKey = serializeBounds(desiredBounds)
    return !embedded || attachmentUncertain || desiredKey !== appliedBoundsKey
  }

  const reportError = (operation: 'embed' | 'resize' | 'detach', error: unknown): void => {
    try {
      onError(operation, error)
    } catch {
      // Diagnostics must not prevent the ownership state machine converging.
    }
  }

  const clearRetryTimer = (): void => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }

  const resetFailures = (): void => {
    clearRetryTimer()
    failureVersion = -1
    failureCount = 0
    blockedDesiredVersion = -1
  }

  const scheduleRetry = (targetVersion: number): void => {
    if (failureVersion !== targetVersion) {
      failureVersion = targetVersion
      failureCount = 0
    }
    failureCount += 1
    blockedDesiredVersion = targetVersion
    clearRetryTimer()
    if (failureCount >= MAX_RECONCILE_ATTEMPTS) return

    const delay = RECONCILE_RETRY_DELAYS_MS[Math.min(
      failureCount - 1,
      RECONCILE_RETRY_DELAYS_MS.length - 1,
    )]!
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (desiredVersion !== targetVersion) return
      blockedDesiredVersion = -1
      reconcile()
    }, delay)
  }

  const drain = async (): Promise<void> => {
    while (true) {
      const target = desiredBounds
      const targetVersion = desiredVersion
      if (!target) {
        if (!embedded && !attachmentUncertain) return
        try {
          await api.detach(instanceId)
        } catch (error) {
          // A rejected RPC may still have completed remotely. Treat the local
          // owner as unknown so a later visible target performs an idempotent
          // embed and disposal can make one final bounded detach attempt.
          embedded = false
          attachmentUncertain = true
          appliedBoundsKey = ''
          reportError('detach', error)
          if (desiredVersion !== targetVersion) continue
          scheduleRetry(targetVersion)
          return
        }
        embedded = false
        attachmentUncertain = false
        appliedBoundsKey = ''
        resetFailures()
        continue
      }

      const targetKey = serializeBounds(target)
      if (!embedded || attachmentUncertain) {
        try {
          await api.embed(instanceId, target)
        } catch (error) {
          embedded = false
          attachmentUncertain = true
          appliedBoundsKey = ''
          reportError('embed', error)
          if (desiredVersion !== targetVersion) continue
          scheduleRetry(targetVersion)
          return
        }
        embedded = true
        attachmentUncertain = false
        appliedBoundsKey = targetKey
        resetFailures()
        continue
      }

      if (targetKey !== appliedBoundsKey) {
        try {
          await api.updateEmbedBounds(instanceId, target)
        } catch (error) {
          reportError('resize', error)
          if (desiredVersion !== targetVersion) continue
          scheduleRetry(targetVersion)
          return
        }
        appliedBoundsKey = targetKey
        resetFailures()
        continue
      }

      return
    }
  }

  const reconcile = (): void => {
    if (running || !needsReconcile()) return
    running = true
    void drain()
      .catch(() => {
        // Operation failures are handled in drain. Block an unexpected error
        // at the current desired state rather than creating an unhandled,
        // frame-by-frame retry loop.
        blockedDesiredVersion = desiredVersion
      })
      .finally(() => {
        running = false
        if (needsReconcile()) reconcile()
      })
  }

  const setDesiredBounds = (bounds: BrowserEmbedBounds | null, force = false): void => {
    const previousKey = desiredBounds ? serializeBounds(desiredBounds) : ''
    const nextKey = bounds ? serializeBounds(bounds) : ''
    desiredBounds = bounds
    if (force || nextKey !== previousKey) {
      clearRetryTimer()
      desiredVersion += 1
      resetFailures()
    }
  }

  return {
    update(bounds) {
      if (disposed) return
      setDesiredBounds(bounds)
      reconcile()
    },
    dispose() {
      if (disposed) return
      disposed = true
      // Invalidate any blocked visible target so an in-flight operation can
      // still converge to the terminal hidden state.
      setDesiredBounds(null, true)
      reconcile()
    },
  }
}
