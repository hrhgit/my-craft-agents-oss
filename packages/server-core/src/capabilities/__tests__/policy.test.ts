import { describe, expect, it, mock } from 'bun:test'
import type { CapabilityRequestV1 } from '@mortise/shared/protocol'
import { createCapabilityAuthorizationPolicy, ELECTRON_CAPABILITY_POLICY_V1 } from '../policy.ts'

const request = (overrides: Partial<CapabilityRequestV1> = {}): CapabilityRequestV1 => ({
  version: 1,
  requestId: 'request-1',
  capability: 'browser.open',
  operation: 'navigate',
  sessionId: 'session-1',
  runtimeId: 'runtime-1',
  extensionId: 'extension-1',
  input: {},
  ...overrides,
})

describe('capability authorization policy', () => {
  it('fails closed for inactive sessions and operations without an explicit rule', async () => {
    const authorize = createCapabilityAuthorizationPolicy({
      sessionExists: id => id === 'session-1',
      rules: [{ capability: 'browser.open', operations: ['navigate'], decision: 'allow' }],
    })

    expect(await authorize(request({ sessionId: 'other' }))).toMatchObject({ allowed: false })
    expect(await authorize(request({ operation: 'evaluate' }))).toMatchObject({ allowed: false })
    expect(await authorize(request({ capability: 'unknown.capability', operation: 'read' }))).toMatchObject({ allowed: false })
    expect(await authorize(request())).toEqual({ allowed: true })
  })

  it('supports extension-scoped grants and fail-closed user confirmation', async () => {
    const prompt = mock(async () => true)
    const rules = [{
      capability: 'oauth.begin', operations: ['authorize'], decision: 'prompt' as const,
      extensionIds: ['trusted-extension'],
    }]
    const withoutPrompt = createCapabilityAuthorizationPolicy({ sessionExists: () => true, rules })
    expect(await withoutPrompt(request({ capability: 'oauth.begin', operation: 'authorize', extensionId: 'trusted-extension' })))
      .toMatchObject({ allowed: false })

    const authorize = createCapabilityAuthorizationPolicy({ sessionExists: () => true, rules, prompt })
    expect(await authorize(request({ capability: 'oauth.begin', operation: 'authorize', extensionId: 'other' })))
      .toMatchObject({ allowed: false })
    expect(await authorize(request({ capability: 'oauth.begin', operation: 'authorize', extensionId: 'trusted-extension' })))
      .toEqual({ allowed: true })
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('uses one canonical automation surface and keeps mutations confirmable', () => {
    const automationRules = ELECTRON_CAPABILITY_POLICY_V1.filter(rule => rule.capability.includes('automation') || rule.capability.includes('scheduler') || rule.capability.includes('webhook'))
    expect(automationRules.every(rule => rule.capability === 'automation.workspace')).toBe(true)
    expect(automationRules.find(rule => rule.decision === 'allow')?.operations).toContain('simulate')
    const promptedOperations = automationRules.filter(rule => rule.decision === 'prompt').flatMap(rule => [...rule.operations])
    expect(promptedOperations).toContain('emit-event')
    expect(promptedOperations).toContain('list')
    expect(promptedOperations).toContain('get-run')
  })
})
