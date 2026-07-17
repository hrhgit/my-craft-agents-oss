import { describe, expect, it } from 'bun:test'
import type { UiValidationScopedState, UiValidationScopedStateUpdate } from '@craft-agent/shared/ui-validation'
import { rendererStatesMissingFromBatch } from '../renderer-state-batch'

function state(overrides: Partial<UiValidationScopedState>): UiValidationScopedState {
  return { scope: 'workspace', phase: 'loading', revision: 1, updatedAt: 1, windowId: '1', ...overrides }
}

describe('authoritative renderer state batches', () => {
  it('disposes prior workspace identities while preserving host-owned native state', () => {
    const existing = [
      state({}),
      state({ scope: 'native-driver', detail: { verified: true } }),
    ]
    const incoming: UiValidationScopedStateUpdate[] = [
      { scope: 'workspace', entityId: 'product-launch', phase: 'ready' },
    ]

    expect(rendererStatesMissingFromBatch(existing, incoming).map(item => item.scope)).toEqual(['workspace'])
  })

  it('replaces one selected workspace with another without redisposing old tombstones', () => {
    const existing = [
      state({ phase: 'disposed' }),
      state({ entityId: 'product-launch', phase: 'ready' }),
    ]
    const incoming: UiValidationScopedStateUpdate[] = [
      { scope: 'workspace', entityId: 'customer-research', phase: 'ready' },
    ]

    expect(rendererStatesMissingFromBatch(existing, incoming).map(item => item.entityId)).toEqual(['product-launch'])
  })
})
