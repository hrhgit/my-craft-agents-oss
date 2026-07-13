import { describe, expect, it } from 'bun:test'
import { validateExtensionContributionDeltaV1, validateExtensionContributionV1 } from './extension-contributions'

const contribution = {
  schemaVersion: 1,
  id: 'status',
  surface: 'composer.above',
  content: { type: 'stack', children: [
    { type: 'text', text: 'Working' },
    { type: 'button', label: 'Open', action: { kind: 'command', command: 'status:open' } },
  ] },
} as const

describe('ExtensionContributionV1', () => {
  it('accepts bounded declarative trees', () => {
    expect(validateExtensionContributionV1(contribution)).toBeNull()
  })

  it('rejects executable, DOM, and unknown primitives', () => {
    expect(validateExtensionContributionV1({ ...contribution, html: '<button />' })).toContain('Unsupported contribution field')
    expect(validateExtensionContributionV1({ ...contribution, content: { type: 'iframe' } })).toContain('Unsupported')
    expect(validateExtensionContributionV1({ ...contribution, content: { type: 'text', text: 'x', onClick: 'run' } })).toContain('Unsupported text node field')
    expect(validateExtensionContributionV1({ ...contribution, surface: 'conversation.message.before', target: undefined })).toContain('target.messageId')
    expect(validateExtensionContributionV1({ ...contribution, surface: 'window.topRight', content: { type: 'markdown', markdown: '# Too large' } })).toContain('Compact surfaces')
    expect(validateExtensionContributionV1({ ...contribution, target: { messageId: 'message' } })).toContain('does not accept a target')
  })

  it('validates routed lifecycle deltas', () => {
    expect(validateExtensionContributionDeltaV1({
      schemaVersion: 1, extensionId: 'status-extension', sessionId: 'session-1', runtimeId: 'runtime-1',
      revision: 1, operation: 'upsert', contribution,
    })).toBeNull()
    expect(validateExtensionContributionDeltaV1({
      schemaVersion: 1, extensionId: 'status-extension', sessionId: 'session-1', runtimeId: 'runtime-1',
      revision: 1, operation: 'remove', contributionId: '',
    })).toContain('contributionId')
  })

  it('only allows a sandbox app as a top-level node on approved surfaces', () => {
    const sandbox = {
      type: 'sandbox-app', appId: 'dashboard', title: 'Dashboard', html: '<main></main>', permissions: [],
    }
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'sandbox', surface: 'conversation.timeline.before', content: sandbox,
    })).toBeNull()
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'nested-sandbox', surface: 'conversation.timeline.before',
      content: { type: 'stack', children: [sandbox] },
    })).toContain('top-level')
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'compact-sandbox', surface: 'window.topRight', content: sandbox,
    })).toContain('Compact surfaces')
  })
})
