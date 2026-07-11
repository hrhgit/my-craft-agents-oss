const PROJECTION_OWNED_LEGACY_EVENTS = new Set([
  'text_delta',
  'text_complete',
  'tool_start',
  'tool_result',
  'error',
  'typed_error',
  'complete',
  'user_message',
  'permission_request',
  'plan_submitted',
  'plan_artifact_changed',
  'plan_mode_state_changed',
  'auth_request',
  'auth_completed',
])

/** Host-only events remain while Pi-native transcript and lifecycle use projection. */
export function shouldSuppressLegacyTranscriptEvent(piNative: boolean, eventType: string): boolean {
  return piNative && PROJECTION_OWNED_LEGACY_EVENTS.has(eventType)
}

/**
 * A sidecar is not an ownership marker: legacy sessions can acquire one when
 * resumed during dual-write. Only sessions created under the Pi-first contract
 * may let projection replace their Craft transcript.
 */
export function isPiNativeConversation(
  session: { conversationFormat?: string } | null | undefined,
): boolean {
  return session?.conversationFormat === 'pi-projection-v1'
}
