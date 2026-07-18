import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CRAFT_UI_PROTOCOL_VERSION, type CraftUiRequest, type CraftUiResponse } from './protocol.ts'
import { writeJsonAtomic } from './files.ts'

const runId = process.env.CRAFT_UI_RUN_ID!
const surface = process.env.CRAFT_UI_SURFACE as 'electron' | 'webui'
const token = process.env.CRAFT_UI_TOKEN!
const endpointPath = process.env.CRAFT_UI_ENDPOINT_MANIFEST!
const artifactsDir = process.env.CRAFT_UI_ARTIFACTS_DIR!
const failFinalStatus = process.argv.includes('--fail-final-status')

let server: ReturnType<typeof Bun.serve>
let seq = 0
server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/command') return new Response('Not found', { status: 404 })
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
    const body = await request.json() as CraftUiRequest
    seq += 1
    if (failFinalStatus && body.method === 'app.status') {
      return Response.json({
        v: CRAFT_UI_PROTOCOL_VERSION,
        kind: 'response',
        id: body.id,
        requestId: body.requestId,
        runId,
        seq,
        revision: seq,
        verificationLevel: 'native-verified',
        ok: false,
        error: { code: 'NOT_READY', message: 'fixture final status failure' },
      } satisfies CraftUiResponse)
    }
    const response: CraftUiResponse = {
      v: CRAFT_UI_PROTOCOL_VERSION,
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
    if (body.method === 'ui.snapshot' || body.method === 'evidence.capture') {
      const name = body.method === 'ui.snapshot' ? 'snapshot' : 'evidence'
      const path = join(artifactsDir, `${name}.json`)
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
  protocolVersion: CRAFT_UI_PROTOCOL_VERSION,
  runId,
  surface,
  transport: 'http',
  url: `http://127.0.0.1:${server.port}`,
  pid: process.pid,
  readyAt: new Date().toISOString(),
})

process.stdout.write(`test host ready token=${token}\n`)
