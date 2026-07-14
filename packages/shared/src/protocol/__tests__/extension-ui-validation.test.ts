import { describe, expect, it } from 'bun:test'
import { validateExtensionUIValidationDefinitionV1, validateExtensionUIValidationDeltaV1 } from '../extension-ui-validation'

const definition = {
  schemaVersion: 1,
  id: 'build.panel',
  contributionId: 'build-status',
  verificationLevel: 'semantic',
  readyWhen: ['panel.ready'],
  signals: [{ id: 'panel.ready', label: 'Build panel ready', status: 'ready' }],
  actions: [{ id: 'refresh', label: 'Refresh', command: 'build:refresh', inputSchema: { type: 'object', properties: {} } }],
  scenarios: [{ id: 'failed', label: 'Failed build', command: 'build:test-failed', teardownCommand: 'build:test-reset' }],
  snapshot: { id: 'panel', role: 'region', label: 'Build', children: [{ id: 'refresh', role: 'button', state: { disabled: false } }] },
} as const

describe('ExtensionUIValidationV1', () => {
  it('accepts bounded semantic contracts and lifecycle deltas', () => {
    expect(validateExtensionUIValidationDefinitionV1(definition)).toBeNull()
    expect(validateExtensionUIValidationDeltaV1({
      schemaVersion: 1, extensionId: 'build', sessionId: 'session', runtimeId: 'runtime', revision: 1,
      operation: 'upsert', definition,
    })).toBeNull()
  })

  it('rejects unknown readiness, duplicate semantic ids, and executable fields', () => {
    expect(validateExtensionUIValidationDefinitionV1({ ...definition, readyWhen: ['missing'] })).toContain('unknown signal')
    expect(validateExtensionUIValidationDefinitionV1({
      ...definition,
      snapshot: { id: 'same', role: 'region', children: [{ id: 'same', role: 'button' }] },
    })).toContain('unique')
    expect(validateExtensionUIValidationDefinitionV1({ ...definition, evaluate: 'window.secret' })).toContain('Unsupported')
  })

  it('bounds schemas and state instead of accepting arbitrary renderer mutation', () => {
    expect(validateExtensionUIValidationDefinitionV1({
      ...definition,
      actions: [{ id: 'bad', label: 'Bad', command: 'bad', inputSchema: { value: Number.NaN } }],
    })).toContain('finite')
    expect(validateExtensionUIValidationDeltaV1({
      schemaVersion: 1, extensionId: 'build', sessionId: 'session', runtimeId: 'runtime', revision: 1,
      operation: 'snapshot', definitions: [definition, definition],
    })).toContain('unique')
  })

  it('accepts optional scenario teardown and rejects orphan teardown schemas', () => {
    expect(validateExtensionUIValidationDefinitionV1(definition)).toBeNull()
    expect(validateExtensionUIValidationDefinitionV1({
      ...definition,
      scenarios: [{ id: 'bad', label: 'Bad', command: 'setup', teardownInputSchema: { type: 'object' } }],
    })).toContain('requires teardownCommand')
  })
})
