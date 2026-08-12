/**
 * Tests for `collectTaggedModels` — the single-level tagged model list used by
 * the "仅显示标签模型" picker mode.
 */

import { describe, test, expect } from 'bun:test'
import { collectTaggedModels } from '../model-picker-helpers'
import type { PiGlobalProvider } from '../../../../../shared/types'

function provider(key: string, models: Array<{ id: string; name?: string; tags?: unknown }>): { key: string; provider: PiGlobalProvider } {
  return { key, provider: { models: models as PiGlobalProvider['models'] } }
}

describe('collectTaggedModels', () => {
  test('collects tagged models across providers with name + tags', () => {
    const entries = collectTaggedModels([
      provider('a', [
        { id: 'm1', name: 'Model One', tags: ['常用', '快速'] },
        { id: 'm2', tags: [] },
        { id: 'm3', tags: undefined },
      ]),
      provider('b', [{ id: 'm4', tags: ['轻量'] }]),
    ])
    expect(entries).toEqual([
      { providerKey: 'a', modelId: 'm1', modelName: 'Model One', tags: ['常用', '快速'] },
      { providerKey: 'b', modelId: 'm4', modelName: 'm4', tags: ['轻量'] },
    ])
  })

  test('drops non-string / blank tags but keeps the model when at least one valid tag remains', () => {
    const entries = collectTaggedModels([
      provider('a', [{ id: 'm1', tags: ['常用', '', 42, null] }]),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.tags).toEqual(['常用'])
  })

  test('excludes models without any valid tag', () => {
    const entries = collectTaggedModels([
      provider('a', [
        { id: 'm1', tags: [] },
        { id: 'm2', tags: ['  '] },
        { id: 'm3' },
      ]),
      provider('b', []),
    ])
    expect(entries).toEqual([])
  })

  test('empty provider list yields no entries', () => {
    expect(collectTaggedModels([])).toEqual([])
  })
})
