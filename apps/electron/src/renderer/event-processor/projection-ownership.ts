const PROJECTION_OWNED_HOST_EVENTS = new Set([
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
])

/** Pi projection is the sole owner of transcript and lifecycle presentation. */
export function isProjectionOwnedHostEvent(eventType: string): boolean {
  return PROJECTION_OWNED_HOST_EVENTS.has(eventType)
}
