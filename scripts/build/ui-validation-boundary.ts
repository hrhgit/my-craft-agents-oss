import type { Plugin } from 'vite'

const NORMALIZED_FORBIDDEN_PRODUCTION_INPUTS = [
  '/apps/electron/src/main/ui-validation/',
  '/apps/electron/src/main/ui-validation.dev.ts',
  '/apps/electron/src/renderer/ui-validation/',
  '/apps/electron/src/shared/ui-validation-state-bridge.ts',
  '/apps/electron/src/renderer/components/extensions/extension-validation-store.ts',
  '/apps/electron/src/renderer/components/extensions/extension-validation-test-bridge.ts',
  '/packages/shared/src/ui-validation/',
  '/packages/shared/src/protocol/extension-ui-validation.ts',
] as const

export function isUiValidationBuildEnabled(command?: 'build' | 'serve'): boolean {
  return process.env.CRAFT_UI_VALIDATION_BUILD === '1' || command === 'serve'
}

export function isForbiddenUiValidationProductionInput(path: string): boolean {
  const normalized = `/${path.replaceAll('\\', '/').replace(/^\/+/, '')}`
  return NORMALIZED_FORBIDDEN_PRODUCTION_INPUTS.some(fragment => normalized.includes(fragment))
}

/** Fail closed if a production renderer dependency graph reaches real validation code. */
export function uiValidationProductionBoundaryPlugin(enabled: boolean): Plugin {
  return {
    name: 'craft-ui-validation-production-boundary',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (enabled) return
      const forbidden = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const moduleId of Object.keys(output.modules)) {
          if (isForbiddenUiValidationProductionInput(moduleId)) forbidden.add(moduleId)
        }
      }
      if (forbidden.size > 0) {
        this.error(`Production bundle contains source-only UI validation modules:\n${[...forbidden].sort().join('\n')}`)
      }
    },
  }
}

export function assertNoUiValidationProductionInputs(inputs: Iterable<string>, artifact: string): void {
  const forbidden = [...inputs].filter(isForbiddenUiValidationProductionInput).sort()
  if (forbidden.length > 0) {
    throw new Error(`${artifact} contains source-only UI validation modules:\n${forbidden.join('\n')}`)
  }
}

const FORBIDDEN_PRODUCTION_RUNTIME_MARKERS = [
  '__craftUiValidation',
  'craft:ui-validation:semantic-change',
  '__CRAFT_UI_VALIDATION_EXTENSION_BRIDGE_V1__',
  '__CRAFT_UI_VALIDATION_APP_SHELL_SCENARIOS_V1__',
  'startUiTestHost',
  'ElectronEvidenceCollector',
  'ui-validation-scenario-session',
  'CRAFT_UI_TEST_HOST',
  'app-shell-scenario-host',
] as const

export function assertNoUiValidationProductionRuntime(source: string, artifact: string): void {
  const marker = FORBIDDEN_PRODUCTION_RUNTIME_MARKERS.find(candidate => source.includes(candidate))
  if (marker) throw new Error(`${artifact} contains source-only UI validation runtime marker: ${marker}`)
}
