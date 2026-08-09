import { describe, expect, test } from 'bun:test'
import { buildAutomationDefinition, draftFromDefinition } from './AutomationEditorPanel'
import type { AutomationDefinitionV3UI } from './types'

const existing: AutomationDefinitionV3UI = {
  id: 'aut_existing',
  name: 'Existing',
  description: 'Before',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  triggers: [
    { id: 'trg_primary', type: 'event', source: 'mortise', eventType: 'session.completed' },
    { id: 'trg_extra', type: 'event', source: 'external', eventType: 'external.extra' },
  ],
  actions: [
    { id: 'act_primary', type: 'prompt', prompt: 'Before', target: { kind: 'new-session', thinkingLevel: 'medium' } },
    { id: 'act_extra', type: 'webhook', url: 'https://example.com/hook', method: 'POST' },
  ],
}

describe('AutomationEditorPanel definition mapping', () => {
  test('hydrates the primary trigger and action', () => {
    expect(draftFromDefinition(existing)).toMatchObject({
      name: 'Existing',
      triggerKind: 'event',
      triggerValue: 'session.completed',
      actionKind: 'prompt',
      actionValue: 'Before',
    })
  })

  test('preserves hidden fields and additional triggers and actions when editing', () => {
    const draft = { ...draftFromDefinition(existing), name: ' Updated ', actionValue: 'After' }
    const updated = buildAutomationDefinition(draft, existing, '2026-02-01T00:00:00.000Z')
    expect(updated.name).toBe('Updated')
    expect(updated.actions[0]).toMatchObject({ id: 'act_primary', type: 'prompt', prompt: 'After', target: { thinkingLevel: 'medium' } })
    expect(updated.triggers[1]).toEqual(existing.triggers[1])
    expect(updated.actions[1]).toEqual(existing.actions[1])
    expect(updated.createdAt).toBe(existing.createdAt)
    expect(updated.updatedAt).toBe('2026-02-01T00:00:00.000Z')
  })
})
