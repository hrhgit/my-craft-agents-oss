type TimeoutHandle = ReturnType<typeof setTimeout>

interface SplashDismissalScheduler {
  schedule(callback: () => void, delayMs: number): TimeoutHandle
  cancel(handle: TimeoutHandle): void
}

export const SPLASH_EXIT_FALLBACK_MS = 750

export function createSplashDismissal(
  onDismiss: () => void,
  scheduler: SplashDismissalScheduler = {
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: handle => clearTimeout(handle),
  },
): { complete(): void; cancel(): void } {
  let completed = false
  let fallback: TimeoutHandle | undefined
  const complete = () => {
    if (completed) return
    completed = true
    if (fallback !== undefined) scheduler.cancel(fallback)
    onDismiss()
  }
  fallback = scheduler.schedule(complete, SPLASH_EXIT_FALLBACK_MS)
  return {
    complete,
    cancel() {
      if (completed) return
      completed = true
      if (fallback !== undefined) scheduler.cancel(fallback)
    },
  }
}
