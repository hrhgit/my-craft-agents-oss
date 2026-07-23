import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVEL_IDS,
  isValidThinkingLevel,
  normalizeThinkingLevel,
} from '../thinking-levels.ts'

describe('normalizeThinkingLevel', () => {
  it('accepts every current thinking level unchanged', () => {
    for (const level of THINKING_LEVEL_IDS) {
      expect(normalizeThinkingLevel(level)).toBe(level)
    }
  })

  it('returns undefined for undefined/null input', () => {
    expect(normalizeThinkingLevel(undefined)).toBeUndefined()
    expect(normalizeThinkingLevel(null)).toBeUndefined()
  })

  it('returns undefined for non-string input', () => {
    expect(normalizeThinkingLevel(42)).toBeUndefined()
    expect(normalizeThinkingLevel({ level: 'medium' })).toBeUndefined()
    expect(normalizeThinkingLevel(['medium'])).toBeUndefined()
  })

  it('returns undefined for unknown string values', () => {
    expect(normalizeThinkingLevel('ultra')).toBeUndefined()
    expect(normalizeThinkingLevel('')).toBeUndefined()
  })

  it('does not migrate the retired "think" value to "medium"', () => {
    // Mutation guard: if the think -> medium alias is reintroduced, this fails.
    expect(normalizeThinkingLevel('think')).toBeUndefined()
    expect(normalizeThinkingLevel('think')).not.toBe('medium')
    expect(normalizeThinkingLevel('think')).not.toBe(DEFAULT_THINKING_LEVEL)
  })

  it('does not migrate the retired "max" value to "xhigh"', () => {
    // Mutation guard: if the max -> xhigh alias is reintroduced, this fails.
    expect(normalizeThinkingLevel('max')).toBeUndefined()
    expect(normalizeThinkingLevel('max')).not.toBe('xhigh')
  })

  it('does not case-fold input', () => {
    // No silent rewrite: only exact lowercase canonical IDs are accepted.
    expect(normalizeThinkingLevel('Medium')).toBeUndefined()
    expect(normalizeThinkingLevel('OFF')).toBeUndefined()
    expect(normalizeThinkingLevel('XHigh')).toBeUndefined()
  })
})

describe('isValidThinkingLevel', () => {
  it('accepts every current thinking level', () => {
    for (const level of THINKING_LEVEL_IDS) {
      expect(isValidThinkingLevel(level)).toBe(true)
    }
  })

  it('rejects the retired "think" and "max" values', () => {
    expect(isValidThinkingLevel('think')).toBe(false)
    expect(isValidThinkingLevel('max')).toBe(false)
  })

  it('rejects unknown and non-string values', () => {
    expect(isValidThinkingLevel('ultra')).toBe(false)
    expect(isValidThinkingLevel(undefined)).toBe(false)
    expect(isValidThinkingLevel(42)).toBe(false)
  })
})
