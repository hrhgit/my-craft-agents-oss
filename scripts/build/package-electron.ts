import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { load } from 'js-yaml'
import {
  acquireElectronBuild,
  buildToolchainExecutableSha256,
  captureElectronBuildSource,
  createElectronBuildCommandEnvironment,
  publishBuildBunToolchain,
  releaseElectronBuild,
  resolveReusableElectronBuildId,
  withElectronBuildForPackaging,
  type ElectronBuildMode,
} from './electron-build-cache.ts'
import {
  acquireDeveloperKitBuildLease,
  computeDeveloperKitBuildId,
  readValidDeveloperKitBuildManifest,
  releaseDeveloperKitBuildLease,
} from './developer-kit-build-manifest.ts'
import { withFileLock } from './file-lock.ts'
import { writeJsonAtomic } from './files.ts'
import {
  computeElectronBuilderToolchainId,
  computePackageArtifactId,
  computePackageArtifactIdentity,
  materializePackageArtifactCache,
  publishPackageArtifactCache,
  readValidPackageArtifactManifest,
  resolvePackageArtifactCachePolicy,
  type PackageArtifactCacheVerification,
} from './package-artifact-cache.ts'
import { getProcessStartTime, matchesProcessIdentity } from './process-identity.ts'

export type PackageTarget = 'default' | 'win' | 'mac' | 'linux'
type ResolvedPackageTarget = Exclude<PackageTarget, 'default'>

const PACKAGE_USAGE = `Usage: bun run scripts/build/package-electron.ts --target <default|win|mac|linux> [options]

Options:
  --development              Package the development Electron build.
  --expected-build-id <sha>  Package an existing immutable build by its SHA-256 id.
  --fresh-source             Capture current source and build its immutable identity instead of reusing the latest valid build.
  --build-source-root <path> Capture source from a checkout other than the current repository.
  --release-dir <path>       Publish artifacts to a repository-local directory instead of apps/electron/release.
  --timings-output <path>    Write structured package phase timings as JSON.
  --no-package-cache         Disable reuse and publication of final package artifacts.
  --package-cache-verification <fast|strict>
                             Select cache-hit validation depth (default: fast).
  --help, -h                 Show this help message.`

export function resolvePackageTarget(
  requested: PackageTarget,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { target: ResolvedPackageTarget; builderArgs: string[] } {
  const hostTarget = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : undefined
  if (!hostTarget) throw new Error(`Electron packaging is unsupported on ${platform}.`)
  const target = requested === 'default' ? hostTarget : requested
  if (target !== hostTarget) {
    throw new Error(`Electron ${target} packaging requires a matching ${hostTarget === 'mac' ? 'macOS' : hostTarget} build host.`)
  }
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Electron packaging is unsupported for ${platform}-${arch}.`)
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error('Electron Windows packaging currently supports x64 only.')
  }
  return { target, builderArgs: [`--${target}`, `--${arch}`] }
}

export function resolveExpectedPackageBuildId(args: string[]): string | undefined {
  if (!args.includes('--expected-build-id')) return undefined
  const expectedBuildId = optionValue(args, '--expected-build-id')
  if (expectedBuildId === undefined || !/^[0-9a-f]{64}$/.test(expectedBuildId)) {
    throw new Error('--expected-build-id requires a lowercase SHA-256 immutable build identity')
  }
  return expectedBuildId
}

export function resolvePackageFreshSource(args: string[]): boolean {
  const freshSource = args.includes('--fresh-source')
  if (freshSource && args.includes('--expected-build-id')) {
    throw new Error('--fresh-source cannot be combined with --expected-build-id')
  }
  return freshSource
}

export function resolvePackageReleaseDir(args: string[], repoRootValue: string, electronDirValue: string): string {
  const repoRoot = resolve(repoRootValue)
  const electronDir = resolve(electronDirValue)
  const requested = optionValue(args, '--release-dir')
  if (args.includes('--release-dir') && !requested) throw new Error('--release-dir requires a path')
  const releaseDir = resolve(repoRoot, requested ?? join(electronDir, 'release'))
  const relativePath = relative(repoRoot, releaseDir)
  const outputRoot = join(repoRoot, 'output')
  const outputRelativePath = relative(outputRoot, releaseDir)
  const electronRelativePath = relative(electronDir, releaseDir)
  const insideOutput = outputRelativePath !== ''
    && outputRelativePath !== '..'
    && !outputRelativePath.startsWith(`..${sep}`)
    && !isAbsolute(outputRelativePath)
  const electronReleaseChild = !electronRelativePath.includes(sep)
    && electronRelativePath.startsWith('release')
  if (
    relativePath === ''
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
    || (!insideOutput && !electronReleaseChild)
  ) {
    throw new Error('--release-dir must identify a dedicated directory under output or apps/electron/release*')
  }
  return releaseDir
}

export function resolvePackageCacheVerification(args: string[]): PackageArtifactCacheVerification {
  const requested = optionValue(args, '--package-cache-verification')
  if (!args.includes('--package-cache-verification')) return 'fast'
  if (requested !== 'fast' && requested !== 'strict') {
    throw new Error('--package-cache-verification requires fast or strict')
  }
  return requested
}

export function createEffectiveElectronBuilderConfig(
  sourceContent: string,
  target: ResolvedPackageTarget,
): Record<string, unknown> {
  const parsed = load(sourceContent)
  if (!isRecord(parsed)) throw new Error('Electron builder configuration must be a YAML object.')

  const config = structuredClone(parsed)
  config.files = arrayValue(config.files, 'files')
    .filter(entry => typeof entry !== 'string' || !entry.includes('dist/installer-developer-kit'))

  config.extraResources = withoutResourceDestinations(
    arrayValue(config.extraResources, 'extraResources'),
    ['app/dist/build-provenance.json'],
  )
  config.extraResources.push({
    from: '${env.MORTISE_ELECTRON_BUILD_PROVENANCE_PATH}',
    to: 'app/dist/build-provenance.json',
  })

  if (target === 'win') {
    const win = recordValue(config.win, 'win')
    win.extraResources = withoutResourceDestinations(
      arrayValue(win.extraResources, 'win.extraResources'),
      ['developer-kit', 'developer-kit/build-provenance.json'],
    )
    win.extraResources.push(
      {
        from: '${env.MORTISE_DEVELOPER_KIT_ARTIFACT_DIR}',
        to: 'developer-kit',
        filter: ['**/*'],
      },
      {
        from: '${env.MORTISE_DEVELOPER_KIT_PROVENANCE_PATH}',
        to: 'developer-kit/build-provenance.json',
      },
    )
    config.win = win
  }

  return config
}

export function materializeElectronBuilderConfigSources(
  config: Record<string, unknown>,
  sources: {
    electronBuildProvenancePath: string
    developerKitArtifactDirectory?: string
    developerKitProvenancePath?: string
  },
): Record<string, unknown> {
  const replacements = new Map<string, string>([
    ['${env.MORTISE_ELECTRON_BUILD_PROVENANCE_PATH}', resolve(sources.electronBuildProvenancePath)],
    ...(sources.developerKitArtifactDirectory
      ? [['${env.MORTISE_DEVELOPER_KIT_ARTIFACT_DIR}', resolve(sources.developerKitArtifactDirectory)] as const]
      : []),
    ...(sources.developerKitProvenancePath
      ? [['${env.MORTISE_DEVELOPER_KIT_PROVENANCE_PATH}', resolve(sources.developerKitProvenancePath)] as const]
      : []),
  ])
  const materialized = structuredClone(config)
  replaceResourceSources(materialized, replacements)
  return materialized
}

export function packageElectron(args = process.argv.slice(2)): void {
  const packageStartedAt = performance.now()
  const timings: Record<string, number> = {}
  if (args.includes('--help') || args.includes('-h')) {
    console.log(PACKAGE_USAGE)
    return
  }
  const requestedTarget = optionValue(args, '--target') as PackageTarget | undefined
  if (!requestedTarget || !['default', 'win', 'mac', 'linux'].includes(requestedTarget)) {
    throw new Error('package-electron requires --target default|win|mac|linux')
  }
  const resolvedTarget = resolvePackageTarget(requestedTarget)
  const mode: ElectronBuildMode = args.includes('--development') ? 'development' : 'production'
  const expectedBuildId = resolveExpectedPackageBuildId(args)
  const freshSource = resolvePackageFreshSource(args)
  const repoRoot = resolve(import.meta.dir, '..', '..')
  const buildSourceRoot = resolve(optionValue(args, '--build-source-root') ?? repoRoot)
  const electronDir = join(repoRoot, 'apps', 'electron')
  const buildRoot = resolve(process.env.MORTISE_BUILD_ROOT ?? join(repoRoot, 'output', 'electron-builds'))
  const developerKitBuildRoot = resolve(
    process.env.MORTISE_DEVELOPER_KIT_BUILD_ROOT ?? join(repoRoot, 'output', 'developer-kit-builds'),
  )
  const packageCacheRoot = resolve(
    process.env.MORTISE_PACKAGE_CACHE_ROOT ?? join(repoRoot, 'output', 'electron-package-cache'),
  )
  const packageCacheVerification = resolvePackageCacheVerification(args)
  const packageCacheRequested = !args.includes('--no-package-cache')
    && !['0', 'false', 'no', 'off'].includes(String(process.env.MORTISE_PACKAGE_CACHE ?? '').trim().toLowerCase())
  const releaseDir = resolvePackageReleaseDir(args, repoRoot, electronDir)
  const publicationLockPath = resolvePackagePublicationLock(repoRoot, electronDir, releaseDir)
  const timingsOutputValue = optionValue(args, '--timings-output')
  if (args.includes('--timings-output') && !timingsOutputValue) throw new Error('--timings-output requires a path')
  const timingsOutput = timingsOutputValue ? resolve(repoRoot, timingsOutputValue) : undefined
  const toolchainStartedAt = performance.now()
  const bunExecutable = publishBuildBunToolchain(buildRoot)
  timings.toolchain = elapsedMs(toolchainStartedAt)
  console.log(`[electron-package] Starting ${resolvedTarget.target} ${mode} packaging.`)
  const runId = `package-${resolvedTarget.target}-${process.pid}-${randomUUID().slice(0, 8)}`
  const runsRoot = join(repoRoot, 'output', 'electron-build-runs')
  const recoveryStartedAt = performance.now()
  reapAbandonedPackageRuns(runsRoot)
  recoverElectronPackagePublication(releaseDir, publicationLockPath)
  timings.recovery = elapsedMs(recoveryStartedAt)
  const runDir = join(runsRoot, runId)
  const packageOutputDir = join(runDir, 'package-output')

  mkdirSync(runDir, { recursive: true })
  writeJsonAtomic(join(runDir, 'run.json'), {
    status: 'ready',
    runId,
    launcherPid: process.pid,
    launcherStartedAt: getProcessStartTime(process.pid),
    createdAt: new Date().toISOString(),
  })

  let lease: ReturnType<typeof acquireElectronBuild> | undefined
  let developerKitLease: ReturnType<typeof acquireDeveloperKitBuildLease> | undefined
  let developerKitManifest: ReturnType<typeof readValidDeveloperKitBuildManifest> | undefined
  let developerKitBuildId: string | undefined
  let packageArtifactIdentity: ReturnType<typeof computePackageArtifactIdentity> | undefined
  let packageCache: {
    enabled: boolean
    status: 'hit' | 'miss' | 'disabled' | 'publish-failed'
    verification: PackageArtifactCacheVerification
    packageId?: string
    reason?: string
  } = {
    enabled: packageCacheRequested,
    status: packageCacheRequested ? 'miss' : 'disabled',
    verification: packageCacheVerification,
    ...(!packageCacheRequested ? { reason: 'disabled by command or environment' } : {}),
  }
  let capturedSource: ReturnType<typeof captureElectronBuildSource> | undefined
  let packageSource: ReturnType<ReturnType<typeof captureElectronBuildSource>['materialize']> | undefined
  try {
    const reusableBuildResolutionStartedAt = performance.now()
    const reusableBuildId = expectedBuildId ?? (!freshSource
      ? resolveReusableElectronBuildId({ buildRoot, mode, verification: 'fast' })
      : undefined)
    timings.reusableBuildResolution = elapsedMs(reusableBuildResolutionStartedAt)
    if (reusableBuildId) {
      const source = expectedBuildId ? 'pinned' : 'latest reusable'
      console.log(`[electron-package] Acquiring ${source} build ${reusableBuildId.slice(0, 12)}...`)
      const acquisitionStartedAt = performance.now()
      try {
        lease = acquireElectronBuild({
          runId,
          runDir,
          repoRoot,
          buildRoot,
          mode,
          expectedBuildId: reusableBuildId,
          skipBuild: true,
          verification: 'fast',
        })
      } catch (error) {
        if (expectedBuildId) throw error
        console.log('[electron-package] The reusable build changed before its lease was acquired.')
      }
      timings.electronBuildAcquisition = elapsedMs(acquisitionStartedAt)
    }
    if (!lease) {
      if (!freshSource) {
        throw new Error('No reusable Electron build is available. Run again with --fresh-source to build the current source.')
      }
      console.log('[electron-package] Capturing immutable source snapshot...')
      const sourceCaptureStartedAt = performance.now()
      capturedSource = captureElectronBuildSource({ repoRoot: buildSourceRoot, buildRoot })
      timings.sourceCapture = elapsedMs(sourceCaptureStartedAt)
      console.log(`[electron-package] Source snapshot ${capturedSource.sourceId.slice(0, 12)} ready.`)
      const acquisitionStartedAt = performance.now()
      lease = acquireElectronBuild({ runId, runDir, repoRoot: buildSourceRoot, buildRoot, mode, capturedSource })
      timings.electronBuildAcquisition = elapsedMs(acquisitionStartedAt)
    }
    const buildEnvironment = createElectronBuildCommandEnvironment(
      process.env,
      mode,
      lease.manifest.sourceId,
      buildRoot,
      bunExecutable,
    )
    const bunExecutableSha256 = buildToolchainExecutableSha256(bunExecutable)
    if (resolvedTarget.target === 'win') {
      developerKitBuildId = computeDeveloperKitBuildId(
        lease.manifest.sourceId,
        true,
        bunExecutableSha256,
      )
    }

    const sourceBuilderConfigPath = join(lease.appDir, 'dist', 'packaging-inputs', 'electron-builder.yml')
    const builderConfig = createEffectiveElectronBuilderConfig(
      readFileSync(sourceBuilderConfigPath, 'utf8'),
      resolvedTarget.target,
    )
    const builderConfigContent = JSON.stringify(builderConfig)
    const builderConfigPath = join(runDir, 'electron-builder.json')
    const cachePolicy = packageCacheRequested
      ? resolvePackageArtifactCachePolicy({
          target: resolvedTarget.target,
          builderConfigContent,
          environment: process.env,
        })
      : { enabled: false, reason: packageCache.reason }
    if (!cachePolicy.enabled) {
      packageCache = {
        enabled: false,
        status: 'disabled',
        verification: packageCacheVerification,
        reason: cachePolicy.reason ?? 'package cache policy is disabled',
      }
      console.log(`[electron-package] Final package cache disabled: ${packageCache.reason}.`)
    } else {
      packageArtifactIdentity = computePackageArtifactIdentity({
        electronBuildId: lease.buildId,
        ...(developerKitBuildId ? { developerKitBuildId } : {}),
        target: resolvedTarget.target,
        arch: process.arch,
        mode,
        builderConfigContent,
        builderToolchainId: computeElectronBuilderToolchainId(repoRoot, bunExecutableSha256),
        policy: cachePolicy,
      })
      const packageId = computePackageArtifactId(packageArtifactIdentity)
      const cacheLookupStartedAt = performance.now()
      const cachedPackage = readValidPackageArtifactManifest(packageCacheRoot, packageId, packageCacheVerification)
      timings.packageCacheLookup = elapsedMs(cacheLookupStartedAt)
      packageCache = {
        enabled: true,
        status: cachedPackage ? 'hit' : 'miss',
        verification: packageCacheVerification,
        packageId,
      }
      if (cachedPackage) {
        console.log(`[electron-package] Reusing final package ${packageId.slice(0, 12)}.`)
        const materializationStartedAt = performance.now()
        materializePackageArtifactCache({
          cacheRoot: packageCacheRoot,
          packageId,
          destinationDir: packageOutputDir,
          verification: packageCacheVerification,
        })
        timings.packageCacheMaterialization = elapsedMs(materializationStartedAt)
        const publicationStartedAt = performance.now()
        publishElectronPackageArtifacts(packageOutputDir, releaseDir, publicationLockPath)
        timings.publication = elapsedMs(publicationStartedAt)
        const receipt = {
          schemaVersion: 1,
          runId,
          target: resolvedTarget.target,
          mode,
          buildId: lease.buildId,
          sourceId: lease.manifest.sourceId,
          ...(developerKitBuildId ? { developerKitBuildId } : {}),
          releaseDir,
          packageCache,
          phases: timings,
          totalMs: elapsedMs(packageStartedAt),
        }
        if (timingsOutput) writeJsonAtomic(timingsOutput, receipt)
        process.stdout.write(`[electron-package:timings] ${JSON.stringify(receipt)}\n`)
        return
      }
    }

    if (resolvedTarget.target === 'win') {
      if (!developerKitBuildId) throw new Error('Windows packaging requires a Developer Kit build identity.')
      const kitLookupStartedAt = performance.now()
      developerKitLease = acquireDeveloperKitBuildLease(
        developerKitBuildRoot,
        developerKitBuildId,
        `${runId}-developer-kit`,
      )
      developerKitManifest = readValidDeveloperKitBuildManifest(
        join(developerKitBuildRoot, 'builds', developerKitBuildId),
        developerKitBuildId,
        'fast',
      )
      timings.developerKitCacheLookup = elapsedMs(kitLookupStartedAt)
      if (developerKitManifest?.sourceId === lease.manifest.sourceId && developerKitManifest.archiveDisabled) {
        console.log(`[electron-package] Reusing Developer Kit build ${developerKitBuildId.slice(0, 12)}.`)
      } else {
        console.log('[electron-package] Developer Kit cache miss; materializing installer source and dependencies...')
        if (!capturedSource) {
          const sourceCaptureStartedAt = performance.now()
          capturedSource = captureElectronBuildSource({ repoRoot: buildSourceRoot, buildRoot })
          timings.sourceCapture = elapsedMs(sourceCaptureStartedAt)
        }
        if (capturedSource.sourceId !== lease.manifest.sourceId) {
          throw new Error(
            `Pinned Electron build ${lease.buildId.slice(0, 12)} requires source ${lease.manifest.sourceId}; `
            + `--build-source-root resolved ${capturedSource.sourceId}.`,
          )
        }
        const materializationStartedAt = performance.now()
        packageSource = capturedSource.materialize({
          parentDir: join(buildRoot, 'sources'),
          prepareDependencies: true,
          bunExecutable,
        })
        timings.sourceMaterializationAndDependencies = elapsedMs(materializationStartedAt)
      }
    }
    const stageStartedAt = performance.now()
    let measuredInsideStage = 0
    withElectronBuildForPackaging(lease, staged => {
      if (resolvedTarget.target === 'win') {
        if (!developerKitBuildId) throw new Error('Windows packaging requires a Developer Kit build identity.')
        const developerKitStartedAt = performance.now()
        const developerKitProvenancePath = join(runDir, 'developer-kit-build-provenance.json')
        run(
          bunExecutable,
          [
            'run',
            join(repoRoot, 'scripts', 'stage-developer-kit-for-installer.ts'),
            '--source-id',
            staged.sourceId,
            '--expected-build-id',
            developerKitBuildId,
            '--electron-app-dir',
            staged.appDir,
            '--electron-build-provenance',
            staged.provenancePath,
            '--provenance-output',
            developerKitProvenancePath,
            ...(packageSource ? ['--source-root', packageSource.sourceRoot] : []),
          ],
          repoRoot,
          'Developer Kit staging',
          {
            ...buildEnvironment,
            MORTISE_DEVELOPER_KIT_BUILD_ROOT: developerKitBuildRoot,
            MORTISE_BUILD_TOOLCHAIN_CACHE_DIR: join(buildRoot, 'toolchains'),
          },
        )
        timings.developerKitStage = elapsedMs(developerKitStartedAt)
        measuredInsideStage += timings.developerKitStage
        developerKitManifest = readValidDeveloperKitBuildManifest(
          join(developerKitBuildRoot, 'builds', developerKitBuildId),
          developerKitBuildId,
          'fast',
        )
        if (
          !developerKitManifest
          || developerKitManifest.sourceId !== staged.sourceId
          || !developerKitManifest.archiveDisabled
        ) {
          throw new Error('Prepared Developer Kit does not match the immutable Electron build.')
        }
      }
      writeJsonAtomic(builderConfigPath, materializeElectronBuilderConfigSources(builderConfig, {
        electronBuildProvenancePath: staged.provenancePath,
        ...(developerKitManifest ? {
          developerKitArtifactDirectory: developerKitManifest.artifactDirectory,
          developerKitProvenancePath: join(runDir, 'developer-kit-build-provenance.json'),
        } : {}),
      }))
      console.log(`[electron-package] Packaging Electron build ${staged.buildId.slice(0, 12)}...`)
      const builderStartedAt = performance.now()
      run(
        bunExecutable,
        [
          'x',
          'electron-builder',
          '--projectDir',
          staged.appDir,
          '--config',
          builderConfigPath,
          '--config.directories.output',
          packageOutputDir,
          ...resolvedTarget.builderArgs,
        ],
        staged.appDir,
        `Electron ${resolvedTarget.target} package`,
        {
          ...buildEnvironment,
          MORTISE_ELECTRON_BUILD_PROVENANCE_PATH: staged.provenancePath,
          ...(developerKitManifest ? {
            MORTISE_DEVELOPER_KIT_ARTIFACT_DIR: developerKitManifest.artifactDirectory,
            MORTISE_DEVELOPER_KIT_PROVENANCE_PATH: join(runDir, 'developer-kit-build-provenance.json'),
          } : {}),
        },
      )
      timings.electronBuilder = elapsedMs(builderStartedAt)
      measuredInsideStage += timings.electronBuilder
      if (packageArtifactIdentity && packageCache.packageId) {
        const cachePublicationStartedAt = performance.now()
        try {
          publishPackageArtifactCache({
            cacheRoot: packageCacheRoot,
            identity: packageArtifactIdentity,
            sourceDir: packageOutputDir,
            consumeSource: true,
          })
          timings.packageCachePublication = elapsedMs(cachePublicationStartedAt)
          measuredInsideStage += timings.packageCachePublication
          if (!existsSync(packageOutputDir)) {
            const cacheMaterializationStartedAt = performance.now()
            materializePackageArtifactCache({
              cacheRoot: packageCacheRoot,
              packageId: packageCache.packageId,
              destinationDir: packageOutputDir,
              verification: 'fast',
            })
            timings.packageCacheMaterializationAfterPublish = elapsedMs(cacheMaterializationStartedAt)
            measuredInsideStage += timings.packageCacheMaterializationAfterPublish
          }
          console.log(`[electron-package] Published final package cache ${packageCache.packageId.slice(0, 12)}.`)
        } catch (error) {
          packageCache = {
            ...packageCache,
            status: 'publish-failed',
            reason: error instanceof Error ? error.message : String(error),
          }
          console.warn(`[electron-package] Final package cache publication failed: ${packageCache.reason}`)
          if (timings.packageCachePublication === undefined) {
            timings.packageCachePublication = elapsedMs(cachePublicationStartedAt)
            measuredInsideStage += timings.packageCachePublication
          }
          if (!existsSync(packageOutputDir)) throw error
        }
      }
      const publicationStartedAt = performance.now()
      publishElectronPackageArtifacts(
        packageOutputDir,
        releaseDir,
        publicationLockPath,
      )
      timings.publication = elapsedMs(publicationStartedAt)
      measuredInsideStage += timings.publication
      console.log(`Packaged immutable Electron build ${staged.buildId.slice(0, 12)}.`)
    })
    timings.electronInputVerification = Number(Math.max(0, elapsedMs(stageStartedAt) - measuredInsideStage).toFixed(2))
    const receipt = {
      schemaVersion: 1,
      runId,
      target: resolvedTarget.target,
      mode,
      buildId: lease.buildId,
      sourceId: lease.manifest.sourceId,
      ...(developerKitBuildId ? { developerKitBuildId } : {}),
      releaseDir,
      packageCache,
      phases: timings,
      totalMs: elapsedMs(packageStartedAt),
    }
    if (timingsOutput) writeJsonAtomic(timingsOutput, receipt)
    process.stdout.write(`[electron-package:timings] ${JSON.stringify(receipt)}\n`)
  } finally {
    packageSource?.dispose()
    if (developerKitLease) releaseDeveloperKitBuildLease(developerKitLease)
    if (lease) releaseElectronBuild(lease)
    capturedSource?.dispose()
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function resolvePackagePublicationLock(repoRoot: string, electronDir: string, releaseDir: string): string {
  if (releaseDir === join(electronDir, 'release')) return join(repoRoot, 'output', 'electron-package-publication')
  const releaseIdentity = createHash('sha256').update(releaseDir.toLowerCase()).digest('hex').slice(0, 16)
  return join(repoRoot, 'output', 'electron-package-publications', releaseIdentity)
}

export function reapAbandonedPackageRuns(runsRootValue: string, nowMs = Date.now()): string[] {
  const runsRoot = resolve(runsRootValue)
  mkdirSync(runsRoot, { recursive: true })
  const removed: string[] = []
  withFileLock(join(runsRoot, '.gc'), () => {
    for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('package-')) continue
      const runDir = join(runsRoot, entry.name)
      let owner: { launcherPid?: number; launcherStartedAt?: number; createdAt?: string }
      try {
        owner = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as typeof owner
      } catch {
        // An unreadable or partially-written owner record is not proof that the
        // run is abandoned. Recovery must fail closed around active outputs.
        continue
      }
      if (!Number.isSafeInteger(owner.launcherPid) || (owner.launcherPid ?? 0) <= 0) continue
      const recordedAt = typeof owner.createdAt === 'string' ? Date.parse(owner.createdAt) : undefined
      if (!Number.isFinite(recordedAt) || (recordedAt ?? nowMs) > nowMs) continue
      if (matchesProcessIdentity({
        pid: owner.launcherPid,
        startedAt: owner.launcherStartedAt,
        recordedAt,
      })) continue
      rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      removed.push(entry.name)
    }
  }, { timeoutMs: 60_000, staleMs: 60_000 })
  return removed
}

export function recoverElectronPackagePublication(
  releaseDirValue: string,
  publicationLockPathValue: string,
): void {
  const releaseDir = resolve(releaseDirValue)
  const publicationLockPath = resolve(publicationLockPathValue)
  withFileLock(publicationLockPath, () => {
    mkdirSync(dirname(releaseDir), { recursive: true })
    recoverInterruptedPackagePublication(releaseDir, `${releaseDir}.previous`)
  }, { timeoutMs: 10 * 60 * 1_000, staleMs: 60_000 })
}

export function publishElectronPackageArtifacts(
  stagedOutputDirValue: string,
  releaseDirValue: string,
  publicationLockPathValue: string,
): void {
  const stagedOutputDir = resolve(stagedOutputDirValue)
  const releaseDir = resolve(releaseDirValue)
  const publicationLockPath = resolve(publicationLockPathValue)
  if (stagedOutputDir === releaseDir) throw new Error('Electron package publication requires an isolated output directory.')

  withFileLock(publicationLockPath, () => {
    mkdirSync(dirname(releaseDir), { recursive: true })
    const backupDir = `${releaseDir}.previous`
    recoverInterruptedPackagePublication(releaseDir, backupDir)
    if (!existsSync(stagedOutputDir) || readdirSync(stagedOutputDir).length === 0) {
      throw new Error(`Electron package output is missing or empty: ${stagedOutputDir}`)
    }
    let previousMoved = false
    let published = false
    try {
      if (existsSync(releaseDir)) {
        renameDirectoryWithRetry(releaseDir, backupDir)
        previousMoved = true
      }
      renameDirectoryWithRetry(stagedOutputDir, releaseDir)
      published = true
      if (previousMoved) {
        try {
          rmSync(backupDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch (error) {
          console.warn(`Electron package was published, but the previous release could not be reclaimed: ${String(error)}`)
        }
      }
    } catch (error) {
      if (!published && previousMoved && !existsSync(releaseDir) && existsSync(backupDir)) {
        renameDirectoryWithRetry(backupDir, releaseDir)
      }
      throw error
    }
  }, { timeoutMs: 10 * 60 * 1_000, staleMs: 60_000 })
}

function recoverInterruptedPackagePublication(releaseDir: string, backupDir: string): void {
  if (!existsSync(backupDir)) return
  if (!existsSync(releaseDir)) {
    renameDirectoryWithRetry(backupDir, releaseDir)
    return
  }
  rmSync(backupDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function renameDirectoryWithRetry(source: string, destination: string): void {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt === 8) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, 10 * 2 ** (attempt - 1)))
    }
  }
}

function optionValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name)
  return index >= 0 ? values[index + 1] : undefined
}

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(2))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordValue(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Electron builder configuration ${name} must be an object.`)
  return value
}

function arrayValue(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Electron builder configuration ${name} must be an array.`)
  return value
}

function withoutResourceDestinations(resources: unknown[], destinations: string[]): unknown[] {
  return resources.filter(resource => !isRecord(resource)
    || typeof resource.to !== 'string'
    || !destinations.includes(resource.to))
}

function replaceResourceSources(value: unknown, replacements: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) replaceResourceSources(entry, replacements)
    return
  }
  if (!isRecord(value)) return
  if (typeof value.from === 'string' && replacements.has(value.from)) {
    value.from = replacements.get(value.from)
  }
  for (const child of Object.values(value)) replaceResourceSources(child, replacements)
}

function run(
  command: string,
  commandArgs: string[],
  cwd: string,
  label: string,
  environment: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`)
}

if (import.meta.main) packageElectron()
