import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MORTISE_UI_PROTOCOL_VERSION, type MortiseUiRequest, type MortiseUiResponse } from './protocol.ts'
import { writeJsonAtomic } from './files.ts'

const runId = process.env.MORTISE_UI_RUN_ID!
const surface = process.env.MORTISE_UI_SURFACE as 'electron' | 'webui'
const token = process.env.MORTISE_UI_TOKEN!
const endpointPath = process.env.MORTISE_UI_ENDPOINT_MANIFEST!
const artifactsDir = process.env.MORTISE_UI_ARTIFACTS_DIR!
const failFinalStatus = process.argv.includes('--fail-final-status')

let server: ReturnType<typeof Bun.serve>
let seq = 0
server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/command') return new Response('Not found', { status: 404 })
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
    const body = await request.json() as MortiseUiRequest
    seq += 1
    if (failFinalStatus && body.method === 'app.status') {
      return Response.json({
        v: MORTISE_UI_PROTOCOL_VERSION,
        kind: 'response',
        id: body.id,
        requestId: body.requestId,
        runId,
        seq,
        revision: seq,
        verificationLevel: 'native-verified',
        ok: false,
        error: { code: 'NOT_READY', message: 'fixture final status failure' },
      } satisfies MortiseUiResponse)
    }
    const response: MortiseUiResponse = {
      v: MORTISE_UI_PROTOCOL_VERSION,
      kind: 'response',
      id: body.id,
      requestId: body.requestId,
      runId,
      seq,
      revision: seq,
      verificationLevel: 'native-verified',
      ok: true,
      result: { command: body.method, params: body.params, surface },
    }
    if (body.method === 'ui.action') {
      response.result = {
        command: body.method,
        params: body.params,
        surface,
        actionId: `fixture-action-${seq}`,
        beforeRevision: Math.max(1, seq - 1),
        afterRevision: seq,
        targetResolved: { ref: `fixture:${seq}`, role: 'button', name: 'Reload extensions' },
        settledBy: ['fixture'],
        warnings: [],
        mode: 'semantic',
      }
    }
    if (body.method === 'ui.snapshot' || body.method === 'evidence.capture') {
      const name = body.method === 'ui.snapshot' ? 'snapshot' : 'evidence'
      const path = join(artifactsDir, `${name}.json`)
      if (body.method === 'ui.snapshot') {
        response.result = {
          ...(response.result as object),
          revision: seq,
          window: { webContentsId: 1, workspaceId: 'fixture-workspace', role: 'main', title: 'Mortise Fixture', url: 'fixture://mortise', bounds: { x: 0, y: 0, width: 1280, height: 800 } },
          regions: {
            navigation: [], sidebar: [], dialog: [], notification: [],
            main: [{ ref: `fixture:${seq}:reload`, semanticId: 'settings.extensions.reload', role: 'button', name: 'Reload extensions', state: {}, actions: ['click'] }],
          },
          truncated: false,
        }
      }
      writeFileSync(path, JSON.stringify(response.result), 'utf8')
      response.result = { ...(response.result as object), artifacts: [{
        kind: 'semantic-snapshot',
        path,
        sha256: 'fixture',
        mimeType: 'application/json',
        sizeBytes: 1,
      }] }
    }
    if (body.method === 'app.shutdown') {
      setTimeout(() => { server.stop(true); process.exit(0) }, 20)
    }
    return Response.json(response)
  },
})

writeJsonAtomic(endpointPath, {
  protocolVersion: MORTISE_UI_PROTOCOL_VERSION,
  runId,
  surface,
  transport: 'http',
  url: `http://127.0.0.1:${server.port}`,
  pid: process.pid,
  readyAt: new Date().toISOString(),
})

process.stdout.write(`test host ready token=${token}\n`)
