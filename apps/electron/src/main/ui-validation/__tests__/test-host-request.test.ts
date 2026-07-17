import { describe, expect, it } from 'bun:test'
import { parseElectronActionParams, parseElectronWaitParams } from '../test-host-request'

describe('Electron Test Host public request parsing', () => {
  it('normalizes legacy ref actions and accepts one stable selector', () => {
    expect(parseElectronActionParams({ revision: 3, ref: 'r3:button', action: 'click' }).target)
      .toEqual({ ref: 'r3:button' })
    expect(parseElectronActionParams({ target: { testId: 'save' }, action: 'click' }).target)
      .toEqual({ testId: 'save' })
  })

  it('rejects multiple renderer selectors at the Electron boundary', () => {
    expect(() => parseElectronActionParams({
      target: { ref: 'r3:button', testId: 'save' },
      revision: 3,
      action: 'click',
    })).toThrow('exactly one')
  })

  it('normalizes legacy wait predicates and rejects multiple node selectors', () => {
    expect(parseElectronWaitParams({ kind: 'app-phase', phase: 'ready' }).predicate)
      .toEqual({ kind: 'app-phase', phase: 'ready' })
    expect(() => parseElectronWaitParams({
      predicate: { kind: 'node', target: { semanticId: 'save', role: 'button' } },
    })).toThrow('exactly one')
  })
})
