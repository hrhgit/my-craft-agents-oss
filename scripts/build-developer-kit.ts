import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { assertMaterializedBuildSourceIdentity, captureBuildSource } from './build-source-snapshot.ts'
import {
  artifactInventorySize,
  collectArtifactInventory,
} from './build/electron-build-cache.ts'
import {
  computeDeveloperKitBuildId,
  DEVELOPER_KIT_BUILD_SCHEMA_VERSION,
  activeDeveloperKitBuildIdsLocked,
  cleanupDeveloperKitBuildCacheLocked,
  readValidDeveloperKitBuildManifest,
  writeDeveloperKitStagingOwner,
  type DeveloperKitBuildManifest,
} from './build/developer-kit-build-manifest.ts'
import { withFileLock } from './build/file-lock.ts'
import { writeJsonAtomic } from './build/files.ts'

const BUILD_SCHEMA_VERSION = DEVELOPER_KIT_BUILD_SCHEMA_VERSION
const LOCK_TIMEOUT_MS = 10 * 60 * 1_000
const DEFAULT_RETAIN_COUNT = 2
const args = process.argv.slice(2)
const noArchive = args.some(arg => arg.toLowerCase() === '--no-archive' || arg.toLowerCase() === '-noarchive')
const sourceRootOption = optionValue(args, '--source-root')
const sourceIdOption = optionValue(args, '--source-id')
assertSupportedArguments(args)
if ((sourceRootOption === undefined) !== (sourceIdOption === undefined)) {
  throw new Error('Developer Kit external source requires both --source-root and --source-id.')
}
if (sourceIdOption !== undefined && !/^[0-9a-f]{64}$/.test(sourceIdOption)) {
  throw new Error('Developer Kit --source-id must be a canonical source identity.')
}
if (process.platform !== 'win32') throw new Error('Mortise Developer Kit packaging currently supports Windows only.')

const repoRoot = resolve(sourceRootOption ?? resolve(import.meta.dir, '..'))
const outputRoot = join(repoRoot, 'output')
const buildRoot = resolve(process.env.MORTISE_DEVELOPER_KIT_BUILD_ROOT ?? join(outputRoot, 'developer-kit-builds'))
for (const name of ['builds', 'locks', 'sources']) mkdirSync(join(buildRoot, name), { recursive: true })

withFileLock(join(buildRoot, 'coordinator'), () => cleanupDeveloperKitBuildCacheLocked(
  buildRoot,
  activeDeveloperKitBuildIdsLocked(buildRoot),
  { retainCount: developerKitRetainCount() },
), { timeoutMs: LOCK_TIMEOUT_MS, staleMs: 60_000 })

if (sourceIdOption) assertMaterializedBuildSourceIdentity(repoRoot, sourceIdOption)
const captured = sourceIdOption ? undefined : captureBuildSource({
  repoRoot,
  scratchRoot: join(buildRoot, 'sources'),
  extraPaths: ['node_modules/@vscode/ripgrep', 'node_modules/electron/dist'],
})
const sourceId = sourceIdOption ?? captured!.sourceId
try {
  const buildId = computeDeveloperKitBuildId(sourceId, noArchive)
  const finalBuildDir = join(buildRoot, 'builds', buildId)
  const manifest = withFileLock(join(buildRoot, 'locks', buildId), () => {
    const cached = readValidDeveloperKitBuildManifest(finalBuildDir, buildId)
    if (cached) return cached
    if (existsSync(finalBuildDir)) removeDirectory(finalBuildDir)

    const source = captured
      ? captured.materialize({ parentDir: join(buildRoot, 'sources'), prepareDependencies: true })
      : { sourceRoot: repoRoot, dispose() {} }
    const stagingDir = join(buildRoot, 'builds', `.staging-${buildId.slice(0, 12)}-${process.pid}-${randomUUID().slice(0, 8)}`)
    const workerOutput = join(stagingDir, 'artifacts')
    mkdirSync(workerOutput, { recursive: true })
    writeDeveloperKitStagingOwner(stagingDir)
    try {
      const workerArgs = [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', join(source.sourceRoot, 'scripts', 'build-developer-kit.ps1'),
        '-Worker', '-OutputRoot', workerOutput,
        ...(noArchive ? ['-NoArchive'] : []),
      ]
      const result = spawnSync('powershell', workerArgs, {
        cwd: source.sourceRoot,
        env: { ...process.env, MORTISE_BUILD_SOURCE_ID: sourceId },
        stdio: 'inherit',
        windowsHide: true,
      })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`Developer Kit worker failed with exit code ${result.status ?? 'unknown'}.`)

      const kitPackage = JSON.parse(readFileSync(join(source.sourceRoot, 'developer-kit', 'package.json'), 'utf8')) as { version: string }
      const kitName = `mortise-developer-kit-${kitPackage.version}-win-x64`
      const finalArtifactDirectory = join(finalBuildDir, 'artifacts', kitName)
      const finalArchivePath = noArchive ? undefined : join(finalBuildDir, 'artifacts', `${kitName}.zip`)
      if (!existsSync(join(workerOutput, kitName))) throw new Error(`Developer Kit worker did not produce ${kitName}.`)
      if (finalArchivePath && !existsSync(join(workerOutput, `${kitName}.zip`))) throw new Error(`Developer Kit worker did not produce ${kitName}.zip.`)
      const artifacts = collectArtifactInventory(workerOutput)

      const completed: DeveloperKitBuildManifest = {
        schemaVersion: BUILD_SCHEMA_VERSION,
        buildId,
        sourceId,
        archiveDisabled: noArchive,
        createdAt: new Date().toISOString(),
        artifactDirectory: finalArtifactDirectory,
        ...(finalArchivePath ? { archivePath: finalArchivePath } : {}),
        sizeBytes: artifactInventorySize(artifacts),
        artifacts,
        platform: process.platform,
        arch: process.arch,
        immutable: true,
      }
      writeJsonAtomic(join(stagingDir, 'build.json'), completed)
      renameDirectoryWithRetry(stagingDir, finalBuildDir)
      return completed
    } catch (error) {
      removeDirectory(stagingDir)
      throw error
    } finally {
      source.dispose()
    }
  }, { timeoutMs: LOCK_TIMEOUT_MS, staleMs: 60_000 })

  if (!sourceIdOption) writeJsonAtomic(join(outputRoot, 'developer-kit-latest.json'), manifest)
  withFileLock(join(buildRoot, 'coordinator'), () => cleanupDeveloperKitBuildCacheLocked(
    buildRoot,
    new Set([manifest.buildId, ...activeDeveloperKitBuildIdsLocked(buildRoot)]),
    { retainCount: developerKitRetainCount() },
  ), {
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: 60_000,
  })
  const resultPath = manifest.archivePath ?? manifest.artifactDirectory
  process.stdout.write(`[Mortise Developer Kit] ${manifest.createdAt} ${basename(resultPath)}\n${resultPath}\n`)
} finally {
  captured?.dispose()
}

function optionValue(values: string[], name: string): string | undefined {
  const index = values.indexOf(name)
  return index >= 0 ? values[index + 1] : undefined
}

function assertSupportedArguments(values: string[]): void {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!
    if (['--no-archive', '-noarchive'].includes(value.toLowerCase())) continue
    if (value === '--source-root' || value === '--source-id') {
      if (!values[index + 1] || values[index + 1]!.startsWith('--')) throw new Error(`${value} requires a value.`)
      index += 1
      continue
    }
    throw new Error(`Unsupported Developer Kit argument: ${value}`)
  }
}

function developerKitRetainCount(): number {
  const retainCountValue = Number(process.env.MORTISE_DEVELOPER_KIT_BUILD_RETAIN_COUNT)
  return Number.isSafeInteger(retainCountValue) && retainCountValue >= 0 ? retainCountValue : DEFAULT_RETAIN_COUNT
}

function removeDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function renameDirectoryWithRetry(source: string, destination: string): void {
  const retryableCodes = new Set(['EACCES', 'EBUSY', 'EPERM'])
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination)
      return
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
      if (attempt >= 19 || !code || !retryableCodes.has(code)) throw error
      Atomics.wait(sleeper, 0, 0, 250)
    }
  }
}
