import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@/components/markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}))
mock.module('./SandboxAppHost', () => ({ SandboxAppHost: () => null }))

const { ExtensionContributionContent } = await import('./ExtensionContributionZone')

describe('ExtensionContributionContent', () => {
  it('keeps host-rendered status tones and command controls accessible', () => {
    const markup = renderToStaticMarkup(
      <ExtensionContributionContent
        sessionId="session"
        extensionId="planner"
        runtimeId="runtime"
        node={{
          type: 'stack',
          children: [
            { type: 'badge', label: 'Needs attention', tone: 'warning' },
            {
              type: 'button',
              label: 'Open plan',
              icon: 'chevron-right',
              action: { kind: 'command', command: 'plan-open' },
            },
          ],
        }}
      />,
    )

    expect(markup).toContain('bg-amber-500/10')
    expect(markup).toContain('aria-label="Open plan"')
    expect(markup).toContain('focus-visible:ring-2')
    expect(markup).toContain('aria-hidden="true"')
  })

  it('renders a stable accessible trigger for step progress', () => {
    const markup = renderToStaticMarkup(
      <ExtensionContributionContent
        sessionId="session"
        extensionId="planner"
        runtimeId="runtime"
        node={{
          type: 'step-progress',
          label: 'Plan execution',
          steps: [
            { id: 'one', label: 'First step', status: 'completed' },
            { id: 'two', label: 'Second step', status: 'in_progress' },
          ],
        }}
      />,
    )

    expect(markup).toContain('data-mortise-semantic-id="extension.planner.step-progress.session"')
    expect(markup).toContain('aria-haspopup="dialog"')
    expect(markup).toContain('Second step')
    expect(markup).toContain('width:50%')
  })

  it('exposes the reason for a disabled command on hover and focus', () => {
    const markup = renderToStaticMarkup(
      <ExtensionContributionContent
        sessionId="session"
        extensionId="planner"
        runtimeId="runtime"
        node={{
          type: 'button',
          label: 'Discuss architecture review',
          disabled: true,
          disabledReason: 'The architecture review did not complete.',
          action: { kind: 'command', command: 'plan-discuss-review' },
        }}
      />,
    )

    expect(markup).toContain('disabled=""')
    expect(markup).toContain('title="The architecture review did not complete."')
    expect(markup).toContain('aria-label="Discuss architecture review. The architecture review did not complete."')
    expect(markup).toContain('tabindex="0"')
  })
})
