import type { Message } from '../../shared/types'

/**
 * Adds the renderer-side UI carrier for a projected Pi user message.
 * The carrier deliberately has no transcript content; Pi remains authoritative
 * for the message body and ordering.
 */
export function upsertPiUserOverlayCarrier(
  messages: Message[],
  carrier: Message,
): Message[] {
  const sanitizedCarrier: Message = {
    ...carrier,
    role: 'user',
    content: '',
  }
  const existingIndex = messages.findIndex(message => message.id === carrier.id)
  if (existingIndex < 0) return [...messages, sanitizedCarrier]

  const existing = messages[existingIndex]!
  const merged: Message = {
    ...existing,
    ...sanitizedCarrier,
    annotations: sanitizedCarrier.annotations ?? existing.annotations,
    attachments: sanitizedCarrier.attachments ?? existing.attachments,
    badges: sanitizedCarrier.badges ?? existing.badges,
  }
  return messages.map((message, index) => index === existingIndex ? merged : message)
}

/** Marks an acknowledged overlay carrier as no longer waiting on the send RPC. */
export function settlePiUserOverlayCarrier(
  messages: Message[],
  messageId: string,
): Message[] {
  const existingIndex = messages.findIndex(message => message.id === messageId)
  if (existingIndex < 0 || messages[existingIndex]?.isPending === false) return messages
  return messages.map((message, index) =>
    index === existingIndex ? { ...message, isPending: false } : message
  )
}

/** Removes a renderer-only carrier when the send RPC rejects before acceptance. */
export function removePiUserOverlayCarrier(
  messages: Message[],
  messageId: string,
): Message[] {
  if (!messages.some(message => message.id === messageId)) return messages
  return messages.filter(message => message.id !== messageId)
}
