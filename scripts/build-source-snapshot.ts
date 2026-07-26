import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const SOURCE_SNAPSHOT_SCHEMA_VERSION = 1
export const MATERIALIZED_BUILD_SOURCE_PROVENANCE = '.mortise-build-source.json'
export const BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS = 600_000
const ABANDONED_SNAPSHOT_MS = 60 * 60 * 1_000
const PI_DEPENDENCY_ROOT = 'pi'
const DEFAULT_SOURCE_PATHS = [
  'package.json',
  'bun.lock',
  'bunfig.toml',
  'tsconfig.json',
  'tsconfig.base.json',
  'apps/electron',
  'apps/webui',
  'packages',
  'scripts',
  'pi',
  'developer-kit',
  'build-developer-kit.cmd',
  'docs/testing.md',
] as const

export interface CaptureBuildSourceOptions {
  repoRoot: string
  scratchRoot: string
  sourcePaths?: readonly string[]
  /** Ignored generated/runtime inputs that must be frozen with the source tree. */
  extraPaths?: readonly string[]
}

export interface MaterializeBuildSourceOptions {
  parentDir: string
  prepareDependencies?: boolean
}

export interface MaterializedBuildSource {
  sourceRoot: string
  dispose(): void
}

export interface CapturedBuildSource {
  repoRoot: string
  sourceId: string
  treeId: string
  materialize(options: MaterializeBuildSourceOptions): MaterializedBuildSource
  dispose(): void
}

interface MaterializedBuildSourceProvenance {
  schemaVersion: typeof SOURCE_SNAPSHOT_SCHEMA_VERSION
  sourceId: string
  treeId: string
}

/**
 * Captures dirty tracked files, deletions, and relevant untracked files without
 * touching the user's real Git index. The resulting tree is immutable even if
 * another task keeps editing the checkout while a build is running.
 */
export function captureBuildSource(options: CaptureBuildSourceOptions): CapturedBuildSource {
  const repoRoot = resolve(options.repoRoot)
  const scratchRoot = resolve(options.scratchRoot)
  const capturesDir = join(scratchRoot, 'captures')
  mkdirSync(capturesDir, { recursive: true })
  reapAbandonedSnapshotState(scratchRoot, capturesDir)
  const captureToken = `${process.pid}-${randomUUID()}`
  const indexPath = join(capturesDir, `.index-${captureToken}`)
  const objectDirectory = join(capturesDir, `.objects-${captureToken}`)
  const extraDirectory = join(capturesDir, `.extras-${captureToken}`)

  try {
    assertGitWorktree(repoRoot)
    const commonGitDirValue = run('git', ['rev-parse', '--git-common-dir'], repoRoot, process.env).stdout.trim()
    const commonGitDir = resolve(repoRoot, commonGitDirValue)
    mkdirSync(objectDirectory, { recursive: true })
    const alternates = [join(commonGitDir, 'objects'), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
      .filter((value): value is string => !!value)
      .join(process.platform === 'win32' ? ';' : ':')
    const gitEnv = {
      ...process.env,
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates,
    }
    // The capsule tree contains only declared build inputs, independent of what
    // unrelated paths happen to be tracked by the current commit.
    runGit(['read-tree', '--empty'], repoRoot, gitEnv)

    const sourcePaths = [...new Set([
      ...(options.sourcePaths ?? DEFAULT_SOURCE_PATHS),
      ...workspaceManifestPaths(repoRoot),
    ])]
      .map(path => path.replaceAll('\\', '/'))
      .filter(path => existsSync(join(repoRoot, ...path.split('/'))) || gitTracksPath(repoRoot, path))
    if (sourcePaths.length === 0) throw new Error('No build source paths exist in the repository snapshot.')
    runGit(['add', '-A', '--', ...sourcePaths], repoRoot, gitEnv)
    const treeId = runGit(['write-tree'], repoRoot, gitEnv).stdout.trim()
    if (!/^[0-9a-f]{40,64}$/i.test(treeId)) throw new Error(`Git returned an invalid source tree id: ${treeId}`)

    const extraFiles = captureExtraFiles(repoRoot)
    const extraPaths = captureExtraPaths(repoRoot, extraDirectory, options.extraPaths ?? [])
    const sourceIdHash = createHash('sha256')
      .update(`mortise-build-source:${SOURCE_SNAPSHOT_SCHEMA_VERSION}\0${treeId}\0`)
    for (const [name, content] of extraFiles) {
      sourceIdHash.update(`extra\0${name}\0`)
      sourceIdHash.update(content)
      sourceIdHash.update('\0')
    }
    for (const extra of extraPaths) {
      sourceIdHash.update(`extra-path\0${extra.relativePath}\0`)
      hashPath(sourceIdHash, extra.storedPath, extra.relativePath)
    }
    const sourceId = sourceIdHash.digest('hex')
    let disposed = false

    return {
      repoRoot,
      sourceId,
      treeId,
      materialize(materializeOptions) {
        if (disposed) throw new Error('Build source capture has already been disposed.')
        const parentDir = resolve(materializeOptions.parentDir)
        mkdirSync(parentDir, { recursive: true })
        const sourceRoot = join(parentDir, `.source-${sourceId.slice(0, 12)}-${process.pid}-${randomUUID().slice(0, 8)}`)
        mkdirSync(sourceRoot, { recursive: true })
        try {
          const prefix = `${sourceRoot}${sep}`.replaceAll('\\', '/')
          runGit(['checkout-index', '--all', '--force', `--prefix=${prefix}`], repoRoot, gitEnv)
          for (const [name, content] of extraFiles) {
            const target = join(sourceRoot, ...name.split('/'))
            mkdirSync(resolve(target, '..'), { recursive: true })
            writeFileSync(target, content, { mode: 0o600 })
          }
          for (const extra of extraPaths) {
            const target = join(sourceRoot, ...extra.relativePath.split('/'))
            mkdirSync(resolve(target, '..'), { recursive: true })
            cpSync(extra.storedPath, target, { recursive: true, force: true, dereference: true })
          }
          writeFileSync(join(sourceRoot, MATERIALIZED_BUILD_SOURCE_PROVENANCE), `${JSON.stringify({
            schemaVersion: SOURCE_SNAPSHOT_SCHEMA_VERSION,
            sourceId,
            treeId,
          } satisfies MaterializedBuildSourceProvenance, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
          if (materializeOptions.prepareDependencies !== false) {
            prepareFrozenDependencies(sourceRoot, scratchRoot)
          }
          return { sourceRoot, dispose: () => removeDirectory(sourceRoot) }
        } catch (error) {
          removeDirectory(sourceRoot)
          throw error
        }
      },
      dispose() {
        if (disposed) return
        disposed = true
        rmSync(indexPath, { force: true })
        rmSync(`${indexPath}.lock`, { force: true })
        removeDirectory(objectDirectory)
        removeDirectory(extraDirectory)
      },
    }
  } catch (error) {
    rmSync(indexPath, { force: true })
    rmSync(`${indexPath}.lock`, { force: true })
    removeDirectory(objectDirectory)
    removeDirectory(extraDirectory)
    throw error
  }
}

export function assertMaterializedBuildSourceIdentity(sourceRoot: string, expectedSourceId: string): void {
  const provenancePath = join(resolve(sourceRoot), MATERIALIZED_BUILD_SOURCE_PROVENANCE)
  let provenance: Partial<MaterializedBuildSourceProvenance>
  try {
    provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as Partial<MaterializedBuildSourceProvenance>
  } catch {
    throw new Error(`Materialized build source provenance is missing or invalid: ${provenancePath}`)
  }
  if (
    provenance.schemaVersion !== SOURCE_SNAPSHOT_SCHEMA_VERSION
    || provenance.sourceId !== expectedSourceId
    || !/^[0-9a-f]{40,64}$/i.test(provenance.treeId ?? '')
  ) {
    throw new Error(`Materialized build source does not match source identity ${expectedSourceId}.`)
  }
}

function captureExtraPaths(repoRoot: string, extraDirectory: string, paths: readonly string[]): Array<{ relativePath: string; storedPath: string }> {
  const captured: Array<{ relativePath: string; storedPath: string }> = []
  for (const value of paths) {
    const relativePath = value.replaceAll('\\', '/').replace(/^\.\//, '')
    const source = resolve(repoRoot, ...relativePath.split('/'))
    const pathFromRoot = relative(repoRoot, source)
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new Error(`Extra build input escapes the repository: ${value}`)
    }
    if (!existsSync(source)) throw new Error(`Required extra build input is missing: ${relativePath}`)
    const storedPath = join(extraDirectory, ...relativePath.split('/'))
    mkdirSync(resolve(storedPath, '..'), { recursive: true })
    cpSync(source, storedPath, { recursive: true, force: true, dereference: true })
    captured.push({ relativePath, storedPath })
  }
  return captured.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function hashPath(hash: ReturnType<typeof createHash>, path: string, name: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    throw new Error(`Captured build input must not contain a symbolic link: ${path}`)
  }
  if (stat.isFile()) {
    hash.update(`file\0${name}\0`)
    hash.update(readFileSync(path))
    hash.update('\0')
    return
  }
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hashPath(hash, join(path, entry.name), `${name}/${entry.name}`)
  }
}

function captureExtraFiles(repoRoot: string): Array<[string, Buffer]> {
  const files: Array<[string, Buffer]> = []
  const envPath = join(repoRoot, '.env')
  if (existsSync(envPath) && lstatSync(envPath).isFile()) files.push(['.env', readFileSync(envPath)])
  return files
}

function reapAbandonedSnapshotState(scratchRoot: string, capturesDir: string): void {
  const now = Date.now()
  for (const entry of readdirSync(scratchRoot, { withFileTypes: true })) {
    const match = /^\.source-[^-]+-(\d+)-/.exec(entry.name)
    if (!entry.isDirectory() || !match || isPidAlive(Number(match[1]))) continue
    removeIfAbandoned(join(scratchRoot, entry.name), now)
  }
  for (const entry of readdirSync(capturesDir, { withFileTypes: true })) {
    const match = /^\.(?:index|objects|extras)-(\d+)-/.exec(entry.name)
    if (!match || isPidAlive(Number(match[1]))) continue
    removeIfAbandoned(join(capturesDir, entry.name), now)
  }
}

function removeIfAbandoned(path: string, now: number): void {
  try {
    if (statSync(path).mtimeMs >= now - ABANDONED_SNAPSHOT_MS) return
    const stat = lstatSync(path)
    if (stat.isDirectory()) removeDirectory(path)
    else rmSync(path, { force: true })
  } catch { /* Another capture may already have reclaimed this path. */ }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES'
  }
}

function prepareFrozenDependencies(sourceRoot: string, scratchRoot: string): void {
  if (!existsSync(join(sourceRoot, 'bun.lock'))) {
    throw new Error('Immutable build dependencies require a captured bun.lock.')
  }
  runFrozenDependencyInstall(process.execPath, frozenBunInstallArgs(), sourceRoot, 'root Bun dependency domain')

  const piRoot = join(sourceRoot, PI_DEPENDENCY_ROOT)
  if (!existsSync(join(piRoot, 'package-lock.json'))) {
    throw new Error('Immutable Pi build dependencies require a captured pi/package-lock.json.')
  }
  const npmCacheDir = join(scratchRoot, 'dependency-cache', 'npm')
  mkdirSync(npmCacheDir, { recursive: true })
  runFrozenDependencyInstall(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `--cache=${npmCacheDir}`,
  ], piRoot, 'embedded Pi npm dependency domain')

  assertDependencyViewsContained(sourceRoot)
}

export function frozenBunInstallArgs(): string[] {
  return [
    'install',
    '--frozen-lockfile',
    '--no-save',
    '--linker=hoisted',
    '--backend=hardlink',
    '--no-progress',
    '--no-summary',
  ]
}

export function runFrozenDependencyInstall(
  command: string,
  args: string[],
  cwd: string,
  label: string,
  timeoutMs = BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS,
): void {
  const startedAt = Date.now()
  process.stdout.write(`[build-source] Preparing ${label}...\n`)
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, HUSKY: '0' },
    stdio: 'inherit',
    timeout: timeoutMs,
    windowsHide: true,
  })
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException
    if (error.code === 'ETIMEDOUT') {
      throw new Error(`Frozen installation for ${label} timed out after ${timeoutMs}ms.`)
    }
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Frozen installation for ${label} failed with exit code ${result.status ?? 'unknown'}.`)
  }
  process.stdout.write(`[build-source] Prepared ${label} in ${Date.now() - startedAt}ms.\n`)
}

function assertDependencyViewsContained(sourceRootValue: string): void {
  const sourceRoot = realpathSync(sourceRootValue)
  for (const workspaceRoot of workspaceRoots(sourceRoot)) {
    const dependencies = join(workspaceRoot, 'node_modules')
    if (!existsSync(dependencies)) continue
    for (const packageRoot of dependencyPackageRoots(dependencies)) {
      const target = realpathSync(packageRoot)
      if (!isWithin(sourceRoot, target)) {
        throw new Error(`Immutable dependency view escapes the source snapshot: ${packageRoot} -> ${target}`)
      }
    }
  }
}

function dependencyPackageRoots(dependencies: string): string[] {
  const roots: string[] = []
  for (const entry of readdirSync(dependencies, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(dependencies, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isDirectory() || scoped.isSymbolicLink()) roots.push(join(path, scoped.name))
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      roots.push(path)
    }
  }
  return roots
}

function workspaceManifestPaths(repoRoot: string): string[] {
  return workspaceRoots(repoRoot)
    .map(root => relative(repoRoot, join(root, 'package.json')).replaceAll('\\', '/'))
    .filter(path => path !== 'package.json' && existsSync(join(repoRoot, ...path.split('/'))))
}

function workspaceRoots(repoRoot: string): string[] {
  const roots = [repoRoot, join(repoRoot, PI_DEPENDENCY_ROOT)].filter(path => existsSync(join(path, 'package.json')))
  for (const group of [join(repoRoot, 'apps'), join(repoRoot, 'packages'), join(repoRoot, 'pi', 'packages')]) {
    if (!existsSync(group)) continue
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(group, entry.name, 'package.json'))) roots.push(join(group, entry.name))
    }
  }
  return roots
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function assertGitWorktree(repoRoot: string): void {
  const result = run('git', ['rev-parse', '--is-inside-work-tree'], repoRoot, process.env, true)
  if (result.status !== 0 || result.stdout.trim() !== 'true') {
    throw new Error(`Isolated builds require a Git worktree: ${repoRoot}`)
  }
}

function gitTracksPath(repoRoot: string, path: string): boolean {
  return run('git', ['ls-files', '--', path], repoRoot, process.env, true).stdout.trim().length > 0
}

function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): { stdout: string; status: number } {
  const result = run('git', args, cwd, env)
  return { stdout: result.stdout, status: result.status ?? 0 }
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

function removeDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
