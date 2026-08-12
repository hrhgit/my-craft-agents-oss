import { describe, test, expect } from 'bun:test'
import {
  piProviderModelTags,
  piProviderModelVisionProxy,
  setPiProviderModelTags,
  setPiProviderModelVisionProxy,
  type PiGlobalProvider,
} from './pi-provider-models'

const provider: PiGlobalProvider = {
  models: [
    { id: 'a', tags: ['常用', '快速'] },
    { id: 'b' },
  ],
}

describe('piProviderModelTags', () => {
  test('returns tags for a tagged model', () => {
    expect(piProviderModelTags(provider, 'a')).toEqual(['常用', '快速'])
  })

  test('returns [] for a model without tags', () => {
    expect(piProviderModelTags(provider, 'b')).toEqual([])
  })

  test('returns [] for unknown model or missing provider', () => {
    expect(piProviderModelTags(provider, 'nope')).toEqual([])
    expect(piProviderModelTags(null, 'a')).toEqual([])
  })

  test('drops non-string and blank tags', () => {
    const messy: PiGlobalProvider = { models: [{ id: 'x', tags: ['ok', '', 42, null] as unknown as string[] }] }
    expect(piProviderModelTags(messy, 'x')).toEqual(['ok'])
  })
})

describe('setPiProviderModelTags', () => {
  test('sets tags with trimming and deduplication', () => {
    const next = setPiProviderModelTags(provider, 'b', [' 轻量 ', '轻量', '快速'])
    expect(next.models!.find(m => m.id === 'b')!.tags).toEqual(['轻量', '快速'])
    // untouched models stay intact
    expect(next.models!.find(m => m.id === 'a')!.tags).toEqual(['常用', '快速'])
  })

  test('removes the tags field when cleared', () => {
    const next = setPiProviderModelTags(provider, 'a', [])
    const model = next.models!.find(m => m.id === 'a')!
    expect('tags' in model).toBe(false)
  })

  test('is a no-op for an unknown model id', () => {
    const next = setPiProviderModelTags(provider, 'nope', ['x'])
    expect(next.models).toEqual(provider.models)
  })
})

describe('piProviderModelVisionProxy', () => {
  const withProxy: PiGlobalProvider = {
    models: [{ id: 'a', visionProxy: { provider: 'openai', model: 'gpt-4o' } }, { id: 'b' }],
  }

  test('returns the configured vision proxy', () => {
    expect(piProviderModelVisionProxy(withProxy, 'a')).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  test('returns undefined when not configured', () => {
    expect(piProviderModelVisionProxy(withProxy, 'b')).toBeUndefined()
    expect(piProviderModelVisionProxy(null, 'a')).toBeUndefined()
  })

  test('rejects malformed vision proxy values', () => {
    const messy: PiGlobalProvider = {
      models: [
        { id: 'x', visionProxy: { provider: '', model: 'gpt-4o' } as unknown as { provider: string; model: string } },
        { id: 'y', visionProxy: { provider: 'openai', model: '  ' } as unknown as { provider: string; model: string } },
      ],
    }
    expect(piProviderModelVisionProxy(messy, 'x')).toBeUndefined()
    expect(piProviderModelVisionProxy(messy, 'y')).toBeUndefined()
  })
})

describe('setPiProviderModelVisionProxy', () => {
  test('sets the vision proxy with trimmed values', () => {
    const next = setPiProviderModelVisionProxy(provider, 'b', { provider: ' openai ', model: ' gpt-4o ' })
    expect(next.models!.find(m => m.id === 'b')!.visionProxy).toEqual({ provider: 'openai', model: 'gpt-4o' })
    expect(next.models!.find(m => m.id === 'a')!.tags).toEqual(['常用', '快速'])
  })

  test('removes the vision proxy field when cleared', () => {
    const next = setPiProviderModelVisionProxy(provider, 'a', undefined)
    const model = next.models!.find(m => m.id === 'a')!
    expect('visionProxy' in model).toBe(false)
  })

  test('is a no-op for an unknown model id', () => {
    const next = setPiProviderModelVisionProxy(provider, 'nope', { provider: 'openai', model: 'gpt-4o' })
    expect(next.models).toEqual(provider.models)
  })
})
