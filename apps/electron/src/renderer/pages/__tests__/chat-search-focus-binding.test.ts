import { describe, expect, it, mock } from 'bun:test'
import {
  createFocusedHandleBinding,
  createFocusedMatchReporter,
} from '../chat-search-focus-binding'

describe('focused chat search binding', () => {
  it('keeps a newly focused panel handle when the previous owner cleans up later', () => {
    const sharedRef: { current: { panel: string } | null } = { current: null }
    const previous = createFocusedHandleBinding(sharedRef, true)
    const next = createFocusedHandleBinding(sharedRef, true)
    const previousHandle = { panel: 'previous' }
    const nextHandle = { panel: 'next' }

    previous(previousHandle)
    next(nextHandle)
    previous(null)

    expect(sharedRef.current).toBe(nextHandle)
    next(null)
    expect(sharedRef.current).toBeNull()
  })

  it('does not publish a handle or match counts from an unfocused panel', () => {
    const sharedRef: { current: { panel: string } | null } = { current: null }
    const report = mock(() => {})

    createFocusedHandleBinding(sharedRef, false)({ panel: 'background' })
    const reporter = createFocusedMatchReporter(report, false)
    reporter?.({ sessionId: 'session-2', count: 3, index: 1, hasMore: false, isHighlighting: false })

    expect(sharedRef.current).toBeNull()
    expect(reporter).toBeUndefined()
    expect(report).not.toHaveBeenCalled()
  })
})
