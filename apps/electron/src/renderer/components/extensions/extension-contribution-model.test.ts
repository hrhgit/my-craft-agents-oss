import { describe, expect, it } from 'bun:test'
import { toExtensionBlock } from './extension-contribution-model'

const contribution = {
  schemaVersion: 1 as const, contributionId: 'widget:status', extensionId: 'ext',
  sessionId: 'session', runtimeId: 'runtime', kind: 'block' as const,
  placement: 'below_editor' as const, payload: { format: 'text', content: 'one\ntwo' },
}

describe('toExtensionBlock', () => {
  it('maps declarative text blocks and removals', () => {
    expect(toExtensionBlock(contribution)).toEqual({ key: 'status', content: ['one', 'two'], placement: 'belowEditor', source: undefined })
    expect(toExtensionBlock({ ...contribution, payload: { format: 'text', content: '', removed: true } })?.content).toBeUndefined()
  })

  it('ignores non-widget and executable formats', () => {
    expect(toExtensionBlock({ ...contribution, contributionId: 'other' })).toBeNull()
    expect(toExtensionBlock({ ...contribution, payload: { format: 'html', content: '<b>x</b>' } })).toBeNull()
  })
})
