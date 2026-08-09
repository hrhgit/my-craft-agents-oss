const PROJECTION_OWNED_HOST_EVENTS = new Set([
  'text_delta',
  'text_complete',
  'tool_start',
  'tool_result',
  'error',
  'typed_error',
  'user_message',
  'plan_submitted',
  'plan_artifact_changed',
  'plan_mode_state_changed',
])

/** Pi projection owns transcript/attempt presentation; Host complete owns durable readiness. */
export function isProjectionOwnedHostEvent(eventType: string): boolean {
  return PROJECTION_OWNED_HOST_EVENTS.has(eventType)
}
