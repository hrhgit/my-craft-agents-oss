import type {
  AutomationActionExecutionResultV1,
  AutomationExecutionContextV1,
  SecretReferenceV1,
  WebhookActionV3,
} from '@mortise/shared/automations'

export interface AutomationSecretResolverV1 {
  resolve(reference: SecretReferenceV1, workspaceId: string): Promise<string | null>
}

export interface AutomationWebhookExecutorOptions {
  resolveSecret?: AutomationSecretResolverV1
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  timeoutMs?: number
  maxAttempts?: number
}

const MAX_CAPTURE_BYTES = 16_384

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('Automation action cancelled')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Automation action cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer.unref?.()
  })
}

async function boundedResponseText(response: Response): Promise<string | undefined> {
  const text = await response.text()
  return text ? text.slice(0, MAX_CAPTURE_BYTES) : undefined
}

function encodeBody(action: WebhookActionV3, headers: Headers): string | URLSearchParams | undefined {
  if (action.body === undefined || action.method === 'GET') return undefined
  const format = action.bodyFormat ?? 'json'
  if (format === 'json') {
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    return JSON.stringify(action.body)
  }
  if (format === 'form') {
    if (!action.body || typeof action.body !== 'object' || Array.isArray(action.body)) {
      throw new Error('Form webhook bodies must be JSON objects')
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded')
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(action.body as Record<string, unknown>)) {
      params.set(key, value == null ? '' : String(value))
    }
    return params
  }
  return typeof action.body === 'string' ? action.body : JSON.stringify(action.body)
}

export function createAutomationWebhookExecutor(options: AutomationWebhookExecutorOptions = {}) {
  const request = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 3, 5))
  return async (
    action: WebhookActionV3,
    context: AutomationExecutionContextV1 & { attemptId: string },
  ): Promise<AutomationActionExecutionResultV1> => {
    const headers = new Headers(action.headers)
    if (!headers.has('idempotency-key')) headers.set('idempotency-key', context.attemptId)
    if (action.auth) {
      if (!options.resolveSecret) {
        return { status: 'blocked', error: { code: 'secret_resolver_unavailable', message: 'Webhook secret resolver is not available', retryable: false } }
      }
      const reference = action.auth.type === 'basic' ? action.auth.password : action.auth.token
      const secret = await options.resolveSecret.resolve(reference, context.workspaceId)
      if (!secret) return { status: 'blocked', error: { code: 'secret_not_found', message: 'Webhook secret reference was not found', retryable: false } }
      headers.set('authorization', action.auth.type === 'basic'
        ? `Basic ${Buffer.from(`${action.auth.username}:${secret}`, 'utf8').toString('base64')}`
        : `Bearer ${secret}`)
    }

    const startedAt = Date.now()
    let lastResult: AutomationActionExecutionResultV1 | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(new Error('Webhook request timed out')), timeoutMs)
      const onAbort = () => controller.abort(context.signal?.reason)
      context.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await request(action.url, {
          method: action.method ?? 'POST',
          headers,
          body: encodeBody(action, headers),
          signal: controller.signal,
        })
        const responseBody = action.captureResponse ? await boundedResponseText(response) : undefined
        const details = {
          kind: 'webhook' as const,
          statusCode: response.status,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
          ...(responseBody ? { responseBody } : {}),
        }
        if (response.ok) return { status: 'succeeded', details }
        const retryable = response.status === 429 || response.status >= 500
        lastResult = {
          status: 'failed',
          details,
          error: { code: 'webhook_http_error', message: `Webhook returned HTTP ${response.status}`, retryable },
        }
        if (!retryable || attempt === maxAttempts) return lastResult
      } catch (error) {
        const cancelled = context.signal?.aborted
        lastResult = {
          status: cancelled ? 'cancelled' : 'failed',
          details: { kind: 'webhook', attempts: attempt, durationMs: Date.now() - startedAt },
          error: {
            code: cancelled ? 'action_cancelled' : controller.signal.aborted ? 'webhook_timeout' : 'webhook_network_error',
            message: error instanceof Error ? error.message : String(error),
            retryable: !cancelled,
          },
        }
        if (cancelled || attempt === maxAttempts) return lastResult
      } finally {
        clearTimeout(timeout)
        context.signal?.removeEventListener('abort', onAbort)
      }
      try {
        await delay(attempt === 1 ? 250 : 1_000, context.signal)
      } catch (error) {
        return {
          status: 'cancelled',
          details: { kind: 'webhook', attempts: attempt, durationMs: Date.now() - startedAt },
          error: { code: 'action_cancelled', message: error instanceof Error ? error.message : String(error), retryable: false },
        }
      }
    }
    return lastResult ?? { status: 'failed', error: { code: 'webhook_failed', message: 'Webhook execution failed', retryable: false } }
  }
}
