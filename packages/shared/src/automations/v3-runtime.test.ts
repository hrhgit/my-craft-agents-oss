import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationV3Runtime } from './v3-runtime.ts'
import { AutomationV3Store } from './v3-store.ts'
import type { AutomationsDocumentV3 } from './v3-types.ts'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('AutomationV3Runtime', () => {
  it('persists, matches, executes ordered actions, and aggregates partial state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-runtime-'))
    roots.push(root)
    const store = new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root })
    const initial = store.initialize()
    const document: AutomationsDocumentV3 = {
      schemaVersion: 3,
      revision: initial.revision,
      definitions: [{
        id: 'aut_123456789abc', name: 'CI failure', enabled: true,
        triggers: [{ id: 'trg_123456789abc', type: 'event', source: 'external', eventType: 'tests.failed' }],
        actions: [
          { id: 'act_123456789abc', type: 'prompt', prompt: 'inspect', target: { kind: 'new-session' } },
          { id: 'act_123456789abd', type: 'webhook', url: 'https://example.test' },
        ],
        createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z',
      }],
    }
    expect(store.mutateDocument({ operationId: 'operation-definition-0001', expectedRevision: 1, document }).status).toBe('ok')
    const order: string[] = []
    const runtime = new AutomationV3Runtime({
      workspaceId: 'workspace-one', store,
      callbacks: {
        prompt: async () => { order.push('prompt'); return { status: 'succeeded', sessionId: 'session_123456789' } },
        webhook: async () => { order.push('webhook'); return { status: 'failed', error: { code: 'http_500', message: 'failed' } } },
      },
    })
    const event = { specversion: '1.0' as const, id: 'event-one', source: 'urn:test', type: 'tests.failed', time: '2026-07-20T00:00:00Z', data: {} }
    const result = await runtime.emitEvent(event, { sourceKind: 'external' })
    expect(result.status).toBe('accepted')
    expect(order).toEqual(['prompt', 'webhook'])
    expect(result.runs[0]?.state).toBe('partial')
    expect(store.listRuns()).toHaveLength(1)
    const duplicate = await runtime.emitEvent(event, { sourceKind: 'external' })
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.status).toBe('duplicate')
    expect(store.listRuns()).toHaveLength(1)
    const conflict = await runtime.emitEvent({ ...event, data: { changed: true } }, { sourceKind: 'external' })
    expect(conflict).toMatchObject({
      status: 'conflict',
      duplicate: false,
      error: { code: 'identity_conflict', retryable: false },
    })
    store.close()
  })

  it('cancels a callback that returns after its abort signal instead of recording success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-runtime-abort-'))
    roots.push(root)
    const store = new AutomationV3Store({ workspaceId: 'workspace-abort', workspaceRootPath: root })
    const initial = store.initialize()
    const now = new Date().toISOString()
    const definition = {
      id: 'aut_abort_callback', name: 'Abort callback', enabled: true,
      triggers: [{ id: 'trg_abort_callback', type: 'event' as const, source: 'mortise' as const, eventType: 'manual' }],
      actions: [{ id: 'act_abort_callback', type: 'prompt' as const, prompt: 'wait', target: { kind: 'new-session' as const } }],
      createdAt: now, updatedAt: now,
    }
    expect(store.mutateDocument({
      operationId: 'operation-abort-callback-definition',
      expectedRevision: initial.revision,
      document: { ...initial, definitions: [definition] },
    }).status).toBe('ok')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const callbackStarted = new Promise<void>(resolve => { started = resolve })
    const runtime = new AutomationV3Runtime({
      workspaceId: 'workspace-abort', store,
      callbacks: {
        prompt: async () => { started(); await gate; return { status: 'succeeded' } },
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    const controller = new AbortController()
    const execution = runtime.runManual(definition.id, 'manual-abort-callback', undefined, controller.signal)
    await callbackStarted
    controller.abort(new Error('test abort'))
    release()
    await expect(execution).resolves.toMatchObject({
      run: {
        state: 'cancelled',
        reason: 'execution-aborted',
        actions: [{ state: 'cancelled' }],
      },
    })
    store.close()
  })
})
