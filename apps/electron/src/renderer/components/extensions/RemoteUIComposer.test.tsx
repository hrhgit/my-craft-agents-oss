import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RemoteUIComposer, type RemoteUIRequest } from './RemoteUIModal'

const baseRequest = {
  type: 'remoteui_request',
  requestId: 'request-1',
  source: 'extension',
  sessionId: 'session-1',
  extensionId: 'ask_user',
  runtimeId: 'runtime-1',
} as const

describe('RemoteUIComposer', () => {
  it('renders choices and custom input inline without a dialog', () => {
    const request: RemoteUIRequest = {
      ...baseRequest,
      kind: 'select',
      title: 'Choose an approach',
      options: [{ title: 'Prototype', description: 'Build the smallest version' }],
      allowFreeform: true,
    }

    const html = renderToStaticMarkup(<RemoteUIComposer request={request} onRespond={() => {}} />)

    expect(html).toContain('data-remote-ui-composer')
    expect(html).toContain('Choose an approach')
    expect(html).toContain('Prototype')
    expect(html).toContain('Type your own answer...')
    expect(html).not.toContain('role="dialog"')
  })

  it('renders editor requests as a direct answer field', () => {
    const request: RemoteUIRequest = {
      ...baseRequest,
      kind: 'editor',
      title: 'Describe the change',
      prefill: 'Initial notes',
    }

    const html = renderToStaticMarkup(<RemoteUIComposer request={request} onRespond={() => {}} />)

    expect(html).toContain('Describe the change')
    expect(html).toContain('Initial notes')
    expect(html).toContain('aria-label="Answer"')
  })
})
