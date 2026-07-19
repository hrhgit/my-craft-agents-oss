import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('mortise-ui CLI', () => {
  it('keeps status and stop independent from profile-only Pi session imports', async () => {
    const controllerSource = readFileSync(join(import.meta.dir, '..', 'controller.ts'), 'utf8')
    expect(controllerSource).not.toMatch(/\bfrom\s+['"]\.\/profile\.ts['"]/)
    expect(controllerSource).toContain("await import('./profile.ts')")

    const runRoot = mkdtempSync(join(tmpdir(), 'mortise-ui-cli-dead-run-')); roots.push(runRoot)
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

  it('mounts repeated extension development directories into the disposable profile', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'mortise-ui-cli-extensions-')); roots.push(runRoot)
    const first = createExtensionPackage(runRoot, 'first-extension')
    const second = createExtensionPackage(runRoot, 'second-extension')
    const adapter = JSON.stringify([process.execPath, join(import.meta.dir, '..', 'test-host.fixture.ts')])
    const started = await runCli([
      'start', '--run-root', runRoot, '--adapter-command-json', adapter,
      '--extension', first, '--extension', second,
    ])
    expect(started.code).toBe(0)
    const manifest = started.json.result.manifest
    try {
      expect(manifest.mountedExtensions).toHaveLength(2)
      expect(manifest.mountedExtensions.flatMap((pkg: { entries: Array<{ id: string }> }) => pkg.entries.map(entry => entry.id)))
        .toEqual(['first-extension', 'second-extension'])
      const settings = JSON.parse(readFileSync(join(manifest.profileDir, 'pi-agent', 'settings.json'), 'utf8'))
      expect(settings.extensions.map((entry: { id: string }) => entry.id)).toEqual(['first-extension', 'second-extension'])
      expect(settings.extensions.every((entry: { path: string }) => entry.path.startsWith(runRoot))).toBe(true)
    } finally {
      const stopped = await runCli(['stop', '--run-root', runRoot, '--run', manifest.runId])
      expect(stopped.code).toBe(0)
    }
  }, 20_000)

  it('exposes the complete JSON command lifecycle', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'mortise-ui-cli-')); roots.push(runRoot)
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
    const label = 'cli-lifecycle'
    const started = await runCli(['start', '--label', label, '--run-root', runRoot, '--adapter-command-json', adapter, '--fixture', fixturePath, '--window-mode', 'background'])
    expect(started.code).toBe(0)
    expectEnvelope(started.json)
    expect(started.json.result.manifest.profileMode).toBe('fixture')
    expect(started.json.result.manifest.label).toBe(label)
    expect(started.json.result.manifest.windowMode).toBe('background')
    expect(started.json.result.manifest.fixture).toMatchObject({ workspaceCount: 1, sessionCount: 1, messageCount: 1, fileCount: 1 })
    const runId = started.json.result.manifest.runId as string
    try {
      for (const command of ['status', 'open', 'snapshot', 'action', 'wait', 'assert', 'evidence']) {
        const args = [command, '--run-root', runRoot, '--run', label]
        if (command !== 'status') args.push('--params', JSON.stringify({ probe: command }))
        const result = await runCli(args)
        expect(result.code).toBe(0)
        expectEnvelope(result.json, runId)
      }
      const capabilities = await runCli(['capabilities', 'list', '--kind', 'scenario', '--json', '--run-root', runRoot, '--run', label])
      expect(capabilities.code).toBe(0)
      expectEnvelope(capabilities.json, runId)
      expect(capabilities.json.result).toMatchObject({ command: 'ui.capabilities', params: { operation: 'list', kind: 'scenario' } })
      const described = await runCli(['capabilities', 'describe', '--kind', 'action', '--id', 'click', '--run-root', runRoot, '--run', label])
      expect(described.code).toBe(0)
      expect(described.json.result).toMatchObject({ command: 'ui.capabilities', params: { operation: 'describe', kind: 'action', id: 'click' } })
      const applied = await runCli(['scenario', 'apply', '--id', 'app.default', '--params', '{}', '--run-root', runRoot, '--run', label])
      expect(applied.code).toBe(0)
      const reset = await runCli(['scenario', 'reset', '--run-root', runRoot, '--run', label])
      expect(reset.code).toBe(0)
      const advanced = await runCli(['clock', 'advance', '--ms', '250', '--timeout-ms', '5000', '--run-root', runRoot, '--run', label])
      expect(advanced.code).toBe(0)
      expectEnvelope(advanced.json, runId)
      expect(advanced.json.result).toMatchObject({ command: 'clock.advance', params: { ms: 250 } })
      for (const operation of ['set', 'clear', 'status']) {
        const fault = await runCli([
          'fault', operation,
          '--params', operation === 'set' ? JSON.stringify({ point: 'transport.connect', effect: { kind: 'disconnect' } }) : '{}',
          '--run-root', runRoot, '--run', label,
        ])
        expect(fault.code).toBe(0)
        expect(fault.json.result.command).toBe(`fault.${operation}`)
      }
    } finally {
      const stopped = await runCli(['stop', '--run-root', runRoot, '--run', label])
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

  it('rejects invalid or repeated semantic labels', async () => {
    const invalid = await runCli(['start', '--label', 'Provider Switch'])
    expect(invalid.code).toBe(1)
    expect(invalid.json).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

    const repeated = await runCli(['start', '--label', 'one', '--label', 'two'])
    expect(repeated.code).toBe(1)
    expect(repeated.json).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('returns the real run and diagnostics when startup fails', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'mortise-ui-cli-failed-start-')); roots.push(runRoot)
    const adapter = JSON.stringify([process.execPath, '-e', "console.error('fixture startup failed'); process.exit(9)"])
    const result = await runCli(['start', '--label', 'failed-start', '--run-root', runRoot, '--adapter-command-json', adapter, '--wait-ms', '1000'])
    expect(result.code).toBe(1)
    expect(result.json.runId).not.toBe('unassigned')
    expect(result.json.error.details.diagnostics).toMatchObject({
      phase: 'endpoint',
      stderrTail: expect.stringContaining('fixture startup failed'),
      cleanup: { attempted: true, remainingPids: [], profileRemoved: true },
    })
    expect(result.json.error.details.nextCommands).toContain('mortise-ui status --run failed-start')
    const evidence = await runCli(['evidence', '--run-root', runRoot, '--run', 'failed-start'])
    expect(evidence.code).toBe(0)
    expect(evidence.json.result).toMatchObject({ hostAvailable: false, manifest: { status: 'failed' } })
    expect(evidence.json.result.artifactManifest.artifacts.some((item: { path: string }) => item.path.endsWith('host.stderr.redacted.log'))).toBe(true)
  }, 10_000)

  it('classifies adapter-reported build failures before the endpoint opens', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'mortise-ui-cli-build-failure-')); roots.push(runRoot)
    const adapter = JSON.stringify([
      process.execPath,
      join(import.meta.dir, 'build-failure.fixture.ts'),
    ])
    const result = await runCli(['start', '--run-root', runRoot, '--adapter-command-json', adapter, '--wait-ms', '1000'])
    expect(result.code).toBe(1)
    expect(result.json.error.details.diagnostics).toMatchObject({
      phase: 'build',
      message: expect.stringContaining('source changed during build'),
    })
  }, 10_000)

  it('closes the diagnostic loop when the final ready-host status fails', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'mortise-ui-cli-final-status-')); roots.push(runRoot)
    const adapter = JSON.stringify([process.execPath, join(import.meta.dir, '..', 'test-host.fixture.ts'), '--fail-final-status'])
    const result = await runCli(['start', '--run-root', runRoot, '--adapter-command-json', adapter, '--wait-ms', '5000'])
    expect(result.code).toBe(1)
    expect(result.json.runId).not.toBe('unassigned')
    expect(result.json.error.details.diagnostics).toMatchObject({
      phase: 'app-readiness',
      cleanup: { remainingPids: [], profileRemoved: true },
    })
  }, 10_000)

  it('makes --no-wait immediate, defaults Electron to background, and stops the full adapter tree', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'mortise-ui-cli-no-wait-')); roots.push(runRoot)
    const adapterPath = join(import.meta.dir, 'process-tree.fixture.ts')
    const adapter = JSON.stringify([process.execPath, adapterPath])
    const started = await runCli(['start', '--run-root', runRoot, '--adapter-command-json', adapter, '--no-wait'])
    expect(started.code).toBe(0)
    expect(started.json.result).toMatchObject({ accepted: true, ready: false, manifest: { windowMode: 'background', status: 'starting' } })
    const manifest = started.json.result.manifest
    const descendantPath = join(manifest.artifactsDir, 'descendant.pid')
    const deadline = Date.now() + 5_000
    while (!existsSync(descendantPath) && Date.now() < deadline) await Bun.sleep(25)
    expect(existsSync(descendantPath)).toBe(true)
    const descendantPid = Number(readFileSync(descendantPath, 'utf8'))
    expect(isPidAlive(descendantPid)).toBe(true)

    const stopped = await runCli(['stop', '--run-root', runRoot, '--run', manifest.runId])
    expect(stopped.code).toBe(0)
    expect(stopped.json.result.manifest.status).toBe('stopped')
    expect(isPidAlive(descendantPid)).toBe(false)
    expect(isPidAlive(manifest.launcherPid)).toBe(false)
  }, 15_000)

  it('rejects background window mode for WebUI runs', async () => {
    const result = await runCli(['start', '--surface', 'webui', '--window-mode', 'background'])
    expect(result.code).toBe(1)
    expect(result.json).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
  })

  it('returns a typed request error for an unreadable fixture', async () => {
    const result = await runCli(['start', '--fixture', join(tmpdir(), 'missing-mortise-ui-fixture.json')])
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

function createExtensionPackage(root: string, id: string): string {
  const extensionRoot = join(root, id)
  mkdirSync(extensionRoot, { recursive: true })
  writeFileSync(join(extensionRoot, 'index.ts'), `export default function ${id.replaceAll('-', '_')}() {}\n`)
  writeFileSync(join(extensionRoot, 'package.json'), JSON.stringify({
    name: `${id}-package`,
    type: 'module',
    pi: {
      extensions: [{
        id,
        path: './index.ts',
        targets: ['mortise'],
        manifest: {
          schemaVersion: 1,
          name: id,
          version: '1.0.0',
          author: { name: 'CLI Test' },
          engines: { mortise: '^0.1.0' },
          capabilities: [],
          permissions: [],
        },
      }],
    },
  }))
  return extensionRoot
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
