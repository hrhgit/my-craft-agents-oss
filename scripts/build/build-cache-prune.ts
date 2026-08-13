import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cleanupElectronBuildCache } from './electron-build-cache.ts'

const DEFAULT_BLOCKS_RETAIN_COUNT = 3
const DEFAULT_PACKAGES_RETAIN_COUNT = 2
const DEFAULT_BUILDS_RETAIN_COUNT = 2
// Keep in sync with electron-build-cache DEFAULT_MAX_BYTES so mode-grouped
// build retention (production/development/ui-validation) is not defeated by
// the prune byte budget.
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024 * 1024

export interface CachePruneTarget {
  path: string
  kind: 'staging' | 'identity'
  sizeBytes: number
}

export interface CachePrunePlan {
  targets: CachePruneTarget[]
  retained: string[]
}

export interface BuildCachePruneOptions {
  repoRoot?: string
  dryRun?: boolean
  blocksRetain?: number
  packagesRetain?: number
  buildsRetain?: number
  maxBytes?: number
}

export interface BuildCachePruneSummary {
  dryRun: boolean
  blocks: CachePrunePlan
  packages: CachePrunePlan
  builds: {
    retainedBuildIds: string[]
    removedBuildIds: string[]
    skippedInDryRun: boolean
  }
}

function isStagingDirectoryName(name: string): boolean {
  return name.startsWith('.staging-') || name.includes('.staging-')
}

function readCreatedAt(manifestPath: string): number | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { createdAt?: unknown }
    if (typeof manifest.createdAt !== 'string') return undefined
    const timestamp = Date.parse(manifest.createdAt)
    return Number.isFinite(timestamp) ? timestamp : undefined
  } catch {
    return undefined
  }
}

function directorySize(path: string): number {
  let total = 0
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = join(current, entry.name)
      if (entry.isDirectory()) {
        visit(target)
      } else if (entry.isFile()) {
        try {
          total += statSync(target).size
        } catch {
          // A completing build may have removed it concurrently.
        }
      }
    }
  }
  try {
    visit(path)
  } catch {
    // A concurrent build may have removed the directory entirely.
  }
  return total
}

function planIdentityCleanup(
  root: string,
  retainCount: number,
  manifestName: string,
  protect: ReadonlySet<string>,
): CachePrunePlan {
  const plan: CachePrunePlan = { targets: [], retained: [] }
  if (!existsSync(root)) return plan

  const entries = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const path = join(root, entry.name)
      const createdAt = readCreatedAt(join(path, manifestName))
      const mtime = statSync(path).mtimeMs
      return { name: entry.name, path, createdAt, mtime }
    })

  const staging = entries.filter(entry => isStagingDirectoryName(entry.name))
  for (const entry of staging) {
    plan.targets.push({ path: entry.path, kind: 'staging', sizeBytes: directorySize(entry.path) })
  }

  const identities = entries
    .filter(entry => !isStagingDirectoryName(entry.name))
    .sort((a, b) => (b.createdAt ?? b.mtime) - (a.createdAt ?? a.mtime))

  const protectedEntries = identities.filter(entry => protect.has(entry.name))
  const recyclable = identities.filter(entry => !protect.has(entry.name))
  for (const entry of recyclable.slice(Math.max(0, retainCount))) {
    plan.targets.push({ path: entry.path, kind: 'identity', sizeBytes: directorySize(entry.path) })
  }
  plan.retained = [...protectedEntries, ...recyclable.slice(0, Math.max(0, retainCount))].map(entry => entry.name)
  return plan
}

export function planBuildBlockCleanup(buildRoot: string, retainCount = DEFAULT_BLOCKS_RETAIN_COUNT): CachePrunePlan {
  const blocksRoot = join(resolve(buildRoot), 'blocks')
  if (!existsSync(blocksRoot)) return { targets: [], retained: [] }

  const lockedByType = new Map<string, Set<string>>()
  const locksRoot = join(blocksRoot, 'locks')
  if (existsSync(locksRoot)) {
    for (const entry of readdirSync(locksRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const match = /^(.*)-([0-9a-f]{64})$/.exec(entry.name)
      if (!match) continue
      const type = match[1]!
      const blockId = match[2]!
      const locked = lockedByType.get(type) ?? new Set<string>()
      locked.add(blockId)
      lockedByType.set(type, locked)
    }
  }

  const combined: CachePrunePlan = { targets: [], retained: [] }
  for (const typeEntry of readdirSync(blocksRoot, { withFileTypes: true })) {
    if (!typeEntry.isDirectory() || typeEntry.name === 'locks') continue
    const typePlan = planIdentityCleanup(
      join(blocksRoot, typeEntry.name),
      retainCount,
      'block.json',
      lockedByType.get(typeEntry.name) ?? new Set<string>(),
    )
    combined.targets.push(...typePlan.targets)
    combined.retained.push(...typePlan.retained.map(name => `${typeEntry.name}/${name}`))
  }
  return combined
}

export function planPackageArtifactCleanup(
  cacheRoot: string,
  retainCount = DEFAULT_PACKAGES_RETAIN_COUNT,
): CachePrunePlan {
  const buildsRoot = join(resolve(cacheRoot), 'builds')
  const protect = new Set<string>()
  const locksRoot = join(resolve(cacheRoot), 'locks')
  if (existsSync(locksRoot)) {
    for (const entry of readdirSync(locksRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) protect.add(entry.name)
    }
  }
  return planIdentityCleanup(buildsRoot, retainCount, 'package.json', protect)
}

export function applyCachePrunePlan(plan: CachePrunePlan): string[] {
  const removed: string[] = []
  for (const target of plan.targets) {
    try {
      rmSync(target.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      removed.push(target.path)
    } catch {
      // A concurrent build may have already removed it.
    }
  }
  return removed
}

export function pruneBuildCaches(options: BuildCachePruneOptions = {}): BuildCachePruneSummary {
  const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dir, '..', '..'))
  const outputRoot = join(repoRoot, 'output')
  const dryRun = options.dryRun ?? true
  const blocksRetain = nonNegativeInteger(options.blocksRetain, DEFAULT_BLOCKS_RETAIN_COUNT)
  const packagesRetain = nonNegativeInteger(options.packagesRetain, DEFAULT_PACKAGES_RETAIN_COUNT)
  const buildsRetain = nonNegativeInteger(options.buildsRetain, DEFAULT_BUILDS_RETAIN_COUNT)
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES)

  const blocks = planBuildBlockCleanup(join(outputRoot, 'electron-builds'), blocksRetain)
  const packages = planPackageArtifactCleanup(join(outputRoot, 'electron-package-cache'), packagesRetain)
  if (!dryRun) {
    applyCachePrunePlan(blocks)
    applyCachePrunePlan(packages)
  }

  const cleanup = dryRun
    ? { retainedBuildIds: [] as string[], removedBuildIds: [] as string[] }
    : cleanupElectronBuildCache({
        buildRoot: join(outputRoot, 'electron-builds'),
        retainCount: buildsRetain,
        maxBytes,
      })

  return {
    dryRun,
    blocks,
    packages,
    builds: {
      retainedBuildIds: cleanup.retainedBuildIds,
      removedBuildIds: cleanup.removedBuildIds,
      skippedInDryRun: dryRun,
    },
  }
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback
}
