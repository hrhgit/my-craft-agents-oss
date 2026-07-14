import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function runCli(args: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'cli.ts'), ...args], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, json: JSON.parse(stdout.trim()), stderr }
}

describe('craft-ui CLI', () => {
  it('exposes the complete JSON command lifecycle', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'craft-ui-cli-')); roots.push(runRoot)
    const adapter = JSON.stringify([process.execPath, join(import.meta.dir, '..', 'test-host.fixture.ts')])
    const started = await runCli(['start', '--run-root', runRoot, '--adapter-command-json', adapter])
    expect(started.code).toBe(0)
    expectEnvelope(started.json)
    const runId = started.json.result.manifest.runId as string
    try {
      for (const command of ['status', 'open', 'snapshot', 'action', 'wait', 'assert', 'evidence']) {
        const args = [command, '--run-root', runRoot, '--run', runId]
        if (command !== 'status') args.push('--params', JSON.stringify({ probe: command }))
        const result = await runCli(args)
        expect(result.code).toBe(0)
        expectEnvelope(result.json, runId)
      }
      const capabilities = await runCli(['capabilities', 'list', '--kind', 'scenario', '--json', '--run-root', runRoot, '--run', runId])
      expect(capabilities.code).toBe(0)
      expectEnvelope(capabilities.json, runId)
      expect(capabilities.json.result).toMatchObject({ command: 'ui.capabilities', params: { operation: 'list', kind: 'scenario' } })
      const described = await runCli(['capabilities', 'describe', '--kind', 'action', '--id', 'click', '--run-root', runRoot, '--run', runId])
      expect(described.code).toBe(0)
      expect(described.json.result).toMatchObject({ command: 'ui.capabilities', params: { operation: 'describe', kind: 'action', id: 'click' } })
      const applied = await runCli(['scenario', 'apply', '--id', 'app.default', '--params', '{}', '--run-root', runRoot, '--run', runId])
      expect(applied.code).toBe(0)
      const reset = await runCli(['scenario', 'reset', '--run-root', runRoot, '--run', runId])
      expect(reset.code).toBe(0)
      const advanced = await runCli(['clock', 'advance', '--ms', '250', '--timeout-ms', '5000', '--run-root', runRoot, '--run', runId])
      expect(advanced.code).toBe(0)
      expectEnvelope(advanced.json, runId)
      expect(advanced.json.result).toMatchObject({ command: 'clock.advance', params: { ms: 250 } })
      for (const operation of ['set', 'clear', 'status']) {
        const fault = await runCli([
          'fault', operation,
          '--params', operation === 'set' ? JSON.stringify({ point: 'transport.connect', effect: { kind: 'disconnect' } }) : '{}',
          '--run-root', runRoot, '--run', runId,
        ])
        expect(fault.code).toBe(0)
        expect(fault.json.result.command).toBe(`fault.${operation}`)
      }
    } finally {
      const stopped = await runCli(['stop', '--run-root', runRoot, '--run', runId])
      expect(stopped.code).toBe(0)
      expectEnvelope(stopped.json, runId)
      expect(stopped.json.result.manifest.status).toBe('stopped')
    }
  }, 30_000)

  it('returns typed V1 errors before a run exists', async () => {
    const result = await runCli(['start', '--surface', 'invalid'])
    expect(result.code).toBe(1)
    expectEnvelope(result.json, 'unassigned')
    expect(result.json).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('requires a kind and id for capability descriptions', async () => {
    const result = await runCli(['capabilities', 'describe'])
    expect(result.code).toBe(1)
    expectEnvelope(result.json, 'unassigned')
    expect(result.json).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })
})

function expectEnvelope(value: any, runId?: string): void {
  expect(value).toMatchObject({
    v: 1,
    kind: 'response',
  })
  expect(typeof value.requestId).toBe('string')
  expect(value.id).toEqual(value.requestId)
  expect(typeof value.runId).toBe('string')
  if (runId !== undefined) expect(value.runId).toBe(runId)
  expect(Number.isSafeInteger(value.seq)).toBe(true)
  expect(Number.isSafeInteger(value.revision)).toBe(true)
  expect(['scenario-verified', 'renderer-verified', 'native-verified']).toContain(value.verificationLevel)
  expect(typeof value.ok).toBe('boolean')
}
