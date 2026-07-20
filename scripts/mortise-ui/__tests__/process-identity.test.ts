import { describe, expect, it } from 'bun:test'
import { isProcessIdentityMismatch } from '../process-identity.ts'

describe('mortise-ui process identity', () => {
  it('accepts the recorded process and rejects a reused PID identity', () => {
    expect(isProcessIdentityMismatch({ startedAt: 10_000, recordedAt: 11_000 }, 10_500)).toBe(false)
    expect(isProcessIdentityMismatch({ startedAt: 10_000, recordedAt: 11_000 }, 20_000)).toBe(true)
  })

  it('uses the run timestamp as a conservative fallback for legacy manifests', () => {
    expect(isProcessIdentityMismatch({ recordedAt: 10_000 }, 9_000)).toBe(false)
    expect(isProcessIdentityMismatch({ recordedAt: 10_000 }, 20_000)).toBe(true)
    expect(isProcessIdentityMismatch({ recordedAt: 10_000 }, undefined)).toBe(false)
  })
})
