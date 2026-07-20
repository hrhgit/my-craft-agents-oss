import type {
  AutomationCapabilityResultV1,
  CloudEventV1,
} from '@mortise/shared/automations'
import type { AutomationWorkspaceCommandV1 } from '@mortise/shared/protocol'
import { AutomationIngressTokenRegistry } from './automation-ingress-token-registry.ts'

export const AUTOMATION_INGRESS_CONTENT_TYPE = 'application/cloudevents+json'
export const AUTOMATION_INGRESS_MAX_BYTES = 1_048_576
export const AUTOMATION_INGRESS_PATH_PREFIX = '/api/automations/workspaces/'

export interface AutomationWorkspaceDispatcherV1 {
  execute(
    workspaceId: string,
    command: AutomationWorkspaceCommandV1,
    context: { eventSourceKind: 'external' | 'mortise' | 'agent' | 'extension'; signal?: AbortSignal },
  ): Promise<AutomationCapabilityResultV1<unknown>>
}

export interface AutomationIngressHandlerOptions {
  tokens: AutomationIngressTokenRegistry
  dispatcher: AutomationWorkspaceDispatcherV1
  workspaceExists(workspaceId: string): boolean
  maxBytes?: number
  rateLimit?: { windowMs: number; maxPerSource: number }
  now?: () => number
}

interface SourceRateState { windowStartedAt: number; count: number }

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice(7)
  return token.length > 0 ? token : null
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.toLowerCase()
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === 'localhost'
    || normalized.startsWith('::ffff:127.')
}

async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length')
  if (declared) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) return null
  }
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function routeWorkspace(pathname: string): string | null {
  if (!pathname.startsWith(AUTOMATION_INGRESS_PATH_PREFIX) || !pathname.endsWith('/events')) return null
  const encoded = pathname.slice(AUTOMATION_INGRESS_PATH_PREFIX.length, -'/events'.length)
  if (!encoded || encoded.includes('/')) return null
  try {
    const workspaceId = decodeURIComponent(encoded)
    return workspaceId.length > 0 && workspaceId.length <= 256 ? workspaceId : null
  } catch {
    return null
  }
}

/**
 * CloudEvents structured-content ingress. Returns null for unrelated routes so
 * the caller can compose it with WebUI/static HTTP handling.
 */
export function createAutomationIngressHandler(options: AutomationIngressHandlerOptions) {
  const maxBytes = options.maxBytes ?? AUTOMATION_INGRESS_MAX_BYTES
  const rate = options.rateLimit ?? { windowMs: 60_000, maxPerSource: 60 }
  const now = options.now ?? Date.now
  const sourceRates = new Map<string, SourceRateState>()

  return async (request: Request, peerAddress?: string): Promise<Response | null> => {
    const url = new URL(request.url)
    const workspaceId = routeWorkspace(url.pathname)
    if (!workspaceId) return null
    if (request.method !== 'POST') return json(405, { accepted: false, error: { code: 'method_not_allowed', message: 'Use POST' } })
    if (!isLoopbackAddress(peerAddress)) return json(403, { accepted: false, error: { code: 'loopback_required', message: 'Automation event ingress is loopback-only' } })
    if (!options.workspaceExists(workspaceId)) return json(404, { accepted: false, error: { code: 'workspace_not_found', message: 'Workspace not found' } })
    const token = bearerToken(request)
    if (!token || !options.tokens.verify(workspaceId, token)) {
      return json(401, { accepted: false, error: { code: 'invalid_token', message: 'Invalid workspace capability token' } })
    }
    if (request.headers.get('content-type')?.toLowerCase() !== AUTOMATION_INGRESS_CONTENT_TYPE) {
      return json(415, { accepted: false, error: { code: 'unsupported_content_type', message: `Content-Type must be ${AUTOMATION_INGRESS_CONTENT_TYPE}` } })
    }

    const bytes = await readBoundedBody(request, maxBytes)
    if (!bytes) return json(413, { accepted: false, error: { code: 'event_too_large', message: `Event exceeds ${maxBytes} bytes` } })

    let event: CloudEventV1
    try {
      event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as CloudEventV1
    } catch {
      return json(400, { accepted: false, error: { code: 'invalid_json', message: 'Request body must be valid UTF-8 JSON' } })
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.source !== 'string') {
      return json(400, { accepted: false, error: { code: 'invalid_cloudevent', message: 'CloudEvent source is required' } })
    }
    if (event.mortiseworkspaceid && event.mortiseworkspaceid !== workspaceId) {
      return json(400, { accepted: false, error: { code: 'workspace_mismatch', message: 'CloudEvent workspace does not match the authenticated route' } })
    }
    const authorization = options.tokens.authorizeEvent(workspaceId, token, event)
    if (!authorization.authorized) {
      return json(403, { accepted: false, error: { code: authorization.reason, message: 'The ingress credential does not allow this event namespace' } })
    }

    const rateKey = `${workspaceId}\n${authorization.producerId}`
    const timestamp = now()
    const current = sourceRates.get(rateKey)
    const state = !current || timestamp - current.windowStartedAt >= rate.windowMs
      ? { windowStartedAt: timestamp, count: 0 }
      : current
    if (state.count >= rate.maxPerSource) {
      return json(429, { accepted: false, error: { code: 'source_rate_limited', message: 'Event source rate limit exceeded' } })
    }
    state.count += 1
    sourceRates.set(rateKey, state)
    if (sourceRates.size > 2_000) {
      for (const [key, value] of sourceRates) {
        if (timestamp - value.windowStartedAt >= rate.windowMs) sourceRates.delete(key)
      }
    }

    const operationId = `http:${event.source}:${event.id}`
    let result: AutomationCapabilityResultV1<unknown>
    try {
      result = await options.dispatcher.execute(workspaceId, {
        schemaVersion: 1,
        operation: 'emit-event',
        operationId,
        event,
      }, { eventSourceKind: 'external', signal: request.signal })
    } catch (error) {
      return json(503, { accepted: false, error: { code: 'dispatcher_unavailable', message: error instanceof Error ? error.message : String(error) } })
    }

    const error = result.error ?? { code: 'event_rejected', message: `Event was not accepted (${result.status})`, retryable: false }
    if (result.status === 'conflict' || error.code === 'identity_conflict') {
      return json(409, { accepted: false, error })
    }
    if (result.status !== 'accepted' && result.status !== 'duplicate') {
      return json(result.status === 'unsupported' ? 503 : 400, { accepted: false, error })
    }
    const data = result.data as { eventId?: string; runIds?: string[]; persisted?: boolean } | undefined
    if (!data?.eventId || data.persisted !== true) {
      return json(503, { accepted: false, error: { code: 'durability_not_confirmed', message: 'Dispatcher did not confirm durable acceptance' } })
    }
    return json(202, {
      accepted: true,
      eventId: data.eventId,
      duplicate: result.status === 'duplicate',
      persisted: true,
      runIds: data.runIds ?? [],
    })
  }
}

export { isLoopbackAddress as isAutomationIngressLoopbackAddress }
