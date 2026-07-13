import { describe, expect, test } from 'bun:test'
import { formatTokenCount, groupProviders, stripPiPrefixForDisplay } from '../model-picker-helpers'

describe('model picker helpers', () => {
  test('formats token counts', () => {
    expect(formatTokenCount(1_500)).toBe('1.5k')
    expect(formatTokenCount(200_000)).toBe('200k')
  })

  test('strips the Pi display prefix', () => {
    expect(stripPiPrefixForDisplay('pi/claude')).toBe('claude')
    expect(stripPiPrefixForDisplay('claude')).toBe('claude')
  })

  test('groups configured providers for hierarchical rendering', () => {
    const providers = [{ key: 'anthropic' }, { key: 'openrouter' }]
    expect(groupProviders(providers)).toEqual([['Providers', providers]])
    expect(groupProviders([])).toEqual([])
  })
})
