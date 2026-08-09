import type { MidStreamSendIntent } from '@mortise/shared/protocol'

interface EnterShortcutEvent {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  isComposing: boolean
}

/**
 * Read the IME-composition flag from a keydown event regardless of whether it
 * is a React synthetic event (exposes `nativeEvent`) or a raw DOM KeyboardEvent
 * from the rich editor's `handleDOMEvents` (exposes `isComposing` directly).
 */
export function getEventIsComposing<T extends {
  nativeEvent?: { isComposing?: boolean }
  isComposing?: boolean
}>(event: T): boolean {
  return event.nativeEvent?.isComposing ?? event.isComposing ?? false
}

export function resolveMidStreamSendIntent(
  sendMessageKey: 'enter' | 'cmd-enter',
  event: EnterShortcutEvent,
): MidStreamSendIntent | null {
  if (event.key !== 'Enter' || event.isComposing) return null

  if (event.metaKey || event.ctrlKey) return 'alternate'
  if (sendMessageKey === 'enter' && !event.shiftKey) return 'default'

  return null
}
