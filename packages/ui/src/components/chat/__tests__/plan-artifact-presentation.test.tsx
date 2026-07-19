import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const { ArtifactContributionProvider, ResponseCard } = await import('../TurnCard')

const artifact = {
  schemaVersion: 1 as const,
  kind: 'plan' as const,
  artifactId: 'plan-1',
  revision: 2,
  state: 'ready' as const,
  review: { status: 'passed' as const, body: '# Independent review' },
  checklist: [],
  createdAt: 1,
}

describe('plan artifact presentation', () => {
  it('renders one plan body with an in-card review pane and artifact footer', () => {
    const markup = renderToStaticMarkup(
      <ArtifactContributionProvider presentation={{
        asideTitle: 'Review',
        aside: <p>Review result</p>,
        footer: <button type="button">Execute original plan</button>,
      }}>
        <ResponseCard text="# Unique plan body" isStreaming={false} variant="plan" artifact={artifact} />
      </ArtifactContributionProvider>,
    )

    expect(markup.match(/Unique plan body/g)).toHaveLength(1)
    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('Review result')
    expect(markup).toContain('data-artifact-footer="plan-1"')
    expect(markup).toContain('Execute original plan')
    expect(markup).not.toContain('Accept Plan')
  })
})
