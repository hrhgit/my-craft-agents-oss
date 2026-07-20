import { describe, expect, it, mock } from 'bun:test'
import { createAutomationWebhookExecutor } from './automation-webhook-executor.ts'

const context = {
  workspaceId: 'workspace-1',
  attemptId: 'attempt-identity-1234',
  definition: {} as any,
  run: {} as any,
}

describe('automation webhook executor', () => {
  it('adds idempotency identity and encodes JSON bodies', async () => {
    const request = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('attempt-identity-1234')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
      expect(init?.body).toBe('{"ok":true}')
      return new Response('', { status: 204 })
    })
    const execute = createAutomationWebhookExecutor({ fetch: request })
    expect(await execute({ id: 'action-identity-1234', type: 'webhook', url: 'https://example.test/hook', body: { ok: true } }, context))
      .toMatchObject({ status: 'succeeded', details: { kind: 'webhook', statusCode: 204, attempts: 1 } })
  })

  it('blocks unresolved secret references without making a request', async () => {
    const request = mock(async () => new Response('', { status: 204 }))
    const execute = createAutomationWebhookExecutor({ fetch: request })
    expect(await execute({
      id: 'action-identity-1234', type: 'webhook', url: 'https://example.test/hook',
      auth: { type: 'bearer', token: { provider: 'mortise-secrets', id: 'secret-1' } },
    }, context)).toMatchObject({ status: 'blocked', error: { code: 'secret_resolver_unavailable' } })
    expect(request).not.toHaveBeenCalled()
  })

  it('classifies retryable HTTP failures', async () => {
    const execute = createAutomationWebhookExecutor({ fetch: async () => new Response('', { status: 503 }), maxAttempts: 1 })
    expect(await execute({ id: 'action-identity-1234', type: 'webhook', url: 'https://example.test/hook' }, context))
      .toMatchObject({ status: 'failed', error: { code: 'webhook_http_error', retryable: true } })
  })
})
