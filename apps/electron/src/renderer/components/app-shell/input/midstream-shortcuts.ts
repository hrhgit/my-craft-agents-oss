import type { MidStreamSendIntent } from '@mortise/shared/protocol'

interface EnterShortcutEvent {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  isComposing: boolean
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
