import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationWorkspaceCommandV1 } from '@mortise/shared/protocol'
import {
  AUTOMATION_INGRESS_CONTENT_TYPE,
  createAutomationIngressHandler,
  type AutomationWorkspaceDispatcherV1,
} from './automation-ingress.ts'
import { AutomationIngressTokenRegistry } from './automation-ingress-token-registry.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(result: Record<string, unknown> = {
  schemaVersion: 1,
  operationId: 'op',
  status: 'accepted',
  data: { eventId: 'event-identity-1234', runIds: [], persisted: true },
}) {
  const root = mkdtempSync(join(tmpdir(), 'mortise-automation-ingress-'))
  roots.push(root)
  const tokens = new AutomationIngressTokenRegistry(root)
  const { path } = tokens.ensure('workspace-1')
  const stored = JSON.parse(readFileSync(path, 'utf8')) as { token: string }
  const execute = mock(async (_workspaceId: string, _command: AutomationWorkspaceCommandV1) => result as any)
  const handler = createAutomationIngressHandler({
    tokens,
    dispatcher: { execute } as AutomationWorkspaceDispatcherV1,
    workspaceExists: id => id === 'workspace-1',
  })
  return { tokens, path, token: stored.token, execute, handler }
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    specversion: '1.0',
    id: 'event-1',
    source: 'urn:mortise:external:ci',
    type: 'mortise.tests.failed',
    time: '2026-07-20T00:00:00.000Z',
    data: { exitCode: 1 },
    ...overrides,
  }
}

function request(token: string, body: unknown = event(), headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1/api/automations/workspaces/workspace-1/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': AUTOMATION_INGRESS_CONTENT_TYPE,
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe('AutomationIngressTokenRegistry', () => {
  it('creates owner-only workspace credentials and rotates atomically', () => {
    const { tokens, path, token } = setup()
    expect(tokens.verify('workspace-1', token)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    tokens.rotate('workspace-1')
    expect(tokens.verify('workspace-1', token)).toBe(false)
    expect(tokens.pathFor('workspace-1')).toBe(path)
  })
})

describe('CloudEvents HTTP ingress', () => {
  it('authenticates the route, derives external source kind, and returns 202 only after persistence', async () => {
    const { handler, execute, token } = setup()
    const response = await handler(request(token), '127.0.0.1')
    expect(response?.status).toBe(202)
    expect(await response?.json()).toMatchObject({ accepted: true, duplicate: false, persisted: true })
    expect(execute).toHaveBeenCalledWith(
      'workspace-1',
      expect.objectContaining({ operation: 'emit-event', event: expect.objectContaining({ source: 'urn:mortise:external:ci' }) }),
      expect.objectContaining({ eventSourceKind: 'external' }),
    )
  })

  it('rejects non-loopback, wrong tokens, content-type parameters, oversized bodies, and workspace spoofing', async () => {
    const { handler, token } = setup()
    expect((await handler(request(token), '10.0.0.2'))?.status).toBe(403)
    expect((await handler(request('wrong-token'), '127.0.0.1'))?.status).toBe(401)
    expect((await handler(request(token, event(), { 'content-type': `${AUTOMATION_INGRESS_CONTENT_TYPE}; charset=utf-8` }), '127.0.0.1'))?.status).toBe(415)
    expect((await handler(request(token, event(), { 'content-length': '1048577' }), '127.0.0.1'))?.status).toBe(413)
    expect((await handler(request(token, event({ mortiseworkspaceid: 'workspace-2' })), '127.0.0.1'))?.status).toBe(400)
    expect((await handler(request(token, event({ source: 'urn:other:ci' })), '127.0.0.1'))?.status).toBe(403)
    expect((await handler(request(token, event({ type: 'other.failed' })), '127.0.0.1'))?.status).toBe(403)
  })

  it('maps duplicate acceptance and source/id conflicts to structured HTTP results', async () => {
    const duplicate = setup({
      schemaVersion: 1, operationId: 'op', status: 'duplicate',
      data: { eventId: 'event-identity-1234', runIds: [], persisted: true },
    })
    const duplicateResponse = await duplicate.handler(request(duplicate.token), '::1')
    expect(duplicateResponse?.status).toBe(202)
    expect(await duplicateResponse?.json()).toMatchObject({ accepted: true, duplicate: true })

    const conflict = setup({
      schemaVersion: 1, operationId: 'op', status: 'conflict',
      error: { code: 'identity_conflict', message: 'different payload', retryable: false },
    })
    const conflictResponse = await conflict.handler(request(conflict.token), '::ffff:127.0.0.1')
    expect(conflictResponse?.status).toBe(409)
    expect(await conflictResponse?.json()).toMatchObject({ accepted: false, error: { code: 'identity_conflict' } })
  })

  it('bounds delivery rate independently by authenticated workspace and event source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automation-ingress-rate-'))
    roots.push(root)
    const tokens = new AutomationIngressTokenRegistry(root)
    const { path } = tokens.ensure('workspace-1')
    const token = (JSON.parse(readFileSync(path, 'utf8')) as { token: string }).token
    const dispatcher = { execute: async () => ({ schemaVersion: 1 as const, operationId: 'op', status: 'accepted' as const, data: { eventId: 'event-identity-1234', runIds: [], persisted: true } }) }
    const handler = createAutomationIngressHandler({
      tokens, dispatcher, workspaceExists: () => true,
      rateLimit: { windowMs: 60_000, maxPerSource: 1 }, now: () => 1_000,
    })
    expect((await handler(request(token), '127.0.0.1'))?.status).toBe(202)
    expect((await handler(request(token, event({ id: 'event-2' })), '127.0.0.1'))?.status).toBe(429)
  })
})
