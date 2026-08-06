import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  acquireElectronBuild,
  captureElectronBuildSource,
  createElectronBuildCommandEnvironment,
  publishBuildBunToolchain,
  releaseElectronBuild,
  withStagedElectronBuild,
  type ElectronBuildMode,
} from './electron-build-cache.ts'
import { withFileLock } from './file-lock.ts'
import { writeJsonAtomic } from './files.ts'
import { getProcessStartTime, matchesProcessIdentity } from './process-identity.ts'

export type PackageTarget = 'default' | 'win' | 'mac' | 'linux'
type ResolvedPackageTarget = Exclude<PackageTarget, 'default'>

const PACKAGE_USAGE = `Usage: bun run scripts/build/package-electron.ts --target <default|win|mac|linux> [options]

Options:
  --development              Package the development Electron build.
  --expected-build-id <sha>  Package an existing immutable build by its SHA-256 id.
  --build-source-root <path> Capture source from a checkout other than the current repository.
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

export function packageElectron(args = process.argv.slice(2)): void {
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
  const repoRoot = resolve(import.meta.dir, '..', '..')
  const buildSourceRoot = resolve(optionValue(args, '--build-source-root') ?? repoRoot)
  const electronDir = join(repoRoot, 'apps', 'electron')
  const buildRoot = resolve(process.env.MORTISE_BUILD_ROOT ?? join(repoRoot, 'output', 'electron-builds'))
  const developerKitBuildRoot = resolve(
    process.env.MORTISE_DEVELOPER_KIT_BUILD_ROOT ?? join(repoRoot, 'output', 'developer-kit-builds'),
  )
  const bunExecutable = publishBuildBunToolchain(buildRoot)
  const runId = `package-${resolvedTarget.target}-${process.pid}-${randomUUID().slice(0, 8)}`
  const runsRoot = join(repoRoot, 'output', 'electron-build-runs')
  reapAbandonedPackageRuns(runsRoot)
  recoverElectronPackagePublication(
    join(electronDir, 'release'),
    join(repoRoot, 'output', 'electron-package-publication'),
  )
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
  let capturedSource: ReturnType<typeof captureElectronBuildSource> | undefined
  let packageSource: ReturnType<ReturnType<typeof captureElectronBuildSource>['materialize']> | undefined
  try {
    if (expectedBuildId) {
      lease = acquireElectronBuild({
        runId,
        runDir,
        repoRoot,
        buildRoot,
        mode,
        expectedBuildId,
        skipBuild: true,
      })
    } else {
      capturedSource = captureElectronBuildSource({ repoRoot: buildSourceRoot, buildRoot })
      lease = acquireElectronBuild({ runId, runDir, repoRoot: buildSourceRoot, buildRoot, mode, capturedSource })
    }
    const buildEnvironment = createElectronBuildCommandEnvironment(
      process.env,
      mode,
      lease.manifest.sourceId,
      buildRoot,
      bunExecutable,
    )
    if (resolvedTarget.target === 'win') {
      capturedSource ??= captureElectronBuildSource({ repoRoot: buildSourceRoot, buildRoot })
      if (capturedSource.sourceId !== lease.manifest.sourceId) {
        throw new Error(
          `Pinned Electron build ${lease.buildId.slice(0, 12)} requires source ${lease.manifest.sourceId}; `
          + `--build-source-root resolved ${capturedSource.sourceId}.`,
        )
      }
      packageSource = capturedSource.materialize({
        parentDir: join(buildRoot, 'sources'),
        prepareDependencies: true,
        bunExecutable,
      })
    }
    withStagedElectronBuild(lease, staged => {
      if (resolvedTarget.target === 'win') {
        if (!packageSource) throw new Error('Windows packaging requires its captured source snapshot.')
        run(
          bunExecutable,
          [
            'run',
            join(packageSource.sourceRoot, 'scripts', 'stage-developer-kit-for-installer.ts'),
            '--source-id',
            staged.sourceId,
            '--source-root',
            packageSource.sourceRoot,
            '--electron-app-dir',
            staged.appDir,
          ],
          packageSource.sourceRoot,
          'Developer Kit staging',
          {
            ...buildEnvironment,
            MORTISE_DEVELOPER_KIT_BUILD_ROOT: developerKitBuildRoot,
            MORTISE_BUILD_TOOLCHAIN_CACHE_DIR: join(buildRoot, 'toolchains'),
          },
        )
      }
      run(
        bunExecutable,
        [
          'x',
          'electron-builder',
          '--projectDir',
          staged.appDir,
          '--config',
          join(staged.distDir, 'packaging-inputs', 'electron-builder.yml'),
          '--config.directories.output',
          packageOutputDir,
          ...resolvedTarget.builderArgs,
        ],
        staged.appDir,
        `Electron ${resolvedTarget.target} package`,
        buildEnvironment,
      )
      publishElectronPackageArtifacts(
        packageOutputDir,
        join(electronDir, 'release'),
        join(repoRoot, 'output', 'electron-package-publication'),
      )
      console.log(`Packaged immutable Electron build ${staged.buildId.slice(0, 12)}.`)
    })
  } finally {
    packageSource?.dispose()
    if (lease) releaseElectronBuild(lease)
    capturedSource?.dispose()
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
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
