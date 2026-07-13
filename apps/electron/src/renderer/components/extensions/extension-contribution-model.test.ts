import { describe, expect, it } from 'bun:test'
import { toExtensionBlock } from './extension-contribution-model'

const contribution = {
  schemaVersion: 1 as const,
  id: 'legacy-widget:status',
  surface: 'composer.below' as const,
  content: { type: 'text' as const, text: 'one\ntwo' },
}

describe('toExtensionBlock', () => {
  it('maps normalized legacy text widgets', () => {
    expect(toExtensionBlock(contribution)).toEqual({ key: 'status', content: ['one', 'two'], placement: 'belowEditor', source: undefined })
  })

  it('ignores native and non-text contributions', () => {
    expect(toExtensionBlock({ ...contribution, id: 'native' })).toBeNull()
    expect(toExtensionBlock({ ...contribution, content: { type: 'markdown', markdown: '**x**' } })).toBeNull()
  })
})
