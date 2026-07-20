import { describe, expect, it, mock } from 'bun:test'
import { CapabilityRouter } from '../router.ts'
import { createAutomationWorkspaceCapabilityProvider, createMessagingSessionCapabilityProvider } from '../providers/messaging-automation.ts'
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
  it('parses the canonical DTO and derives extension source identity', async () => {
    const execute = mock(async () => ({ schemaVersion: 1, status: 'ok', revision: 1, data: [] }))
    const router = new CapabilityRouter()
    router.register(createAutomationWorkspaceCapabilityProvider({ execute }))
    expect(await router.invoke(request('automation.workspace', 'list', { schemaVersion: 1 }))).toMatchObject({
      status: 'success',
      output: { schemaVersion: 1, status: 'ok', data: [] },
    })
    expect(execute).toHaveBeenCalledWith(
      { operation: 'list', schemaVersion: 1 },
      expect.objectContaining({
        sessionId: 'session-1',
        runtimeId: 'runtime-1',
        extensionId: 'extension-1',
        eventSourceKind: 'extension',
      }),
    )
  })

  it('classifies Pi runtime calls as agent events without trusting input fields', async () => {
    const execute = mock(async (..._args: unknown[]) => ({ schemaVersion: 1, operationId: 'op-emit', status: 'accepted', data: {
      eventId: 'event-identity-1234', runIds: [], persisted: true,
    } }))
    const router = new CapabilityRouter()
    router.register(createAutomationWorkspaceCapabilityProvider({ execute }))
    const event = {
      specversion: '1.0', id: 'external-event-1', source: 'urn:test', type: 'tests.failed',
      time: new Date().toISOString(), data: {},
    }
    const result = await router.invoke({
      ...request('automation.workspace', 'emit-event', { schemaVersion: 1, operationId: 'op-emit', event }),
      extensionId: 'pi-runtime',
    })
    expect(result).toMatchObject({ status: 'success', output: { status: 'accepted' } })
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ eventSourceKind: 'agent' })
  })

  it('rejects unsupported operations and extra DTO fields before dispatch', async () => {
    const execute = mock(async () => ({ schemaVersion: 1, status: 'ok', data: [] }))
    const router = new CapabilityRouter()
    router.register(createAutomationWorkspaceCapabilityProvider({ execute }))
    expect(await router.invoke(request('automation.workspace', 'status', { schemaVersion: 1 }))).toMatchObject({ status: 'failed' })
    expect(await router.invoke({
      ...request('automation.workspace', 'list', { schemaVersion: 1, sourceKind: 'mortise' }),
      requestId: 'spoof-source',
    })).toMatchObject({ status: 'failed' })
    expect(execute).not.toHaveBeenCalled()
  })
})
