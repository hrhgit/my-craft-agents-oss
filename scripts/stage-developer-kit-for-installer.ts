import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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
  type DeveloperKitBuildManifest,
} from './build/developer-kit-build-manifest.ts'
import { writeJsonAtomic } from './build/files.ts'

interface DeveloperKitManifest {
  hostVersion?: unknown
}

interface ElectronPackageManifest {
  version?: unknown
}

export interface StageDeveloperKitOptions {
  expectedSourceId: string
  electronAppDir: string
  electronBuildProvenancePath?: string
  sourceRoot?: string
  expectedBuildId?: string
  developerKitBuildRoot?: string
  bunExecutable?: string
  runId?: string
  provenanceOutputPath?: string
}

export interface StageDeveloperKitResult {
  buildId: string
  reused: boolean
  stagedKitDirectory: string
  artifactDirectory: string
  provenancePath: string
  timings: Record<string, number>
}

interface StageDeveloperKitDependencies {
  platform?: NodeJS.Platform
  buildDeveloperKit?: (options: {
    sourceRoot: string
    expectedSourceId: string
    bunExecutable: string
  }) => void
}

export function stageDeveloperKitForInstaller(
  options: StageDeveloperKitOptions,
  dependencies: StageDeveloperKitDependencies = {},
): StageDeveloperKitResult {
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    throw new Error('Offline Developer Kit installer staging is supported on Windows only.')
  }
  if (!/^[0-9a-f]{64}$/.test(options.expectedSourceId)) {
    throw new Error('Developer Kit installer staging requires a canonical source identity.')
  }

  const timings: Record<string, number> = {}
  const electronAppDir = resolve(options.electronAppDir)
  const repoRoot = resolve(import.meta.dir, '..')
  const developerKitBuildRoot = resolve(
    options.developerKitBuildRoot
      ?? process.env.MORTISE_DEVELOPER_KIT_BUILD_ROOT
      ?? join(repoRoot, 'output', 'developer-kit-builds'),
  )
  const bunExecutable = resolve(options.bunExecutable ?? process.execPath)
  const bunExecutableSha256 = buildToolchainExecutableSha256(bunExecutable)
  const buildId = computeDeveloperKitBuildId(options.expectedSourceId, true, bunExecutableSha256)
  if (options.expectedBuildId !== undefined && options.expectedBuildId !== buildId) {
    throw new Error(`Expected Developer Kit build ${options.expectedBuildId} does not match computed build ${buildId}.`)
  }

  const electronBuildProvenancePath = resolve(
    options.electronBuildProvenancePath ?? join(electronAppDir, 'dist', 'build-provenance.json'),
  )
  const electronBuildProvenance = readJson<{ sourceId?: unknown }>(
    electronBuildProvenancePath,
    `Developer Kit installer staging requires an isolated Electron build stage: ${electronBuildProvenancePath}.`,
  )
  if (electronBuildProvenance.sourceId !== options.expectedSourceId) {
    throw new Error('Electron build stage does not match the canonical source identity.')
  }

  const leaseStartedAt = performance.now()
  const lease = acquireDeveloperKitBuildLease(
    developerKitBuildRoot,
    buildId,
    options.runId ?? `installer-${process.pid}`,
  )
  timings.lease = elapsedMs(leaseStartedAt)
  try {
    const lookupStartedAt = performance.now()
    let manifest = readInstallerManifest(developerKitBuildRoot, buildId, options.expectedSourceId)
    timings.cacheLookup = elapsedMs(lookupStartedAt)
    const reused = manifest !== undefined
    if (!manifest) {
      if (!options.sourceRoot) {
        throw new Error(`Developer Kit build ${buildId.slice(0, 12)} is not cached; --source-root is required to build it.`)
      }
      const sourceRoot = resolve(options.sourceRoot)
      const buildStartedAt = performance.now()
      const buildDeveloperKit = dependencies.buildDeveloperKit ?? runDeveloperKitBuild
      buildDeveloperKit({ sourceRoot, expectedSourceId: options.expectedSourceId, bunExecutable })
      timings.build = elapsedMs(buildStartedAt)
      manifest = readInstallerManifest(developerKitBuildRoot, buildId, options.expectedSourceId)
      if (!manifest) throw new Error('Developer Kit build did not publish an artifact directory for the installer.')
    }

    const validationStartedAt = performance.now()
    validateDeveloperKitForElectron(manifest, electronAppDir)
    timings.validation = elapsedMs(validationStartedAt)

    const sourceArtifacts = artifactDirectoryInventory(manifest)
    const provenancePath = resolve(
      options.provenanceOutputPath
        ?? join(electronAppDir, 'dist', 'installer-developer-kit', 'build-provenance.json'),
    )
    const stagedKitDirectory = options.provenanceOutputPath
      ? manifest.artifactDirectory
      : join(electronAppDir, 'dist', 'installer-developer-kit')
    const copyStartedAt = performance.now()
    if (!options.provenanceOutputPath) {
      rmSync(stagedKitDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      mkdirSync(stagedKitDirectory, { recursive: true })
      cpSync(manifest.artifactDirectory, stagedKitDirectory, { recursive: true, force: true })
      const stagedArtifacts = collectArtifactInventory(stagedKitDirectory)
      if (!artifactInventoriesEqual(sourceArtifacts, stagedArtifacts)) {
        throw new Error('Staged Developer Kit does not match the immutable build artifact.')
      }
    } else {
      mkdirSync(dirname(provenancePath), { recursive: true })
    }
    writeJsonAtomic(provenancePath, {
      schemaVersion: 1,
      buildId: manifest.buildId,
      sourceId: manifest.sourceId,
      sizeBytes: artifactInventorySize(sourceArtifacts),
      artifacts: sourceArtifacts,
    })
    timings.copyAndVerify = elapsedMs(copyStartedAt)
    return {
      buildId,
      reused,
      stagedKitDirectory,
      artifactDirectory: manifest.artifactDirectory,
      provenancePath,
      timings,
    }
  } finally {
    releaseDeveloperKitBuildLease(lease)
  }
}

function readInstallerManifest(
  developerKitBuildRoot: string,
  buildId: string,
  expectedSourceId: string,
): DeveloperKitBuildManifest | undefined {
  const manifest = readValidDeveloperKitBuildManifest(join(developerKitBuildRoot, 'builds', buildId), buildId)
  if (
    !manifest
    || manifest.sourceId !== expectedSourceId
    || !manifest.archiveDisabled
    || !existsSync(manifest.artifactDirectory)
  ) return undefined
  return manifest
}

function validateDeveloperKitForElectron(manifest: DeveloperKitBuildManifest, electronAppDir: string): void {
  const kitManifest = readJson<DeveloperKitManifest>(
    join(manifest.artifactDirectory, 'developer-kit.json'),
    'Developer Kit manifest is missing or invalid.',
  )
  const electronPackage = readJson<ElectronPackageManifest>(
    join(electronAppDir, 'package.json'),
    'Electron package manifest is missing or invalid.',
  )
  if (typeof kitManifest.hostVersion !== 'string' || kitManifest.hostVersion !== electronPackage.version) {
    throw new Error(`Developer Kit host version ${String(kitManifest.hostVersion)} does not match Mortise ${String(electronPackage.version)}.`)
  }
}

function artifactDirectoryInventory(manifest: DeveloperKitBuildManifest) {
  const prefix = `${basename(manifest.artifactDirectory)}/`
  const artifacts = manifest.artifacts
    .filter(artifact => artifact.path.startsWith(prefix))
    .map(artifact => ({ ...artifact, path: artifact.path.slice(prefix.length) }))
  if (artifacts.length !== manifest.artifacts.length) {
    throw new Error('Developer Kit artifact manifest contains files outside its immutable directory.')
  }
  return artifacts
}

function runDeveloperKitBuild(options: {
  sourceRoot: string
  expectedSourceId: string
  bunExecutable: string
}): void {
  const buildResult = spawnSync(options.bunExecutable, [
    'run',
    join(options.sourceRoot, 'scripts', 'build-developer-kit.ts'),
    '--no-archive',
    '--source-root',
    options.sourceRoot,
    '--source-id',
    options.expectedSourceId,
  ], {
    cwd: options.sourceRoot,
    env: { ...process.env, MORTISE_BUILD_BUN_EXECUTABLE: options.bunExecutable },
    stdio: 'inherit',
    windowsHide: true,
  })
  if (buildResult.error) throw buildResult.error
  if (buildResult.status !== 0) {
    throw new Error(`Developer Kit build for installer failed with exit code ${buildResult.status ?? 'unknown'}.`)
  }
}

function readJson<T>(path: string, errorMessage: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    throw new Error(errorMessage)
  }
}

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(2))
}

function optionValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name)
  return index >= 0 ? values[index + 1] : undefined
}

function runCli(args = process.argv.slice(2)): void {
  if (process.platform !== 'win32') {
    process.stdout.write('[Mortise] Skipping offline Developer Kit staging outside Windows.\n')
    return
  }
  const expectedSourceId = optionValue(args, '--source-id')
  if (!expectedSourceId) throw new Error('Developer Kit installer staging requires --source-id <canonical-source-id>.')
  const electronAppDir = optionValue(args, '--electron-app-dir')
  if (!electronAppDir) throw new Error('Developer Kit installer staging requires --electron-app-dir <immutable-staging-app-dir>.')
  const result = stageDeveloperKitForInstaller({
    expectedSourceId,
    electronAppDir,
    electronBuildProvenancePath: optionValue(args, '--electron-build-provenance'),
    sourceRoot: optionValue(args, '--source-root'),
    expectedBuildId: optionValue(args, '--expected-build-id'),
    provenanceOutputPath: optionValue(args, '--provenance-output'),
  })
  process.stdout.write(`[Mortise] Prepared offline Developer Kit: ${result.artifactDirectory}\n`)
  process.stdout.write(`[mortise-developer-kit:timings] ${JSON.stringify({
    buildId: result.buildId,
    reused: result.reused,
    artifactDirectory: result.artifactDirectory,
    provenancePath: result.provenancePath,
    phases: result.timings,
  })}\n`)
}

if (import.meta.main) runCli()
