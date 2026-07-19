import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { captureBuildSource } from './build-source-snapshot.ts'
import { withFileLock } from './mortise-ui/artifacts.ts'
import { writeJsonAtomic } from './mortise-ui/files.ts'

const BUILD_SCHEMA_VERSION = 1
const LOCK_TIMEOUT_MS = 10 * 60 * 1_000
const DEFAULT_RETAIN_COUNT = 2
const BUILD_ENV_KEYS = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'SLACK_OAUTH_CLIENT_ID',
  'SLACK_OAUTH_CLIENT_SECRET',
  'MICROSOFT_OAUTH_CLIENT_ID',
] as const

interface DeveloperKitBuildManifest {
  schemaVersion: typeof BUILD_SCHEMA_VERSION
  buildId: string
  sourceId: string
  createdAt: string
  artifactDirectory: string
  archivePath?: string
  immutable: true
}

const args = process.argv.slice(2)
const noArchive = args.some(arg => arg.toLowerCase() === '--no-archive' || arg.toLowerCase() === '-noarchive')
const unsupported = args.filter(arg => !['--no-archive', '-noarchive'].includes(arg.toLowerCase()))
if (unsupported.length > 0) throw new Error(`Unsupported Developer Kit argument: ${unsupported[0]}`)
if (process.platform !== 'win32') throw new Error('Mortise Developer Kit packaging currently supports Windows only.')

const repoRoot = resolve(import.meta.dir, '..')
const outputRoot = join(repoRoot, 'output')
const buildRoot = resolve(process.env.MORTISE_DEVELOPER_KIT_BUILD_ROOT ?? join(outputRoot, 'developer-kit-builds'))
for (const name of ['builds', 'locks', 'sources']) mkdirSync(join(buildRoot, name), { recursive: true })

const captured = captureBuildSource({
  repoRoot,
  scratchRoot: join(buildRoot, 'sources'),
  extraPaths: [
    'apps/electron/vendor/bun',
    'apps/electron/resources/bin/win32-x64',
  ],
})
try {
  const buildId = developerKitBuildId(captured.sourceId, noArchive)
  const finalBuildDir = join(buildRoot, 'builds', buildId)
  const manifest = withFileLock(join(buildRoot, 'locks', buildId), () => {
    const cached = readManifest(finalBuildDir, buildId)
    if (cached) return cached
    if (existsSync(finalBuildDir)) removeDirectory(finalBuildDir)

    const source = captured.materialize({ parentDir: join(buildRoot, 'sources'), linkDependencies: true })
    const stagingDir = join(buildRoot, 'builds', `.staging-${buildId.slice(0, 12)}-${process.pid}-${randomUUID().slice(0, 8)}`)
    const workerOutput = join(stagingDir, 'artifacts')
    mkdirSync(workerOutput, { recursive: true })
    try {
      const workerArgs = [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', join(source.sourceRoot, 'scripts', 'build-developer-kit.ps1'),
        '-Worker', '-OutputRoot', workerOutput,
        ...(noArchive ? ['-NoArchive'] : []),
      ]
      const result = spawnSync('powershell', workerArgs, {
        cwd: source.sourceRoot,
        env: process.env,
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

      const completed: DeveloperKitBuildManifest = {
        schemaVersion: BUILD_SCHEMA_VERSION,
        buildId,
        sourceId: captured.sourceId,
        createdAt: new Date().toISOString(),
        artifactDirectory: finalArtifactDirectory,
        ...(finalArchivePath ? { archivePath: finalArchivePath } : {}),
        immutable: true,
      }
      writeJsonAtomic(join(stagingDir, 'build.json'), completed)
      renameSync(stagingDir, finalBuildDir)
      return completed
    } catch (error) {
      removeDirectory(stagingDir)
      throw error
    } finally {
      source.dispose()
    }
  }, { timeoutMs: LOCK_TIMEOUT_MS, staleMs: 60_000 })

  writeJsonAtomic(join(outputRoot, 'developer-kit-latest.json'), manifest)
  withFileLock(join(buildRoot, 'coordinator'), () => cleanupCompletedBuilds(buildRoot, manifest.buildId), {
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: 60_000,
  })
  const resultPath = manifest.archivePath ?? manifest.artifactDirectory
  process.stdout.write(`[Mortise Developer Kit] ${manifest.createdAt} ${basename(resultPath)}\n${resultPath}\n`)
} finally {
  captured.dispose()
}

function developerKitBuildId(sourceId: string, archiveDisabled: boolean): string {
  const hash = createHash('sha256')
  hash.update(`mortise-developer-kit:${BUILD_SCHEMA_VERSION}\0${sourceId}\0${process.platform}\0${process.arch}\0${process.versions.bun ?? process.version}\0${archiveDisabled}\0`)
  for (const key of BUILD_ENV_KEYS) {
    hash.update(`${key}\0`)
    hash.update(createHash('sha256').update(process.env[key] ?? '').digest())
  }
  return hash.digest('hex')
}

function readManifest(buildDir: string, buildId: string): DeveloperKitBuildManifest | undefined {
  try {
    const value = JSON.parse(readFileSync(join(buildDir, 'build.json'), 'utf8')) as DeveloperKitBuildManifest
    if (
      value.schemaVersion !== BUILD_SCHEMA_VERSION
      || value.buildId !== buildId
      || value.immutable !== true
      || !existsSync(value.artifactDirectory)
      || (value.archivePath !== undefined && !existsSync(value.archivePath))
    ) return undefined
    return value
  } catch { return undefined }
}

function cleanupCompletedBuilds(buildRoot: string, protectedBuildId: string): void {
  const retainCountValue = Number(process.env.MORTISE_DEVELOPER_KIT_BUILD_RETAIN_COUNT)
  const retainCount = Number.isSafeInteger(retainCountValue) && retainCountValue >= 0 ? retainCountValue : DEFAULT_RETAIN_COUNT
  const buildsDir = join(buildRoot, 'builds')
  const builds = readdirSync(buildsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.staging-'))
    .map(entry => readManifest(join(buildsDir, entry.name), entry.name))
    .filter((value): value is DeveloperKitBuildManifest => !!value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const keep = new Set([protectedBuildId])
  for (const build of builds) {
    if (keep.size >= Math.max(1, retainCount)) break
    keep.add(build.buildId)
  }
  for (const build of builds) {
    if (!keep.has(build.buildId)) removeDirectory(join(buildsDir, build.buildId))
  }
}

function removeDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
