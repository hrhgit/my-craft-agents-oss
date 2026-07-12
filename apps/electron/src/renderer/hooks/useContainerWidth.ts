import { useState, useEffect, type RefObject } from 'react'

export function getResizeObserverInlineSize(
  entry: Pick<ResizeObserverEntry, 'borderBoxSize' | 'target'>,
): number {
  return entry.borderBoxSize[0]?.inlineSize ?? entry.target.getBoundingClientRect().width
}

/**
 * Tracks the border-box inline-size (width) of a DOM element using ResizeObserver.
 *
 * Used by AppShell to derive `isAutoCompact` — when the shell container
 * is narrower than the mobile threshold, sidebar/navigator auto-collapse
 * and panels switch to single-panel mode.
 *
 * Returns 0 until the element is first measured.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const ro = new ResizeObserver(([entry]) => {
      setWidth(getResizeObserverInlineSize(entry))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return width
}
