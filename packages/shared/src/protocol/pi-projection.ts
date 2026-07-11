export const PI_PROJECTION_SCHEMA_VERSION = 1 as const

export type PiProjectionEntityType =
  | 'conversation'
  | 'turn'
  | 'content_block'
  | 'tool_run'
  | 'prompt_request'
  | 'artifact_ref'

/** Stable host-to-client envelope. `kind` and `payload` retain Pi runtime semantics. */
export interface PiProjectionEventV1<TPayload = unknown> {
  schemaVersion: typeof PI_PROJECTION_SCHEMA_VERSION
  eventId: string
  seq: number
  sessionId: string
  runtimeId: string
  turnId?: string
  entityId: string
  entityType: PiProjectionEntityType
  entityVersion: number
  kind: string
  payload: TPayload
}

export interface PiProjectionEntityV1<TPayload = unknown> {
  entityId: string
  entityType: PiProjectionEntityType
  entityVersion: number
  /** Immutable sequence at which this entity first entered the projection. */
  createdSeq: number
  turnId?: string
  kind: string
  payload: TPayload
  lastEventId: string
  lastSeq: number
}

export interface PiProjectionSnapshotV1 {
  schemaVersion: typeof PI_PROJECTION_SCHEMA_VERSION
  sessionId: string
  runtimeId: string
  lastSeq: number
  entities: PiProjectionEntityV1[]
}
