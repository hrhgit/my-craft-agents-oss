import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createAgent(onExtensionEvent?: BackendConfig['onExtensionEvent']) {
  const agent = new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/craft-agent-test' } as any,
    session: { id: 'session-test', workspaceRootPath: '/tmp/craft-agent-test', createdAt: 0, lastUsedAt: 0 } as any,
    isHeadless: true,
    onExtensionEvent,
  } satisfies BackendConfig)
  const responses: unknown[] = []
  ;(agent as any).rpcClient = { respondToExtensionUI: (response: unknown) => responses.push(response) }
  return { agent, responses }
}

describe('PiAgent RemoteUI bridge', () => {
  it('maps every supported dialog request to a renderer request', () => {
    const { agent } = createAgent()
    const map = (agent as any).mapExtensionUiRequest.bind(agent)

    expect(map({ type: 'extension_ui_request', id: 'select', extensionId: 'legacy-extension', method: 'select', title: 'Pick one', options: ['A'] })).toMatchObject({
      type: 'remoteui_request', kind: 'select', requestId: 'select', options: [{ title: 'A' }],
    })
    expect(map({ type: 'extension_ui_request', id: 'confirm', extensionId: 'ambiguity-dictionary', method: 'confirm', title: 'Continue?', message: 'Confirm it' })).toMatchObject({
      type: 'remoteui_request', kind: 'confirm', requestId: 'confirm',
    })
    expect(map({ type: 'extension_ui_request', id: 'input', extensionId: 'prompt-automation', method: 'input', title: 'Name', placeholder: 'Enter a name' })).toMatchObject({
      type: 'remoteui_request', kind: 'editor', requestId: 'input', placeholder: 'Enter a name',
    })
    expect(map({ type: 'extension_ui_request', id: 'editor', extensionId: 'subagent', method: 'editor', title: 'Logs', prefill: 'log text' })).toMatchObject({
      type: 'remoteui_request', kind: 'editor', requestId: 'editor', prefill: 'log text',
    })
    agent.destroy()
  })

  it('does not decode extension-specific data from legacy dialog titles', () => {
    const { agent } = createAgent()
    const map = (agent as any).mapExtensionUiRequest.bind(agent)
    const encodedTitle = 'Choose areas\n\nOptions (select one or more):\n1. UI\n2. Backend'

    expect(map({
      type: 'extension_ui_request',
      id: 'legacy-input',
      extensionId: 'legacy-extension',
      method: 'input',
      title: encodedTitle,
    })).toMatchObject({
      type: 'remoteui_request',
      kind: 'editor',
      requestId: 'legacy-input',
      title: encodedTitle,
    })

    agent.destroy()
  })

  it('converts modal results to the scalar Pi RPC responses', () => {
    const { agent, responses } = createAgent()

    agent.sendRemoteUIResponse('select', { selections: ['First option', 'Second option'] })
    agent.sendRemoteUIResponse('freeform', { selections: [], freeformText: 'My answer' })
    agent.sendRemoteUIResponse('editor', { text: 'Notes' })
    agent.sendRemoteUIResponse('confirm', { confirmed: true })
    agent.sendRemoteUIResponse('cancel', null, 'cancelled')

    expect(responses).toEqual([
      { type: 'extension_ui_response', id: 'select', value: 'First option, Second option' },
      { type: 'extension_ui_response', id: 'freeform', value: 'My answer' },
      { type: 'extension_ui_response', id: 'editor', value: 'Notes' },
      { type: 'extension_ui_response', id: 'confirm', confirmed: true },
      { type: 'extension_ui_response', id: 'cancel', cancelled: true },
    ])

    agent.destroy()
  })

  it('passes interaction v1 through with trusted ownership and structured answers', () => {
    const { agent, responses } = createAgent()
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
    agent.sendRemoteUIResponse('interaction-1', {
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

    expect(agent.sendRemoteUIResponse('interaction-1', null, 'cancelled')).toBe(true)
    expect(responses).toHaveLength(1)

    agent.destroy()
  })

  it('settles interaction requests that Craft cannot safely render', () => {
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
})
