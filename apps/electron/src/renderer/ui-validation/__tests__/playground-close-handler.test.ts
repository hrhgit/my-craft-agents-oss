import { describe, expect, it, mock } from 'bun:test'
import { installPlaygroundCloseHandler } from '../playground-close-handler'

describe('playground validation close handler', () => {
  it('disposes validation state and confirms the first close request', () => {
    let requestClose: (() => void) | undefined
    const unsubscribe = mock(() => undefined)
    const confirmCloseWindow = mock(async () => undefined)
    const disposeValidation = mock(() => undefined)
    const cleanup = installPlaygroundCloseHandler({
      onCloseRequested(callback) {
        requestClose = callback
        return unsubscribe
      },
      confirmCloseWindow,
    }, disposeValidation)

    requestClose?.()
    requestClose?.()

    expect(disposeValidation).toHaveBeenCalledTimes(1)
    expect(confirmCloseWindow).toHaveBeenCalledTimes(1)

    cleanup()
    cleanup()
    expect(disposeValidation).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('disposes validation state when the page unloads without a close request', () => {
    const unsubscribe = mock(() => undefined)
    const disposeValidation = mock(() => undefined)
    const cleanup = installPlaygroundCloseHandler({
      onCloseRequested: () => unsubscribe,
      confirmCloseWindow: async () => undefined,
    }, disposeValidation)

    cleanup()

    expect(disposeValidation).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
