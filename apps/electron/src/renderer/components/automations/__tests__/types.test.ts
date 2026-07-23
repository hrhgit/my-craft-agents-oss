import { describe, expect, it } from 'bun:test'
import { parseAutomationDefinitionsV3 } from '../types'

describe('parseAutomationDefinitionsV3', () => {
  it('rejects non-list and malformed current definitions', () => {
    expect(parseAutomationDefinitionsV3(null)).toEqual([])
    expect(parseAutomationDefinitionsV3({ automations: {} })).toEqual([])
    expect(parseAutomationDefinitionsV3([{}])).toEqual([])
  })

  it('projects interval, prompt target, and canonical definition identity', () => {
    const now = '2026-07-20T00:00:00.000Z'
    const [item] = parseAutomationDefinitionsV3([{
      id: 'automation-v3-test', name: 'Interval review', enabled: true,
      triggers: [{ id: 'trigger-v3-test', type: 'time', schedule: { kind: 'interval', everyMs: 60_000, anchorAt: now } }],
      actions: [{ id: 'action-v3-test', type: 'prompt', prompt: 'review', target: { kind: 'isolated-agent', model: 'test-model' } }],
      createdAt: now, updatedAt: now,
    }])
    expect(item).toMatchObject({
      id: 'automation-v3-test', event: 'SchedulerTick', summary: 'Every 60 seconds',
      actions: [{ type: 'prompt', prompt: 'review', model: 'test-model' }],
      definition: { id: 'automation-v3-test' },
    })
    expect(item).not.toHaveProperty('matcherIndex')
  })
})
