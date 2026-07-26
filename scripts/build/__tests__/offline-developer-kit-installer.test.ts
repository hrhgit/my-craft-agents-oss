import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../..')

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('offline Developer Kit installer contract', () => {
  test('stages a matching kit before every Windows installer entrypoint', () => {
    const rootPackage = readRepoFile('package.json')
    const powershellBuild = readRepoFile('apps/electron/scripts/build-win.ps1')
    const packageElectron = readRepoFile('scripts/build/package-electron.ts')
    const stagingScript = readRepoFile('scripts/stage-developer-kit-for-installer.ts')

    expect(rootPackage.match(/"electron:dist(?::(?:dev:)?win)?"[^\n]*package-electron\.ts/g)?.length).toBe(3)
    expect(packageElectron).toContain("resolvedTarget.target === 'win'")
    expect(packageElectron).toContain("'--source-id'")
    expect(packageElectron).toContain('staged.sourceId')
    expect(packageElectron).toContain("'--source-root'")
    expect(packageElectron).toContain('packageSource.sourceRoot')
    expect(packageElectron).toContain("'--electron-app-dir'")
    expect(packageElectron).toContain('staged.appDir')
    expect(packageElectron).toContain('publishBuildBunToolchain(buildRoot)')
    expect(packageElectron).toContain('bunExecutable,')
    expect(packageElectron).toContain('withStagedElectronBuild(lease')
    expect(powershellBuild).toContain('bun run electron:dist:win')
    expect(powershellBuild).not.toContain('copyPiRuntime')
    expect(stagingScript).toContain("'--no-archive'")
    expect(stagingScript).toContain("process.platform !== 'win32'")
    expect(stagingScript).not.toContain('developer-kit-latest.json')
    expect(stagingScript).toContain('computeDeveloperKitBuildId(expectedSourceId, true, bunExecutableSha256)')
    expect(stagingScript).toContain('spawnSync(process.execPath')
    expect(stagingScript).toContain('acquireDeveloperKitBuildLease')
    expect(stagingScript).toContain('releaseDeveloperKitBuildLease')
    expect(stagingScript).toContain('manifest.sourceId !== expectedSourceId')
    expect(stagingScript).toContain('artifactInventoriesEqual')
    expect(stagingScript).toContain("'build-provenance.json'")
    expect(stagingScript).toContain('does not match Mortise')
    expect(stagingScript).toContain('installer-developer-kit')
    expect(stagingScript).toContain("optionValue(args, '--electron-app-dir')")
    expect(stagingScript).toContain("optionValue(args, '--source-root')")
    expect(stagingScript).toContain("join(electronAppDir, 'package.json')")
    expect(stagingScript).toContain("join(electronAppDir, 'dist', 'build-provenance.json')")
    expect(stagingScript).not.toContain("join(repoRoot, 'apps', 'electron', 'dist', 'installer-developer-kit')")
  })

  test('keeps the kit optional at install time and discoverable when selected', () => {
    const config = readRepoFile('apps/electron/electron-builder.yml')
    const installer = readRepoFile('apps/electron/resources/installer.nsh')
    const discovery = readRepoFile('packages/shared/src/config/developer-kit.ts')

    expect(config).toContain('from: dist/installer-developer-kit')
    expect(config).toContain('to: developer-kit')
    expect(config).toContain('include: dist/resources/installer.nsh')
    expect(installer).toContain('Install Mortise Developer Kit (recommended for developers)')
    expect(installer).toContain('IfSilent 0 +2')
    expect(installer).toContain('!ifndef BUILD_UNINSTALLER')
    expect(installer).toContain('RMDir /r "$INSTDIR\\resources\\developer-kit"')
    expect(discovery).toContain("join(env.MORTISE_RESOURCES_PATH, 'developer-kit')")
  })
})
