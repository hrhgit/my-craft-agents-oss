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
    const smokeScript = readFileSync(resolve(import.meta.dir, '../../smoke-developer-kit.ps1'), 'utf8')
    const packagedGuide = readFileSync(resolve(import.meta.dir, '../../../developer-kit/docs/ui-validation.md'), 'utf8')
    const logsGuide = readFileSync(resolve(import.meta.dir, '../../../developer-kit/docs/logs.md'), 'utf8')
    const rootPackage = readFileSync(resolve(import.meta.dir, '../../../package.json'), 'utf8')
    const piBuildCommand = 'Invoke-Checked { & $BunExecutable run pi:build } "Pi workspace build"'
    const piBinaryBuildCommand = 'Invoke-Checked { & $BunExecutable run pi:build:binary } "Pi binary build"'
    const electronBuildCommand = 'Invoke-Checked { & $BunExecutable run electron:build:source } "Developer Host build"'
    expect(config).toContain('appId: io.github.hrhgit.mortise.devhost')
    expect(config).toContain('productName: Mortise Developer Host')
    expect(config).toContain('npmRebuild: false')
    expect(buildScript).toContain('$env:MORTISE_UI_VALIDATION_BUILD = "1"')
    expect(buildScript).toContain('$env:MORTISE_DEV_HOST_BUILD = "1"')
    expect(buildScript).toContain(piBuildCommand)
    expect(buildScript).toContain(piBinaryBuildCommand)
    expect(buildScript).toContain(electronBuildCommand)
    expect(buildScript).not.toContain('Invoke-Checked { bun ')
    expect(buildScript.indexOf(piBuildCommand)).toBeLessThan(buildScript.indexOf(electronBuildCommand))
    expect(buildScript.indexOf(piBinaryBuildCommand)).toBeLessThan(buildScript.indexOf(electronBuildCommand))
    expect(buildScript).toContain('dev-host\\resources\\ui-validation')
    expect(buildScript).toContain('scripts\\mortise-ui\\windows-uia-driver.ps1')
    expect(buildScript).toContain('Packaged Windows UI Automation driver not found')
    expect(buildScript).toContain('-OutputRoot is required in Developer Kit worker mode')
    expect(buildScript).toContain('docs\\source-development-testing.md')
    expect(buildScript).toContain('docs\\source-development-pi-extensions.md')
    expect(buildScript).toContain('Write-PackagedPiExtensionGuide')
    expect(buildScript).toContain('bin\\smoke.ps1')
    expect(buildScript).toContain('"Packaged Developer Kit smoke"')
    expect(buildScript).toContain('mortise-logs.exe')
    expect(buildScript).toContain('mortise-logs\\cli.ts')
    expect(orchestrator).toContain('captureBuildSource')
    expect(orchestrator).not.toContain('resolveReusableDeveloperKitBuild')
    expect(orchestrator).not.toContain('!freshSource && !reusable')
    expect(orchestrator).toContain('Reusing build')
    expect(orchestrator).toContain('computeDeveloperKitBuildId(sourceId, true, bunExecutableSha256)')
    expect(orchestrator).toContain('ensureDeveloperKitArchive(outputRoot, manifest)')
    expect(orchestrator).toContain('seedUvToolchainCacheFromCompletedBuild')
    expect(orchestrator).toContain('MORTISE_BUILD_TOOLCHAIN_CACHE_DIR: toolchainCacheDir')
    expect(orchestrator).toContain("withFileLock(join(buildRoot, 'locks', buildId)")
    expect(orchestrator).toContain('renameDirectoryWithRetry(stagingDir, finalBuildDir)')
    expect(orchestrator).toContain("new Set(['EACCES', 'EBUSY', 'EPERM'])")
    expect(rootPackage).toContain('"developer-kit:dist:win": "bun run scripts/build-developer-kit.ts"')
    expect(rootPackage).toContain('"developer-kit:smoke:win"')
    expect(packagedGuide).toContain('bin\\mortise-ui.exe')
    expect(packagedGuide).not.toContain('bun run mortise-ui')
    expect(logsGuide).toContain('mortise-logs.exe')
    expect(logsGuide).toContain('leaves root-cause analysis to the calling AI')
    expect(smokeScript).toContain('mortise-developer-kit-smoke-')
    expect(smokeScript).toContain('Remove-Item Env:BUN_INSTALL')
    expect(smokeScript).toContain('source-development-*')
    expect(smokeScript).toContain('$logsCliPath trace smoke-request')
  })

  test('keeps non-shell UI runtimes outside the playground static graph', () => {
    const playgroundEntry = readFileSync(resolve(import.meta.dir, '../../../apps/electron/src/renderer/playground.tsx'), 'utf8')
    const playgroundApp = readFileSync(resolve(import.meta.dir, '../../../apps/electron/src/renderer/playground/PlaygroundApp.tsx'), 'utf8')

    expect(playgroundEntry).toContain("await import('./components/ui/sonner')")
    expect(playgroundEntry).toContain('React.lazy')
    expect(playgroundEntry).not.toMatch(
      /import\s+\{\s*Toaster\s*\}\s+from\s+['"]\.\/components\/ui\/sonner['"]/,
    )
    expect(playgroundApp).toContain('<select')
    expect(playgroundApp).not.toContain("from '@/components/ui/select'")
    expect(playgroundApp).toContain('type="checkbox"')
    expect(playgroundApp).not.toContain("from '@/components/ui/switch'")
  })

  test('pins the raw Electron smoke to one immutable UI-validation build lease', () => {
    const rootPackage = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const rawSmoke = readFileSync(resolve(import.meta.dir, '../../e2e/ui-validation/raw-host-smoke.ts'), 'utf8')
    const electronStart = readFileSync(resolve(import.meta.dir, '../../electron-start.ts'), 'utf8')
    const electronAdapter = readFileSync(resolve(import.meta.dir, '../../mortise-ui/electron-adapter.ts'), 'utf8')
    const electronMain = readFileSync(resolve(import.meta.dir, '../../../apps/electron/src/main/index.ts'), 'utf8')
    const builderConfig = readFileSync(resolve(import.meta.dir, '../../../apps/electron/electron-builder.yml'), 'utf8')
    expect(rootPackage.scripts['test:ui-validation:raw-host-smoke']).not.toContain('electron:build')
    expect(rawSmoke).toContain('acquireElectronBuild({')
    expect(rawSmoke).toContain("mode: 'ui-validation'")
    expect(rawSmoke).toContain('buildLease.appDir')
    expect(rawSmoke).toContain('createElectronBuildRuntimeEnvironment(buildLease, { uiValidation: true })')
    expect(rawSmoke).toContain('resolveElectronBuildExecutable(buildLease)')
    expect(rawSmoke).not.toContain("createRequire(import.meta.url)('electron')")
    expect(rawSmoke).toContain('buildLease.manifest.sourceId')
    expect(rawSmoke).toContain('expectedSourceId')
    expect(rawSmoke).toContain('hostPid: host.pid')
    expect(rawSmoke).toContain('await waitForHostSpawn(host)')
    expect(rawSmoke).toContain('hostSpawned = true')
    expect(rawSmoke).toContain('host === undefined || !hostSpawned')
    expect(rawSmoke).toContain('await clickPhysicalRendererTarget(page, target)')
    expect(rawSmoke).toContain('await page.mouse.click(')
    expect(rawSmoke).not.toContain('await target.click(')
    expect(rawSmoke).not.toContain('target.click({ force: true })')
    expect(rawSmoke).toContain('collectOwnedProcessTree(host.pid)')
    expect(rawSmoke).toContain('terminateOwnedProcessTrees(ownedProcesses)')
    expect(rawSmoke).toContain('releaseElectronBuild(buildLease)')
    expect(electronStart).toContain('createElectronBuildRuntimeEnvironment(lease)')
    expect(electronStart).toContain('resolveElectronBuildExecutable(lease)')
    expect(electronStart).not.toContain("node_modules', '.bin'")
    expect(electronAdapter).toContain('resolveElectronBuildExecutable(lease)')
    expect(electronAdapter).not.toContain("createRequire(import.meta.url)('electron')")
    expect(builderConfig).toContain('electronDist: dist/packaging-inputs/runtime/electron')
    expect(electronMain).toContain('process.env.MORTISE_RUNTIME_APP_ROOT')
    expect(electronMain).not.toContain('MORTISE_UI_RUNTIME_APP_ROOT')
  })
})
