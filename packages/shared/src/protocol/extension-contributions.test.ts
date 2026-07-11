import { describe, expect, it } from 'bun:test'
import { validateExtensionContributionV1 } from './extension-contributions'

const contribution = {
  schemaVersion: 1, contributionId: 'block:status', extensionId: 'status-extension',
  sessionId: 'session-1', runtimeId: 'runtime-1', kind: 'block', placement: 'below_editor',
  payload: { format: 'text', content: 'Working' },
}

describe('ExtensionContributionV1', () => {
  it('accepts bounded declarative blocks', () => {
    expect(validateExtensionContributionV1(contribution)).toBeNull()
  })

  it('rejects executable and DOM payloads', () => {
    expect(validateExtensionContributionV1({ ...contribution, payload: { format: 'text', content: 'x', html: '<button />' } })).toContain('forbidden')
    expect(validateExtensionContributionV1({ ...contribution, payload: { format: 'text', content: 'x', component: () => null } })).toContain('forbidden')
  })
})
