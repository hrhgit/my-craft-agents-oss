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
      "addEventListener('mortise:ui-validation:semantic-change', handler)",
      'main.cjs',
    )).toThrow(/main\.cjs contains source-only UI validation runtime marker/)
    expect(() => assertNoUiValidationProductionRuntime('ordinary production code', 'main.cjs')).not.toThrow()
  })

  test('does not publish source-only validation modules through production WebUI sourcemaps', () => {
    const config = readFileSync(resolve(import.meta.dir, '../../../apps/webui/vite.config.ts'), 'utf8')
    expect(config).toContain('sourcemap: uiValidationBuild')
    expect(config).not.toMatch(/sourcemap:\s*true/)
  })

  test('keeps the packaged Developer Host in a separate application identity and build entry', () => {
    const config = readFileSync(resolve(import.meta.dir, '../../../apps/electron/electron-builder.devhost.yml'), 'utf8')
    const buildScript = readFileSync(resolve(import.meta.dir, '../../build-developer-kit.ps1'), 'utf8')
    const orchestrator = readFileSync(resolve(import.meta.dir, '../../build-developer-kit.ts'), 'utf8')
    const rootPackage = readFileSync(resolve(import.meta.dir, '../../../package.json'), 'utf8')
    expect(config).toContain('appId: io.github.hrhgit.mortise.devhost')
    expect(config).toContain('productName: Mortise Developer Host')
    expect(config).toContain('npmRebuild: false')
    expect(buildScript).toContain('$env:MORTISE_UI_VALIDATION_BUILD = "1"')
    expect(buildScript).toContain('$env:MORTISE_DEV_HOST_BUILD = "1"')
    expect(buildScript).toContain('Invoke-Checked { bun run pi:build } "Pi workspace build"')
    expect(buildScript).toContain('Invoke-Checked { bun run pi:build:binary } "Pi binary build"')
    expect(buildScript.indexOf('bun run pi:build')).toBeLessThan(buildScript.indexOf('bun run electron:build'))
    expect(buildScript.indexOf('bun run pi:build:binary')).toBeLessThan(buildScript.indexOf('bun run electron:build'))
    expect(buildScript).toContain('dev-host\\resources\\ui-validation')
    expect(buildScript).toContain('scripts\\mortise-ui\\windows-uia-driver.ps1')
    expect(buildScript).toContain('Packaged Windows UI Automation driver not found')
    expect(buildScript).toContain('-OutputRoot is required in Developer Kit worker mode')
    expect(orchestrator).toContain('captureBuildSource')
    expect(orchestrator).toContain("withFileLock(join(buildRoot, 'locks', buildId)")
    expect(rootPackage).toContain('"developer-kit:dist:win": "bun run scripts/build-developer-kit.ts"')
  })
})
