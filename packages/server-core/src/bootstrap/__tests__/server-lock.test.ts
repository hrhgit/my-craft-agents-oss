import { describe, expect, it } from 'bun:test'
import { isProcessIdentityMismatch } from '../headless-start'

describe('server lock process identity', () => {
  it('accepts a lock owned by the same process', () => {
    expect(isProcessIdentityMismatch({ startedAt: 10_000, processStartedAt: 9_000 }, 9_500)).toBe(false)
  })

  it('rejects a live PID whose process identity changed', () => {
    expect(isProcessIdentityMismatch({ startedAt: 10_000, processStartedAt: 9_000 }, 20_000)).toBe(true)
  })

  it('detects PID reuse when process identity capture was unavailable', () => {
    expect(isProcessIdentityMismatch({ startedAt: 10_000 }, 20_000)).toBe(true)
  })

  it('stays conservative when process identity capture was unavailable', () => {
    expect(isProcessIdentityMismatch({ startedAt: 10_000 }, 9_500)).toBe(false)
    expect(isProcessIdentityMismatch({ startedAt: 10_000 }, null)).toBe(false)
  })
})
