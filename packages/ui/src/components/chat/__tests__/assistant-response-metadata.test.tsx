import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const { ResponseCard } = await import('../TurnCard')

describe('assistant response metadata', () => {
  it('renders completion time, duration, and per-turn token counts in a hidden row below the card', () => {
    const markup = renderToStaticMarkup(
      <ResponseCard
        text="Done"
        isStreaming={false}
        completedAt={1_783_861_265_432}
        durationMs={65_432}
        inputTokens={2_700}
        outputTokens={345}
      />,
    )

    expect(markup).toContain('data-response-completion-row="true"')
    expect(markup).toContain('data-response-completion-metadata="true"')
    expect(markup).toContain('group-hover/assistant-response:opacity-100')
    expect(markup).toContain('group-focus-within/assistant-response:opacity-100')
    expect(markup).toContain('1m05s')
    expect(markup).toContain('2.7k')
    expect(markup).toContain('345')
  })

  it('omits the metadata row while the response is streaming', () => {
    const markup = renderToStaticMarkup(
      <ResponseCard text="Working" isStreaming inputTokens={100} outputTokens={10} />,
    )

    expect(markup).not.toContain('data-response-completion-row')
  })
})
