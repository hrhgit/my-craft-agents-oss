import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// packages/ui has no DOM test harness, so guard the shared component contract
// directly. Browser validation covers the hover and clipboard interaction.
const source = readFileSync(
  fileURLToPath(new URL('../UserMessageBubble.tsx', import.meta.url)),
  'utf8',
)

describe('UserMessageBubble actions', () => {
  it('reserves a hidden action row that reveals for hover and keyboard focus', () => {
    expect(source).toContain('data-user-message-actions')
    expect(source).toContain('h-[18px] min-h-[18px]')
    expect(source).toContain('pointer-events-none opacity-0')
    expect(source).toContain('group-hover/user-message:opacity-100')
    expect(source).toContain('group-focus-within/user-message:opacity-100')
  })

  it('shows the sent time and copies the user message', () => {
    expect(source).toContain('formatCompletionClock(timestamp)')
    expect(source).toContain('navigator.clipboard.writeText(content)')
    expect(source).toContain("t('common.copy')")
  })
})
