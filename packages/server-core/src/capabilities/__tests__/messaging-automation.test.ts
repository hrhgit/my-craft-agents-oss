import { describe, expect, it, mock } from 'bun:test'
import { CapabilityRouter } from '../router.ts'
import { createAutomationWorkspaceCapabilityProvider, createMessagingSessionCapabilityProvider, createScopedAutomationCapabilityProvider } from '../providers/messaging-automation.ts'
import type { CapabilityRequestV1 } from '../types.ts'

function request(capability: string, operation: string, input: unknown = {}): CapabilityRequestV1 {
  return { version: 1, requestId: `${capability}-${operation}`, capability, operation, input,
    sessionId: 'session-1', runtimeId: 'runtime-1', extensionId: 'extension-1' }
}

describe('messaging session capability', () => {
  it('uses Host session identity and exposes only bounded operations', async () => {
    const pair = mock(async () => ({ code: '123456', expiresAt: 42 }))
    const unbind = mock(async () => ({ removed: 1 }))
    const router = new CapabilityRouter()
    router.register(createMessagingSessionCapabilityProvider({
      status: async () => ({ enabled: true, platforms: [] }),
      listBindings: async () => [{ id: 'b1', platform: 'telegram', channelId: 'chat-1', enabled: true, createdAt: 1 }],
      pair,
      unbind,
    }))
    expect(await router.invoke(request('messaging.session', 'pair', { platform: 'telegram' }))).toMatchObject({ status: 'success', output: { code: '123456' } })
    expect(pair).toHaveBeenCalledWith('session-1', 'telegram')
    expect(await router.invoke({ ...request('messaging.session', 'unbind', { platform: 'telegram', sessionId: 'other' }), requestId: 'spoof' })).toMatchObject({ status: 'failed' })
    expect(unbind).not.toHaveBeenCalled()
  })

  it('does not expose credential-management operations', async () => {
    const router = new CapabilityRouter()
    router.register(createMessagingSessionCapabilityProvider({ status: async () => ({ enabled: false, platforms: [] }), listBindings: async () => [], pair: async () => ({ code: '', expiresAt: 0 }), unbind: async () => ({ removed: 0 }) }))
    expect(await router.invoke(request('messaging.session', 'save-token', { token: 'secret' }))).toMatchObject({ status: 'failed' })
  })
})

describe('automation workspace capability', () => {
  it('toggles by stable ID in the Host-resolved session workspace', async () => {
    const setEnabled = mock(async (_sessionId: string, id: string, enabled: boolean) => ({ id, enabled }))
    const router = new CapabilityRouter()
    router.register(createAutomationWorkspaceCapabilityProvider({ status: async () => ({ automationCount: 1, schedulerRunning: true }), list: async () => [], setEnabled }))
    expect(await router.invoke(request('automation.workspace', 'set-enabled', { id: 'auto-1', enabled: false }))).toMatchObject({ status: 'success', output: { id: 'auto-1', enabled: false } })
    expect(setEnabled).toHaveBeenCalledWith('session-1', 'auto-1', false)
  })

  it('rejects execution, webhook, prompt, and file mutation inputs', async () => {
    const setEnabled = mock(async () => ({ id: 'auto-1', enabled: true }))
    const router = new CapabilityRouter()
    router.register(createAutomationWorkspaceCapabilityProvider({ status: async () => ({ automationCount: 0, schedulerRunning: false }), list: async () => [], setEnabled }))
    expect(await router.invoke(request('automation.workspace', 'replay', { id: 'auto-1' }))).toMatchObject({ status: 'failed' })
    expect(await router.invoke({ ...request('automation.workspace', 'set-enabled', { id: 'auto-1', enabled: true, prompt: 'run this' }), requestId: 'extra' })).toMatchObject({ status: 'failed' })
    expect(setEnabled).not.toHaveBeenCalled()
  })
})

describe('scoped scheduler and webhook capabilities', () => {
  it('use independent capability names without exposing execution operations', async () => {
    const adapter = { status: async () => ({ automationCount: 1, schedulerRunning: true }), list: async () => [], setEnabled: async (_sessionId: string, id: string, enabled: boolean) => ({ id, enabled }) }
    const router = new CapabilityRouter({ authorize: () => ({ allowed: true }) })
    router.register(createScopedAutomationCapabilityProvider('scheduler', adapter))
    router.register(createScopedAutomationCapabilityProvider('webhook', adapter))
    expect(await router.invoke(request('scheduler.workspace', 'status'))).toMatchObject({ status: 'success' })
    expect(await router.invoke({ ...request('webhook.workspace', 'execute'), requestId: 'webhook-execute' })).toMatchObject({ status: 'failed' })
  })
})
