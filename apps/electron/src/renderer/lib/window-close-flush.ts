export type WindowCloseFlusher = () => void | Promise<void>

const flushers = new Set<WindowCloseFlusher>()
const DEFAULT_CLOSE_FLUSH_TIMEOUT_MS = 1_500

export function registerWindowCloseFlusher(flusher: WindowCloseFlusher): () => void {
  flushers.add(flusher)
  return () => flushers.delete(flusher)
}

export async function flushWindowCloseState(timeoutMs = DEFAULT_CLOSE_FLUSH_TIMEOUT_MS): Promise<void> {
  if (flushers.size === 0) return
  const pending = Promise.all([...flushers].map(flusher => Promise.resolve().then(flusher)))
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pending.then(() => undefined),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Renderer state flush timed out after ${timeoutMs} ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
