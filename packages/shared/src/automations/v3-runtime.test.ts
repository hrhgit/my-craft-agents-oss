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
    const initial = store.initializeOrMigrate().document
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

  it('records once misfire skips without disabling definitions that have other triggers', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-runtime-'))
    roots.push(root)
    const store = new AutomationV3Store({ workspaceId: 'workspace-once', workspaceRootPath: root })
    const initial = store.initializeOrMigrate().document
    const onceTrigger = {
      id: 'trg_once_skip_123', type: 'time' as const,
      schedule: { kind: 'once' as const, at: '2026-07-20T09:00:00Z', misfire: 'skip' as const },
    }
    const definition = {
      id: 'aut_once_skip_123', name: 'Once plus event', enabled: true,
      triggers: [
        onceTrigger,
        { id: 'trg_event_123456', type: 'event' as const, source: 'mortise' as const, eventType: 'mortise.test' },
      ],
      actions: [{ id: 'act_once_skip_123', type: 'prompt' as const, prompt: 'inspect', target: { kind: 'new-session' as const } }],
      createdAt: '2026-07-20T00:00:00Z', updatedAt: '2026-07-20T00:00:00Z',
    }
    expect(store.mutateDocument({
      operationId: 'operation-once-definition', expectedRevision: initial.revision,
      document: { ...initial, definitions: [definition] },
    }).status).toBe('ok')
    const runtime = new AutomationV3Runtime({
      workspaceId: 'workspace-once', store,
      callbacks: {
        prompt: async () => ({ status: 'succeeded' }),
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    const run = runtime.acceptTimeTrigger(definition, onceTrigger, {
      occurrenceKey: '2026-07-20T09:00:00.000Z', scheduledAt: '2026-07-20T09:00:00.000Z',
      recovery: true, skipReason: 'misfire',
    })
    expect(run).toMatchObject({ state: 'skipped', reason: 'misfire-skip' })
    expect(store.initializeOrMigrate().document.definitions[0]?.enabled).toBe(true)
    store.close()
  })
})
