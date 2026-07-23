import type * as React from 'react'

export interface ChatMatchInfo {
  sessionId: string | null
  count: number
  index: number
  hasMore: boolean
  isHighlighting: boolean
}

interface MutableRef<T> {
  current: T | null
}

/**
 * Bind a panel-local handle to a shared shell ref without allowing an older
 * panel's ref cleanup to clear a handle already published by the new owner.
 */
export function createFocusedHandleBinding<T>(
  sharedRef: MutableRef<T> | undefined,
  isFocused: boolean,
): React.RefCallback<T> {
  let ownedHandle: T | null = null

  return (handle) => {
    if (!isFocused || !sharedRef) return

    if (handle) {
      ownedHandle = handle
      sharedRef.current = handle
      return
    }

    if (ownedHandle && sharedRef.current === ownedHandle) {
      sharedRef.current = null
    }
    ownedHandle = null
  }
}

export function createFocusedMatchReporter(
  report: ((info: ChatMatchInfo) => void) | undefined,
  isFocused: boolean,
): ((info: ChatMatchInfo) => void) | undefined {
  if (!report || !isFocused) return undefined
  return info => report(info)
}
