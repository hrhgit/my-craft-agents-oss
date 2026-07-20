import { afterEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readArtifactManifest, recordArtifact } from '../artifacts.ts'
import { writeJsonAtomic } from '../files.ts'
import { MORTISE_UI_PROTOCOL_VERSION } from '../protocol.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('mortise-ui artifact manifest', () => {
  it('recovers a dead owner without waiting for the missing-owner stale timeout', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-artifacts-'))
    roots.push(root)
    const artifactsDir = join(root, 'artifacts')
    const manifestPath = join(artifactsDir, 'manifest.json')
    const lockPath = `${manifestPath}.lock`
    const artifactPath = join(artifactsDir, 'recovered.txt')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'dead-owner', pid: 2_147_483_647 }))
    writeFileSync(artifactPath, 'recovered', 'utf8')

    recordArtifact({
      manifestPath,
      runId: 'stale-run',
      artifactsDir,
      artifact: { kind: 'other', path: artifactPath },
    })

    expect(readArtifactManifest(manifestPath, 'stale-run').artifacts).toHaveLength(1)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('recovers a stale lock whose owner metadata was never written', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-artifacts-'))
    roots.push(root)
    const artifactsDir = join(root, 'artifacts')
    const manifestPath = join(artifactsDir, 'manifest.json')
    const lockPath = `${manifestPath}.lock`
    const artifactPath = join(artifactsDir, 'missing-owner.txt')
    mkdirSync(lockPath, { recursive: true })
    const staleAt = new Date(Date.now() - 60_000)
    utimesSync(lockPath, staleAt, staleAt)
    writeFileSync(artifactPath, 'recovered', 'utf8')

    recordArtifact({
      manifestPath,
      runId: 'missing-owner-run',
      artifactsDir,
      artifact: { kind: 'other', path: artifactPath },
    })

    expect(readArtifactManifest(manifestPath, 'missing-owner-run').artifacts).toHaveLength(1)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('does not steal an old lock from a live owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-artifacts-'))
    roots.push(root)
    const artifactsDir = join(root, 'artifacts')
    const manifestPath = join(artifactsDir, 'manifest.json')
    const lockPath = `${manifestPath}.lock`
    const artifactPath = join(artifactsDir, 'waited.txt')
    const startSignal = join(root, 'start')
    const readySignal = join(root, 'ready')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ token: 'live-owner', pid: process.pid }))
    const staleAt = new Date(Date.now() - 60_000)
    utimesSync(lockPath, staleAt, staleAt)

    const child = spawn(process.execPath, [
      join(import.meta.dir, 'artifact-writer.fixture.ts'),
      manifestPath,
      'live-owner-run',
      artifactsDir,
      artifactPath,
      startSignal,
      readySignal,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    await waitFor(() => existsSync(readySignal), 10_000)
    writeFileSync(startSignal, '', 'utf8')
    await waitFor(() => existsSync(`${readySignal}.recording`), 10_000)
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(child.exitCode).toBeNull()
    expect(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({ token: 'live-owner' })

    rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await waitForExit(child)
    expect(readArtifactManifest(manifestPath, 'live-owner-run').artifacts).toHaveLength(1)
    expect(existsSync(lockPath)).toBe(false)
  }, 15_000)

  it('keeps all entries from concurrent processes without temp or lock debris', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-artifacts-'))
    roots.push(root)
    const artifactsDir = join(root, 'artifacts')
    const manifestPath = join(artifactsDir, 'manifest.json')
    const runId = 'concurrent-run'
    const startSignal = join(root, 'start')
    const writerCount = 12
    writeJsonAtomic(manifestPath, {
      protocolVersion: MORTISE_UI_PROTOCOL_VERSION,
      runId,
      updatedAt: new Date(0).toISOString(),
      artifacts: [],
    })

    const children = Array.from({ length: writerCount }, (_, index) => {
      const artifactPath = join(artifactsDir, `artifact-${index}.txt`)
      const readySignal = join(root, `ready-${index}`)
      const child = spawn(process.execPath, [
        join(import.meta.dir, 'artifact-writer.fixture.ts'),
        manifestPath,
        runId,
        artifactsDir,
        artifactPath,
        startSignal,
        readySignal,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      return { child, artifactPath, readySignal }
    })

    await waitFor(() => children.every(({ readySignal }) => existsSync(readySignal)), 30_000)
    writeFileSync(startSignal, '', 'utf8')
    await Promise.all(children.map(({ child }) => waitForExit(child)))

    const manifest = readArtifactManifest(manifestPath, runId)
    expect(manifest.artifacts).toHaveLength(writerCount)
    expect(new Set(manifest.artifacts.map(artifact => artifact.path))).toEqual(
      new Set(children.map(({ artifactPath }) => artifactPath)),
    )
    expect(readdirSync(artifactsDir).filter(name => name.includes('.tmp') || name.endsWith('.lock'))).toEqual([])
  }, 60_000)

  it('serializes repeated same-process updates and replaces only the matching path', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-artifacts-'))
    roots.push(root)
    const artifactsDir = join(root, 'artifacts')
    const manifestPath = join(artifactsDir, 'manifest.json')
    const runId = 'same-process-run'
    const paths = Array.from({ length: 30 }, (_, index) => join(artifactsDir, `artifact-${index}.txt`))
    mkdirSync(artifactsDir, { recursive: true })

    for (const path of paths) {
      writeFileSync(path, path, 'utf8')
      recordArtifact({ manifestPath, runId, artifactsDir, artifact: { kind: 'other', path } })
    }
    recordArtifact({
      manifestPath,
      runId,
      artifactsDir,
      artifact: { kind: 'log', path: paths[0]!, description: 'replacement' },
    })

    const manifest = readArtifactManifest(manifestPath, runId)
    expect(manifest.artifacts).toHaveLength(paths.length)
    expect(manifest.artifacts.find(artifact => artifact.path === paths[0]))
      .toMatchObject({ kind: 'log', description: 'replacement' })
  })
})

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for concurrent artifact writers')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`artifact writer exited ${code}: ${stderr}`)
}
