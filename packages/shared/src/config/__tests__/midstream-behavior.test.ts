import { describe, expect, it } from 'bun:test'
import {
  alternateMidStreamBehavior,
  DEFAULT_MID_STREAM_BEHAVIOR,
  normalizeMidStreamBehavior,
} from '../midstream-behavior.ts'

// ============================================================
// Pure helpers
// ============================================================

describe('global mid-stream behavior', () => {
  it('defaults Enter to queue', () => {
    expect(DEFAULT_MID_STREAM_BEHAVIOR).toBe('queue')
  })

  it('maps the alternate shortcut to the opposite behavior', () => {
    expect(alternateMidStreamBehavior('queue')).toBe('steer')
    expect(alternateMidStreamBehavior('steer')).toBe('queue')
  })
})

describe('normalizeMidStreamBehavior', () => {
  it('returns the explicit value when set to steer', () => {
    expect(normalizeMidStreamBehavior('steer')).toBe('steer')
  })

  it('returns the explicit value when set to queue', () => {
    expect(normalizeMidStreamBehavior('queue')).toBe('queue')
  })

  it('falls back to default when midStreamBehavior is undefined (legacy connection)', () => {
    expect(normalizeMidStreamBehavior(undefined)).toBeUndefined()
  })

  it('falls back to default when midStreamBehavior has an unknown value (corrupt config.json)', () => {
    expect(normalizeMidStreamBehavior('invalid')).toBeUndefined()
    expect(normalizeMidStreamBehavior('')).toBeUndefined()
  })
})

