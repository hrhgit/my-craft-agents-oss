import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock } from './file-lock.ts'

const DEPENDENCY_VIEW_SCHEMA_VERSION = 1
const MATERIALIZED_DEPENDENCY_VIEWS = '.mortise-dependency-views.json'
export const BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS = 600_000
const DEPENDENCY_VIEW_RETAIN_COUNT = 2
const PI_DEPENDENCY_ROOT = 'pi'

type DependencyDomain = 'root-bun' | 'embedded-pi-npm'

interface DependencyViewLink {
  path: string
  target: string
}

interface DependencyViewManifest {
  schemaVersion: typeof DEPENDENCY_VIEW_SCHEMA_VERSION
  dependencyId: string
  domain: DependencyDomain
  platform: NodeJS.Platform
  arch: string
  toolchain: string
  installArguments: string[]
  roots: string[]
  sourceLinks: DependencyViewLink[]
  sealed: true
  createdAt: string
}

export function prepareFrozenDependencies(sourceRoot: string, scratchRoot: string, bunExecutable: string): void {
  prepareFrozenRootDependencies(sourceRoot, scratchRoot, bunExecutable)
  prepareFrozenPiDependencies(sourceRoot, scratchRoot)
  assertFrozenDependencyViewsContained(sourceRoot, scratchRoot)
}

export function prepareFrozenRootDependencies(sourceRoot: string, scratchRoot: string, bunExecutable: string): void {
  if (!existsSync(join(sourceRoot, 'bun.lock'))) {
    throw new Error('Immutable build dependencies require a captured bun.lock.')
  }
  const installArguments = frozenBunInstallArgs()
  prepareCachedDependencyView({
    sourceRoot,
    scratchRoot,
    domain: 'root-bun',
    toolchain: dependencyToolchainIdentity(bunExecutable, ['--version']),
    installArguments,
    identityPaths: rootDependencyIdentityPaths(sourceRoot),
    dependencyRoots: rootDependencyRoots(sourceRoot),
    install: () => runFrozenDependencyInstall(
      bunExecutable,
      installArguments,
      sourceRoot,
      'root Bun dependency domain',
      { bunExecutable },
    ),
  })
}

export function prepareFrozenPiDependencies(sourceRoot: string, scratchRoot: string): void {
  const piRoot = join(sourceRoot, PI_DEPENDENCY_ROOT)
  if (!existsSync(join(piRoot, 'package-lock.json'))) {
    throw new Error('Immutable Pi build dependencies require a captured pi/package-lock.json.')
  }
  const npmCacheDir = join(scratchRoot, 'dependency-cache', 'npm')
  mkdirSync(npmCacheDir, { recursive: true })
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const installArguments = [
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `--cache=${npmCacheDir}`,
  ]
  prepareCachedDependencyView({
    sourceRoot,
    scratchRoot,
    domain: 'embedded-pi-npm',
    toolchain: `${dependencyToolchainIdentity(npmExecutable, ['--version'])}:node-${process.version}`,
    installArguments: installArguments.filter(argument => !argument.startsWith('--cache=')),
    identityPaths: piDependencyIdentityPaths(sourceRoot),
    dependencyRoots: piDependencyRoots(sourceRoot),
    install: () => runFrozenDependencyInstall(
      npmExecutable,
      installArguments,
      piRoot,
      'embedded Pi npm dependency domain',
    ),
  })
}

function prepareCachedDependencyView(options: {
  sourceRoot: string
  scratchRoot: string
  domain: DependencyDomain
  toolchain: string
  installArguments: string[]
  identityPaths: string[]
  dependencyRoots: string[]
  install(): void
}): void {
  const dependencyId = computeDependencyViewId(options)
  const cacheRoot = join(resolve(options.scratchRoot), 'dependency-cache')
  const domainRoot = join(cacheRoot, 'views', options.domain)
  const viewRoot = join(domainRoot, dependencyId)
  const label = options.domain === 'root-bun' ? 'root Bun' : 'embedded Pi npm'
  mkdirSync(domainRoot, { recursive: true })

  withFileLock(join(cacheRoot, 'locks', `${options.domain}-${dependencyId}`), () => {
    const cached = readDependencyViewManifest(viewRoot, options.domain, dependencyId)
    if (cached) {
      const startedAt = Date.now()
      materializeDependencyView(options.sourceRoot, viewRoot, cached)
      process.stdout.write(`[build-source] Reused ${label} dependency view ${dependencyId.slice(0, 12)} in ${Date.now() - startedAt}ms.\n`)
      return
    }

    removeDirectory(viewRoot)
    for (const dependencyRoot of options.dependencyRoots) removeDirectory(dependencyRoot)
    options.install()
    const stagingRoot = join(domainRoot, `.staging-${dependencyId.slice(0, 12)}-${process.pid}-${randomUUID().slice(0, 8)}`)
    removeDirectory(stagingRoot)
    mkdirSync(join(stagingRoot, 'tree'), { recursive: true })
    try {
      const sourceLinks = detachSourceDependencyLinks(options.sourceRoot, options.dependencyRoots)
      const roots = moveDependencyRootsIntoView(options.sourceRoot, stagingRoot, options.dependencyRoots)
      const manifest: DependencyViewManifest = {
        schemaVersion: DEPENDENCY_VIEW_SCHEMA_VERSION,
        dependencyId,
        domain: options.domain,
        platform: process.platform,
        arch: process.arch,
        toolchain: options.toolchain,
        installArguments: [...options.installArguments],
        roots,
        sourceLinks,
        sealed: true,
        createdAt: new Date().toISOString(),
      }
      writeFileSync(join(stagingRoot, 'dependency-view.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      renameSync(stagingRoot, viewRoot)
      materializeDependencyView(options.sourceRoot, viewRoot, manifest)
      process.stdout.write(`[build-source] Published ${label} dependency view ${dependencyId.slice(0, 12)}.\n`)
    } finally {
      removeDirectory(stagingRoot)
    }
  }, { timeoutMs: BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS, staleMs: BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS })
  withFileLock(join(cacheRoot, 'coordinator'), () => {
    cleanupDependencyViews(cacheRoot, options.domain, dependencyId)
  }, { timeoutMs: BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS, staleMs: BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS })
}

function cleanupDependencyViews(cacheRoot: string, domain: DependencyDomain, currentDependencyId: string): void {
  const domainRoot = join(cacheRoot, 'views', domain)
  if (!existsSync(domainRoot)) return
  const views = readdirSync(domainRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
    .map(entry => {
      const path = join(domainRoot, entry.name)
      const manifest = readDependencyViewManifest(path, domain, entry.name)
      return {
        dependencyId: entry.name,
        path,
        createdAt: manifest?.createdAt ?? new Date(statSync(path).mtimeMs).toISOString(),
        valid: !!manifest,
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const keep = new Set([
    currentDependencyId,
    ...activeMaterializedDependencyViewIds(dirname(cacheRoot), domain),
    ...views.filter(view => view.valid).slice(0, DEPENDENCY_VIEW_RETAIN_COUNT).map(view => view.dependencyId),
  ])
  for (const view of views) {
    if (keep.has(view.dependencyId)) continue
    try {
      withFileLock(join(cacheRoot, 'locks', `${domain}-${view.dependencyId}`), () => {
        removeDirectory(view.path)
      }, { timeoutMs: 0, staleMs: BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error
    }
  }
}

function activeMaterializedDependencyViewIds(scratchRoot: string, domain: DependencyDomain): string[] {
  const active: string[] = []
  if (!existsSync(scratchRoot)) return active
  for (const entry of readdirSync(scratchRoot, { withFileTypes: true })) {
    const match = /^\.source-[^-]+-(\d+)-/.exec(entry.name)
    if (!entry.isDirectory() || !match || !isPidAlive(Number(match[1]))) continue
    try {
      const views = JSON.parse(readFileSync(join(scratchRoot, entry.name, MATERIALIZED_DEPENDENCY_VIEWS), 'utf8')) as Partial<Record<DependencyDomain, unknown>>
      const dependencyId = views[domain]
      if (typeof dependencyId === 'string' && /^[0-9a-f]{64}$/.test(dependencyId)) active.push(dependencyId)
    } catch { /* The active snapshot may not have materialized this dependency domain yet. */ }
  }
  return active
}

function computeDependencyViewId(options: {
  sourceRoot: string
  domain: DependencyDomain
  toolchain: string
  installArguments: string[]
  identityPaths: string[]
}): string {
  const hash = createHash('sha256')
  hash.update(`mortise-dependency-view:${DEPENDENCY_VIEW_SCHEMA_VERSION}\0${options.domain}\0${process.platform}\0${process.arch}\0`)
  hash.update(`toolchain\0${options.toolchain}\0`)
  for (const argument of options.installArguments) hash.update(`argument\0${argument}\0`)
  for (const path of [...options.identityPaths].sort()) {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Dependency identity input is missing: ${path}`)
    hash.update(`input\0${relative(options.sourceRoot, path).replaceAll('\\', '/')}\0`)
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function dependencyToolchainIdentity(command: string, versionArguments: string[]): string {
  const result = spawnSync(command, versionArguments, { encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Unable to identify dependency toolchain ${command}.`)
  const resolvedCommand = isAbsolute(command) && existsSync(command)
    ? `${resolve(command)}:${createHash('sha256').update(readFileSync(command)).digest('hex')}`
    : command
  return `${resolvedCommand}:${result.stdout.trim()}`
}

function readDependencyViewManifest(
  viewRoot: string,
  domain: DependencyDomain,
  dependencyId: string,
): DependencyViewManifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(viewRoot, 'dependency-view.json'), 'utf8')) as DependencyViewManifest
    if (
      manifest.schemaVersion !== DEPENDENCY_VIEW_SCHEMA_VERSION
      || manifest.dependencyId !== dependencyId
      || manifest.domain !== domain
      || manifest.platform !== process.platform
      || manifest.arch !== process.arch
      || manifest.sealed !== true
      || !Array.isArray(manifest.roots)
      || !Array.isArray(manifest.sourceLinks)
    ) return undefined
    for (const root of manifest.roots) {
      if (!isSafeRelativePath(root)) return undefined
      if (!existsSync(join(viewRoot, 'tree', ...root.split('/')))) return undefined
    }
    for (const link of manifest.sourceLinks) {
      if (!isSafeRelativePath(link.path) || !isSafeRelativePath(link.target)) return undefined
    }
    return manifest
  } catch {
    return undefined
  }
}

function moveDependencyRootsIntoView(sourceRoot: string, stagingRoot: string, roots: string[]): string[] {
  const moved: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    const relativePath = relative(sourceRoot, root).replaceAll('\\', '/')
    const destination = join(stagingRoot, 'tree', ...relativePath.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(root, destination)
    moved.push(relativePath)
  }
  if (moved.length === 0) throw new Error('Frozen dependency installation produced no dependency roots.')
  return moved.sort()
}

function detachSourceDependencyLinks(sourceRoot: string, dependencyRoots: string[]): DependencyViewLink[] {
  const links: DependencyViewLink[] = []
  for (const dependencies of dependencyRoots) {
    if (!existsSync(dependencies)) continue
    for (const packageRoot of dependencyPackageRoots(dependencies)) {
      if (!lstatSync(packageRoot).isSymbolicLink()) continue
      const target = realpathSync(packageRoot)
      if (!isWithin(sourceRoot, target)) {
        throw new Error(`Installed dependency link escapes the source snapshot: ${packageRoot} -> ${target}`)
      }
      links.push({
        path: relative(sourceRoot, packageRoot).replaceAll('\\', '/'),
        target: relative(sourceRoot, target).replaceAll('\\', '/'),
      })
      rmSync(packageRoot, { recursive: true, force: true })
    }
  }
  return links.sort((a, b) => a.path.localeCompare(b.path))
}

function materializeDependencyView(sourceRoot: string, viewRoot: string, manifest: DependencyViewManifest): void {
  for (const relativeRoot of manifest.roots) {
    const cachedRoot = join(viewRoot, 'tree', ...relativeRoot.split('/'))
    const destinationRoot = join(sourceRoot, ...relativeRoot.split('/'))
    removeDirectory(destinationRoot)
    mkdirSync(destinationRoot, { recursive: true })
    for (const entry of readdirSync(cachedRoot, { withFileTypes: true })) {
      materializeDependencyEntry(join(cachedRoot, entry.name), join(destinationRoot, entry.name), entry.name.startsWith('@'))
    }
  }
  for (const link of manifest.sourceLinks) {
    const linkPath = join(sourceRoot, ...link.path.split('/'))
    const targetPath = join(sourceRoot, ...link.target.split('/'))
    mkdirSync(dirname(linkPath), { recursive: true })
    symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }
  recordMaterializedDependencyView(sourceRoot, manifest.domain, manifest.dependencyId)
}

function materializeDependencyEntry(source: string, destination: string, expandDirectory = false): void {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(source)
    if (isAbsolute(target)) throw new Error(`Cached dependency symlink must be relative: ${source} -> ${target}`)
    const type = process.platform === 'win32'
      ? statSync(realpathSync(source)).isDirectory() ? 'junction' : 'file'
      : undefined
    symlinkSync(target, destination, type)
    return
  }
  if (stat.isFile()) {
    try {
      linkSync(source, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      cpSync(source, destination, { force: true })
    }
    return
  }
  if (stat.isDirectory()) {
    if (!expandDirectory) {
      symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
      return
    }
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      materializeDependencyEntry(join(source, entry.name), join(destination, entry.name))
    }
    return
  }
  throw new Error(`Cached dependency view must contain only files and directories: ${source}`)
}

function recordMaterializedDependencyView(sourceRoot: string, domain: DependencyDomain, dependencyId: string): void {
  const path = join(sourceRoot, MATERIALIZED_DEPENDENCY_VIEWS)
  let views: Partial<Record<DependencyDomain, string>> = {}
  try { views = JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<DependencyDomain, string>> } catch { /* First dependency domain. */ }
  views[domain] = dependencyId
  writeFileSync(path, `${JSON.stringify(views, null, 2)}\n`, 'utf8')
}

function rootDependencyIdentityPaths(sourceRoot: string): string[] {
  return [
    join(sourceRoot, 'package.json'),
    join(sourceRoot, 'bun.lock'),
    join(sourceRoot, 'bunfig.toml'),
    ...workspaceManifestPaths(sourceRoot).map(path => join(sourceRoot, ...path.split('/'))),
  ].filter(existsSync)
}

function piDependencyIdentityPaths(sourceRoot: string): string[] {
  const piRoot = join(sourceRoot, PI_DEPENDENCY_ROOT)
  return [
    join(piRoot, 'package-lock.json'),
    join(piRoot, '.npmrc'),
    ...piWorkspaceRoots(sourceRoot).map(root => join(root, 'package.json')),
  ].filter(existsSync)
}

function rootDependencyRoots(sourceRoot: string): string[] {
  return rootWorkspaceRoots(sourceRoot).map(root => join(root, 'node_modules'))
}

function piDependencyRoots(sourceRoot: string): string[] {
  return piWorkspaceRoots(sourceRoot).map(root => join(root, 'node_modules'))
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
  options: { timeoutMs?: number; bunExecutable?: string } = {},
): void {
  const timeoutMs = options.timeoutMs ?? BUILD_DEPENDENCY_INSTALL_TIMEOUT_MS
  const startedAt = Date.now()
  process.stdout.write(`[build-source] Preparing ${label}...\n`)
  const result = spawnSync(command, args, {
    cwd,
    env: frozenDependencyInstallEnvironment(process.env, options.bunExecutable),
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

function frozenDependencyInstallEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  bunExecutable: string | undefined,
): NodeJS.ProcessEnv {
  const inheritedPath = Object.entries(baseEnv)
    .find(([name]) => name.toLowerCase() === 'path')?.[1]
  const envWithoutPath = Object.fromEntries(
    Object.entries(baseEnv).filter(([name]) => name.toLowerCase() !== 'path'),
  )
  return {
    ...envWithoutPath,
    ...(bunExecutable
      ? { PATH: [dirname(bunExecutable), inheritedPath].filter(Boolean).join(delimiter) }
      : inheritedPath ? { PATH: inheritedPath } : {}),
    HUSKY: '0',
  }
}

export function assertFrozenDependencyViewsContained(sourceRootValue: string, scratchRootValue?: string): void {
  const sourceRoot = realpathSync(sourceRootValue)
  const dependencyCacheRoot = scratchRootValue && existsSync(join(scratchRootValue, 'dependency-cache', 'views'))
    ? realpathSync(join(scratchRootValue, 'dependency-cache', 'views'))
    : undefined
  for (const workspaceRoot of workspaceRoots(sourceRoot)) {
    const dependencies = join(workspaceRoot, 'node_modules')
    if (!existsSync(dependencies)) continue
    for (const packageRoot of dependencyPackageRoots(dependencies)) {
      const target = realpathSync(packageRoot)
      if (!isWithin(sourceRoot, target) && (!dependencyCacheRoot || !isWithin(dependencyCacheRoot, target))) {
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

export function workspaceManifestPaths(repoRoot: string): string[] {
  return workspaceRoots(repoRoot)
    .map(root => relative(repoRoot, join(root, 'package.json')).replaceAll('\\', '/'))
    .filter(path => path !== 'package.json' && existsSync(join(repoRoot, ...path.split('/'))))
}

function workspaceRoots(repoRoot: string): string[] {
  return [...rootWorkspaceRoots(repoRoot), ...piWorkspaceRoots(repoRoot)]
}

function rootWorkspaceRoots(repoRoot: string): string[] {
  const roots = [repoRoot].filter(path => existsSync(join(path, 'package.json')))
  for (const group of [join(repoRoot, 'apps'), join(repoRoot, 'packages')]) {
    if (!existsSync(group)) continue
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(group, entry.name, 'package.json'))) roots.push(join(group, entry.name))
    }
  }
  return roots
}

function piWorkspaceRoots(repoRoot: string): string[] {
  const roots = [join(repoRoot, PI_DEPENDENCY_ROOT)].filter(path => existsSync(join(path, 'package.json')))
  const group = join(repoRoot, PI_DEPENDENCY_ROOT, 'packages')
  if (existsSync(group)) {
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

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false
  const normalized = path.replaceAll('\\', '/')
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../')
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

function removeDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
