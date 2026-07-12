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

  it('renders multiple choices with native checkboxes and an inline custom answer field', () => {
    const request: RemoteUIRequest = {
      ...baseRequest,
      kind: 'select',
      title: 'Choose the relevant areas',
      options: [{ title: 'UI' }, { title: 'Backend' }],
      allowMultiple: true,
      allowFreeform: true,
    }

    const html = renderToStaticMarkup(<RemoteUIComposer request={request} onRespond={() => {}} />)

    expect(html).toContain('type="checkbox"')
    expect(html).toContain('data-remote-ui-option')
    expect(html).toContain('data-remote-ui-freeform')
    expect(html).not.toContain('rounded-full')
  })

  it('keeps input hints as placeholders instead of prefilled answers', () => {
    const request: RemoteUIRequest = {
      ...baseRequest,
      kind: 'editor',
      title: 'Describe the change',
      placeholder: 'Type the change to make',
    }

    const html = renderToStaticMarkup(<RemoteUIComposer request={request} onRespond={() => {}} />)

    expect(html).toContain('Describe the change')
    expect(html).toContain('placeholder="Type the change to make"')
    expect(html).toContain('aria-label="Answer"')
    expect(html).not.toContain('value="Type the change to make"')
  })
})
