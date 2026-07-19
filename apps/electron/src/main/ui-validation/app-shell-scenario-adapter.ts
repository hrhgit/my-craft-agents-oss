import type { WebContents } from 'electron'
import { UI_VALIDATION_APP_SHELL_SCENARIO_IDS } from '@mortise/shared/ui-validation'
import { UiValidationError } from '@mortise/shared/ui-validation'

const BRIDGE_KEY = '__MORTISE_UI_VALIDATION_APP_SHELL_SCENARIOS_V1__'
const MAX_REQUEST_BYTES = 32_768

export const APP_SHELL_SCENARIO_IDS = new Set(UI_VALIDATION_APP_SHELL_SCENARIO_IDS)

export class AppShellScenarioAdapterError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AppShellScenarioAdapterError'
  }
}

type FixedMethod = 'list' | 'snapshot' | 'apply' | 'reset' | 'clock.advance' | 'fault.set' | 'fault.clear'

/** Fixed renderer adapter. No caller-supplied JavaScript or property path is accepted. */
export class ElectronAppShellScenarioAdapter {
  constructor(private readonly webContents: WebContents) {}

  list(): Promise<unknown> { return this.call('list') }
  snapshot(): Promise<unknown> { return this.call('snapshot') }
  apply(request: Record<string, unknown>): Promise<unknown> { return this.call('apply', request) }
  reset(): Promise<unknown> { return this.call('reset') }
  advance(ms: number): Promise<unknown> { return this.call('clock.advance', ms) }
  setFault(request: Record<string, unknown>): Promise<unknown> { return this.call('fault.set', request) }
  clearFault(faultId?: string): Promise<unknown> { return this.call('fault.clear', faultId) }

  private async call(method: FixedMethod, input?: unknown): Promise<unknown> {
    if (this.webContents.isDestroyed()) throw new AppShellScenarioAdapterError('WINDOW_GONE', 'Renderer window is gone.')
    const serialized = JSON.stringify(input)
    if (serialized !== undefined && serialized.length > MAX_REQUEST_BYTES) throw new AppShellScenarioAdapterError('UNSUPPORTED', 'AppShell scenario request is too large.')
    const argument = serialized ?? 'undefined'
    const invocation = method === 'clock.advance'
      ? `bridge.clock.advance(${argument})`
      : method === 'fault.set'
        ? `bridge.fault.set(${argument})`
        : method === 'fault.clear'
          ? `bridge.fault.clear(${argument})`
          : `bridge[${JSON.stringify(method)}](${argument})`
    const expression = `(() => {
      const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
      if (!bridge || bridge.schemaVersion !== 1) return { ok: false, code: 'NOT_READY', message: 'AppShell scenario bridge is unavailable.' };
      return Promise.resolve(${invocation})
        .then(result => ({ ok: true, result }))
        .catch(error => ({ ok: false, code: error?.code || 'UNSUPPORTED', message: String(error?.message || error) }));
    })()`
    const result = await this.webContents.executeJavaScript(expression, true) as { ok?: boolean; result?: unknown; code?: string; message?: string }
    if (!result?.ok) throw new AppShellScenarioAdapterError(result?.code || 'UNSUPPORTED', result?.message || 'AppShell scenario request failed.')
    return result.result
  }
}

/** Copies only shared typed fields before crossing the fixed renderer bridge. */
export function appShellScenarioApplyRequest(params: Record<string, unknown>, scenarioId: string): Record<string, unknown> {
  if (!APP_SHELL_SCENARIO_IDS.has(scenarioId as never)) throw new UiValidationError('SCENARIO_INVALID', `Scenario ${scenarioId} is not a registered AppShell scenario.`)
  const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  return {
    name: scenarioId,
    ...(typeof params.seed === 'number' ? { seed: params.seed } : {}),
    ...(record(params.clock) ? { clock: params.clock } : {}),
    ...(record(params.viewport) ? { viewport: params.viewport } : {}),
    ...(typeof params.locale === 'string' ? { locale: params.locale } : {}),
    ...(typeof params.theme === 'string' ? { theme: params.theme } : {}),
    ...(record(params.fixture) ? { fixture: params.fixture } : {}),
  }
}
