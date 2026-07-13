import { describe, expect, it } from 'bun:test'
import { createInstance, type InitOptions } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  RemoteUIComposer,
  createRemoteUIAnswerDraft,
  isRemoteUICompositionKey,
  remoteUIDraftResult,
  selectRemoteUIOption,
  setRemoteUIFreeform,
  type RemoteUIRequest,
} from './RemoteUIModal'

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  initImmediate: false,
  resources: {
    en: {
      translation: {
        'common.back': 'Back',
        'common.cancel': 'Cancel',
        'common.close': 'Close',
        'common.forward': 'Forward',
        'common.ok': 'OK',
        'remoteUI.answer': 'Answer',
        'remoteUI.answerPlaceholder': 'Type your answer...',
        'remoteUI.comment': 'Additional comment',
        'remoteUI.commentPlaceholder': 'Additional comment (optional)',
        'remoteUI.customAnswer': 'Custom answer',
        'remoteUI.customAnswerPlaceholder': 'Write your own answer...',
        'remoteUI.skipQuestion': 'Skip question',
        'remoteUI.submitAnswer': 'Submit answer',
      },
    },
  },
} as InitOptions)

const baseRequest = {
  type: 'remoteui_request',
  requestId: 'request-1',
  source: 'extension',
  sessionId: 'session-1',
  extensionId: 'legacy-extension',
  runtimeId: 'runtime-1',
} as const

function renderComposer(request: RemoteUIRequest): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RemoteUIComposer
        request={request}
        onRespond={() => {}}
      />
    </I18nextProvider>,
  )
}

describe('RemoteUIComposer', () => {
  it('renders radio choices and the custom answer as the final inline item', () => {
    const request: RemoteUIRequest = {
      ...baseRequest,
      kind: 'select',
      title: 'Choose an approach',
      options: [{ title: 'Prototype', description: 'Build the smallest version' }],
      allowFreeform: true,
    }

    const html = renderComposer(request)

    expect(html).toContain('data-remote-ui-composer')
    expect(html).toContain('type="radio"')
    expect(html).toContain('Write your own answer...')
    expect(html.indexOf('data-remote-ui-custom-option')).toBeGreaterThan(html.indexOf('data-remote-ui-option'))
    expect(html).toContain('lucide-arrow-up')
    expect(html).not.toContain('Write my own answer...')
    expect(html).not.toContain('role="dialog"')
  })

  it('renders every multiple choice as a checkbox without a confirm-style submit button', () => {
    const request: RemoteUIRequest = {
      ...baseRequest,
      kind: 'select',
      title: 'Choose the relevant areas',
      options: [{ title: 'UI' }, { title: 'Backend' }],
      allowMultiple: true,
      allowFreeform: true,
    }

    const html = renderComposer(request)

    expect(html.match(/type="checkbox"/g)).toHaveLength(2)
    expect(html).toContain('data-remote-ui-custom-option')
    expect(html).toContain('lucide-arrow-up')
    expect(html).not.toContain('lucide-send')
  })

  it('keeps editor hints as placeholders instead of prefilled answers', () => {
    const request: RemoteUIRequest = {
      ...baseRequest,
      kind: 'editor',
      title: 'Describe the change',
      placeholder: 'Type the change to make',
    }

    const html = renderComposer(request)

    expect(html).toContain('Describe the change')
    expect(html).toContain('placeholder="Type the change to make"')
    expect(html).toContain('aria-label="Answer"')
    expect(html).not.toContain('value="Type the change to make"')
  })

  it('keeps custom text and preset selections mutually exclusive', () => {
    const question: RemoteUIRequest = {
      ...baseRequest,
      kind: 'select',
      title: 'Choose tools',
      options: [{ title: 'Git' }, { title: 'Docker' }],
      allowMultiple: true,
      allowFreeform: true,
    }
    const initial = createRemoteUIAnswerDraft(question)
    const selected = selectRemoteUIOption(initial, 'Git', true)
    const custom = setRemoteUIFreeform(selected, 'A different tool')
    const selectedAgain = selectRemoteUIOption(custom, 'Docker', true)

    expect(selected.selections).toEqual(['Git'])
    expect(custom.selections).toEqual([])
    expect(remoteUIDraftResult(question, custom)).toEqual({
      selections: [],
      freeformText: 'A different tool',
    })
    expect(selectedAgain.freeformText).toBe('')
    expect(selectedAgain.selections).toEqual(['Docker'])
  })

  it('treats Windows IME keyCode 229 as an active composition key', () => {
    expect(isRemoteUICompositionKey({ nativeEvent: { keyCode: 229 } }, false)).toBe(true)
    expect(isRemoteUICompositionKey({ nativeEvent: { isComposing: true } }, false)).toBe(true)
    expect(isRemoteUICompositionKey({ nativeEvent: {} }, true)).toBe(true)
    expect(isRemoteUICompositionKey({ nativeEvent: {} }, false)).toBe(false)
  })
})
