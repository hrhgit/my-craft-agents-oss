import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { UI_VALIDATION_EXTENDED_TIMEOUT_MS } from '@mortise/shared/ui-validation'
import {
  MORTISE_UI_PROTOCOL_VERSION,
  type MortiseUiEndpointManifest,
  type MortiseUiRequest,
  type MortiseUiResponse,
  type MortiseUiSurfaceDriver,
} from './protocol.ts'

export class MortiseUiClientError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'MortiseUiClientError'
  }
}

export function readEndpointManifest(path: string): MortiseUiEndpointManifest {
  if (!existsSync(path)) throw new MortiseUiClientError('ENDPOINT_NOT_READY', `Endpoint manifest does not exist: ${path}`)
  const endpoint = JSON.parse(readFileSync(path, 'utf8')) as MortiseUiEndpointManifest
  if (endpoint.protocolVersion !== MORTISE_UI_PROTOCOL_VERSION) {
    throw new MortiseUiClientError('PROTOCOL_MISMATCH', `Unsupported host protocol version: ${endpoint.protocolVersion}`)
  }
  const url = new URL(endpoint.url)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(hostname)) {
    throw new MortiseUiClientError('UNSAFE_ENDPOINT', 'Mortise UI host endpoint must use HTTP on a numeric loopback address')
  }
  return endpoint
}

export async function requestMortiseUiHost<T>(args: {
  endpointManifestPath: string
  tokenPath: string
  runId: string
  command: string
  params?: Record<string, unknown>
  timeoutMs?: number
  minimumSeqExclusive?: number
}): Promise<MortiseUiResponse<T>> {
  const endpoint = readEndpointManifest(args.endpointManifestPath)
  if (endpoint.runId !== args.runId) throw new MortiseUiClientError('RUN_ID_MISMATCH', 'Endpoint belongs to a different run')
  const token = readFileSync(args.tokenPath, 'utf8').trim()
  if (!token) throw new MortiseUiClientError('TOKEN_MISSING', 'Run token is empty')
  const requestId = randomUUID()
  const request: MortiseUiRequest = {
    v: MORTISE_UI_PROTOCOL_VERSION,
    kind: 'request',
    id: requestId,
    requestId,
    runId: args.runId,
    method: args.command,
    params: args.params ?? {},
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Mortise UI host request timed out')), args.timeoutMs ?? UI_VALIDATION_EXTENDED_TIMEOUT_MS)
  try {
    const response = await fetch(new URL('/v1/command', endpoint.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null) as MortiseUiResponse<T> | null
    if (
      !payload
      || payload.v !== MORTISE_UI_PROTOCOL_VERSION
      || payload.kind !== 'response'
      || payload.id !== request.id
      || payload.requestId !== request.requestId
      || payload.runId !== args.runId
      || !Number.isSafeInteger(payload.seq) || payload.seq < 0
      || !Number.isSafeInteger(payload.revision) || payload.revision < 0
      || !['scenario-verified', 'renderer-verified', 'native-verified'].includes(payload.verificationLevel)
      || (args.minimumSeqExclusive !== undefined && payload.seq <= args.minimumSeqExclusive)
    ) {
      throw new MortiseUiClientError('INVALID_RESPONSE', `Host returned an invalid response (HTTP ${response.status})`)
    }
    if (!response.ok && payload.ok) throw new MortiseUiClientError('INVALID_RESPONSE', `Host returned HTTP ${response.status} with ok=true`)
    return payload
  } catch (error) {
    if (error instanceof MortiseUiClientError) throw error
    throw new MortiseUiClientError('HOST_UNREACHABLE', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timeout)
  }
}

export function createMortiseUiSurfaceDriver(args: {
  endpointManifestPath: string
  tokenPath: string
  runId: string
  timeoutMs?: number
  minimumSeqExclusive?: number
  request?: typeof requestMortiseUiHost
}): MortiseUiSurfaceDriver {
  const request = args.request ?? requestMortiseUiHost
  let minimumSeqExclusive = args.minimumSeqExclusive
  let disposed = false

  const invoke = async (command: string, params: Record<string, unknown> = {}): Promise<MortiseUiResponse> => {
    if (disposed && command !== 'app.shutdown') {
      throw new MortiseUiClientError('DRIVER_DISCONNECTED', 'Mortise UI surface driver is disposed')
    }
    const response = await request({
      endpointManifestPath: args.endpointManifestPath,
      tokenPath: args.tokenPath,
      runId: args.runId,
      command,
      params,
      timeoutMs: args.timeoutMs,
      minimumSeqExclusive,
    })
    minimumSeqExclusive = Math.max(minimumSeqExclusive ?? -1, response.seq)
    return response
  }

  return {
    ready: params => invoke('app.status', params),
    windows: params => invoke('ui.windows', params),
    snapshot: params => invoke('ui.snapshot', params),
    action: params => invoke('ui.action', params),
    wait: params => invoke('ui.wait', params),
    screenshot: params => invoke('ui.screenshot', params),
    logs: params => invoke('ui.logs', params),
    resize: params => invoke('ui.resize', params),
    async dispose() {
      if (disposed) throw new MortiseUiClientError('DRIVER_DISCONNECTED', 'Mortise UI surface driver is already disposed')
      disposed = true
      return await invoke('app.shutdown')
    },
  }
}
