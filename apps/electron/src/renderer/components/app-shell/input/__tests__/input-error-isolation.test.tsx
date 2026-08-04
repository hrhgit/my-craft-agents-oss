import * as React from 'react'
import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@sentry/electron/renderer', () => ({
  captureException: () => undefined,
}))

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => options?.count == null
      ? key
      : `${key}:${options.count}`,
  }),
}))

const { InputErrorBoundary } = await import('../InputErrorBoundary')
const { DegradedComposer, createDegradedComposerSubmission } = await import('../DegradedComposer')

describe('composer error isolation', () => {
  test('replaces only the failed boundary with its supplied fallback', () => {
    const boundary = new InputErrorBoundary({
      resetKey: 'session::composer',
      fallback: ({ retry }) => (
        <textarea aria-label="basic composer" onDoubleClick={retry} defaultValue="draft survives" />
      ),
      children: <div>advanced composer</div>,
    })
    boundary.state = { hasError: true }

    const markup = renderToStaticMarkup(boundary.render() as React.ReactElement)
    expect(markup).toContain('aria-label="basic composer"')
    expect(markup).toContain('draft survives')
    expect(markup).not.toContain('advanced composer')
  })

  test('allows optional controls to disappear without replacing siblings', () => {
    const boundary = new InputErrorBoundary({
      resetKey: 'session::badges',
      fallback: null,
      children: <div>optional badges</div>,
    })
    boundary.state = { hasError: true }

    expect(boundary.render()).toBeNull()
  })

  test('keeps a basic editable and sendable composer in the shell fallback', () => {
    const markup = renderToStaticMarkup(
      <DegradedComposer
        sessionId="session-1"
        inputProps={{
          currentModel: 'model-1',
          onModelChange: () => undefined,
          onSubmit: async () => true,
          inputValue: 'unsent draft',
        }}
        onRetry={() => undefined}
      />,
    )

    expect(markup).toContain('data-mortise-semantic-id="composer.session-1.degraded"')
    expect(markup).toContain('<textarea')
    expect(markup).toContain('unsent draft')
    expect(markup).toContain('aria-label="shortcuts.sendMessage"')
  })

  test('submits the exact basic-text draft through the normal composer contract', () => {
    const attempt = createDegradedComposerSubmission('  keep exact draft  ', [])

    expect(attempt.composerText).toBe('  keep exact draft  ')
    expect(attempt.message).toBe('keep exact draft')
    expect(attempt.midStreamSendIntent).toBe('default')
  })
})
