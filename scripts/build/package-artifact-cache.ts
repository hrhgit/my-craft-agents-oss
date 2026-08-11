import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { withFileLock } from './file-lock.ts'
import { writeJsonAtomic } from './files.ts'

export const PACKAGE_ARTIFACT_CACHE_SCHEMA_VERSION = 1
export const PACKAGE_ARTIFACT_CACHE_PRODUCER_VERSION = 'mortise-package-artifacts-v2'

export type PackageArtifactCacheVerification = 'fast' | 'strict'

export interface PackageArtifactIdentity {
  electronBuildId: string
  developerKitBuildId?: string
  target: 'win' | 'mac' | 'linux'
  arch: string
  mode: 'production' | 'development'
  builderConfigSha256: string
  builderToolchainId: string
  signingMode: 'unsigned'
  publicationMode: 'local-only'
}

export interface PackageArtifactEntry {
  path: string
  type: 'file' | 'symlink'
  sizeBytes: number
  sha256: string
}

export interface PackageArtifactManifest extends PackageArtifactIdentity {
  schemaVersion: typeof PACKAGE_ARTIFACT_CACHE_SCHEMA_VERSION
  producerVersion: typeof PACKAGE_ARTIFACT_CACHE_PRODUCER_VERSION
  packageId: string
  createdAt: string
  sizeBytes: number
  artifacts: PackageArtifactEntry[]
  immutable: true
}

export interface PackageArtifactCachePolicy {
  enabled: boolean
  signingMode?: 'unsigned'
  publicationMode?: 'local-only'
  reason?: string
}

const SIGNING_ENVIRONMENT_KEYS = [
  'CSC_LINK',
  'WIN_CSC_LINK',
  'CSC_NAME',
  'CSC_KEY_PASSWORD',
  'WIN_CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'MORTISE_REQUIRE_CODE_SIGNING',
] as const

const PUBLICATION_ENVIRONMENT_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'EP_DRAFT',
  'EP_PRE_RELEASE',
] as const

export function resolvePackageArtifactCachePolicy(options: {
  target: PackageArtifactIdentity['target']
  builderConfigContent: string
  environment?: NodeJS.ProcessEnv
}): PackageArtifactCachePolicy {
  const environment = options.environment ?? process.env
  const signingEnvironmentKey = SIGNING_ENVIRONMENT_KEYS.find(key => key === 'MORTISE_REQUIRE_CODE_SIGNING'
    ? hasEnabledFlag(environment[key])
    : hasNonEmptyValue(environment[key]))
  if (signingEnvironmentKey) {
    return { enabled: false, reason: `signing environment ${signingEnvironmentKey} has no stable cache identity` }
  }
  const publicationEnvironmentKey = PUBLICATION_ENVIRONMENT_KEYS.find(key => key === 'GH_TOKEN' || key === 'GITHUB_TOKEN'
    ? hasNonEmptyValue(environment[key])
    : hasEnabledFlag(environment[key]))
  if (publicationEnvironmentKey) {
    return { enabled: false, reason: `publication environment ${publicationEnvironmentKey} has no stable cache identity` }
  }
  if (options.target === 'mac' && String(environment.CSC_IDENTITY_AUTO_DISCOVERY ?? '').toLowerCase() !== 'false') {
    return { enabled: false, reason: 'macOS signing identity auto-discovery is enabled' }
  }

  let config: unknown
  try {
    config = load(options.builderConfigContent)
  } catch {
    return { enabled: false, reason: 'electron-builder configuration could not be parsed for signing and publication policy' }
  }
  const unstableConfigKey = findUnstableConfigurationKey(config)
  if (unstableConfigKey) {
    return { enabled: false, reason: `electron-builder configuration ${unstableConfigKey} has no stable cache identity` }
  }
  return { enabled: true, signingMode: 'unsigned', publicationMode: 'local-only' }
}

export function computePackageArtifactIdentity(options: {
  electronBuildId: string
  developerKitBuildId?: string
  target: PackageArtifactIdentity['target']
  arch: string
  mode: PackageArtifactIdentity['mode']
  builderConfigContent: string
  builderToolchainId: string
  policy: PackageArtifactCachePolicy
}): PackageArtifactIdentity {
  if (!options.policy.enabled || !options.policy.signingMode || !options.policy.publicationMode) {
    throw new Error('Package artifact identity requires an enabled stable cache policy.')
  }
  for (const [name, value] of [
    ['Electron build', options.electronBuildId],
    ...(options.developerKitBuildId ? [['Developer Kit build', options.developerKitBuildId] as const] : []),
    ['builder toolchain', options.builderToolchainId],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} identity must be a lowercase SHA-256.`)
  }
  return {
    electronBuildId: options.electronBuildId,
    ...(options.developerKitBuildId ? { developerKitBuildId: options.developerKitBuildId } : {}),
    target: options.target,
    arch: options.arch,
    mode: options.mode,
    builderConfigSha256: sha256(options.builderConfigContent),
    builderToolchainId: options.builderToolchainId,
    signingMode: options.policy.signingMode,
    publicationMode: options.policy.publicationMode,
  }
}

export function computePackageArtifactId(identity: PackageArtifactIdentity): string {
  return sha256(
    `mortise-package-artifact:${PACKAGE_ARTIFACT_CACHE_SCHEMA_VERSION}\0${PACKAGE_ARTIFACT_CACHE_PRODUCER_VERSION}\0${stableIdentity(identity)}\0`,
  )
}

export function computeElectronBuilderToolchainId(repoRootValue: string, bunExecutableSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(bunExecutableSha256)) {
    throw new Error('Electron builder toolchain identity requires a canonical Bun executable SHA-256.')
  }
  const repoRoot = resolve(repoRootValue)
  const packageManifest = readFileSync(join(repoRoot, 'package.json'))
  const lockfile = readFileSync(join(repoRoot, 'bun.lock'))
  return sha256(Buffer.concat([
    Buffer.from(`mortise-electron-builder-toolchain:${PACKAGE_ARTIFACT_CACHE_SCHEMA_VERSION}\0${bunExecutableSha256}\0`),
    packageManifest,
    Buffer.from('\0'),
    lockfile,
  ]))
}

export function readValidPackageArtifactManifest(
  cacheRootValue: string,
  packageId: string,
  verification: PackageArtifactCacheVerification = 'fast',
): PackageArtifactManifest | undefined {
  const cacheRoot = resolve(cacheRootValue)
  return readManifest(join(cacheRoot, 'builds', packageId), packageId, verification)
}

export function publishPackageArtifactCache(options: {
  cacheRoot: string
  identity: PackageArtifactIdentity
  sourceDir: string
  consumeSource?: boolean
}): PackageArtifactManifest {
  const cacheRoot = resolve(options.cacheRoot)
  const sourceDir = resolve(options.sourceDir)
  const packageId = computePackageArtifactId(options.identity)
  const buildDir = join(cacheRoot, 'builds', packageId)
  const lockPath = join(cacheRoot, 'locks', packageId)
  mkdirSync(dirname(lockPath), { recursive: true })
  return withFileLock(lockPath, () => {
    const existing = readManifest(buildDir, packageId, 'strict')
    if (existing && identitiesEqual(existing, options.identity)) return existing
    rmSync(buildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    const stagingDir = join(cacheRoot, 'builds', `.staging-${packageId.slice(0, 12)}-${process.pid}-${randomUUID().slice(0, 8)}`)
    rmSync(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    let sourceMoved = false
    let sourceCopied = false
    try {
      const artifactsDir = join(stagingDir, 'artifacts')
      mkdirSync(stagingDir, { recursive: true })
      if (options.consumeSource) {
        try {
          renameDirectoryWithRetry(sourceDir, artifactsDir)
          sourceMoved = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
          cpSync(sourceDir, artifactsDir, { recursive: true, force: true, dereference: false })
          sourceCopied = true
        }
      } else {
        cpSync(sourceDir, artifactsDir, { recursive: true, force: true, dereference: false })
      }
      const artifacts = collectArtifacts(artifactsDir)
      if (artifacts.length === 0) throw new Error(`Electron package output is missing or empty: ${sourceDir}`)
      const manifest: PackageArtifactManifest = {
        schemaVersion: PACKAGE_ARTIFACT_CACHE_SCHEMA_VERSION,
        producerVersion: PACKAGE_ARTIFACT_CACHE_PRODUCER_VERSION,
        packageId,
        ...options.identity,
        createdAt: new Date().toISOString(),
        sizeBytes: artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0),
        artifacts,
        immutable: true,
      }
      writeJsonAtomic(join(stagingDir, 'package.json'), manifest)
      renameDirectoryWithRetry(stagingDir, buildDir)
      if (sourceCopied) rmSync(sourceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      return manifest
    } catch (error) {
      if (sourceMoved && !existsSync(sourceDir) && existsSync(join(stagingDir, 'artifacts'))) {
        renameDirectoryWithRetry(join(stagingDir, 'artifacts'), sourceDir)
      }
      throw error
    } finally {
      rmSync(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, { timeoutMs: 10 * 60 * 1_000, staleMs: 10 * 60 * 1_000 })
}

export function materializePackageArtifactCache(options: {
  cacheRoot: string
  packageId: string
  destinationDir: string
  verification?: PackageArtifactCacheVerification
}): PackageArtifactManifest {
  const cacheRoot = resolve(options.cacheRoot)
  const manifest = readValidPackageArtifactManifest(cacheRoot, options.packageId, options.verification ?? 'fast')
  if (!manifest) throw new Error(`Package artifact cache ${options.packageId.slice(0, 12)} is missing or invalid.`)
  const destinationDir = resolve(options.destinationDir)
  rmSync(destinationDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  mkdirSync(dirname(destinationDir), { recursive: true })
  cpSync(join(cacheRoot, 'builds', options.packageId, 'artifacts'), destinationDir, {
    recursive: true,
    force: true,
    dereference: false,
  })
  return manifest
}

function readManifest(
  buildDir: string,
  packageId: string,
  verification: PackageArtifactCacheVerification,
): PackageArtifactManifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(buildDir, 'package.json'), 'utf8')) as PackageArtifactManifest
    if (
      manifest.schemaVersion !== PACKAGE_ARTIFACT_CACHE_SCHEMA_VERSION
      || manifest.producerVersion !== PACKAGE_ARTIFACT_CACHE_PRODUCER_VERSION
      || manifest.packageId !== packageId
      || computePackageArtifactId(manifest) !== packageId
      || !isValidIdentity(manifest)
      || manifest.immutable !== true
      || !Array.isArray(manifest.artifacts)
      || manifest.sizeBytes !== manifest.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0)
    ) return undefined
    const artifactsRoot = join(buildDir, 'artifacts')
    for (const artifact of manifest.artifacts) {
      if (!isValidArtifactEntry(artifact)) return undefined
      const artifactPath = join(artifactsRoot, ...artifact.path.split('/'))
      const stat = lstatSync(artifactPath)
      if (artifact.type === 'file') {
        if (!stat.isFile() || stat.size !== artifact.sizeBytes) return undefined
        if (verification === 'strict' && sha256(readFileSync(artifactPath)) !== artifact.sha256) return undefined
      } else {
        if (!stat.isSymbolicLink()) return undefined
        const target = readlinkSync(artifactPath)
        if (Buffer.byteLength(target) !== artifact.sizeBytes) return undefined
        if (verification === 'strict' && sha256(target) !== artifact.sha256) return undefined
      }
    }
    if (verification === 'strict' && !artifactListsEqual(manifest.artifacts, collectArtifacts(artifactsRoot))) return undefined
    return manifest
  } catch {
    return undefined
  }
}

function collectArtifacts(root: string): PackageArtifactEntry[] {
  const artifacts: PackageArtifactEntry[] = []
  collectArtifactPath(root, '', artifacts)
  return artifacts.sort((a, b) => a.path.localeCompare(b.path))
}

function collectArtifactPath(path: string, relativePath: string, artifacts: PackageArtifactEntry[]): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path)
    artifacts.push({ path: normalizePath(relativePath), type: 'symlink', sizeBytes: Buffer.byteLength(target), sha256: sha256(target) })
    return
  }
  if (stat.isFile()) {
    artifacts.push({ path: normalizePath(relativePath), type: 'file', sizeBytes: stat.size, sha256: sha256(readFileSync(path)) })
    return
  }
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    collectArtifactPath(join(path, entry.name), relativePath ? `${relativePath}/${entry.name}` : entry.name, artifacts)
  }
}

function findUnstableConfigurationKey(value: unknown, path = ''): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key
    const normalizedKey = key.toLowerCase()
    if (
      normalizedKey !== 'aftersign'
      && /(?:publish|notar|identity|certificate|csc|forcecodesigning|signtool|signinghash|^sign$)/.test(normalizedKey)
      && configurationValueEnabled(child)
    ) return childPath
    const nested = findUnstableConfigurationKey(child, childPath)
    if (nested) return nested
  }
  return undefined
}

function configurationValueEnabled(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  return true
}

function identitiesEqual(manifest: PackageArtifactManifest, identity: PackageArtifactIdentity): boolean {
  return stableIdentity(manifest) === stableIdentity(identity)
}

function stableIdentity(identity: PackageArtifactIdentity): string {
  return JSON.stringify({
    electronBuildId: identity.electronBuildId,
    developerKitBuildId: identity.developerKitBuildId ?? null,
    target: identity.target,
    arch: identity.arch,
    mode: identity.mode,
    builderConfigSha256: identity.builderConfigSha256,
    builderToolchainId: identity.builderToolchainId,
    signingMode: identity.signingMode,
    publicationMode: identity.publicationMode,
  })
}

function artifactListsEqual(left: PackageArtifactEntry[], right: PackageArtifactEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isValidArtifactEntry(value: PackageArtifactEntry): boolean {
  return typeof value.path === 'string'
    && value.path !== ''
    && !value.path.startsWith('/')
    && !value.path.split('/').includes('..')
    && (value.type === 'file' || value.type === 'symlink')
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes >= 0
    && /^[0-9a-f]{64}$/.test(value.sha256)
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
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

function isValidIdentity(value: PackageArtifactIdentity): boolean {
  return /^[0-9a-f]{64}$/.test(value.electronBuildId)
    && (value.developerKitBuildId === undefined || /^[0-9a-f]{64}$/.test(value.developerKitBuildId))
    && ['win', 'mac', 'linux'].includes(value.target)
    && typeof value.arch === 'string'
    && value.arch !== ''
    && (value.mode === 'production' || value.mode === 'development')
    && /^[0-9a-f]{64}$/.test(value.builderConfigSha256)
    && /^[0-9a-f]{64}$/.test(value.builderToolchainId)
    && value.signingMode === 'unsigned'
    && value.publicationMode === 'local-only'
}

function hasNonEmptyValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function hasEnabledFlag(value: string | undefined): boolean {
  return hasNonEmptyValue(value) && !['0', 'false', 'no', 'off'].includes(value!.trim().toLowerCase())
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
