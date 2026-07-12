import { describe, expect, it } from 'bun:test'
import { getResizeObserverInlineSize } from '../useContainerWidth'

describe('getResizeObserverInlineSize', () => {
  it('uses the stable border box when padding changes the content box', () => {
    const entry = {
      borderBoxSize: [{ inlineSize: 773 }],
      target: {
        getBoundingClientRect: () => ({ width: 765 }),
      },
    } as unknown as Pick<ResizeObserverEntry, 'borderBoxSize' | 'target'>

    expect(getResizeObserverInlineSize(entry)).toBe(773)
  })

  it('falls back to the target border box when observer box sizes are unavailable', () => {
    const entry = {
      borderBoxSize: [],
      target: {
        getBoundingClientRect: () => ({ width: 640 }),
      },
    } as unknown as Pick<ResizeObserverEntry, 'borderBoxSize' | 'target'>

    expect(getResizeObserverInlineSize(entry)).toBe(640)
  })
})
