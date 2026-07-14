import { describe, expect, it } from 'bun:test'
import type { WebContents } from 'electron'
import { APP_SHELL_SCENARIO_IDS, AppShellScenarioAdapterError, ElectronAppShellScenarioAdapter } from '../app-shell-scenario-adapter'

function fake(result: unknown, destroyed = false) {
  const expressions: string[] = []
  const execute = async (expression: string) => { expressions.push(expression); return result }
  return { expressions, contents: { isDestroyed: () => destroyed, executeJavaScript: execute } as unknown as WebContents }
}

describe('ElectronAppShellScenarioAdapter', () => {
  it('exposes the fixed initial scenario allowlist', () => {
    expect(APP_SHELL_SCENARIO_IDS.size).toBe(12)
    expect(APP_SHELL_SCENARIO_IDS.has('session.streaming')).toBeTrue()
    expect(APP_SHELL_SCENARIO_IDS.has('arbitrary' as never)).toBeFalse()
  })

  it('calls only fixed bridge methods with JSON data', async () => {
    const target = fake({ ok: true, result: { scenarioId: 'app.loading' } })
    await new ElectronAppShellScenarioAdapter(target.contents).apply({ name: 'app.loading', seed: 1 })
    const expression = target.expressions[0] ?? ''
    expect(expression).toContain('__CRAFT_UI_VALIDATION_APP_SHELL_SCENARIOS_V1__')
    expect(expression).toContain('bridge["apply"]')
    expect(expression).not.toContain('eval(')
  })

  it('uses fixed nested clock/fault paths and preserves typed failures', async () => {
    const target = fake({ ok: true, result: 1000 })
    await new ElectronAppShellScenarioAdapter(target.contents).advance(250)
    expect(target.expressions[0]).toContain('bridge.clock.advance(250)')
    const rejected = fake({ ok: false, code: 'FAULT_INVALID', message: 'bad fault' })
    await expect(new ElectronAppShellScenarioAdapter(rejected.contents).setFault({ point: 'unknown' }))
      .rejects.toEqual(new AppShellScenarioAdapterError('FAULT_INVALID', 'bad fault'))
  })
})
