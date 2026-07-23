import type { Message, StoredMessage } from './message.ts';

function rejectRemovedPlanRole(role: string): void {
  if (role === 'plan') {
    throw new TypeError('Stored message role "plan" was removed; use role "assistant" with a versioned plan artifact');
  }
}

/**
 * Convert runtime Message to StoredMessage for persistence.
 *
 * Excludes transient runtime-only fields:
 * - isStreaming
 * - isPending
 */
export function messageToStored(msg: Message): StoredMessage {
  const { role, isStreaming, isPending, ...rest } = msg;
  rejectRemovedPlanRole(role);
  return { ...rest, type: role } as StoredMessage;
}

/**
 * Convert StoredMessage to runtime Message.
 *
 * Adds a timestamp fallback for messages where timestamp was omitted.
 */
export function storedToMessage(stored: StoredMessage): Message {
  const { type, ...rest } = stored;
  rejectRemovedPlanRole(type);
  const timestamp = stored.timestamp ?? Date.now();
  return { ...rest, role: type, timestamp } as Message;
}
