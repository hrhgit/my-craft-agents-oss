export interface PlaygroundCloseApi {
  onCloseRequested(callback: () => void): () => void
  confirmCloseWindow(): Promise<void>
}

export function installPlaygroundCloseHandler(
  api: PlaygroundCloseApi,
  disposeValidation: () => void,
): () => void {
  let closeRequested = false
  let disposed = false
  let unsubscribed = false

  const disposeOnce = () => {
    if (disposed) return
    disposed = true
    disposeValidation()
  }
  const unsubscribe = api.onCloseRequested(() => {
    if (closeRequested) return
    closeRequested = true
    disposeOnce()
    void api.confirmCloseWindow().catch(error => {
      console.error('[Playground] Failed to confirm validation window close:', error)
    })
  })

  return () => {
    if (!unsubscribed) {
      unsubscribed = true
      unsubscribe()
    }
    disposeOnce()
  }
}
