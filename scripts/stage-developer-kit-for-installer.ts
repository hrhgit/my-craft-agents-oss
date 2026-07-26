import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  artifactInventoriesEqual,
  artifactInventorySize,
  buildToolchainExecutableSha256,
  collectArtifactInventory,
} from './build/electron-build-cache.ts'
import {
  acquireDeveloperKitBuildLease,
  computeDeveloperKitBuildId,
  readValidDeveloperKitBuildManifest,
  releaseDeveloperKitBuildLease,
} from './build/developer-kit-build-manifest.ts'
import { writeJsonAtomic } from './build/files.ts'

if (process.platform !== 'win32') {
  process.stdout.write('[Mortise] Skipping offline Developer Kit staging outside Windows.\n')
  process.exit(0)
}

interface DeveloperKitManifest {
  hostVersion?: unknown
}

interface ElectronPackageManifest {
  version?: unknown
}

const repoRoot = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const expectedSourceId = optionValue(args, '--source-id')
if (!expectedSourceId || !/^[0-9a-f]{64}$/.test(expectedSourceId)) {
  throw new Error('Developer Kit installer staging requires --source-id <canonical-source-id>.')
}
const electronAppDirValue = optionValue(args, '--electron-app-dir')
if (!electronAppDirValue) {
  throw new Error('Developer Kit installer staging requires --electron-app-dir <immutable-staging-app-dir>.')
}
const electronAppDir = resolve(electronAppDirValue)
const sourceRootValue = optionValue(args, '--source-root')
if (!sourceRootValue) {
  throw new Error('Developer Kit installer staging requires --source-root <materialized-source-root>.')
}
const sourceRoot = resolve(sourceRootValue)
const electronBuildProvenancePath = join(electronAppDir, 'dist', 'build-provenance.json')
let electronBuildProvenance: { sourceId?: unknown }
try {
  electronBuildProvenance = JSON.parse(readFileSync(electronBuildProvenancePath, 'utf8')) as { sourceId?: unknown }
} catch {
  throw new Error(`Developer Kit installer staging requires an isolated Electron build stage: ${electronBuildProvenancePath}.`)
}
if (electronBuildProvenance.sourceId !== expectedSourceId) {
  throw new Error('Electron build stage does not match the canonical source identity.')
}
const stagedKitDirectory = join(electronAppDir, 'dist', 'installer-developer-kit')
const developerKitBuildRoot = resolve(
  process.env.MORTISE_DEVELOPER_KIT_BUILD_ROOT ?? join(repoRoot, 'output', 'developer-kit-builds'),
)
const bunExecutableSha256 = buildToolchainExecutableSha256()
const buildId = computeDeveloperKitBuildId(expectedSourceId, true, bunExecutableSha256)
const lease = acquireDeveloperKitBuildLease(
  developerKitBuildRoot,
  buildId,
  `installer-${process.pid}`,
)
try {
  const buildResult = spawnSync(process.execPath, [
    'run',
    join(sourceRoot, 'scripts', 'build-developer-kit.ts'),
    '--no-archive',
    '--source-root',
    sourceRoot,
    '--source-id',
    expectedSourceId,
  ], {
    cwd: sourceRoot,
    env: { ...process.env, MORTISE_BUILD_BUN_EXECUTABLE: process.execPath },
    stdio: 'inherit',
    windowsHide: true,
  })

  if (buildResult.error) throw buildResult.error
  if (buildResult.status !== 0) {
    throw new Error(`Developer Kit build for installer failed with exit code ${buildResult.status ?? 'unknown'}.`)
  }

const buildDir = join(developerKitBuildRoot, 'builds', buildId)
const manifest = readValidDeveloperKitBuildManifest(buildDir, buildId)
if (!manifest || manifest.sourceId !== expectedSourceId || !manifest.archiveDisabled || !existsSync(manifest.artifactDirectory)) {
  throw new Error('Developer Kit build did not publish an artifact directory for the installer.')
}
const artifactsRoot = dirname(manifest.artifactDirectory)
if (!artifactInventoriesEqual(
  manifest.artifacts,
  collectArtifactInventory(artifactsRoot),
)) throw new Error('Developer Kit build artifacts do not match their immutable manifest.')

const kitManifestPath = join(manifest.artifactDirectory, 'developer-kit.json')
const electronPackagePath = join(electronAppDir, 'package.json')
const kitManifest = JSON.parse(readFileSync(kitManifestPath, 'utf8')) as DeveloperKitManifest
const electronPackage = JSON.parse(readFileSync(electronPackagePath, 'utf8')) as ElectronPackageManifest
if (typeof kitManifest.hostVersion !== 'string' || kitManifest.hostVersion !== electronPackage.version) {
  throw new Error(`Developer Kit host version ${String(kitManifest.hostVersion)} does not match Mortise ${String(electronPackage.version)}.`)
}

rmSync(stagedKitDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
mkdirSync(stagedKitDirectory, { recursive: true })
cpSync(manifest.artifactDirectory, stagedKitDirectory, { recursive: true, force: true })
const stagedArtifacts = collectArtifactInventory(stagedKitDirectory)
const sourceArtifacts = collectArtifactInventory(manifest.artifactDirectory)
if (!artifactInventoriesEqual(sourceArtifacts, stagedArtifacts)) {
  throw new Error('Staged Developer Kit does not match the immutable build artifact.')
}
writeJsonAtomic(join(stagedKitDirectory, 'build-provenance.json'), {
  schemaVersion: 1,
  buildId: manifest.buildId,
  sourceId: manifest.sourceId,
  sizeBytes: artifactInventorySize(sourceArtifacts),
  artifacts: sourceArtifacts,
})
process.stdout.write(`[Mortise] Staged offline Developer Kit: ${stagedKitDirectory}\n`)
} finally {
  releaseDeveloperKitBuildLease(lease)
}

function optionValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name)
  return index >= 0 ? values[index + 1] : undefined
}
