import { describe, expect, it } from 'bun:test'
import { isAcceptableSandboxMessage } from './SandboxAppHost'

describe('isAcceptableSandboxMessage', () => {
  it('rejects null, undefined, and values that stringify to undefined', () => {
    expect(isAcceptableSandboxMessage(null)).toBe(false)
    expect(isAcceptableSandboxMessage(undefined)).toBe(false)
    expect(isAcceptableSandboxMessage({ toJSON: () => undefined })).toBe(false)
  })

  it('rejects unserializable and oversized messages', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(isAcceptableSandboxMessage(circular)).toBe(false)
    expect(isAcceptableSandboxMessage({ value: 'x'.repeat(32_768) })).toBe(false)
  })

  it('accepts bounded object messages', () => {
    expect(isAcceptableSandboxMessage({ type: 'ready' })).toBe(true)
  })
})
