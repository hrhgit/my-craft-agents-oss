import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertNoUiValidationProductionInputs,
  assertNoUiValidationProductionRuntime,
  isForbiddenUiValidationProductionInput,
} from '../ui-validation-boundary'

describe('UI validation production bundle boundary', () => {
  test('rejects main, renderer, and extension Test Host implementation modules', () => {
    expect(isForbiddenUiValidationProductionInput('apps/electron/src/main/ui-validation/test-host.ts')).toBe(true)
    expect(isForbiddenUiValidationProductionInput('E:\\repo\\apps\\electron\\src\\renderer\\ui-validation\\bridge.ts')).toBe(true)
    expect(isForbiddenUiValidationProductionInput('apps/electron/src/renderer/components/extensions/extension-validation-test-bridge.ts')).toBe(true)
    expect(isForbiddenUiValidationProductionInput('packages/shared/src/ui-validation/scenario.ts')).toBe(true)
    expect(isForbiddenUiValidationProductionInput('packages/shared/src/protocol/extension-ui-validation.ts')).toBe(true)
  })

  test('allows the inert production boundary and ordinary semantic UI attributes', () => {
    expect(isForbiddenUiValidationProductionInput('apps/electron/src/renderer/ui-validation-disabled/state-bridge.ts')).toBe(false)
    expect(isForbiddenUiValidationProductionInput('apps/electron/src/renderer/components/ui/button.tsx')).toBe(false)
  })

  test('fails with the artifact and offending input', () => {
    expect(() => assertNoUiValidationProductionInputs([
      'apps/electron/src/main/index.ts',
      'apps/electron/src/main/ui-validation/test-host.ts',
    ], 'main.cjs')).toThrow(/main\.cjs contains source-only UI validation modules:[\s\S]*test-host\.ts/)
  })

  test('rejects validation runtime left inside a shared production module', () => {
    expect(() => assertNoUiValidationProductionRuntime(
      "addEventListener('craft:ui-validation:semantic-change', handler)",
      'main.cjs',
    )).toThrow(/main\.cjs contains source-only UI validation runtime marker/)
    expect(() => assertNoUiValidationProductionRuntime('ordinary production code', 'main.cjs')).not.toThrow()
  })

  test('does not publish source-only validation modules through production WebUI sourcemaps', () => {
    const config = readFileSync(resolve(import.meta.dir, '../../../apps/webui/vite.config.ts'), 'utf8')
    expect(config).toContain('sourcemap: uiValidationBuild')
    expect(config).not.toMatch(/sourcemap:\s*true/)
  })
})
