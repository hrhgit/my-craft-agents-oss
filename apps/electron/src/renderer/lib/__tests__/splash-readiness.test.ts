import { describe, expect, it } from 'bun:test'
import { createSplashDismissal, SPLASH_EXIT_FALLBACK_MS } from '../splash-readiness'

describe('splash readiness dismissal', () => {
  it('dismisses through the bounded fallback when animation completion never arrives', () => {
    let fallback: (() => void) | undefined
    const delays: number[] = []
    let dismissals = 0
    createSplashDismissal(() => { dismissals += 1 }, {
      schedule(callback, delayMs) {
        fallback = callback
        delays.push(delayMs)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancel() {},
    })

    expect(delays).toEqual([SPLASH_EXIT_FALLBACK_MS])
    fallback?.()
    expect(dismissals).toBe(1)
  })

  it('completes only once when motion and the fallback both settle', () => {
    let fallback: (() => void) | undefined
    let dismissals = 0
    const dismissal = createSplashDismissal(() => { dismissals += 1 }, {
      schedule(callback) {
        fallback = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      cancel() {},
    })

    dismissal.complete()
    fallback?.()
    expect(dismissals).toBe(1)
  })
})
