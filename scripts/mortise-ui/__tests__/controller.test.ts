import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UI_VALIDATION_MAX_WAIT_MS } from '@mortise/shared/ui-validation'
import { DEFAULT_MORTISE_UI_START_WAIT_MS, getDefaultAdapterCommand, getMortiseUiRunStatus, readRunManifest, resolveRunDir, startMortiseUiRun, stopMortiseUiRun } from '../controller.ts'
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
})

describe('mortise-ui controller', () => {
  it('allows slow cold source-development launches by default', () => {
    expect(DEFAULT_MORTISE_UI_START_WAIT_MS).toBe(600_000)
  })

  it('uses an explicitly configured packaged Developer Host', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-dev-host-')); roots.push(root)
    const executable = join(root, 'Mortise Developer Host.exe')
    writeFileSync(executable, 'fixture', 'utf8')
    process.env.MORTISE_DEV_HOST_PATH = executable
    expect(getDefaultAdapterCommand('electron')).toEqual([executable])
  })

  it('requires explicit source profiles for clone mode', async () => {
    await expect(startMortiseUiRun({ surface: 'electron', profileMode: 'clone' }))
      .rejects.toThrow('explicit sourceMortiseConfigDir and sourcePiAgentDir')
  })

  it('enforces the shared maximum cold-start budget', async () => {
    await expect(startMortiseUiRun({ surface: 'electron', waitMs: UI_VALIDATION_MAX_WAIT_MS + 1 }))
      .rejects.toThrow(`waitMs must be between 1 and ${UI_VALIDATION_MAX_WAIT_MS}`)
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
  }, 20_000)

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
    expect(existsSync(join(manifest.profileDir, 'mortise-config', 'config.json'))).toBe(true)
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
  }, 20_000)
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
