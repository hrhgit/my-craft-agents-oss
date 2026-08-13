import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  artifactInventorySize,
  buildToolchainExecutableSha256,
  collectArtifactInventory,
} from '../electron-build-cache'
import {
  computeDeveloperKitBuildId,
  DEVELOPER_KIT_BUILD_SCHEMA_VERSION,
  type DeveloperKitBuildManifest,
} from '../developer-kit-build-manifest'
import { writeJsonAtomic } from '../files'
import { stageDeveloperKitForInstaller } from '../../stage-developer-kit-for-installer'

const repoRoot = resolve(import.meta.dir, '../../..')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('offline Developer Kit installer contract', () => {
  test('pins one Bun version across packaged runtime and CI producers', () => {
    const common = readRepoFile('scripts/build/common.ts')
    const validationWorkflow = readRepoFile('.github/workflows/validate.yml')
    const serverWorkflow = readRepoFile('.github/workflows/validate-server.yml')

    expect(common).toContain("export const BUN_VERSION = 'bun-v1.3.14'")
    expect(validationWorkflow.match(/bun-version: "1\.3\.14"/g)?.length).toBe(4)
    expect(serverWorkflow.match(/bun-version: "1\.3\.14"/g)?.length).toBe(1)
    expect(`${common}\n${validationWorkflow}\n${serverWorkflow}`).not.toMatch(/bun-v1\.3\.(?:9|10)|bun-version: "1\.3\.(?:9|10)"/)
  })

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
    expect(packageElectron).toContain("'--electron-build-provenance'")
    expect(packageElectron).toContain('staged.provenancePath')
    expect(packageElectron).toContain('publishBuildBunToolchain(buildRoot)')
    expect(packageElectron).toContain('bunExecutable,')
    expect(packageElectron).toContain('withElectronBuildForPackaging(lease')
    expect(packageElectron).toContain("'--provenance-output'")
    expect(packageElectron).toContain('MORTISE_DEVELOPER_KIT_ARTIFACT_DIR')
    expect(packageElectron).toContain('MORTISE_DEVELOPER_KIT_PROVENANCE_PATH')
    expect(packageElectron).toContain('MORTISE_ELECTRON_BUILD_PROVENANCE_PATH')
    expect(powershellBuild).toContain('bun run electron:dist:win')
    expect(powershellBuild).not.toContain('copyPiRuntime')
    expect(stagingScript).toContain("'--no-archive'")
    expect(stagingScript).toContain("process.platform !== 'win32'")
    expect(stagingScript).not.toContain('developer-kit-latest.json')
    expect(stagingScript).toContain('computeDeveloperKitBuildId(options.expectedSourceId, true, bunExecutableSha256)')
    expect(stagingScript).toContain('dependencies.buildDeveloperKit ?? runDeveloperKitBuild')
    expect(stagingScript).toContain('acquireDeveloperKitBuildLease')
    expect(stagingScript).toContain('releaseDeveloperKitBuildLease')
    expect(stagingScript).toContain('manifest.sourceId !== expectedSourceId')
    expect(stagingScript).toContain('artifactInventoriesEqual')
    expect(stagingScript).toContain("'build-provenance.json'")
    expect(stagingScript).toContain('does not match Mortise')
    expect(stagingScript).toContain('installer-developer-kit')
    expect(stagingScript).toContain("optionValue(args, '--electron-app-dir')")
    expect(stagingScript).toContain("optionValue(args, '--electron-build-provenance')")
    expect(stagingScript).toContain("optionValue(args, '--source-root')")
    expect(stagingScript).toContain("join(electronAppDir, 'package.json')")
    expect(stagingScript).toContain("join(electronAppDir, 'dist', 'build-provenance.json')")
    expect(stagingScript).not.toContain("join(repoRoot, 'apps', 'electron', 'dist', 'installer-developer-kit')")
  })

  test('reuses a valid immutable kit without requiring source materialization or a build', () => {
    const fixture = createCachedKitFixture()
    let buildCalls = 0

    const result = stageDeveloperKitForInstaller({
      expectedSourceId: fixture.sourceId,
      expectedBuildId: fixture.buildId,
      electronAppDir: fixture.electronAppDir,
      developerKitBuildRoot: fixture.buildRoot,
      bunExecutable: process.execPath,
      runId: 'cached-kit-test',
    }, {
      platform: 'win32',
      buildDeveloperKit: () => { buildCalls += 1 },
    })

    expect(result.reused).toBe(true)
    expect(result.buildId).toBe(fixture.buildId)
    expect(buildCalls).toBe(0)
    expect(JSON.parse(readFileSync(join(result.stagedKitDirectory, 'build-provenance.json'), 'utf8'))).toMatchObject({
      buildId: fixture.buildId,
      sourceId: fixture.sourceId,
    })
  })

  test('requires a materialized source only when the immutable kit cache misses', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-kit-cache-miss-'))
    temporaryRoots.push(root)
    const electronAppDir = join(root, 'electron-app')
    const sourceId = 'a'.repeat(64)
    mkdirSync(join(electronAppDir, 'dist'), { recursive: true })
    writeJsonAtomic(join(electronAppDir, 'dist', 'build-provenance.json'), { sourceId })

    expect(() => stageDeveloperKitForInstaller({
      expectedSourceId: sourceId,
      electronAppDir,
      developerKitBuildRoot: join(root, 'kit-builds'),
      bunExecutable: process.execPath,
      runId: 'missing-kit-test',
    }, { platform: 'win32' })).toThrow('--source-root is required')
  })

  test('prepares direct immutable inputs without copying the Developer Kit tree', () => {
    const fixture = createCachedKitFixture()
    const electronBuildProvenancePath = join(fixture.electronAppDir, '..', 'run', 'electron-build-provenance.json')
    const provenancePath = join(fixture.electronAppDir, '..', 'run', 'developer-kit-provenance.json')
    mkdirSync(join(fixture.electronAppDir, '..', 'run'), { recursive: true })
    writeJsonAtomic(electronBuildProvenancePath, { sourceId: fixture.sourceId })
    rmSync(join(fixture.electronAppDir, 'dist', 'build-provenance.json'))
    const result = stageDeveloperKitForInstaller({
      expectedSourceId: fixture.sourceId,
      expectedBuildId: fixture.buildId,
      electronAppDir: fixture.electronAppDir,
      electronBuildProvenancePath,
      developerKitBuildRoot: fixture.buildRoot,
      bunExecutable: process.execPath,
      provenanceOutputPath: provenancePath,
      runId: 'direct-kit-test',
    }, { platform: 'win32' })

    expect(result.artifactDirectory).toBe(fixture.artifactDirectory)
    expect(result.stagedKitDirectory).toBe(fixture.artifactDirectory)
    expect(result.provenancePath).toBe(resolve(provenancePath))
    expect(existsSync(join(fixture.electronAppDir, 'dist', 'installer-developer-kit'))).toBe(false)
    expect(JSON.parse(readFileSync(provenancePath, 'utf8'))).toMatchObject({
      buildId: fixture.buildId,
      sourceId: fixture.sourceId,
    })
  })

  test('keeps the kit optional at install time and discoverable when selected', () => {
    const config = readRepoFile('apps/electron/electron-builder.yml')
    const developerHostConfig = readRepoFile('apps/electron/electron-builder.devhost.yml')
    const installer = readRepoFile('apps/electron/resources/installer.nsh')
    const discovery = readRepoFile('packages/shared/src/config/developer-kit.ts')

    expect(config).not.toContain('${env.MORTISE_DEVELOPER_KIT_ARTIFACT_DIR}')
    expect(config).not.toContain('${env.MORTISE_DEVELOPER_KIT_PROVENANCE_PATH}')
    expect(config).not.toContain('${env.MORTISE_ELECTRON_BUILD_PROVENANCE_PATH}')
    expect(config).not.toContain('!dist/installer-developer-kit')
    expect(config).toContain('include: dist/resources/installer.nsh')
    expect(config).toContain('deleteAppDataOnUninstall: false')
    expect(config).not.toContain('deleteAppDataOnUninstall: true')
    expect(developerHostConfig).toContain('deleteAppDataOnUninstall: false')
    expect(developerHostConfig).not.toContain('deleteAppDataOnUninstall: true')
    expect(installer).toContain('Install Mortise Developer Kit (recommended for developers)')
    expect(installer).toContain('IfSilent 0 +2')
    expect(installer).toContain('!ifndef BUILD_UNINSTALLER')
    expect(installer).toContain('RMDir /r "$INSTDIR\\resources\\developer-kit"')
    expect(installer).toContain('link-dev-host.ps1')
    expect(installer).toContain('nsExec::ExecToLog')
    expect(config).toContain('dist/packaging-inputs/hooks/link-dev-host.ps1')
    expect(readRepoFile('scripts/build/stage-electron-packaging-inputs.ts')).toContain("'link-dev-host.ps1'")
    expect(discovery).toContain("join(env.MORTISE_RESOURCES_PATH, 'developer-kit')")
  })
})

function createCachedKitFixture(): {
  sourceId: string
  buildId: string
  buildRoot: string
  electronAppDir: string
  artifactDirectory: string
} {
  const root = mkdtempSync(join(tmpdir(), 'mortise-cached-kit-'))
  temporaryRoots.push(root)
  const sourceId = 'b'.repeat(64)
  const buildRoot = join(root, 'kit-builds')
  const buildId = computeDeveloperKitBuildId(
    sourceId,
    true,
    buildToolchainExecutableSha256(process.execPath),
  )
  const buildDir = join(buildRoot, 'builds', buildId)
  const artifactsRoot = join(buildDir, 'artifacts')
  const artifactDirectory = join(artifactsRoot, 'mortise-developer-kit-test-win-x64')
  mkdirSync(artifactDirectory, { recursive: true })
  writeJsonAtomic(join(artifactDirectory, 'developer-kit.json'), { hostVersion: '0.1.0' })
  writeFileSync(join(artifactDirectory, 'payload.txt'), 'cached kit', 'utf8')
  const artifacts = collectArtifactInventory(artifactsRoot)
  const manifest: DeveloperKitBuildManifest = {
    schemaVersion: DEVELOPER_KIT_BUILD_SCHEMA_VERSION,
    buildId,
    sourceId,
    bunExecutableSha256: buildToolchainExecutableSha256(process.execPath),
    archiveDisabled: true,
    createdAt: new Date().toISOString(),
    artifactDirectory,
    sizeBytes: artifactInventorySize(artifacts),
    artifacts,
    platform: process.platform,
    arch: process.arch,
    immutable: true,
  }
  writeJsonAtomic(join(buildDir, 'build.json'), manifest)

  const electronAppDir = join(root, 'electron-app')
  mkdirSync(join(electronAppDir, 'dist'), { recursive: true })
  writeJsonAtomic(join(electronAppDir, 'package.json'), { version: '0.1.0' })
  writeJsonAtomic(join(electronAppDir, 'dist', 'build-provenance.json'), { sourceId })
  return { sourceId, buildId, buildRoot, electronAppDir, artifactDirectory }
}
