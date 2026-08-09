/**
 * Wire protocol types for the WS-based RPC layer.
 *
 * Shared between server (main process / headless) and client (renderer / Node).
 */

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

export type MessageType =
  | 'handshake'
  | 'handshake_ack'
  | 'request'
  | 'request_cancel'
  | 'response'
  | 'event'
  | 'error'
  | 'sequence_ack'

export interface MessageEnvelope {
  /** Correlation ID. UUIDv4 for requests; echoed in responses. */
  id: string
  type: MessageType
  /** Required for request / response / event / error. */
  channel?: string
  /** Request args or event payload. */
  args?: unknown[]
  /** Response payload. */
  result?: unknown
  /** Structured error. */
  error?: WireError
  /** Sent on handshake / handshake_ack. */
  protocolVersion?: string
  /** Sent on handshake by the client. */
  workspaceId?: string
  /** Sent on handshake for remote auth. */
  token?: string
  /** Assigned by server in handshake_ack. */
  clientId?: string
  /** Server identity stamp on outgoing events. For MultiClient source disambiguation. */
  serverId?: string
  /** Electron webContents.id, sent on handshake by local clients. */
  webContentsId?: number
  /** Client capabilities advertised on handshake. */
  clientCapabilities?: string[]
  /** Server-registered channels, sent in handshake_ack. Clients use this to avoid calling unavailable channels. */
  registeredChannels?: string[]

  // -- Reliable delivery fields --

  /** Per-client monotonic delivery sequence number, assigned when an event is targeted to that client. */
  seq?: number
  /** Client's last processed per-client seq — sent in sequence_ack and reconnect handshake. */
  lastSeq?: number
  /** Previous clientId — sent by client on reconnect handshake. */
  reconnectClientId?: string
  /** True when handshake_ack is for a reconnection (vs fresh connect). */
  reconnected?: boolean
  /** True when server buffer was evicted — client must do a full state refresh. */
  stale?: boolean
  /** Server app version, sent in handshake_ack. Clients can use this for compatibility checks. */
  serverVersion?: string
}

export interface WireError {
  code: TransportErrorCode
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const SESSION_SETTLEMENT_ERROR_CODE = 'SESSION_SETTLEMENT_FAILED' as const

export type TransportErrorCode =
  | 'HANDLER_ERROR'
  | 'CHANNEL_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'SESSION_NOT_IDLE'
  | 'SESSION_ID_CONFLICT'
  | 'ARTIFACT_NOT_PORTABLE'
  | 'TRANSFER_TOO_LARGE'
  | 'TRANSFER_TIMEOUT'
  | 'TRANSFER_VERIFICATION_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'SESSION_PERSISTENCE_FAILED'
  | 'SESSION_PROJECTION_PERSISTENCE_FAILED'
  | 'SESSION_PUBLICATION_DURABILITY_FAILED'
  | 'QUEUED_MESSAGE_WITHDRAWN'
  | typeof SESSION_SETTLEMENT_ERROR_CODE
  | 'CLIENT_DISCONNECTED'
  | 'CLIENT_REQUEST_TIMEOUT'
  | 'BROWSER_NO_CAPABLE_CLIENT'
  | 'BROWSER_INSTANCE_NOT_OWNED'
  | 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED'
  | 'BROWSER_REMOTE_EVALUATE_BLOCKED'
  | 'WORKSPACE_MARKER_MISSING'
  | 'WORKSPACE_MARKER_MISMATCH'
  | 'WORKSPACE_LOCATION_UNAVAILABLE'
  | 'WORKSPACE_LOCATION_IN_USE'
  | 'WORKSPACE_STALE_REVISION'
  | 'WORKSPACE_TOPOLOGY_READ_ONLY'
  | 'UNSUPPORTED'
  | 'NO_INTERACTIVE_CLIENT'
  | 'TARGET_UNAVAILABLE'
  | 'LOCATION_PERMISSION_DENIED'
  | 'LOCATION_VERSION_UNSUPPORTED'

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<TransportErrorCode>([
  'HANDLER_ERROR',
  'CHANNEL_NOT_FOUND',
  'AUTH_FAILED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'SESSION_NOT_IDLE',
  'SESSION_ID_CONFLICT',
  'ARTIFACT_NOT_PORTABLE',
  'TRANSFER_TOO_LARGE',
  'TRANSFER_TIMEOUT',
  'TRANSFER_VERIFICATION_FAILED',
  'REQUEST_TIMEOUT',
  'CAPABILITY_UNAVAILABLE',
  'SESSION_PERSISTENCE_FAILED',
  'SESSION_PROJECTION_PERSISTENCE_FAILED',
  'SESSION_PUBLICATION_DURABILITY_FAILED',
  'QUEUED_MESSAGE_WITHDRAWN',
  SESSION_SETTLEMENT_ERROR_CODE,
  'CLIENT_DISCONNECTED',
  'CLIENT_REQUEST_TIMEOUT',
  'BROWSER_NO_CAPABLE_CLIENT',
  'BROWSER_INSTANCE_NOT_OWNED',
  'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
  'BROWSER_REMOTE_EVALUATE_BLOCKED',
  'WORKSPACE_MARKER_MISSING',
  'WORKSPACE_MARKER_MISMATCH',
  'WORKSPACE_LOCATION_UNAVAILABLE',
  'WORKSPACE_LOCATION_IN_USE',
  'WORKSPACE_STALE_REVISION',
  'WORKSPACE_TOPOLOGY_READ_ONLY',
  'UNSUPPORTED',
  'NO_INTERACTIVE_CLIENT',
  'TARGET_UNAVAILABLE',
  'LOCATION_PERMISSION_DENIED',
  'LOCATION_VERSION_UNSUPPORTED',
])

export function isTransportErrorCode(value: unknown): value is TransportErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value)
}

export interface SessionSettlementFailureData {
  sessionId: string
  stage: 'turn-settlement'
  retryable: true
  terminal: false
  outcome: 'accepted-pending-settlement'
}

/**
 * The user message is already canonical and must never be submitted again.
 * Recovery may only retry the host-owned settlement boundary for this Session.
 */
export interface SessionSettlementFailure extends WireError {
  code: typeof SESSION_SETTLEMENT_ERROR_CODE
  data: SessionSettlementFailureData
}

export interface SessionPublicationFailureData {
  sessionId: string
  stage: 'runtime' | 'metadata' | 'projection'
  retryable: boolean
  terminal: true
  outcome: 'unpublished'
}

/**
 * Mortise accepted the first turn, but the provisional Session could not be
 * published. The original outbox mutation remains retryable and must not be
 * submitted with a new client mutation id.
 */
export interface SessionPublicationFailure extends WireError {
  code: 'SESSION_PUBLICATION_DURABILITY_FAILED'
  data: SessionPublicationFailureData
}

export type SessionFailure = SessionSettlementFailure | SessionPublicationFailure

export function isSessionSettlementFailure(value: unknown): value is SessionSettlementFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const failure = value as { code?: unknown; message?: unknown; data?: unknown }
  if (
    failure.code !== SESSION_SETTLEMENT_ERROR_CODE
    || typeof failure.message !== 'string'
    || !failure.data
    || typeof failure.data !== 'object'
    || Array.isArray(failure.data)
  ) {
    return false
  }

  const data = failure.data as Record<string, unknown>
  return typeof data.sessionId === 'string'
    && data.sessionId.length > 0
    && data.stage === 'turn-settlement'
    && data.retryable === true
    && data.terminal === false
    && data.outcome === 'accepted-pending-settlement'
}

export function isSessionPublicationFailure(value: unknown): value is SessionPublicationFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const failure = value as { code?: unknown; message?: unknown; data?: unknown }
  if (
    failure.code !== 'SESSION_PUBLICATION_DURABILITY_FAILED'
    || typeof failure.message !== 'string'
    || !failure.data
    || typeof failure.data !== 'object'
    || Array.isArray(failure.data)
  ) return false

  const data = failure.data as Record<string, unknown>
  return typeof data.sessionId === 'string'
    && data.sessionId.length > 0
    && (data.stage === 'runtime' || data.stage === 'metadata' || data.stage === 'projection')
    && typeof data.retryable === 'boolean'
    && data.terminal === true
    && data.outcome === 'unpublished'
}

/**
 * Sender-side helper for throwing transport errors with a typed `code`.
 *
 * Class identity is lost across the wire — the transport reconstructs a plain
 * `Error` with `.code` on the receiving side. Receivers MUST branch on
 * `err.code === 'X'`, never `err instanceof CodedError`.
 */
export class CodedError extends Error {
  readonly code: TransportErrorCode
  readonly data?: unknown
  constructor(code: TransportErrorCode, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
    this.name = 'CodedError'
  }
}

// ---------------------------------------------------------------------------
// Push target (server → clients)
// ---------------------------------------------------------------------------

export type PushTarget =
  | { to: 'all'; exclude?: string }
  | { to: 'workspace'; workspaceId: string; exclude?: string }
  | { to: 'client'; clientId: string }

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = '1.0'

/** Heartbeat interval in ms. Server pings every 30s. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** Client that misses this many pongs gets terminated. */
export const HEARTBEAT_MAX_MISSED = 2

/** Default request timeout in ms. */
export const REQUEST_TIMEOUT_MS = 30_000

// -- Reliable delivery constants --

/** Max events to retain per client in the ring buffer. */
export const EVENT_BUFFER_MAX_SIZE = 500

/** Events older than this are evicted from the buffer. */
export const EVENT_BUFFER_TTL_MS = 30_000

/** How long to retain a disconnected client's buffer for potential reconnect. */
export const DISCONNECTED_CLIENT_TTL_MS = 60_000

/** Client sends a sequence_ack every N ms. */
export const SEQUENCE_ACK_INTERVAL_MS = 5_000
