import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

export const CONVERSATION_BOTTOM_THRESHOLD = 24
export const CONVERSATION_TOP_THRESHOLD = 100

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
  atBottom: boolean
}

export function getConversationScrollMetrics(
  viewport: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
  threshold = CONVERSATION_BOTTOM_THRESHOLD,
): ScrollMetrics {
  const distanceFromBottom = Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight)
  return {
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    distanceFromBottom,
    atBottom: distanceFromBottom <= threshold,
  }
}

export interface PrependScrollSnapshot {
  scrollTop: number
  scrollHeight: number
}

export interface ConversationFollowState {
  following: boolean
  hasNewContent: boolean
}

export interface ConversationFollowSignal {
  userInitiated: boolean
  movedUp: boolean
  atBottom: boolean
  contentChanged?: boolean
}

export function reduceConversationFollowState(
  state: ConversationFollowState,
  signal: ConversationFollowSignal,
): ConversationFollowState {
  let following = state.following
  let hasNewContent = state.hasNewContent

  if (signal.userInitiated) {
    if (signal.movedUp) following = false
    else if (signal.atBottom) following = true
  }

  if (signal.contentChanged && !following) hasNewContent = true
  if (following && signal.atBottom) hasNewContent = false

  return { following, hasNewContent }
}

export interface UseConversationScrollControllerOptions {
  sessionId: string | null | undefined
  onNearTop?: () => void
  bottomThreshold?: number
  topThreshold?: number
}

export interface ConversationScrollController {
  viewportRef: RefObject<HTMLDivElement>
  contentRef: RefObject<HTMLDivElement>
  isFollowing: boolean
  hasNewContent: boolean
  distanceFromBottom: number
  followContentGrowth: () => void
  resetForSession: () => void
  scrollToLatest: (behavior?: ScrollBehavior | 'instant') => void
  detach: () => void
  capturePrependPosition: () => PrependScrollSnapshot | null
  restorePrependPosition: (snapshot: PrependScrollSnapshot | null) => void
  compensateViewportHeight: (delta: number) => void
  scrollTargetIntoView: (element: HTMLElement, options?: ScrollIntoViewOptions) => void
}

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'])

export function useConversationScrollController({
  sessionId,
  onNearTop,
  bottomThreshold = CONVERSATION_BOTTOM_THRESHOLD,
  topThreshold = CONVERSATION_TOP_THRESHOLD,
}: UseConversationScrollControllerOptions): ConversationScrollController {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const previousScrollTopRef = useRef(0)
  const followingRef = useRef(true)
  const followStateRef = useRef<ConversationFollowState>({ following: true, hasNewContent: false })
  const userInteractionRef = useRef(false)
  const topLoadTriggeredRef = useRef(false)
  const followFrameRef = useRef<number | null>(null)
  const prependFrameRef = useRef<number | null>(null)
  const wheelInteractionFrameRef = useRef<number | null>(null)
  const latestOnNearTopRef = useRef(onNearTop)
  latestOnNearTopRef.current = onNearTop

  const [isFollowing, setIsFollowing] = useState(true)
  const [hasNewContent, setHasNewContent] = useState(false)
  const [distanceFromBottom, setDistanceFromBottom] = useState(0)

  const readMetrics = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return null
    const metrics = getConversationScrollMetrics(viewport, bottomThreshold)
    setDistanceFromBottom(metrics.distanceFromBottom)
    return metrics
  }, [bottomThreshold])

  const setFollowing = useCallback((following: boolean) => {
    followStateRef.current = {
      following,
      hasNewContent: following ? false : followStateRef.current.hasNewContent,
    }
    followingRef.current = following
    setIsFollowing(following)
    if (following) setHasNewContent(false)
  }, [])

  const applyFollowState = useCallback((next: ConversationFollowState) => {
    followStateRef.current = next
    followingRef.current = next.following
    setIsFollowing(next.following)
    setHasNewContent(next.hasNewContent)
  }, [])

  const detach = useCallback(() => {
    setFollowing(false)
  }, [setFollowing])

  const scrollToLatest = useCallback((behavior: ScrollBehavior | 'instant' = 'instant') => {
    const viewport = viewportRef.current
    if (!viewport) return

    setFollowing(true)
    const top = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    if (behavior === 'smooth') {
      viewport.scrollTo({ top, behavior })
    } else {
      viewport.scrollTop = top
    }
    previousScrollTopRef.current = top
    readMetrics()
  }, [readMetrics, setFollowing])

  const followContentGrowth = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    if (!followingRef.current) {
      applyFollowState(reduceConversationFollowState(followStateRef.current, {
        userInitiated: false,
        movedUp: false,
        atBottom: false,
        contentChanged: true,
      }))
      readMetrics()
      return
    }

    if (followFrameRef.current !== null) return
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null
      if (!followingRef.current) {
        applyFollowState(reduceConversationFollowState(followStateRef.current, {
          userInitiated: false,
          movedUp: false,
          atBottom: false,
          contentChanged: true,
        }))
        readMetrics()
        return
      }
      scrollToLatest('instant')
    })
  }, [applyFollowState, readMetrics, scrollToLatest])

  const resetForSession = useCallback(() => {
    topLoadTriggeredRef.current = false
    previousScrollTopRef.current = viewportRef.current?.scrollTop ?? 0
    setFollowing(true)
    setDistanceFromBottom(0)
    scrollToLatest('instant')
  }, [scrollToLatest, setFollowing])

  useEffect(() => {
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current)
      followFrameRef.current = null
    }
    if (prependFrameRef.current !== null) {
      cancelAnimationFrame(prependFrameRef.current)
      prependFrameRef.current = null
    }
    topLoadTriggeredRef.current = false
    previousScrollTopRef.current = viewportRef.current?.scrollTop ?? 0
    setFollowing(true)
    setDistanceFromBottom(0)
  }, [sessionId, setFollowing])

  const capturePrependPosition = useCallback((): PrependScrollSnapshot | null => {
    const viewport = viewportRef.current
    if (!viewport) return null
    return { scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight }
  }, [])

  const restorePrependPosition = useCallback((snapshot: PrependScrollSnapshot | null) => {
    if (!snapshot) return
    if (prependFrameRef.current !== null) cancelAnimationFrame(prependFrameRef.current)
    prependFrameRef.current = requestAnimationFrame(() => {
      prependFrameRef.current = null
      const viewport = viewportRef.current
      if (!viewport) return
      const heightDelta = viewport.scrollHeight - snapshot.scrollHeight
      viewport.scrollTop = snapshot.scrollTop + heightDelta
      previousScrollTopRef.current = viewport.scrollTop
      readMetrics()
    })
  }, [readMetrics])

  const compensateViewportHeight = useCallback((delta: number) => {
    const viewport = viewportRef.current
    if (!viewport || !followingRef.current) return
    viewport.scrollTop += delta
    previousScrollTopRef.current = viewport.scrollTop
    readMetrics()
  }, [readMetrics])

  const scrollTargetIntoView = useCallback((element: HTMLElement, options?: ScrollIntoViewOptions) => {
    const viewport = viewportRef.current
    if (!viewport) return
    detach()
    element.scrollIntoView(options)
    readMetrics()
  }, [detach, readMetrics])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const markUserInteraction = () => {
      userInteractionRef.current = true
    }
    const clearPointerInteraction = () => {
      userInteractionRef.current = false
    }
    const handleWheel = (event: WheelEvent) => {
      userInteractionRef.current = true
      if (event.deltaY < 0) detach()
      if (wheelInteractionFrameRef.current !== null) cancelAnimationFrame(wheelInteractionFrameRef.current)
      wheelInteractionFrameRef.current = requestAnimationFrame(() => {
        wheelInteractionFrameRef.current = null
        userInteractionRef.current = false
      })
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(event.key)) return
      userInteractionRef.current = true
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' || (event.key === ' ' && event.shiftKey)) {
        detach()
      }
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) userInteractionRef.current = false
    }
    const handleScroll = () => {
      const metrics = getConversationScrollMetrics(viewport, bottomThreshold)
      const movedUp = metrics.scrollTop < previousScrollTopRef.current - 1
      previousScrollTopRef.current = metrics.scrollTop
      setDistanceFromBottom(metrics.distanceFromBottom)

      applyFollowState(reduceConversationFollowState(followStateRef.current, {
        userInitiated: userInteractionRef.current,
        movedUp,
        atBottom: metrics.atBottom,
      }))

      if (metrics.scrollTop < topThreshold && !topLoadTriggeredRef.current) {
        topLoadTriggeredRef.current = true
        latestOnNearTopRef.current?.()
      } else if (metrics.scrollTop > topThreshold + 40) {
        topLoadTriggeredRef.current = false
      }
    }

    viewport.addEventListener('scroll', handleScroll, { passive: true })
    viewport.addEventListener('wheel', handleWheel, { passive: true })
    viewport.addEventListener('pointerdown', markUserInteraction, { passive: true })
    viewport.addEventListener('pointerup', clearPointerInteraction, { passive: true })
    viewport.addEventListener('pointercancel', clearPointerInteraction, { passive: true })
    viewport.addEventListener('touchstart', markUserInteraction, { passive: true })
    viewport.addEventListener('touchend', clearPointerInteraction, { passive: true })
    viewport.addEventListener('touchcancel', clearPointerInteraction, { passive: true })
    viewport.addEventListener('keydown', handleKeyDown)
    viewport.addEventListener('keyup', handleKeyUp)
    readMetrics()

    return () => {
      if (wheelInteractionFrameRef.current !== null) cancelAnimationFrame(wheelInteractionFrameRef.current)
      viewport.removeEventListener('scroll', handleScroll)
      viewport.removeEventListener('wheel', handleWheel)
      viewport.removeEventListener('pointerdown', markUserInteraction)
      viewport.removeEventListener('pointerup', clearPointerInteraction)
      viewport.removeEventListener('pointercancel', clearPointerInteraction)
      viewport.removeEventListener('touchstart', markUserInteraction)
      viewport.removeEventListener('touchend', clearPointerInteraction)
      viewport.removeEventListener('touchcancel', clearPointerInteraction)
      viewport.removeEventListener('keydown', handleKeyDown)
      viewport.removeEventListener('keyup', handleKeyUp)
    }
  }, [applyFollowState, bottomThreshold, detach, readMetrics, sessionId, topThreshold])

  useEffect(() => {
    const content = contentRef.current ?? viewportRef.current?.firstElementChild
    if (!content || typeof ResizeObserver === 'undefined') return
    const resizeObserver = new ResizeObserver(() => followContentGrowth())
    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [followContentGrowth, sessionId])

  useEffect(() => () => {
    if (followFrameRef.current !== null) cancelAnimationFrame(followFrameRef.current)
    if (prependFrameRef.current !== null) cancelAnimationFrame(prependFrameRef.current)
  }, [])

  return useMemo(() => ({
    viewportRef: viewportRef as RefObject<HTMLDivElement>,
    contentRef: contentRef as RefObject<HTMLDivElement>,
    isFollowing,
    hasNewContent,
    distanceFromBottom,
    followContentGrowth,
    resetForSession,
    scrollToLatest,
    detach,
    capturePrependPosition,
    restorePrependPosition,
    compensateViewportHeight,
    scrollTargetIntoView,
  }), [
    capturePrependPosition,
    compensateViewportHeight,
    detach,
    distanceFromBottom,
    followContentGrowth,
    hasNewContent,
    isFollowing,
    resetForSession,
    restorePrependPosition,
    scrollTargetIntoView,
    scrollToLatest,
  ])
}
