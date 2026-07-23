import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createAgent(onExtensionEvent?: BackendConfig['onExtensionEvent']) {
  const agent = new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/mortise-test' } as any,
    session: { mortiseId: 'session-test', workspaceRootPath: '/tmp/mortise-test', createdAt: 0, lastUsedAt: 0 } as any,
    isHeadless: true,
    onExtensionEvent,
  } satisfies BackendConfig)
  const responses: unknown[] = []
  ;(agent as any).rpcClient = {
    runtimeId: 'runtime-test',
    respondToExtensionUI: (response: unknown) => responses.push(response),
  }
  return { agent, responses }
}

describe('PiAgent extension interaction bridge', () => {
  it('passes interaction v1 through with trusted ownership and structured answers', () => {
    const bridgeEvents: unknown[] = []
    const { agent, responses } = createAgent(event => bridgeEvents.push(event))
    const map = (agent as any).mapExtensionUiRequest.bind(agent)
    const bridgeEvent = map({
      type: 'extension_ui_request',
      id: 'interaction-1',
      extensionId: 'ask-user',
      clientId: 'client-1',
      runtimeId: 'runtime-1',
      sessionId: 'pi-session-1',
      method: 'interact',
      request: {
        schemaVersion: 1,
        fields: [{
          id: 'targets',
          kind: 'choice',
          label: 'Targets',
          multiple: true,
          options: [{ id: 'new-york', label: 'New York, US' }, { id: 'paris', label: 'Paris, FR' }],
        }],
      },
    })

    expect(bridgeEvent).toMatchObject({
      type: 'extension_interaction_request',
      requestId: 'interaction-1',
      extensionId: 'ask-user',
      runtimeId: 'runtime-1',
    })
    agent.respondToExtensionInteraction('interaction-1', {
      schemaVersion: 1,
      status: 'submitted',
      answers: [{ fieldId: 'targets', kind: 'choice', selectedOptionIds: ['new-york', 'paris'] }],
    })
    expect(responses).toEqual([{
      type: 'extension_ui_response',
      id: 'interaction-1',
      extensionId: 'ask-user',
      clientId: 'client-1',
      runtimeId: 'runtime-1',
      sessionId: 'pi-session-1',
      interaction: {
        schemaVersion: 1,
        status: 'submitted',
        answers: [{ fieldId: 'targets', kind: 'choice', selectedOptionIds: ['new-york', 'paris'] }],
      },
    }])
    expect(bridgeEvents).toContainEqual({
      type: 'extension_interaction_settled',
      schemaVersion: 1,
      requestId: 'interaction-1',
      extensionId: 'ask-user',
      runtimeId: 'runtime-1',
      sessionId: 'session-test',
      outcome: 'submitted',
    })

    expect(agent.respondToExtensionInteraction('interaction-1', {
      schemaVersion: 1,
      status: 'cancelled',
      reason: 'user',
    })).toBe(true)
    expect(responses).toHaveLength(1)

    agent.destroy()
  })

  it('commits interaction state even when host event broadcasting fails', () => {
    const { agent, responses } = createAgent(() => { throw new Error('bridge unavailable') })
    const map = (agent as any).mapExtensionUiRequest.bind(agent)
    map({
      type: 'extension_ui_request',
      id: 'interaction-broadcast-failure',
      extensionId: 'ask-user',
      runtimeId: 'runtime-1',
      method: 'interact',
      request: { schemaVersion: 1, fields: [{ id: 'confirm', kind: 'confirm', label: 'Continue?' }] },
    })

    expect(agent.respondToExtensionInteraction('interaction-broadcast-failure', {
      schemaVersion: 1,
      status: 'submitted',
      answers: [{ fieldId: 'confirm', kind: 'confirm', value: true }],
    })).toBe(true)
    expect(agent.respondToExtensionInteraction('interaction-broadcast-failure', {
      schemaVersion: 1,
      status: 'cancelled',
      reason: 'user',
    })).toBe(true)
    expect(responses).toHaveLength(1)

    map({
      type: 'extension_ui_request',
      id: 'interaction-cancel-broadcast-failure',
      extensionId: 'ask-user',
      runtimeId: 'runtime-1',
      method: 'interact',
      request: { schemaVersion: 1, fields: [{ id: 'confirm', kind: 'confirm', label: 'Continue?' }] },
    })
    expect(() => (agent as any).cancelPendingExtensionInteractions('runtime-disposed')).not.toThrow()
    expect((agent as any).pendingExtensionInteractions.size).toBe(0)

    agent.destroy()
  })

  it('settles interaction requests that Mortise cannot safely render', () => {
    const { agent, responses } = createAgent()
    const map = (agent as any).mapExtensionUiRequest.bind(agent)

    expect(map({
      type: 'extension_ui_request',
      id: 'invalid-interaction',
      extensionId: 'ask-user',
      runtimeId: 'runtime-1',
      method: 'interact',
      request: {
        schemaVersion: 1,
        fields: [{ id: 'secret', kind: 'text', label: 'Secret', multiline: true, sensitive: true }],
      },
    })).toBeNull()
    expect(responses).toEqual([expect.objectContaining({
      type: 'extension_ui_response',
      id: 'invalid-interaction',
      extensionId: 'ask-user',
      interaction: { schemaVersion: 1, status: 'cancelled', reason: 'host-disconnected' },
    })])

    agent.destroy()
  })

  it('forwards Pi interaction cancellation only for the trusted owner', () => {
    const events: unknown[] = []
    const { agent } = createAgent(event => events.push(event))
    const map = (agent as any).mapExtensionUiRequest.bind(agent)
    const handle = (agent as any).handlePiClientEvent.bind(agent)
    map({
      type: 'extension_ui_request',
      id: 'interaction-cancel',
      extensionId: 'ask-user',
      runtimeId: 'runtime-1',
      method: 'interact',
      request: { schemaVersion: 1, fields: [{ id: 'confirm', kind: 'confirm', label: 'Continue?' }] },
    })

    handle({
      type: 'extension_ui_cancel',
      id: 'interaction-cancel',
      extensionId: 'forged-owner',
      runtimeId: 'runtime-1',
      schemaVersion: 1,
      reason: 'aborted',
    })
    expect(events).toEqual([])
    handle({
      type: 'extension_ui_cancel',
      id: 'interaction-cancel',
      extensionId: 'ask-user',
      runtimeId: 'runtime-1',
      schemaVersion: 1,
      reason: 'aborted',
    })
    expect(events).toEqual([expect.objectContaining({
      type: 'extension_interaction_cancel',
      requestId: 'interaction-cancel',
      extensionId: 'ask-user',
      reason: 'aborted',
    })])

    agent.destroy()
  })

  it('rejects a response for an unknown interaction instead of using the retired scalar protocol', () => {
    const { agent, responses } = createAgent()
    expect(agent.respondToExtensionInteraction('unknown', {
      schemaVersion: 1,
      status: 'cancelled',
      reason: 'user',
    })).toBe(false)
    expect(responses).toEqual([])
    agent.destroy()
  })
})
