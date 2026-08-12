import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { withFileLock } from './file-lock.ts'
import type { BuildBlockSpec } from './build-inputs.ts'

export const BUILD_BLOCK_SCHEMA_VERSION = 1
export const BUILD_BLOCK_PRODUCER_VERSION = 'mortise-build-blocks-v1'

const BLOCK_PUBLISH_RENAME_ATTEMPTS = 12
const BLOCK_PUBLISH_RENAME_BASE_DELAY_MS = 25
const BLOCK_PUBLISH_RENAME_MAX_DELAY_MS = 250

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Publish a built block by renaming its staging directory into place. On Windows a
 * transient handle on freshly written outputs (antivirus scan, indexer) makes the
 * rename fail with EPERM/EACCES/EBUSY; retry with backoff so the build survives the
 * transient lock. A leftover destination is cleared before retrying (the caller holds
 * the block lock, so no other publisher can own it). Persistent locks and a vanished
 * staging directory still fail the build.
 */
export function publishBlockDirectory(
  stagingDir: string,
  blockDir: string,
  rename: (source: string, destination: string) => void = renameSync,
): void {
  for (let attempt = 1; attempt <= BLOCK_PUBLISH_RENAME_ATTEMPTS; attempt += 1) {
    try {
      rename(stagingDir, blockDir)
      return
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw error
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '') || attempt === BLOCK_PUBLISH_RENAME_ATTEMPTS) throw error
      try {
        if (existsSync(blockDir)) removeDirectory(blockDir)
      } catch {
        // Stale-destination cleanup is best-effort; the next attempt will re-check.
      }
      sleepSync(Math.min(BLOCK_PUBLISH_RENAME_MAX_DELAY_MS, BLOCK_PUBLISH_RENAME_BASE_DELAY_MS * 2 ** (attempt - 1)))
    }
  }
}

export interface BuildBlockArtifact {
  path: string
  sizeBytes: number
  sha256: string
}

export interface BuildBlockManifest {
  schemaVersion: typeof BUILD_BLOCK_SCHEMA_VERSION
  producerVersion: typeof BUILD_BLOCK_PRODUCER_VERSION
  blockName: string
  blockId: string
  inputId: string
  dependencyIds: string[]
  toolchain: string
  mode: string
  platform: string
  arch: string
  outputPaths: string[]
  outputs: BuildBlockArtifact[]
  sealed: true
  createdAt: string
}

export interface BuildBlockContext {
  sourceRoot: string
  buildRoot: string
  mode: string
  toolchain: string
  inputHashCache?: Map<string, string>
  verify?: 'fast' | 'strict'
}

export interface RunBuildBlockOptions {
  context: BuildBlockContext
  spec: BuildBlockSpec
  dependencyIds?: readonly string[]
  build: () => void
}

export interface RunBuildBlockResult {
  manifest: BuildBlockManifest
  reused: boolean
}

export function runBuildBlock(options: RunBuildBlockOptions): RunBuildBlockResult {
  const { context, spec } = options
  const dependencyIds = [...(options.dependencyIds ?? [])]
  const inputId = computeBuildBlockInputId(context, spec, dependencyIds)
  const blockId = computeBuildBlockId(context, spec, inputId, dependencyIds)
  const blockRoot = join(resolve(context.buildRoot), 'blocks', spec.id)
  const blockDir = join(blockRoot, blockId)
  const lockPath = join(resolve(context.buildRoot), 'blocks', 'locks', `${spec.id}-${blockId}`)
  mkdirSync(blockRoot, { recursive: true })
  mkdirSync(dirname(lockPath), { recursive: true })

  return withFileLock(lockPath, () => {
    const existing = readBlockManifest(blockDir, context, spec, blockId, inputId, dependencyIds, context.verify ?? 'fast')
    if (existing) {
      restoreBlockOutputs(existing, blockDir, context.sourceRoot)
      return { manifest: existing, reused: true }
    }

    removeDirectory(blockDir)
    const stagingDir = `${blockDir}.staging-${process.pid}-${Date.now()}`
    removeDirectory(stagingDir)
    mkdirSync(join(stagingDir, 'outputs'), { recursive: true })
    try {
      options.build()
      const artifacts = captureBlockOutputs(context.sourceRoot, stagingDir, spec.outputPaths)
      const manifest: BuildBlockManifest = {
        schemaVersion: BUILD_BLOCK_SCHEMA_VERSION,
        producerVersion: BUILD_BLOCK_PRODUCER_VERSION,
        blockName: spec.id,
        blockId,
        inputId,
        dependencyIds,
        toolchain: context.toolchain,
        mode: context.mode,
        platform: spec.platformSensitive ? process.platform : 'any',
        arch: spec.platformSensitive ? process.arch : 'any',
        outputPaths: [...spec.outputPaths],
        outputs: artifacts,
        sealed: true,
        createdAt: new Date().toISOString(),
      }
      writeFileSync(join(stagingDir, 'block.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      mkdirSync(dirname(blockDir), { recursive: true })
      publishBlockDirectory(stagingDir, blockDir)
      return { manifest, reused: false }
    } finally {
      removeDirectory(stagingDir)
    }
  }, { timeoutMs: 600_000, staleMs: 600_000 })
}

export function computeBuildBlockInputId(
  context: BuildBlockContext,
  spec: BuildBlockSpec,
  dependencyIds: readonly string[] = [],
): string {
  const hash = createHash('sha256')
  hash.update(`mortise-build-block-input:${BUILD_BLOCK_SCHEMA_VERSION}\0${spec.id}\0${spec.builder}\0`)
  for (const inputPath of [...spec.inputPaths].sort()) {
    const absolute = join(context.sourceRoot, ...inputPath.split('/'))
    if (!existsSync(absolute)) throw new Error(`Build block ${spec.id} input is missing: ${inputPath}`)
    const contentId = context.inputHashCache?.get(inputPath) ?? hashPathContent(absolute)
    context.inputHashCache?.set(inputPath, contentId)
    hash.update(`input\0${inputPath}\0${contentId}\0`)
  }
  for (const dependencyId of [...dependencyIds].sort()) hash.update(`dependency\0${dependencyId}\0`)
  return hash.digest('hex')
}

export function computeBuildBlockId(
  context: BuildBlockContext,
  spec: BuildBlockSpec,
  inputId: string,
  dependencyIds: readonly string[],
): string {
  const hash = createHash('sha256')
  hash.update(`mortise-build-block:${BUILD_BLOCK_SCHEMA_VERSION}\0${spec.id}\0${spec.builder}\0${inputId}\0`)
  for (const dependencyId of [...dependencyIds].sort()) hash.update(`${dependencyId}\0`)
  hash.update(`${context.mode}\0${context.toolchain}\0`)
  if (spec.platformSensitive) hash.update(`${process.platform}\0${process.arch}\0`)
  return hash.digest('hex')
}

function readBlockManifest(
  blockDir: string,
  context: BuildBlockContext,
  spec: BuildBlockSpec,
  blockId: string,
  inputId: string,
  dependencyIds: readonly string[],
  verify: 'fast' | 'strict',
): BuildBlockManifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(blockDir, 'block.json'), 'utf8')) as BuildBlockManifest
    if (
      manifest.schemaVersion !== BUILD_BLOCK_SCHEMA_VERSION
      || manifest.producerVersion !== BUILD_BLOCK_PRODUCER_VERSION
      || manifest.blockName !== spec.id
      || manifest.blockId !== blockId
      || manifest.inputId !== inputId
      || JSON.stringify(manifest.dependencyIds) !== JSON.stringify([...dependencyIds])
      || manifest.toolchain !== context.toolchain
      || manifest.mode !== context.mode
      || manifest.sealed !== true
      || (spec.platformSensitive && (manifest.platform !== process.platform || manifest.arch !== process.arch))
      || (!spec.platformSensitive && (manifest.platform !== 'any' || manifest.arch !== 'any'))
      || JSON.stringify(manifest.outputPaths) !== JSON.stringify([...spec.outputPaths])
      || !Array.isArray(manifest.outputs)
    ) return undefined
    for (const artifact of manifest.outputs) {
      const target = join(blockDir, 'outputs', ...artifact.path.split('/'))
      if (!existsSync(target) || !statSync(target).isFile() || statSync(target).size !== artifact.sizeBytes) return undefined
      if (verify === 'strict' && createHash('sha256').update(readFileSync(target)).digest('hex') !== artifact.sha256) return undefined
    }
    return manifest
  } catch {
    return undefined
  }
}

function captureBlockOutputs(sourceRoot: string, stagingDir: string, outputPaths: readonly string[]): BuildBlockArtifact[] {
  const artifacts: BuildBlockArtifact[] = []
  for (const outputPath of outputPaths) {
    const source = join(sourceRoot, ...outputPath.split('/'))
    if (!existsSync(source)) throw new Error(`Build block output is missing: ${outputPath}`)
    const destination = join(stagingDir, 'outputs', ...outputPath.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, force: true, dereference: true })
    collectFiles(destination, outputPath, artifacts)
  }
  return artifacts.sort((a, b) => a.path.localeCompare(b.path))
}

function collectFiles(path: string, relativePath: string, artifacts: BuildBlockArtifact[]): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`Build block output must not contain a symbolic link: ${path}`)
  if (stat.isFile()) {
    artifacts.push({
      path: relativePath.replaceAll('\\', '/'),
      sizeBytes: stat.size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    })
    return
  }
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    collectFiles(join(path, entry.name), `${relativePath}/${entry.name}`, artifacts)
  }
}

function restoreBlockOutputs(manifest: BuildBlockManifest, blockDir: string, sourceRoot: string): void {
  const outputRoot = join(blockDir, 'outputs')
  for (const outputPath of manifest.outputPaths) {
    const source = join(outputRoot, ...outputPath.split('/'))
    const destination = join(sourceRoot, ...outputPath.split('/'))
    removeDirectory(destination)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, force: true, dereference: true })
  }
}

function hashPathContent(path: string): string {
  const hash = createHash('sha256')
  hashPath(hash, path, '')
  return hash.digest('hex')
}

function hashPath(hash: ReturnType<typeof createHash>, path: string, name: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`Build block input must not contain a symbolic link: ${path}`)
  if (stat.isFile()) {
    hash.update(`file\0${name}\0`)
    hash.update(readFileSync(path))
    hash.update('\0')
    return
  }
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    hashPath(hash, join(path, entry.name), name ? `${name}/${entry.name}` : entry.name)
  }
}

function removeDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
