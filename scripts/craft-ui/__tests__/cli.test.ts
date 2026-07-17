import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('keeps status and stop independent from profile-only Pi session imports', async () => {
    const controllerSource = readFileSync(join(import.meta.dir, '..', 'controller.ts'), 'utf8')
    expect(controllerSource).not.toMatch(/\bfrom\s+['"]\.\/profile\.ts['"]/)
    expect(controllerSource).toContain("await import('./profile.ts')")

    const runRoot = mkdtempSync(join(tmpdir(), 'craft-ui-cli-dead-run-')); roots.push(runRoot)
    const runId = 'dead-run'
    const runDir = join(runRoot, runId)
    const profileDir = join(runDir, 'profile')
    const artifactsDir = join(runDir, 'artifacts')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      protocolVersion: 1,
      runId,
      surface: 'electron',
      status: 'failed',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      controllerPid: 1,
      profileMode: 'isolated',
      windowMode: 'foreground',
      containsClonedUserData: false,
      runDir,
      profileDir,
      artifactsDir,
      endpointManifestPath: join(runDir, 'endpoint.json'),
      tokenPath: join(runDir, 'token'),
      stdoutPath: join(artifactsDir, 'host.stdout.log'),
      stderrPath: join(artifactsDir, 'host.stderr.log'),
      adapterCommand: [],
      lastResponseSeq: 0,
      lastRevision: 0,
      verificationLevel: 'scenario-verified',
    }))
    const status = await runCli(['status', '--run-root', runRoot, '--run', runId])
    expect(status.code).toBe(0)
    expect(status.json.result.processAlive).toBe(false)

    const stopped = await runCli(['stop', '--run-root', runRoot, '--run', runId])
    expect(stopped.code).toBe(0)
    expect(stopped.json.result.manifest.status).toBe('stopped')
    expect(stopped.json.result.manifest.profileCleanedAt).toBeString()
  })

  it('exposes the fixture schema before a run exists', async () => {
    const result = await runCli(['fixture', 'schema', '--json'])
    expect(result.code).toBe(0)
    expectEnvelope(result.json, 'unassigned')
    expect(result.json.result.schema).toMatchObject({
      properties: { version: { const: 1 }, workspaces: { maxItems: 32 } },
    })
  })

  it('exposes the complete JSON command lifecycle', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'craft-ui-cli-')); roots.push(runRoot)
    const adapter = JSON.stringify([process.execPath, join(import.meta.dir, '..', 'test-host.fixture.ts')])
    const fixturePath = join(runRoot, 'fixture.json')
    writeFileSync(fixturePath, JSON.stringify({
      version: 1,
      active: { workspaceId: 'cli-workspace', sessionId: 'cli-session' },
      workspaces: [{
        id: 'cli-workspace', name: 'CLI Workspace',
        files: [{ path: 'README.md', content: '# CLI fixture\n' }],
        sessions: [{ id: 'cli-session', messages: [{ role: 'user', content: 'CLI history' }] }],
      }],
    }))
    const started = await runCli(['start', '--run-root', runRoot, '--adapter-command-json', adapter, '--fixture', fixturePath, '--window-mode', 'background'])
    expect(started.code).toBe(0)
    expectEnvelope(started.json)
    expect(started.json.result.manifest.profileMode).toBe('fixture')
    expect(started.json.result.manifest.windowMode).toBe('background')
    expect(started.json.result.manifest.fixture).toMatchObject({ workspaceCount: 1, sessionCount: 1, messageCount: 1, fileCount: 1 })
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

  it('rejects background window mode for WebUI runs', async () => {
    const result = await runCli(['start', '--surface', 'webui', '--window-mode', 'background'])
    expect(result.code).toBe(1)
    expect(result.json).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('returns a typed request error for an unreadable fixture', async () => {
    const result = await runCli(['start', '--fixture', join(tmpdir(), 'missing-craft-ui-fixture.json')])
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
