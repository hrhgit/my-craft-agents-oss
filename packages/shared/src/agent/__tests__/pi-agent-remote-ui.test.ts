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

    expect(map({ type: 'extension_ui_request', id: 'select', extensionId: 'ask-user', method: 'select', title: 'Pick one', options: ['A'] })).toMatchObject({
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
    expect(map({
      type: 'extension_ui_request',
      id: 'ask-user-single',
      extensionId: 'ask-user',
      method: 'select',
      title: 'Pick an approach',
      options: ['Prototype', '✏️ Write my own answer...'],
    })).toMatchObject({
      type: 'remoteui_request',
      kind: 'select',
      requestId: 'ask-user-single',
      options: [{ title: 'Prototype' }],
      allowFreeform: true,
    })
    agent.destroy()
  })

  it('maps canonical ask-user multi-select input titles to structured select requests', () => {
    const { agent } = createAgent()
    const map = (agent as any).mapExtensionUiRequest.bind(agent)

    expect(map({
      type: 'extension_ui_request',
      id: 'ask-user-multiple',
      extensionId: 'ask-user',
      method: 'input',
      title: '[2/3] 多选测试：请选择两个或更多常用工具。\r\n\r\nContext:\r\n这是纯多选测试。\r\n\r\nOptions (select one or more):\r\n1. VS Code\r\n2. Git\r\n3. Docker\r\n4. Postman',
      placeholder: 'Type your selection(s)...',
    })).toMatchObject({
      type: 'remoteui_request',
      kind: 'select',
      requestId: 'ask-user-multiple',
      title: '[2/3] 多选测试：请选择两个或更多常用工具。',
      message: '这是纯多选测试。',
      options: [
        { title: 'VS Code' },
        { title: 'Git' },
        { title: 'Docker' },
        { title: 'Postman' },
      ],
      allowMultiple: true,
      allowFreeform: true,
    })

    agent.destroy()
  })

  it('keeps multi-select title decoding scoped to ask-user extension IDs', () => {
    const { agent } = createAgent()
    const map = (agent as any).mapExtensionUiRequest.bind(agent)
    const encodedTitle = 'Choose areas\n\nOptions (select one or more):\n1. UI\n2. Backend'

    expect(map({
      type: 'extension_ui_request',
      id: 'legacy-ask-user',
      extensionId: 'ask_user',
      method: 'input',
      title: encodedTitle,
    })).toMatchObject({ kind: 'select', allowMultiple: true })
    expect(map({
      type: 'extension_ui_request',
      id: 'other-extension',
      extensionId: 'prompt-automation',
      method: 'input',
      title: encodedTitle,
    })).toMatchObject({ kind: 'editor', title: encodedTitle })

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
})
