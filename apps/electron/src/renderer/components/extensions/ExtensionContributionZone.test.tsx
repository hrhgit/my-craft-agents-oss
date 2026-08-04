import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
mock.module('@/components/markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}))
mock.module('./SandboxAppHost', () => ({ SandboxAppHost: () => null }))

const { ExtensionContributionContent, selectResponsiveMode } = await import('./ExtensionContributionZone')

describe('ExtensionContributionContent', () => {
  it('renders the full responsive variant by default and exposes its mode contract', () => {
    const markup = renderToStaticMarkup(
      <ExtensionContributionContent
        sessionId="session"
        extensionId="planner"
        runtimeId="runtime"
        node={{
          type: 'responsive',
          semanticId: 'plan.status',
          full: { type: 'text', text: 'Full status' },
          compact: { type: 'badge', label: 'Compact', tone: 'info' },
          minimal: { type: 'icon', name: 'activity', label: 'Minimal' },
        }}
      />,
    )

    expect(markup).toContain('data-mortise-responsive-mode="full"')
    expect(markup).toContain('Full status')
    expect(markup).toContain('data-mortise-semantic-id="extension.planner.content.plan.status"')
  })

  it('selects the nearest declared responsive variant at host thresholds', () => {
    const node = {
      type: 'responsive' as const,
      full: { type: 'text' as const, text: 'Full' },
      compact: { type: 'badge' as const, label: 'Compact' },
      minimal: { type: 'icon' as const, name: 'activity' as const, label: 'Minimal' },
    }
    expect(selectResponsiveMode(600, node)).toBe('full')
    expect(selectResponsiveMode(420, node)).toBe('compact')
    expect(selectResponsiveMode(220, node)).toBe('minimal')
    expect(selectResponsiveMode(220, { ...node, minimal: undefined })).toBe('compact')
    expect(selectResponsiveMode(220, { ...node, minimal: undefined, compact: undefined })).toBe('full')
  })

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
