import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MortiseUiClientError, createMortiseUiSurfaceDriver, readEndpointManifest, requestMortiseUiHost } from '../client.ts'
import { MORTISE_UI_PROTOCOL_VERSION } from '../protocol.ts'

const roots: string[] = []
const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('mortise-ui endpoint validation', () => {
  it('rejects non-loopback and hostname-based endpoints', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-client-')); roots.push(root)
    for (const url of ['http://192.168.1.4:9999', 'https://127.0.0.1:9999', 'http://localhost:9999']) {
      const path = join(root, `${Math.random()}.json`)
      writeFileSync(path, JSON.stringify({
        protocolVersion: MORTISE_UI_PROTOCOL_VERSION,
        runId: 'run', surface: 'electron', transport: 'http', url, pid: 1, readyAt: new Date().toISOString(),
      }))
      expect(() => readEndpointManifest(path)).toThrow(MortiseUiClientError)
    }
  })

  it('rejects a response whose requestId does not match the request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-ui-client-')); roots.push(root)
    const runId = 'request-id-test'
    const tokenPath = join(root, 'token')
    const endpointManifestPath = join(root, 'endpoint.json')
    writeFileSync(tokenPath, 'secret-token')
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        const body = await request.json() as { id: string }
        return Response.json({
          v: MORTISE_UI_PROTOCOL_VERSION, kind: 'response', id: body.id, requestId: 'different-request', runId,
          seq: 1, revision: 1, verificationLevel: 'scenario-verified', ok: true, result: {},
        })
      },
    })
    servers.push(server)
    writeFileSync(endpointManifestPath, JSON.stringify({
      protocolVersion: MORTISE_UI_PROTOCOL_VERSION, runId, surface: 'webui', transport: 'http',
      url: `http://127.0.0.1:${server.port}`, pid: process.pid, readyAt: new Date().toISOString(),
    }))
    await expect(requestMortiseUiHost({ endpointManifestPath, tokenPath, runId, command: 'app.status' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})

describe('MortiseUiSurfaceDriver facade', () => {
  it('maps the complete driver contract to bounded JSON protocol commands', async () => {
    const calls: Array<{ command: string; params?: Record<string, unknown>; minimumSeqExclusive?: number }> = []
    let seq = 0
    const driver = createMortiseUiSurfaceDriver({
      endpointManifestPath: 'endpoint.json', tokenPath: 'token', runId: 'run-1', minimumSeqExclusive: 10,
      request: async args => {
        calls.push({ command: args.command, params: args.params, minimumSeqExclusive: args.minimumSeqExclusive })
        seq += 1
        return {
          v: 1, kind: 'response', id: `id-${seq}`, requestId: `id-${seq}`, runId: 'run-1',
          seq: 10 + seq, revision: seq, verificationLevel: 'scenario-verified', ok: true, result: {},
        } as never
      },
    })

    await driver.ready()
    await driver.windows({ workspaceId: 'workspace-1' })
    await driver.snapshot({ sinceRevision: 1 })
    await driver.action({ action: 'click', target: { ref: 'r1:a' }, revision: 1 })
    await driver.wait({ predicate: { kind: 'app-phase', phase: 'ready' } })
    await driver.screenshot({ label: 'ready' })
    await driver.logs({ maxBytes: 4096 })
    await driver.resize({ width: 1280, height: 720 })
    await driver.dispose()

    expect(calls.map(call => call.command)).toEqual([
      'app.status', 'ui.windows', 'ui.snapshot', 'ui.action', 'ui.wait',
      'ui.screenshot', 'ui.logs', 'ui.resize', 'app.shutdown',
    ])
    expect(calls.map(call => call.minimumSeqExclusive)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18])
    expect(calls[1]?.params).toEqual({ workspaceId: 'workspace-1' })
  })

  it('rejects use after disposal without sending another command', async () => {
    let calls = 0
    const driver = createMortiseUiSurfaceDriver({
      endpointManifestPath: 'endpoint.json', tokenPath: 'token', runId: 'run-1',
      request: async () => {
        calls += 1
        return {
          v: 1, kind: 'response', id: 'id', requestId: 'id', runId: 'run-1', seq: calls,
          revision: 0, verificationLevel: 'scenario-verified', ok: true, result: {},
        } as never
      },
    })
    await driver.dispose()
    await expect(driver.snapshot()).rejects.toMatchObject({ code: 'DRIVER_DISCONNECTED' })
    expect(calls).toBe(1)
  })
})
