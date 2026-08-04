import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(__dirname, '../ChatDisplay.tsx'), 'utf8')

describe('ChatDisplay streaming scroll follow', () => {
  it('pauses immediately when the user scrolls upward', () => {
    expect(source).toContain('const isScrollingUp = scrollTop < lastScrollTopRef.current - 1')
    expect(source).toContain('isStickToBottomRef.current = !isScrollingUp && distanceFromBottom < 20')
  })

  it('rechecks the user preference before a delayed streaming scroll runs', () => {
    const resizeObserverBlock = source.slice(
      source.indexOf('const resizeObserver = new ResizeObserver'),
      source.indexOf('resizeObserver.observe(content)'),
    )

    expect(resizeObserverBlock).toContain('if (!isStickToBottomRef.current) return')
    expect(resizeObserverBlock).toContain('behavior: isFocusedPanelRef.current ? \'smooth\' : \'instant\'')
    expect(resizeObserverBlock).not.toContain('always scroll to bottom')
  })
})
