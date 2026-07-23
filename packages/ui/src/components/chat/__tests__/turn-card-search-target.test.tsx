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
})
