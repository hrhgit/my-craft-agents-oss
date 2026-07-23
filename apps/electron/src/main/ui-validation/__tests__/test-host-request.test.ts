import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseElectronActionParams, parseElectronWaitParams, parseRendererPerformanceDuration } from '../test-host-request'

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

  it('preserves BrowserView surface identity for action routing', () => {
    expect(parseElectronActionParams({
      revision: 4,
      target: { kind: 'browser', instanceId: 'browser-1', ref: 'b4:browser-1:e2' },
      action: 'click',
      mode: 'physical',
    }).target).toEqual({ kind: 'browser', instanceId: 'browser-1', ref: 'b4:browser-1:e2' })
  })

  it('builds composite snapshots from the base renderer driver without recursion', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'test-host.ts'), 'utf8')
    expect(source).toContain('const snapshot = await driver.snapshot(selector)')
    expect(source).not.toContain('const snapshot = await compositeSnapshot(selector)\n    if (!browserSurfaces)')
  })

  it('normalizes legacy wait predicates and rejects multiple node selectors', () => {
    expect(parseElectronWaitParams({ kind: 'app-phase', phase: 'ready' }).predicate)
      .toEqual({ kind: 'app-phase', phase: 'ready' })
    expect(() => parseElectronWaitParams({
      predicate: { kind: 'node', target: { semanticId: 'save', role: 'button' } },
    })).toThrow('exactly one')
  })

  it('accepts only bounded numeric renderer performance durations', () => {
    expect(parseRendererPerformanceDuration(undefined)).toBe(1_000)
    expect(parseRendererPerformanceDuration(100)).toBe(100)
    expect(parseRendererPerformanceDuration(5_000)).toBe(5_000)
    expect(parseRendererPerformanceDuration(99)).toBeNull()
    expect(parseRendererPerformanceDuration(5_001)).toBeNull()
    expect(parseRendererPerformanceDuration('250')).toBeNull()
    expect(parseRendererPerformanceDuration(Number.NaN)).toBeNull()
  })
})
