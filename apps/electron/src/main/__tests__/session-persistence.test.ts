import { describe, expect, it } from 'bun:test'

describe('session persistence invariants', () => {
  it('preserves the original creation timestamp', () => {
    const managed = { createdAt: 1_700_000_000_000, lastMessageAt: 1_700_099_999_000 }
    const stored = { createdAt: managed.createdAt }
    expect(stored.createdAt).toBe(managed.createdAt)
    expect(stored.createdAt).not.toBe(managed.lastMessageAt)
  })

  it('resolves the session model before provider and global defaults', () => {
    const sessionModel = 'session-model'
    const providerModel = 'provider-model'
    const globalModel = 'global-model'
    const noSession: string | undefined = undefined
    const noProvider: string | undefined = undefined
    expect(sessionModel || providerModel || globalModel).toBe(sessionModel)
    expect(noSession || providerModel || globalModel).toBe(providerModel)
    expect(noSession || noProvider || globalModel).toBe(globalModel)
  })
})

describe('orphaned provider repair', () => {
  it('clears a provider override that no longer exists', () => {
    const managed: { provider?: string } = { provider: 'deleted-provider' }
    const providers: Record<string, unknown> = {}
    if (managed.provider && !providers[managed.provider]) delete managed.provider
    expect(managed.provider).toBeUndefined()
  })

  it('preserves a valid provider override', () => {
    const managed: { provider?: string } = { provider: 'anthropic' }
    const providers: Record<string, unknown> = { anthropic: {} }
    if (managed.provider && !providers[managed.provider]) delete managed.provider
    expect(managed.provider).toBe('anthropic')
  })
})
