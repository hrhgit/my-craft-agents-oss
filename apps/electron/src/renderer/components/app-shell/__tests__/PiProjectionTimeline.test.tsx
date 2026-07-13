import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(__dirname, '../PiProjectionTimeline.tsx'), 'utf8')

describe('PiProjectionTimeline', () => {
  it('keeps complete thinking markdown visible instead of a collapsed summary', () => {
    expect(source).toContain("if (item.contentKind === 'thinking')")
    expect(source).toContain('<div className="text-sm opacity-80">{content}</div>')
    expect(source).not.toContain('<summary')
  })

  it('renders user requests with the shared message card', () => {
    expect(source).toContain("import { ActivityCardsOverlay, UserMessageBubble")
    expect(source).toContain('<UserMessageBubble')
    expect(source).toContain('content={item.text}')
  })
})
