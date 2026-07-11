import { describe, expect, it, mock } from 'bun:test'
import type { CapabilityRequestV1 } from '@craft-agent/shared/protocol'
import { createCapabilityAuthorizationPolicy } from '../policy.ts'

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
    expect(await authorize(request({ capability: 'credentials.keychain', operation: 'read' }))).toMatchObject({ allowed: false })
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

  it('requires confirmation for account mutations but not secret-free status', async () => {
    const prompt = mock(async () => true)
    const authorize = createCapabilityAuthorizationPolicy({
      sessionExists: () => true,
      rules: [
        { capability: 'oauth.flow', operations: ['begin', 'revoke'], decision: 'prompt' },
        { capability: 'oauth.flow', operations: ['status', 'cancel'], decision: 'allow' },
        { capability: 'credentials.keychain', operations: ['has'], decision: 'allow' },
        { capability: 'credentials.keychain', operations: ['remove'], decision: 'prompt' },
      ],
      prompt,
    })
    expect(await authorize(request({ capability: 'oauth.flow', operation: 'status' }))).toEqual({ allowed: true })
    expect(await authorize(request({ capability: 'credentials.keychain', operation: 'has' }))).toEqual({ allowed: true })
    expect(await authorize(request({ capability: 'oauth.flow', operation: 'begin' }))).toEqual({ allowed: true })
    expect(await authorize(request({ capability: 'credentials.keychain', operation: 'remove' }))).toEqual({ allowed: true })
    expect(prompt).toHaveBeenCalledTimes(2)
  })
})
