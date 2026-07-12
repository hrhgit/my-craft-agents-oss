import { describe, expect, test } from 'bun:test'
import {
  getConnectionModelContextWindow,
  getContextUsagePercent,
} from '../context-usage'

describe('context usage', () => {
  test('uses the current connection model window for custom models', () => {
    const configuredWindow = getConnectionModelContextWindow([
      { id: 'gpt-5.6-sol', contextWindow: 600_000 },
    ], 'gpt-5.6-sol')

    expect(getContextUsagePercent({ inputTokens: 128_333 }, 'gpt-5.6-sol', configuredWindow))
      .toEqual({ inputTokens: 128_333, contextWindow: 600_000, percent: 21 })
  })

  test('prefers the runtime-reported context window', () => {
    expect(getContextUsagePercent(
      { inputTokens: 100_000, contextWindow: 200_000 },
      'gpt-5.6-sol',
      600_000,
    )).toEqual({ inputTokens: 100_000, contextWindow: 200_000, percent: 50 })
  })

  test('falls back to the built-in model registry', () => {
    expect(getContextUsagePercent(
      { inputTokens: 100_000 },
      'claude-sonnet-4-6',
    )).toEqual({ inputTokens: 100_000, contextWindow: 200_000, percent: 50 })
  })
})
