import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

const repositoryRoot = resolve(import.meta.dir, '../../..')

// Explicit, finite execution budget for the whole graph scan.
//
// Bun applies a silent 5000ms per-test default when no timeout is declared. The
// full AST scan runs close enough to that ceiling (base warm p95 ~2945ms on the
// EXT-BR-02 reference host) that the accidental default can abort a healthy run
// on a slower machine. We replace it with one explicit budget set above 2x the
// recorded base warm p95 while staying finite, so genuine nonlinear growth still
// fails fast with an attributed phase/package/file instead of a silent timeout.
const SCAN_BUDGET_MS = 10_000
// Hard backstop handed to Bun so an unexpected hang still terminates the run.
// Kept above SCAN_BUDGET_MS so the descriptive budget assertion reports first.
const TEST_TIMEOUT_MS = SCAN_BUDGET_MS + 5_000

interface PhaseTiming {
  phase: string
  ms: number
}

interface SlowestEntry {
  id: string
  ms: number
}

interface PackageManifest {
  name?: string
  workspaces?: string[]
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface WorkspacePackage {
  directory: string
  relativeDirectory: string
  manifest: PackageManifest
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

async function workspacePackages(): Promise<WorkspacePackage[]> {
  const rootManifest = readJson<PackageManifest>(resolve(repositoryRoot, 'package.json'))
  const patterns = rootManifest.workspaces ?? []
  const included = patterns.filter(pattern => !pattern.startsWith('!'))
  const excluded = new Set<string>()

  for (const pattern of patterns.filter(pattern => pattern.startsWith('!'))) {
    const glob = new Bun.Glob(`${pattern.slice(1)}/package.json`)
    for await (const path of glob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
      excluded.add(dirname(path).replaceAll('\\', '/'))
    }
  }

  const directories = new Set<string>()
  for (const pattern of included) {
    const glob = new Bun.Glob(`${pattern}/package.json`)
    for await (const path of glob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
      const directory = dirname(path).replaceAll('\\', '/')
      if (!excluded.has(directory)) directories.add(directory)
    }
  }

  return [...directories].sort().map(relativeDirectory => ({
    directory: resolve(repositoryRoot, relativeDirectory),
    relativeDirectory,
    manifest: readJson<PackageManifest>(resolve(repositoryRoot, relativeDirectory, 'package.json')),
  }))
}

function dependencyNames(manifest: PackageManifest, includeDev: boolean): string[] {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
    ...(includeDev ? manifest.devDependencies : undefined),
  }).sort()
}

function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | null {
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []

  const visit = (name: string): string[] | null => {
    if (active.has(name)) {
      const start = stack.indexOf(name)
      return [...stack.slice(start), name]
    }
    if (visited.has(name)) return null

    visited.add(name)
    active.add(name)
    stack.push(name)
    for (const dependency of graph.get(name) ?? []) {
      if (!graph.has(dependency)) continue
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    stack.pop()
    active.delete(name)
    return null
  }

  for (const name of [...graph.keys()].sort()) {
    const cycle = visit(name)
    if (cycle) return cycle
  }
  return null
}

function moduleSpecifiers(source: string): string[] {
  return [...new Set(
    ts.preProcessFile(source, true, true).importedFiles.map(reference => reference.fileName),
  )]
}

async function sourceDependencyGraph(
  packages: readonly WorkspacePackage[],
): Promise<{
  graph: Map<string, string[]>
  undeclared: string[]
  slowestPackage: SlowestEntry | null
  slowestFile: SlowestEntry | null
}> {
  const packageNames = new Set(
    packages.map(pkg => pkg.manifest.name).filter((name): name is string => Boolean(name)),
  )
  const graph = new Map<string, string[]>()
  const undeclared: string[] = []
  let slowestPackage: SlowestEntry | null = null
  let slowestFile: SlowestEntry | null = null

  // Deterministic "is a slower, or equal-and-earlier-named" comparison so the
  // reported hotspot never depends on scan iteration order.
  const keepSlower = (current: SlowestEntry | null, candidate: SlowestEntry): SlowestEntry => {
    if (!current) return candidate
    if (candidate.ms > current.ms) return candidate
    if (candidate.ms === current.ms && candidate.id < current.id) return candidate
    return current
  }

  for (const pkg of packages) {
    const packageName = pkg.manifest.name
    if (!packageName) continue
    const packageStart = performance.now()
    const declared = new Set(dependencyNames(pkg.manifest, true))
    const imported = new Set<string>()
    const glob = new Bun.Glob('src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}')

    for await (const file of glob.scan({ cwd: pkg.directory, onlyFiles: true })) {
      const absoluteFile = resolve(pkg.directory, file)
      const fileId = relative(repositoryRoot, absoluteFile).replaceAll('\\', '/')
      const fileStart = performance.now()
      const source = readFileSync(absoluteFile, 'utf8')
      for (const specifier of moduleSpecifiers(source)) {
        const parts = specifier.split('/')
        const packageNameRoot = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
        const dependency = packageNames.has(packageNameRoot) ? packageNameRoot : undefined
        if (!dependency || dependency === packageName) continue
        imported.add(dependency)
        if (!declared.has(dependency)) {
          undeclared.push(`${fileId}: ${dependency}`)
        }
      }
      const fileMs = Number((performance.now() - fileStart).toFixed(2))
      slowestFile = keepSlower(slowestFile, { id: fileId, ms: fileMs })
    }
    graph.set(packageName, [...imported].sort())
    const packageMs = Number((performance.now() - packageStart).toFixed(2))
    slowestPackage = keepSlower(slowestPackage, { id: packageName, ms: packageMs })
  }

  return { graph, undeclared: undeclared.sort(), slowestPackage, slowestFile }
}

describe('workspace package graph', () => {
  test('extracts module references without treating comments or strings as imports', () => {
    const source = [
      'import "@mortise/core"',
      'export { value } from "@mortise/shared/protocol"',
      'const lazy = import("@mortise/ui")',
      'const commonJs = require("@mortise/server-core")',
      'import piAi = require("@mortise/pi-ai")',
      'type SessionTools = import("@mortise/session-tools-core").SessionTools',
      'const ignored = \'import "@mortise/not-real"\'',
      '// require("@mortise/also-not-real")',
    ].join('\n')

    expect(moduleSpecifiers(source)).toEqual([
      '@mortise/core',
      '@mortise/shared/protocol',
      '@mortise/ui',
      '@mortise/server-core',
      '@mortise/pi-ai',
      '@mortise/session-tools-core',
    ])
  })

  test('has no manifest or source-import dependency cycles', async () => {
    const timings: PhaseTiming[] = []
    const overallStart = performance.now()

    const phase = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      const start = performance.now()
      try {
        return await fn()
      } finally {
        timings.push({ phase: name, ms: Number((performance.now() - start).toFixed(2)) })
      }
    }

    const packages = await phase('load-manifests', () => workspacePackages())

    const { runtimeGraph, buildGraph } = await phase('build-manifest-graphs', () => {
      const runtime = new Map<string, string[]>()
      const build = new Map<string, string[]>()
      for (const pkg of packages) {
        if (!pkg.manifest.name) continue
        runtime.set(pkg.manifest.name, dependencyNames(pkg.manifest, false))
        build.set(pkg.manifest.name, dependencyNames(pkg.manifest, true))
      }
      return { runtimeGraph: runtime, buildGraph: build }
    })

    const source = await phase('scan-source-imports', () => sourceDependencyGraph(packages))

    const cycles = await phase('detect-cycles', () => ({
      runtime: findCycle(runtimeGraph),
      build: findCycle(buildGraph),
      source: findCycle(source.graph),
    }))

    const elapsedMs = Number((performance.now() - overallStart).toFixed(2))
    const sortedTimings = [...timings].sort((a, b) => b.ms - a.ms || a.phase.localeCompare(b.phase))

    // Always emit deterministic, sorted diagnostics so healthy and failing runs
    // both leave attributable phase/package/file evidence.
    console.error(
      `[workspace-package-graph] elapsed=${elapsedMs}ms budget=${SCAN_BUDGET_MS}ms`
      + ` phases=${JSON.stringify(sortedTimings)}`
      + ` slowestPackage=${JSON.stringify(source.slowestPackage)}`
      + ` slowestFile=${JSON.stringify(source.slowestFile)}`,
    )

    expect(packages.length).toBeGreaterThan(0)
    expect(cycles.runtime).toBeNull()
    expect(cycles.build).toBeNull()
    expect(source.undeclared).toEqual([])
    expect(cycles.source).toBeNull()

    if (elapsedMs > SCAN_BUDGET_MS) {
      const slowestPhase = sortedTimings[0]
      throw new Error(
        `workspace package graph scan exceeded ${SCAN_BUDGET_MS}ms budget: elapsed=${elapsedMs}ms;`
        + ` slowest phase=${slowestPhase?.phase ?? 'n/a'}(${slowestPhase?.ms ?? 0}ms);`
        + ` slowest package=${source.slowestPackage?.id ?? 'n/a'}(${source.slowestPackage?.ms ?? 0}ms);`
        + ` slowest file=${source.slowestFile?.id ?? 'n/a'}(${source.slowestFile?.ms ?? 0}ms)`,
      )
    }
  }, TEST_TIMEOUT_MS)
})
