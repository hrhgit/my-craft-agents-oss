import { describe, expect, it } from 'bun:test'
import { AutomationsDocumentV3Schema, CloudEventV1Schema } from './v3-schemas.ts'

const now = '2026-07-20T00:00:00.000Z'

function document(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    revision: 1,
    definitions: [{
      id: 'aut_123456789abc',
      name: 'Test',
      enabled: true,
      triggers: [{ id: 'trg_123456789abc', type: 'event', source: 'external', eventType: 'tests.failed' }],
      actions: [{ id: 'act_123456789abc', type: 'prompt', prompt: 'inspect', target: { kind: 'new-session' } }],
      createdAt: now,
      updatedAt: now,
    }],
    ...overrides,
  }
}

describe('Automations V3 schemas', () => {
  it('accepts the strict V3 document and rejects unknown major fields', () => {
    expect(AutomationsDocumentV3Schema.safeParse(document()).success).toBe(true)
    expect(AutomationsDocumentV3Schema.safeParse(document({ unknown: true })).success).toBe(false)
    expect(AutomationsDocumentV3Schema.safeParse({ ...document(), schemaVersion: 4 }).success).toBe(false)
  })

  it('rejects event-session targets on definitions containing a time trigger', () => {
    const value = document()
    value.definitions[0]!.triggers = [{ id: 'trg_123456789abc', type: 'time', schedule: { kind: 'once', at: now } }] as never
    value.definitions[0]!.actions = [{
      id: 'act_123456789abc', type: 'prompt', prompt: 'inspect',
      target: { kind: 'session', session: 'event-session', delivery: 'followUp' },
    }] as never
    expect(AutomationsDocumentV3Schema.safeParse(value).success).toBe(false)
  })

  it('requires CloudEvents 1.0 required attributes and JSON data', () => {
    const event = { specversion: '1.0', id: 'one', source: 'urn:test', type: 'tests.failed', time: now, data: { exitCode: 1 } }
    expect(CloudEventV1Schema.safeParse(event).success).toBe(true)
    expect(CloudEventV1Schema.safeParse({ ...event, specversion: '0.3' }).success).toBe(false)
    expect(CloudEventV1Schema.safeParse({ ...event, data: undefined }).success).toBe(false)
  })

  it('rejects unsafe matchers and semantically invalid condition times', () => {
    const unsafe = document()
    unsafe.definitions[0]!.triggers[0] = { ...unsafe.definitions[0]!.triggers[0], matcher: '(a+)+' }
    expect(AutomationsDocumentV3Schema.safeParse(unsafe).success).toBe(false)
    const invalidTime = document()
    invalidTime.definitions[0]!.conditions = [{ condition: 'time', after: '25:99' }] as never
    expect(AutomationsDocumentV3Schema.safeParse(invalidTime).success).toBe(false)
  })
})
