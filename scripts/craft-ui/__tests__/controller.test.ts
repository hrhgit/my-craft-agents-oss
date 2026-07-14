import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCraftUiRunStatus, startCraftUiRun, stopCraftUiRun } from '../controller.ts'
import { requestCraftUiHost } from '../client.ts'
import { collectLocalEvidence, registerReturnedArtifacts } from '../evidence.ts'

const roots: string[] = []
const runs: Array<{ runDir: string }> = []
afterEach(async () => {
  for (const run of runs.splice(0)) await stopCraftUiRun(run.runDir).catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('craft-ui controller', () => {
  it('requires explicit source profiles for clone mode', async () => {
    await expect(startCraftUiRun({ surface: 'electron', profileMode: 'clone' }))
      .rejects.toThrow('explicit sourceCraftConfigDir and sourcePiAgentDir')
  })

  it('starts, queries, records evidence, and stops a loopback host adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-ui-controller-')); roots.push(root)
    const manifest = await startCraftUiRun({
      surface: 'electron',
      adapterCommand: [process.execPath, join(import.meta.dir, '..', 'test-host.fixture.ts')],
      runRoot: root,
      waitMs: 10_000,
    })
    runs.push(manifest)
    expect(manifest.status).toBe('ready')
    expect(manifest.containsClonedUserData).toBe(false)
    expect(readFileSync(manifest.tokenPath, 'utf8').trim()).toHaveLength(64)

    const status = await getCraftUiRunStatus(manifest.runDir) as { processAlive: boolean; host: { ok: boolean } }
    expect(status.processAlive).toBe(true)
    expect(status.host.ok).toBe(true)

    const response = await requestCraftUiHost<{ command: string; artifacts: Array<Record<string, unknown>> }>({ ...manifest, command: 'ui.snapshot' })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.result.command).toBe('ui.snapshot')
    registerReturnedArtifacts(manifest, response.result)
    const evidence = collectLocalEvidence(manifest)
    expect(evidence.artifacts.some(item => item.kind === 'snapshot')).toBe(true)
    const stdout = evidence.artifacts.find(item => item.path.endsWith('host.stdout.redacted.log'))
    expect(stdout).toBeDefined()
    expect(readFileSync(stdout!.path, 'utf8')).toContain('[REDACTED]')

    const stopped = await stopCraftUiRun(manifest.runDir)
    runs.pop()
    expect(stopped.status).toBe('stopped')
    expect(stopped.profileCleanedAt).toBeString()
    expect(existsSync(manifest.profileDir)).toBe(false)
  }, 20_000)
})
