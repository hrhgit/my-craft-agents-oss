import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.mjs' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))

const {
  TurnCard,
  getTurnCardSearchReveal,
} = await import('../TurnCard')

const parent = {
  id: 'task-parent',
  type: 'tool' as const,
  status: 'completed' as const,
  toolName: 'Task',
  toolUseId: 'tool-use-parent',
  toolInput: { description: 'Delegate search' },
  timestamp: 1,
}

const child = {
  id: 'nested-tool',
  type: 'tool' as const,
  status: 'completed' as const,
  toolName: 'Read',
  toolUseId: 'tool-use-child',
  parentId: 'tool-use-parent',
  toolInput: { file_path: 'src/search.ts' },
  content: 'nested result needle',
  timestamp: 2,
}

describe('TurnCard search targets', () => {
  it('derives both turn and containing group expansion for a nested tool result', () => {
    expect(getTurnCardSearchReveal([parent, child], { type: 'tool-result', id: child.id })).toEqual({
      expandTurn: true,
      activityGroupId: parent.id,
    })
  })

  it('renders stable turn, response, tool-call, and tool-result identities once revealed', () => {
    const markup = renderToStaticMarkup(
      <TurnCard
        turnId="assistant-turn"
        activities={[parent, child]}
        response={{ text: 'final response', isStreaming: false, messageId: 'assistant-message' }}
        isStreaming={false}
        isComplete
        isExpanded
        expandedActivityGroups={new Set([parent.id])}
      />,
    )

    expect(markup).toContain('data-mortise-search-target-type="turn" data-mortise-search-target-id="assistant-turn"')
    expect(markup).toContain('data-mortise-search-target-type="message" data-mortise-search-target-id="assistant-message"')
    expect(markup).toContain('data-mortise-search-target-type="tool-call" data-mortise-search-target-id="nested-tool"')
    expect(markup).toContain('data-mortise-search-target-type="tool-result" data-mortise-search-target-id="nested-tool"')
  })

  it('keeps process text in the collapsible thinking stream and renders only the final result card', () => {
    const processText = {
      id: 'process-text',
      type: 'intermediate' as const,
      status: 'completed' as const,
      content: 'Visible reasoning block',
      timestamp: 1,
    }
    const emptyProcessText = {
      ...processText,
      id: 'empty-process-text',
      content: '   ',
      timestamp: 2,
    }
    const emptyStreamingProcessText = {
      ...emptyProcessText,
      id: 'empty-streaming-process-text',
      status: 'running' as const,
      timestamp: 3,
    }
    const tool = {
      id: 'collapsed-tool',
      type: 'tool' as const,
      status: 'completed' as const,
      toolName: 'Read',
      toolUseId: 'collapsed-tool-use',
      toolInput: { file_path: 'src/hidden.ts' },
      timestamp: 4,
    }

    const collapsedMarkup = renderToStaticMarkup(
      <TurnCard
        turnId="thinking-stream-turn"
        activities={[processText, emptyProcessText, emptyStreamingProcessText, tool]}
        response={{ text: 'Only final result', isStreaming: false, messageId: 'final-result' }}
        isStreaming={false}
        isComplete
        isExpanded={false}
      />,
    )

    expect(collapsedMarkup).toContain('Only final result')
    expect(collapsedMarkup).not.toContain('Visible reasoning block')
    expect(collapsedMarkup).not.toContain('data-mortise-process-text-card')
    expect(collapsedMarkup).not.toContain('data-mortise-search-target-id="collapsed-tool"')

    const expandedMarkup = renderToStaticMarkup(
      <TurnCard
        turnId="thinking-stream-turn"
        activities={[processText, emptyProcessText, emptyStreamingProcessText, tool]}
        response={{ text: 'Only final result', isStreaming: false, messageId: 'final-result' }}
        isStreaming={false}
        isComplete
        isExpanded
      />,
    )
    expect(expandedMarkup).toContain('Visible reasoning block')
    expect(expandedMarkup).toContain('Only final result')
    expect(expandedMarkup).not.toContain('data-mortise-process-text-card')
    expect(expandedMarkup).toContain('data-mortise-search-target-id="collapsed-tool"')
  })

  it('renders mixed-scale activities by stable order instead of timestamp', () => {
    const firstReasoning = {
      id: 'ordered-reasoning-one',
      type: 'intermediate' as const,
      status: 'completed' as const,
      content: 'First ordered reasoning',
      order: 2,
      timestamp: 1_900_000_000_000,
    }
    const firstTool = {
      id: 'ordered-tool-one',
      type: 'tool' as const,
      status: 'completed' as const,
      toolName: 'Read',
      toolUseId: 'ordered-tool-one-use',
      toolInput: { file_path: 'src/one.ts' },
      order: 3,
      timestamp: 30,
    }
    const secondReasoning = {
      ...firstReasoning,
      id: 'ordered-reasoning-two',
      content: 'Second ordered reasoning',
      order: 4,
      timestamp: 1_800_000_000_000,
    }
    const secondTool = {
      ...firstTool,
      id: 'ordered-tool-two',
      toolUseId: 'ordered-tool-two-use',
      toolInput: { file_path: 'src/two.ts' },
      order: 5,
      timestamp: 10,
    }

    const markup = renderToStaticMarkup(
      <TurnCard
        turnId="ordered-activity-turn"
        activities={[secondTool, secondReasoning, firstTool, firstReasoning]}
        response={{ text: 'Ordered final result', isStreaming: false, messageId: 'ordered-final-result' }}
        isStreaming={false}
        isComplete
        isExpanded
      />,
    )

    const firstReasoningIndex = markup.indexOf('First ordered reasoning')
    const firstToolIndex = markup.indexOf('data-mortise-search-target-id="ordered-tool-one"')
    const secondReasoningIndex = markup.indexOf('Second ordered reasoning')
    const secondToolIndex = markup.indexOf('data-mortise-search-target-id="ordered-tool-two"')
    const finalResultIndex = markup.indexOf('Ordered final result')
    expect([firstReasoningIndex, firstToolIndex, secondReasoningIndex, secondToolIndex, finalResultIndex]
      .every(index => index >= 0)).toBe(true)
    expect(firstReasoningIndex).toBeLessThan(firstToolIndex)
    expect(firstToolIndex).toBeLessThan(secondReasoningIndex)
    expect(secondReasoningIndex).toBeLessThan(secondToolIndex)
    expect(secondToolIndex).toBeLessThan(finalResultIndex)
  })

  it('lets response cards grow without internal vertical scrolling', () => {
    const markup = renderToStaticMarkup(
      <TurnCard
        turnId="flowing-card-turn"
        activities={[]}
        response={{ text: 'A long response body', isStreaming: false }}
        isStreaming={false}
        isComplete
        isExpanded={false}
        expandedActivityGroups={new Set()}
      />,
    )

    expect(markup).not.toContain('overflow-y-auto')
    expect(markup).not.toContain('scrollbar-hover')
    expect(markup).not.toContain('max-height:')
  })
})
