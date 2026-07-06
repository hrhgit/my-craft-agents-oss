/**
 * Shared route helpers for Pi tree sessions displayed through Craft UI.
 *
 * A `pi-*` session id is a read-only route id, not a Craft session lifecycle id.
 * It points at the same Pi tree session file whether opened in the embedded
 * session view or in a child BrowserWindow.
 */

export const PI_READ_ONLY_SESSION_PREFIX = 'pi-'

export function isPiReadOnlySessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(PI_READ_ONLY_SESSION_PREFIX)
}

export function toPiReadOnlySessionId(sessionId: string): string {
  return isPiReadOnlySessionId(sessionId)
    ? sessionId
    : `${PI_READ_ONLY_SESSION_PREFIX}${sessionId}`
}

export function fromPiReadOnlySessionId(sessionId: string): string {
  return isPiReadOnlySessionId(sessionId)
    ? sessionId.slice(PI_READ_ONLY_SESSION_PREFIX.length)
    : sessionId
}

export function toPiReadOnlySessionRoute(sessionId: string): `allSessions/session/${string}` {
  return `allSessions/session/${toPiReadOnlySessionId(sessionId)}`
}
