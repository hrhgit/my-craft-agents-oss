import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  acquireElectronBuild,
  cleanupElectronBuildCache,
  computeElectronBuildFingerprint,
  releaseElectronBuild,
} from '../build-cache.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('mortise-ui immutable Electron build cache', () => {
  it('changes the build identity when a source input changes', () => {
    const root = tempRoot('mortise-ui-build-fingerprint-')
    write(root, 'package.json', '{}')
    write(root, 'apps/electron/src/main.ts', 'export const value = 1\n')
    const before = computeElectronBuildFingerprint(root)
    write(root, 'apps/electron/src/main.ts', 'export const value = 2\n')
    expect(computeElectronBuildFingerprint(root)).not.toBe(before)
  })

  it('reuses one immutable build and removes it after the final lease is released', () => {
    const root = tempRoot('mortise-ui-build-reuse-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const builds: string[] = []
    const build = (sourceRoot: string) => { builds.push('built'); seedBuildOutputs(sourceRoot) }
    const first = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'run-a', runDir: createRun(root, 'run-a'), computeFingerprint: () => 'a'.repeat(64), build,
      retainCount: 0, maxBytes: 1,
    })
    const second = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'run-b', runDir: createRun(root, 'run-b'), computeFingerprint: () => 'a'.repeat(64), build,
      retainCount: 0, maxBytes: 1,
    })

    expect(builds).toEqual(['built'])
    expect(second.buildId).toBe(first.buildId)
    expect(existsSync(join(first.appDir, 'dist', 'renderer', 'index.html'))).toBe(true)
    releaseElectronBuild(first, { retainCount: 0, maxBytes: 1 })
    expect(existsSync(first.buildDir)).toBe(true)
    releaseElectronBuild(second, { retainCount: 0, maxBytes: 1 })
    expect(existsSync(first.buildDir)).toBe(false)
  }, 20_000)

  it('keeps active builds and automatically retains only the newest completed builds', () => {
    const root = tempRoot('mortise-ui-build-retention-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    let sequence = 0
    let clock = 0
    const now = () => new Date(++clock * 1_000)
    const build = (sourceRoot: string) => { sequence += 1; seedBuildOutputs(sourceRoot, `build-${sequence}`) }
    const active = acquireElectronBuild({
      repoRoot, buildRoot, runId: 'active', runDir: createRun(root, 'active'), computeFingerprint: () => '1'.repeat(64), build,
      retainCount: 1, maxBytes: 1_000_000, now,
    })

    for (const [runId, fingerprint] of [['second', '2'.repeat(64)], ['third', '3'.repeat(64)]] as const) {
      const lease = acquireElectronBuild({
        repoRoot, buildRoot, runId, runDir: createRun(root, runId), computeFingerprint: () => fingerprint, build,
        retainCount: 1, maxBytes: 1_000_000, now,
      })
      releaseElectronBuild(lease, { retainCount: 1, maxBytes: 1_000_000 })
    }

    const buildsWhileActive = buildIds(buildRoot)
    expect(buildsWhileActive).toContain(active.buildId)
    expect(buildsWhileActive).toContain('3'.repeat(64))
    expect(buildsWhileActive).not.toContain('2'.repeat(64))
    releaseElectronBuild(active, { retainCount: 1, maxBytes: 1_000_000 })
    expect(buildIds(buildRoot)).toEqual(['3'.repeat(64)])
  }, 15_000)

  it('publishes from an immutable snapshot while the live source keeps changing', () => {
    const root = tempRoot('mortise-ui-build-source-race-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    write(repoRoot, 'apps/electron/src/main.ts', 'export const value = "before"\n')
    let sourceRoot = ''
    const lease = acquireElectronBuild({
      repoRoot,
      buildRoot,
      runId: 'race',
      runDir: createRun(root, 'race'),
      computeFingerprint: () => 'a'.repeat(64),
      build: snapshotRoot => {
        sourceRoot = snapshotRoot
        expect(resolve(snapshotRoot)).not.toBe(resolve(repoRoot))
        expect(readFileSync(join(snapshotRoot, 'apps/electron/src/main.ts'), 'utf8')).toContain('before')
        write(repoRoot, 'apps/electron/src/main.ts', 'export const value = "after"\n')
        seedBuildOutputs(repoRoot, 'live')
        seedBuildOutputs(snapshotRoot, 'snapshot')
      },
    })
    expect(readFileSync(join(lease.appDir, 'dist/resources/fixture.txt'), 'utf8')).toBe('snapshot')
    expect(existsSync(sourceRoot)).toBe(false)
    releaseElectronBuild(lease)
  })

  it('deduplicates concurrent processes for the same build identity', async () => {
    const root = tempRoot('mortise-ui-build-concurrent-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    initGitRepo(repoRoot)
    const counterPath = join(root, 'build-count.txt')
    const fingerprint = 'c'.repeat(64)
    writeFileSync(counterPath, '', 'utf8')
    const workers = Array.from({ length: 4 }, (_, index) => {
      const runId = `worker-${index}`
      const runDir = createRun(root, runId)
      return Bun.spawn([
        process.execPath,
        join(import.meta.dir, 'build-cache-worker.fixture.ts'),
        repoRoot,
        buildRoot,
        runDir,
        runId,
        fingerprint,
        counterPath,
        join(root, `${runId}.json`),
      ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
    })
    const exits = await Promise.all(workers.map(worker => worker.exited))
    const errors = await Promise.all(workers.map(worker => new Response(worker.stderr).text()))
    expect(exits.map((exit, index) => ({ exit, error: errors[index] })).filter(item => item.exit !== 0)).toEqual([])
    expect(readFileSync(counterPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1)
    const results = Array.from({ length: 4 }, (_, index) => JSON.parse(readFileSync(join(root, `worker-${index}.json`), 'utf8')) as { buildId: string; appDir: string })
    expect(new Set(results.map(result => result.buildId))).toEqual(new Set([fingerprint]))
    expect(new Set(results.map(result => result.appDir)).size).toBe(1)
    expect(buildIds(buildRoot)).toEqual([fingerprint])
    expect(cleanupElectronBuildCache({ buildRoot, retainCount: 0, maxBytes: 1 }).removedBuildIds).toContain(fingerprint)
  }, 20_000)

  it('lets different source identities compile at the same time', async () => {
    const root = tempRoot('mortise-ui-build-parallel-')
    const repoRoot = join(root, 'repo')
    const buildRoot = join(root, 'cache')
    const counterPath = join(root, 'build-count.txt')
    const releasePath = join(root, 'release')
    initGitRepo(repoRoot)
    writeFileSync(counterPath, '', 'utf8')
    const fingerprints = ['d'.repeat(64), 'e'.repeat(64)]
    const workers = fingerprints.map((fingerprint, index) => {
      const runId = `parallel-${index}`
      return Bun.spawn([
        process.execPath,
        join(import.meta.dir, 'build-cache-worker.fixture.ts'),
        repoRoot,
        buildRoot,
        createRun(root, runId),
        runId,
        fingerprint,
        counterPath,
        join(root, `${runId}.json`),
        join(root, `${runId}.started`),
        releasePath,
      ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
    })

    try {
      await waitFor(() => fingerprints.every((_, index) => existsSync(join(root, `parallel-${index}.started`))), 8_000)
    } finally {
      writeFileSync(releasePath, 'release', 'utf8')
    }
    const exits = await Promise.all(workers.map(worker => worker.exited))
    const errors = await Promise.all(workers.map(worker => new Response(worker.stderr).text()))
    expect(exits.map((exit, index) => ({ exit, error: errors[index] })).filter(item => item.exit !== 0)).toEqual([])
    expect(readFileSync(counterPath, 'utf8').trim().split(/\r?\n/).filter(Boolean)).toHaveLength(2)
    expect(buildIds(buildRoot)).toEqual(fingerprints)
  }, 20_000)
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function createRun(root: string, runId: string): string {
  const runDir = join(root, 'runs', runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ status: 'ready', launcherPid: process.pid }), 'utf8')
  return runDir
}

function initGitRepo(repoRoot: string): void {
  mkdirSync(repoRoot, { recursive: true })
  const result = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
  write(repoRoot, 'package.json', '{}\n')
  write(repoRoot, 'apps/electron/src/main.ts', 'export const value = 1\n')
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for concurrent build workers')
    await Bun.sleep(20)
  }
}

function seedBuildOutputs(repoRoot: string, content = 'fixture'): void {
  write(repoRoot, 'apps/electron/package.json', JSON.stringify({ name: '@mortise/electron-test', main: 'dist/main.cjs', type: 'module' }))
  for (const path of ['main.cjs', 'bootstrap-preload.cjs', 'browser-toolbar-preload.cjs', 'workspace-server.mjs']) {
    write(repoRoot, `apps/electron/dist/${path}`, `// ${content}: ${path}\n`)
  }
  write(repoRoot, 'apps/electron/dist/renderer/index.html', `<!doctype html><title>${content}</title>`)
  write(repoRoot, 'apps/electron/dist/resources/fixture.txt', content)
}

function write(root: string, path: string, content: string): void {
  const target = join(root, ...path.split('/'))
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

function buildIds(buildRoot: string): string[] {
  const buildsDir = join(buildRoot, 'builds')
  if (!existsSync(buildsDir)) return []
  return readdirSync(buildsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.staging-'))
    .map(entry => entry.name)
    .sort()
}
