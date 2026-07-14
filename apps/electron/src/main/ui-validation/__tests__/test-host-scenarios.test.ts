import { describe, expect, it } from 'bun:test'
import { appShellScenarioApplyRequest } from '../app-shell-scenario-adapter'

describe('Test Host AppShell scenario routing', () => {
  it('copies only typed scenario fields and preserves frozen clock configuration', () => {
    expect(appShellScenarioApplyRequest({
      name: 'session.streaming', seed: 9, clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' },
      viewport: { width: 900, height: 700 }, timeoutMs: 15_000, evaluate: 'globalThis.secret',
    }, 'session.streaming')).toEqual({
      name: 'session.streaming', seed: 9, clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' }, viewport: { width: 900, height: 700 },
    })
  })

  it('rejects IDs outside the fixed AppShell registry', () => {
    expect(() => appShellScenarioApplyRequest({}, 'arbitrary.scenario')).toThrow('not a registered AppShell scenario')
  })
})
