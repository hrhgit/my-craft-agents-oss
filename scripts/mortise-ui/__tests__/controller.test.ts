import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ELECTRON_BUILD_PRODUCER_VERSION,
  ELECTRON_BUILD_SCHEMA_VERSION,
} from '../../build/electron-build-cache.ts'
import { DEFAULT_MORTISE_UI_START_WAIT_MS, MORTISE_UI_MAX_START_WAIT_MS, MORTISE_UI_MIN_RENDERER_READINESS_MS, getDefaultAdapterCommand, getMortiseUiRunStatus, mortiseUiHostRequestTimeoutMs, mortiseUiRendererReadinessDeadline, readPackagedDeveloperHostIdentity, readRunManifest, resolveRunDir, restartMortiseUiRun, startMortiseUiRun, stopMortiseUiRun, updateRunManifest } from '../controller.ts'
import { requestMortiseUiHost } from '../client.ts'
import { collectLocalEvidence, registerReturnedArtifacts } from '../evidence.ts'

const roots: string[] = []
const runs: Array<{ runDir: string }> = []
const originalDeveloperHostPath = process.env.MORTISE_DEV_HOST_PATH
afterEach(async () => {
  for (const run of runs.splice(0)) await stopMortiseUiRun(run.runDir).catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalDeveloperHostPath === undefined) delete process.env.MORTISE_DEV_HOST_PATH
  else process.env.MORTISE_DEV_HOST_PATH = originalDeveloperHostPath
}, 30_000)

describe('mortise-ui controller', () => {
  it('allows slow cold source-development launches by default', () => {
    expect(DEFAULT_MORTISE_UI_START_WAIT_MS).toBe(900_000)
  })

  it('keeps host requests within the protocol wait limit', () => {
    expect(mortiseUiHostRequestTimeoutMs(DEFAULT_MORTISE_UI_START_WAIT_MS)).toBe(600_000)
    expect(mortiseUiHostRequestTimeoutMs(45_000)).toBe(45_000)
    expect(mortiseUiHostRequestTimeoutMs(0)).toBe(1)
  })

  it('does not let a cold build consume the renderer readiness window', () => {
    const endpointOpenedAt = 1_000_000
    expect(mortiseUiRendererReadinessDeadline(endpointOpenedAt + 2_000, endpointOpenedAt))
      .toBe(endpointOpenedAt + MORTISE_UI_MIN_RENDERER_READINESS_MS)
    expect(mortiseUiRendererReadinessDeadline(endpointOpenedAt + 120_000, endpointOpenedAt))
      .toBe(endpointOpenedAt + 120_000)
  })

  it('uses an explicitly configured packaged Developer Host', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-dev-host-')); roots.push(root)
    const executable = join(root, 'Mortise Developer Host.exe')
    writeFileSync(executable, 'fixture', 'utf8')
    const provenancePath = join(root, 'resources', 'app', 'dist', 'build-provenance.json')
    mkdirSync(join(provenancePath, '..'), { recursive: true })
    writeFileSync(provenancePath, JSON.stringify({
      schemaVersion: ELECTRON_BUILD_SCHEMA_VERSION,
      producerVersion: ELECTRON_BUILD_PRODUCER_VERSION,
      mode: 'ui-validation',
      buildId: 'a'.repeat(64),
      sourceId: 'b'.repeat(64),
    }))
    process.env.MORTISE_DEV_HOST_PATH = executable
    expect(getDefaultAdapterCommand('electron')).toEqual([executable])
    expect(readPackagedDeveloperHostIdentity(executable)).toEqual({
      buildId: 'a'.repeat(64),
      sourceId: 'b'.repeat(64),
    })
  })

  it('rejects a configured Developer Host without immutable provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-unprovenanced-host-')); roots.push(root)
    const executable = join(root, 'Mortise Developer Host.exe')
    writeFileSync(executable, 'fixture', 'utf8')
    expect(() => readPackagedDeveloperHostIdentity(executable)).toThrow('provenance is missing or invalid')
  })

  it('requires explicit source profiles for clone mode', async () => {
    await expect(startMortiseUiRun({ surface: 'electron', profileMode: 'clone' }))
      .rejects.toThrow('explicit sourceMortiseConfigDir')
  })

  it('requires canonical Electron identities for pinned builds', async () => {
    await expect(startMortiseUiRun({ surface: 'electron', expectedBuildId: 'not-a-build' }))
      .rejects.toThrow('lowercase SHA-256 identity')
    await expect(startMortiseUiRun({ surface: 'webui', expectedBuildId: 'a'.repeat(64) }))
      .rejects.toThrow('requires the Electron surface')
  })

  it('enforces the shared maximum cold-start budget', async () => {
    await expect(startMortiseUiRun({ surface: 'electron', waitMs: MORTISE_UI_MAX_START_WAIT_MS + 1 }))
      .rejects.toThrow(`waitMs must be between 1 and ${MORTISE_UI_MAX_START_WAIT_MS}`)
  })

  it('requires concise directory-safe semantic labels', async () => {
    await expect(startMortiseUiRun({ surface: 'electron', label: 'Provider Switch' }))
      .rejects.toThrow('Run label must be 1-64 lowercase characters')
    await expect(startMortiseUiRun({ surface: 'electron', label: '-provider-switch' }))
      .rejects.toThrow('Run label must be 1-64 lowercase characters')
  })

  it('selects only one live active run when --run is omitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-active-run-')); roots.push(root)
    const stopped = writeTestManifest(root, 'stopped-run', 'stopped')
    expect(() => resolveRunDir(root)).toThrow('No active Mortise UI run')
    const active = writeTestManifest(root, 'active-run', 'starting', process.pid)
    expect(resolveRunDir(root)).toBe(active)
    writeTestManifest(root, 'second-active-run', 'ready', process.pid)
    expect(() => resolveRunDir(root)).toThrow('More than one active Mortise UI run')
    expect(resolveRunDir(root, 'stopped-run')).toBe(stopped)
  })

  it('resolves semantic labels without guessing between ambiguous runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-labeled-run-')); roots.push(root)
    const first = writeTestManifest(root, 'run-a', 'stopped', undefined, 'provider-switch')
    expect(resolveRunDir(root, 'provider-switch')).toBe(first)
    expect(resolveRunDir(root, 'run-a')).toBe(first)

    writeTestManifest(root, 'run-b', 'stopped', undefined, 'provider-switch')
    expect(() => resolveRunDir(root, 'provider-switch')).toThrow('Mortise UI run label is ambiguous')

    const active = writeTestManifest(root, 'run-c', 'ready', process.pid, 'provider-switch')
    expect(resolveRunDir(root, 'provider-switch')).toBe(active)
    writeTestManifest(root, 'run-d', 'ready', process.pid, 'provider-switch')
    expect(() => resolveRunDir(root, 'provider-switch')).toThrow('Mortise UI run label is ambiguous')
  })

  it('serializes run manifest updates from concurrent CLI processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-run-lock-')); roots.push(root)
    const runDir = writeTestManifest(root, 'concurrent-run', 'starting', process.pid)
    const barrier = join(root, 'go')
    const writers = Array.from({ length: 16 }, (_, index) => Bun.spawn([
      process.execPath,
      join(import.meta.dir, 'run-manifest-writer.fixture.ts'),
      runDir,
      barrier,
      `marker${index}`,
    ], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' }))
    writeFileSync(barrier, 'go', 'utf8')
    const exits = await Promise.all(writers.map(writer => writer.exited))
    const errors = await Promise.all(writers.map(async (writer, index) => ({
      index,
      exit: exits[index],
      stderr: await new Response(writer.stderr).text(),
    })))
    expect(errors.filter(item => item.exit !== 0)).toEqual([])
    const manifest = readRunManifest(runDir) as unknown as Record<string, unknown>
    for (let index = 0; index < writers.length; index += 1) expect(manifest[`marker${index}`]).toBe(`marker${index}`)
    expect(existsSync(join(runDir, 'run.json.lock'))).toBe(false)
  }, 60_000)

  it('retries disposable profile cleanup instead of treating residue as already stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-cleanup-retry-')); roots.push(root)
    const runDir = writeTestManifest(root, 'cleanup-retry', 'stopped')
    const profileDir = readRunManifest(runDir).profileDir
    writeFileSync(join(profileDir, 'residue.txt'), 'retry me', 'utf8')
    updateRunManifest(runDir, { cleanupError: 'previous cleanup failed' })

    const stopped = await stopMortiseUiRun(runDir)

    expect(stopped.status).toBe('stopped')
    expect(stopped.cleanupError).toBeUndefined()
    expect(stopped.profileCleanedAt).toBeString()
    expect(existsSync(profileDir)).toBe(false)
  })

  it('starts, queries, records evidence, and stops a loopback host adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-controller-')); roots.push(root)
    const manifest = await startMortiseUiRun({
      surface: 'electron',
      label: 'controller-lifecycle',
      adapterCommand: [process.execPath, join(import.meta.dir, '..', 'test-host.fixture.ts')],
      runRoot: root,
      waitMs: 10_000,
    })
    runs.push(manifest)
    expect(manifest.status).toBe('ready')
    expect(manifest.label).toBe('controller-lifecycle')
    expect(resolveRunDir(root, 'controller-lifecycle')).toBe(manifest.runDir)
    expect(manifest.profileMode).toBe('fixture')
    expect(manifest.windowMode).toBe('background')
    expect(manifest.containsClonedUserData).toBe(false)
    expect(existsSync(join(manifest.profileDir, 'mortise-config', 'state.sqlite'))).toBe(true)
    expect(existsSync(join(manifest.profileDir, 'mortise-config', 'config.json'))).toBe(false)
    expect(readFileSync(manifest.tokenPath, 'utf8').trim()).toHaveLength(64)

    const status = await getMortiseUiRunStatus(manifest.runDir) as { processAlive: boolean; host: { ok: boolean } }
    expect(status.processAlive).toBe(true)
    expect(status.host.ok).toBe(true)

    const response = await requestMortiseUiHost<{ command: string; artifacts: Array<Record<string, unknown>> }>({ ...manifest, command: 'ui.snapshot' })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.command).toBe('ui.snapshot')
    registerReturnedArtifacts(manifest, response.result)
    const evidence = collectLocalEvidence(manifest)
    expect(evidence.artifacts.some(item => item.kind === 'snapshot')).toBe(true)
    const stdout = evidence.artifacts.find(item => item.path.endsWith('host.stdout.redacted.log'))
    expect(stdout).toBeDefined()
    expect(readFileSync(stdout!.path, 'utf8')).toContain('[REDACTED]')

    const stopped = await stopMortiseUiRun(manifest.runDir)
    runs.pop()
    expect(stopped.status).toBe('stopped')
    expect(stopped.profileCleanedAt).toBeString()
    expect(existsSync(manifest.profileDir)).toBe(false)
  }, 30_000)

  it('restarts against the same profile with a fresh run identity and protocol sequence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-restart-')); roots.push(root)
    const first = await startMortiseUiRun({
      surface: 'electron',
      expectedBuildId: 'a'.repeat(64),
      label: 'restart-profile',
      adapterCommand: [process.execPath, join(import.meta.dir, '..', 'test-host.fixture.ts')],
      runRoot: root,
      waitMs: 10_000,
    })
    runs.push(first)
    writeFileSync(join(first.profileDir, 'restart-marker.txt'), 'persisted', 'utf8')
    const firstToken = readFileSync(first.tokenPath, 'utf8')
    const firstSeq = first.lastResponseSeq ?? 0

    const second = await restartMortiseUiRun(first.runDir, { waitMs: 10_000 })
    runs.splice(0, 1, second)

    expect(second.runId).not.toBe(first.runId)
    expect(second.buildId).toBe(first.buildId)
    expect(second.profileDir).toBe(first.profileDir)
    expect(second.restartedFromRunId).toBe(first.runId)
    expect(second.profileOwnerRunId).toBe(second.runId)
    expect(readRunManifest(first.runDir).restartedByRunId).toBe(second.runId)
    expect(readFileSync(join(second.profileDir, 'restart-marker.txt'), 'utf8')).toBe('persisted')
    expect(readFileSync(second.tokenPath, 'utf8')).not.toBe(firstToken)
    expect(second.lastResponseSeq).toBeGreaterThan(0)
    expect(second.lastResponseSeq).toBeLessThanOrEqual(firstSeq)

    const response = await requestMortiseUiHost({ ...second, command: 'app.status', minimumSeqExclusive: second.lastResponseSeq })
    expect(response.ok).toBe(true)
    expect(response.seq).toBeGreaterThan(second.lastResponseSeq ?? 0)
  }, 30_000)
})

function writeTestManifest(root: string, runId: string, status: 'starting' | 'ready' | 'stopped', launcherPid?: number, label?: string): string {
  const runDir = join(root, runId)
  const profileDir = join(runDir, 'profile')
  const artifactsDir = join(runDir, 'artifacts')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    protocolVersion: 1,
    runId,
    ...(label ? { label } : {}),
    surface: 'electron',
    status,
    createdAt: new Date(Date.now() + Math.random() * 1_000).toISOString(),
    updatedAt: new Date().toISOString(),
    controllerPid: process.pid,
    ...(launcherPid ? { launcherPid } : {}),
    profileMode: 'isolated',
    windowMode: 'background',
    containsClonedUserData: false,
    runDir,
    profileDir,
    artifactsDir,
    endpointManifestPath: join(runDir, 'endpoint.json'),
    tokenPath: join(runDir, 'token'),
    stdoutPath: join(artifactsDir, 'host.stdout.log'),
    stderrPath: join(artifactsDir, 'host.stderr.log'),
    adapterCommand: [],
  }))
  return runDir
}
