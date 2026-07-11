import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createAgent() {
  const agent = new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/craft-agent-test' } as any,
    session: { id: 'session-test', workspaceRootPath: '/tmp/craft-agent-test', createdAt: 0, lastUsedAt: 0 } as any,
    isHeadless: true,
  } satisfies BackendConfig)
  const responses: unknown[] = []
  ;(agent as any).rpcClient = { respondToExtensionUI: (response: unknown) => responses.push(response) }
  return { agent, responses }
}

describe('PiAgent RemoteUI bridge', () => {
  it('maps every supported dialog request to a renderer request', () => {
    const { agent } = createAgent()
    const map = (agent as any).mapExtensionUiRequest.bind(agent)

    expect(map({ type: 'extension_ui_request', id: 'select', extensionId: 'ask_user', method: 'select', title: 'Pick one', options: ['A'] })).toMatchObject({
      type: 'remoteui_request', kind: 'select', requestId: 'select', options: [{ title: 'A' }],
    })
    expect(map({ type: 'extension_ui_request', id: 'confirm', extensionId: 'ambiguity-dictionary', method: 'confirm', title: 'Continue?', message: 'Confirm it' })).toMatchObject({
      type: 'remoteui_request', kind: 'confirm', requestId: 'confirm',
    })
    expect(map({ type: 'extension_ui_request', id: 'input', extensionId: 'prompt-automation', method: 'input', title: 'Name', placeholder: 'Enter a name' })).toMatchObject({
      type: 'remoteui_request', kind: 'editor', requestId: 'input', prefill: 'Enter a name',
    })
    expect(map({ type: 'extension_ui_request', id: 'editor', extensionId: 'subagent', method: 'editor', title: 'Logs', prefill: 'log text' })).toMatchObject({
      type: 'remoteui_request', kind: 'editor', requestId: 'editor', prefill: 'log text',
    })

    agent.destroy()
  })

  it('converts modal results to the scalar Pi RPC responses', () => {
    const { agent, responses } = createAgent()

    agent.sendRemoteUIResponse('select', { selections: ['First option'] })
    agent.sendRemoteUIResponse('freeform', { selections: [], freeformText: 'My answer' })
    agent.sendRemoteUIResponse('editor', { text: 'Notes' })
    agent.sendRemoteUIResponse('confirm', { confirmed: true })
    agent.sendRemoteUIResponse('cancel', null, 'cancelled')

    expect(responses).toEqual([
      { type: 'extension_ui_response', id: 'select', value: 'First option' },
      { type: 'extension_ui_response', id: 'freeform', value: 'My answer' },
      { type: 'extension_ui_response', id: 'editor', value: 'Notes' },
      { type: 'extension_ui_response', id: 'confirm', confirmed: true },
      { type: 'extension_ui_response', id: 'cancel', cancelled: true },
    ])

    agent.destroy()
  })
})
