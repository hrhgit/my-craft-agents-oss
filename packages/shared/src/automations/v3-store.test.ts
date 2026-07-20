import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationV3Store } from './v3-store.ts'
import type { AutomationsDocumentV3 } from './v3-types.ts'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function open() {
  const root = mkdtempSync(join(tmpdir(), 'mortise-automations-v3-'))
  roots.push(root)
  return new AutomationV3Store({ workspaceId: 'workspace-one', workspaceRootPath: root })
}

describe('AutomationV3Store', () => {
  it('enforces revision CAS and operation replay', () => {
    const store = open()
    const initial = store.initializeOrMigrate().document
    const next: AutomationsDocumentV3 = { ...initial, definitions: [] }
    const applied = store.mutateDocument({ operationId: 'operation-create-0001', expectedRevision: 1, document: next })
    expect(applied.status).toBe('ok')
    expect(applied.revision).toBe(2)
    const replay = store.mutateDocument({ operationId: 'operation-create-0001', expectedRevision: 1, document: next })
    expect(replay.status).toBe('duplicate')
    const stale = store.mutateDocument({ operationId: 'operation-create-0002', expectedRevision: 1, document: next })
    expect(stale.status).toBe('conflict')
    expect(stale.revision).toBe(2)
    store.close()
  })

  it('deduplicates CloudEvents by source/id and detects changed payloads', () => {
    const store = open()
    const event = { specversion: '1.0', id: 'event-one', source: 'urn:test:ci', type: 'tests.failed', time: '2026-07-20T00:00:00Z', data: { code: 1 } }
    const accepted = store.acceptCloudEvent(event, { sourceKind: 'external' })
    expect(accepted.status).toBe('accepted')
    expect(accepted.data?.acceptedAt).not.toBe(event.time)
    expect(Date.parse(accepted.data!.acceptedAt)).toBeGreaterThan(Date.parse(event.time))
    expect(store.acceptCloudEvent(event, { sourceKind: 'external' }).status).toBe('duplicate')
    expect(store.acceptCloudEvent({ ...event, data: { code: 2 } }, { sourceKind: 'external' }).status).toBe('conflict')
    store.close()
  })

  it('overwrites untrusted workspace identity and rejects foreign Sessions', () => {
    const store = open()
    const result = store.acceptCloudEvent({
      specversion: '1.0', id: 'event-two', source: 'urn:test', type: 'test', time: '2026-07-20T00:00:00Z',
      mortiseworkspaceid: 'other', mortisesessionid: 'session-other', data: {},
    }, { sourceKind: 'external', validateSession: () => false })
    expect(result.status).toBe('invalid')
    expect(result.error?.code).toBe('invalid_event_session')
    store.close()
  })
})
