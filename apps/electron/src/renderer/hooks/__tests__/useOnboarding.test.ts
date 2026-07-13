import { describe, expect, test } from 'bun:test'
import { resolveSlugForMethod } from '../useOnboarding'

describe('provider key allocation', () => {
  test('uses the standard Pi API key when available', () => {
    expect(resolveSlugForMethod('pi_api_key', null, new Set())).toBe('pi-api-key')
  })

  test('keeps the key when editing a provider', () => {
    expect(resolveSlugForMethod('pi_api_key', 'anthropic', new Set(['anthropic']))).toBe('anthropic')
  })

  test('allocates a unique provider key', () => {
    expect(resolveSlugForMethod('pi_api_key', null, new Set(['pi-api-key', 'pi-api-key-2']))).toBe('pi-api-key-3')
  })
})
