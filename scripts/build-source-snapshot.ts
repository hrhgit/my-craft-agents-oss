import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const SOURCE_SNAPSHOT_SCHEMA_VERSION = 1
const ABANDONED_SNAPSHOT_MS = 60 * 60 * 1_000
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
const LOCAL_DEPENDENCY_DIRECTORIES = new Set(['.cache', '.vite', '.vite-temp'])

export interface CaptureBuildSourceOptions {
  repoRoot: string
  scratchRoot: string
  sourcePaths?: readonly string[]
  /** Ignored generated/runtime inputs that must be frozen with the source tree. */
  extraPaths?: readonly string[]
}

export interface MaterializeBuildSourceOptions {
  parentDir: string
  linkDependencies?: boolean
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
    const hasHead = run('git', ['rev-parse', '--verify', 'HEAD'], repoRoot, process.env, true).status === 0
    runGit(hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], repoRoot, gitEnv)

    const sourcePaths = (options.sourcePaths ?? DEFAULT_SOURCE_PATHS)
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
            cpSync(extra.storedPath, target, { recursive: true, force: true, dereference: false })
          }
          if (materializeOptions.linkDependencies !== false) {
            linkWorkspaceDependencyViews(repoRoot, sourceRoot)
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
    cpSync(source, storedPath, { recursive: true, force: true, dereference: false })
    captured.push({ relativePath, storedPath })
  }
  return captured.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function hashPath(hash: ReturnType<typeof createHash>, path: string, name: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    hash.update(`link\0${name}\0${realpathSync(path)}\0`)
    return
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

function linkWorkspaceDependencyViews(repoRoot: string, sourceRoot: string): void {
  const roots = [repoRoot, join(repoRoot, 'pi')]
  for (const group of [join(repoRoot, 'apps'), join(repoRoot, 'packages'), join(repoRoot, 'pi', 'packages')]) {
    if (!existsSync(group)) continue
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(group, entry.name))
    }
  }

  let linked = 0
  for (const workspaceRoot of roots) {
    const dependencies = join(workspaceRoot, 'node_modules')
    if (!existsSync(dependencies)) continue
    const workspaceRelative = relative(repoRoot, workspaceRoot)
    const target = workspaceRelative ? join(sourceRoot, workspaceRelative, 'node_modules') : join(sourceRoot, 'node_modules')
    linkDependencyDirectory(dependencies, target, repoRoot, sourceRoot)
    linked += 1
  }
  if (linked === 0) {
    throw new Error(`Cannot prepare isolated build dependencies because node_modules is missing under ${repoRoot}.`)
  }
}

function linkDependencyDirectory(source: string, target: string, repoRoot: string, sourceRoot: string): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (LOCAL_DEPENDENCY_DIRECTORIES.has(entry.name)) {
      mkdirSync(targetPath, { recursive: true })
      continue
    }
    if (entry.isSymbolicLink()) {
      if (entry.name.endsWith('.pre-monorepo-link')) continue
      const resolvedTarget = realpathSync(sourcePath)
      const mappedTarget = mapDependencyTarget(resolvedTarget, repoRoot, sourceRoot)
      createDirectoryLink(mappedTarget, targetPath)
      continue
    }
    if (entry.isDirectory() && entry.name === '.bin') {
      cpSync(sourcePath, targetPath, { recursive: true, force: true, dereference: false })
      continue
    }
    if (entry.isDirectory() && entry.name.startsWith('@')) {
      linkDependencyDirectory(sourcePath, targetPath, repoRoot, sourceRoot)
      continue
    }
    if (entry.isDirectory()) {
      createDirectoryLink(sourcePath, targetPath)
      continue
    }
    if (entry.isFile()) copyFileSync(sourcePath, targetPath)
  }
}

function mapDependencyTarget(target: string, repoRoot: string, sourceRoot: string): string {
  const path = relative(repoRoot, target)
  if (path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))) {
    const mapped = resolve(sourceRoot, path)
    if (!existsSync(mapped)) {
      throw new Error(`Workspace dependency target is absent from the immutable source snapshot: ${path || '.'}`)
    }
    return mapped
  }
  return target
}

function createDirectoryLink(target: string, path: string): void {
  mkdirSync(resolve(path, '..'), { recursive: true })
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
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
