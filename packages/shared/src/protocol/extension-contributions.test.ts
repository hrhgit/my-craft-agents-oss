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

  it('accepts artifact panes, artifact actions, and bounded step progress', () => {
    expect(validateExtensionContributionV1({
      schemaVersion: 1,
      id: 'review',
      surface: 'conversation.artifact.aside',
      title: 'Review',
      target: { artifactId: 'plan-1' },
      content: { type: 'markdown', markdown: '# Review' },
    })).toBeNull()
    expect(validateExtensionContributionV1({
      schemaVersion: 1,
      id: 'actions',
      surface: 'conversation.artifact.footer',
      target: { artifactId: 'plan-1' },
      content: { type: 'button', label: 'Execute', emphasis: 'primary', disabled: true, disabledReason: 'Review is unavailable', action: { kind: 'command', command: 'plan-execute' } },
    })).toBeNull()
    expect(validateExtensionContributionV1({
      schemaVersion: 1,
      id: 'progress',
      surface: 'conversation.status',
      content: { type: 'step-progress', label: 'Plan execution', steps: [
        { id: 'one', label: 'First step', status: 'completed' },
        { id: 'two', label: 'Second step', status: 'in_progress' },
      ] },
    })).toBeNull()
  })

  it('rejects malformed artifact targets and step progress', () => {
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'review', surface: 'conversation.artifact.aside', title: 'Review',
      target: { messageId: 'message-1' }, content: { type: 'text', text: 'Review' },
    })).toContain('target.artifactId')
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'review', surface: 'conversation.artifact.aside',
      target: { artifactId: 'plan-1' }, content: { type: 'text', text: 'Review' },
    })).toContain('require title')
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'progress', surface: 'conversation.status',
      content: { type: 'step-progress', label: 'Plan execution', steps: [
        { id: 'same', label: 'One', status: 'pending' },
        { id: 'same', label: 'Two', status: 'completed' },
      ] },
    })).toContain('unique')
    expect(validateExtensionContributionV1({
      ...contribution,
      content: { type: 'button', label: 'Open', disabled: true, disabledReason: 'x'.repeat(513), action: { kind: 'command', command: 'open' } },
    })).toContain('disabledReason')
  })

  it('only allows a sandbox app as a top-level node on approved surfaces', () => {
    const sandbox = {
      type: 'sandbox-app', appId: 'dashboard', title: 'Dashboard', html: '<main></main>', permissions: [],
    }
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'sandbox', surface: 'conversation.timeline.before', content: sandbox,
    })).toBeNull()
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'validation-sandbox', surface: 'conversation.timeline.before',
      content: { ...sandbox, permissions: ['validation'] },
    })).toBeNull()
    expect(validateExtensionContributionV1({
      schemaVersion: 1,
      id: 'workspace-sandbox',
      surface: 'workspace.content',
      workspaceContent: { title: 'Dashboard', icon: 'activity' },
      content: sandbox,
    })).toBeNull()
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'nested-sandbox', surface: 'conversation.timeline.before',
      content: { type: 'stack', children: [sandbox] },
    })).toContain('top-level')
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'compact-sandbox', surface: 'window.topRight', content: sandbox,
    })).toContain('Compact surfaces')
  })

  it('validates workspace content metadata and rejects the obsolete right-workbench surface', () => {
    const sandbox = { type: 'sandbox-app', appId: 'inspector', title: 'Inspector', html: '' }
    expect(validateExtensionContributionV1({
      schemaVersion: 1,
      id: 'inspector',
      surface: 'workspace.content',
      workspaceContent: {
        title: 'Repository inspector',
        icon: 'activity',
        scope: 'workspace',
        instancePolicy: 'singleton',
        preferredGroup: 'adjacent',
      },
      content: sandbox,
    })).toBeNull()
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'legacy', surface: 'workbench.right', content: sandbox,
    })).toContain('Unsupported contribution surface')
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'missing-metadata', surface: 'workspace.content', content: sandbox,
    })).toContain('requires workspaceContent metadata')
    expect(validateExtensionContributionV1({
      ...contribution,
      workspaceContent: { title: 'Wrong surface', icon: 'activity' },
    })).toContain('only allowed')
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'invalid-group', surface: 'workspace.content', content: sandbox,
      workspaceContent: { title: 'Invalid group', icon: 'activity', preferredGroup: 'right' },
    })).toContain('preferredGroup')
    expect(validateExtensionContributionV1({
      schemaVersion: 1, id: 'legacy-width', surface: 'workspace.content', content: sandbox,
      workspaceContent: { title: 'Legacy width', icon: 'activity', preferredWidth: 480 },
    })).toContain('Unsupported workspaceContent metadata field')
  })

  it('requires a trusted workspace route for workspace-scoped tools', () => {
    const scoped = {
      schemaVersion: 1 as const,
      id: 'workspace-tool',
      surface: 'workspace.content' as const,
      workspaceContent: { title: 'Workspace tool', icon: 'activity' as const, scope: 'workspace' as const },
      content: { type: 'text' as const, text: 'Ready' },
    }
    const base = {
      schemaVersion: 1 as const,
      extensionId: 'tool',
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      revision: 1,
      operation: 'upsert' as const,
      contribution: scoped,
    }
    expect(validateExtensionContributionDeltaV1(base)).toContain('require workspaceId')
    expect(validateExtensionContributionDeltaV1({ ...base, workspaceId: 'workspace-1' })).toBeNull()
  })
})
