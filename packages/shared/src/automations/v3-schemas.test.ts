import { describe, expect, it } from 'bun:test'
import { AutomationRunV1Schema, AutomationsDocumentV3Schema, CloudEventV1Schema } from './v3-schemas.ts'

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

  it('rejects removed isolated targets and misfire policies', () => {
    const isolated = document()
    isolated.definitions[0]!.actions = [{
      id: 'act_123456789abc', type: 'prompt', prompt: 'inspect', target: { kind: 'isolated-agent' },
    }] as never
    expect(AutomationsDocumentV3Schema.safeParse(isolated).success).toBe(false)

    const misfire = document()
    misfire.definitions[0]!.triggers = [{
      id: 'trg_123456789abc', type: 'time',
      schedule: { kind: 'once', at: now, misfire: 'run-once' },
    }] as never
    expect(AutomationsDocumentV3Schema.safeParse(misfire).success).toBe(false)
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

  it('rejects semantically invalid durable run identities, states, and timestamps', () => {
    const value = document().definitions[0]!
    const run = {
      schemaVersion: 1,
      runId: 'run-schema-0001',
      occurrenceId: 'occurrence-schema-0001',
      occurrenceKey: 'schema-key',
      automationId: value.id,
      definitionRevision: 1,
      definitionSnapshot: value,
      triggerId: value.triggers[0]!.id,
      state: 'queued',
      createdAt: '2026-07-26T00:00:00.000Z',
      actions: value.actions.map(action => ({
        actionRunId: `run-action-${action.id}`,
        actionId: action.id,
        state: 'queued',
        attempts: 0,
      })),
    }
    expect(AutomationRunV1Schema.safeParse(run).success).toBe(true)
    expect(AutomationRunV1Schema.safeParse({ ...run, state: 'unknown' }).success).toBe(false)
    expect(AutomationRunV1Schema.safeParse({ ...run, createdAt: 'not-a-date' }).success).toBe(false)
    expect(AutomationRunV1Schema.safeParse({ ...run, automationId: 'automation-other-0001' }).success).toBe(false)
  })
})
