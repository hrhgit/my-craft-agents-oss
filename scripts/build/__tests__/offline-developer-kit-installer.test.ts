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
    const nodeBuild = readRepoFile('scripts/build/win32.ts')
    const stagingScript = readRepoFile('scripts/stage-developer-kit-for-installer.ts')

    expect(rootPackage).toContain('bun run scripts/stage-developer-kit-for-installer.ts')
    expect(rootPackage.match(/"electron:dist(?::(?:dev:)?win)?"[^\n]*stage-developer-kit-for-installer/g)?.length).toBe(3)
    expect(powershellBuild).toContain('bun run scripts/stage-developer-kit-for-installer.ts')
    expect(nodeBuild).toContain("run('bun run scripts/stage-developer-kit-for-installer.ts', rootDir)")
    expect(stagingScript).toContain("'--no-archive'")
    expect(stagingScript).toContain("process.platform !== 'win32'")
    expect(stagingScript).toContain('developer-kit-latest.json')
    expect(stagingScript).toContain('does not match Mortise')
    expect(stagingScript).toContain('installer-developer-kit')
  })

  test('keeps the kit optional at install time and discoverable when selected', () => {
    const config = readRepoFile('apps/electron/electron-builder.yml')
    const installer = readRepoFile('apps/electron/resources/installer.nsh')
    const discovery = readRepoFile('packages/shared/src/config/developer-kit.ts')

    expect(config).toContain('from: dist/installer-developer-kit')
    expect(config).toContain('to: developer-kit')
    expect(config).toContain('include: resources/installer.nsh')
    expect(installer).toContain('Install Mortise Developer Kit (recommended for developers)')
    expect(installer).toContain('!ifndef BUILD_UNINSTALLER')
    expect(installer).toContain('RMDir /r "$INSTDIR\\resources\\developer-kit"')
    expect(discovery).toContain("join(env.MORTISE_RESOURCES_PATH, 'developer-kit')")
  })
})
