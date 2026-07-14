import { describe, expect, it } from 'bun:test'
import type { ExtensionUIValidationDeltaV1 } from '@craft-agent/shared/protocol'
import { ExtensionValidationStore } from '../extension-validation-store'

const upsert = (revision: number, id = 'panel'): ExtensionUIValidationDeltaV1 => ({
  schemaVersion: 1, extensionId: 'extension', sessionId: 'session', runtimeId: 'runtime', revision,
  operation: 'upsert', definition: { schemaVersion: 1, id, contributionId: 'status', verificationLevel: 'semantic' },
})

describe('ExtensionValidationStore', () => {
  it('applies monotonic revisions and lifecycle cleanup', () => {
    const store = new ExtensionValidationStore()
    expect(store.apply(upsert(1))).toBe(true)
    expect(store.apply(upsert(1, 'stale'))).toBe(false)
    expect(store.list('session')).toHaveLength(1)
    expect(store.apply({ schemaVersion: 1, extensionId: 'extension', sessionId: 'session', runtimeId: 'runtime', revision: 2, operation: 'reset' })).toBe(true)
    expect(store.list('session')).toHaveLength(0)
  })

  it('replaces snapshots and clears all validation for a failed runtime', () => {
    const store = new ExtensionValidationStore()
    store.apply(upsert(1, 'old'))
    store.apply({
      schemaVersion: 1, extensionId: 'extension', sessionId: 'session', runtimeId: 'runtime', revision: 2,
      operation: 'snapshot', definitions: [{ schemaVersion: 1, id: 'new', contributionId: 'status', verificationLevel: 'physical' }],
    })
    expect(store.list('session').map(item => item.definition.id)).toEqual(['new'])
    store.resetRuntime('session', 'runtime')
    expect(store.list('session')).toHaveLength(0)
  })

  it('preserves trusted command ownership and updates only dynamic state', () => {
    const store = new ExtensionValidationStore()
    store.apply(upsert(1), { commandOwnerExtensionId: 'trusted-owner' })
    expect(store.updateState({
      extensionId: 'extension', sessionId: 'session', runtimeId: 'runtime', commandOwnerExtensionId: 'trusted-owner',
    }, 'panel', 2, {
      signals: [{ id: 'ready', label: 'Ready', status: 'ready' }],
      readyWhen: ['ready'],
    })).toBe(true)
    const item = store.resolve({ extensionId: 'extension', sessionId: 'session', runtimeId: 'runtime', definitionId: 'panel' })
    expect(item?.commandOwnerExtensionId).toBe('trusted-owner')
    expect(item?.definition.signals?.[0]?.status).toBe('ready')
  })
})
