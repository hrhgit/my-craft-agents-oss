export const PI_PROJECTION_SCHEMA_VERSION = 1 as const

export type PiProjectionEntityType =
  | 'conversation'
  | 'turn'
  | 'content_block'
  | 'tool_run'
  | 'prompt_request'
  | 'artifact_ref'

/**
 * Schema-v1 identity contract for projected message content. Every visible
 * content block belongs to one stable Pi message, even when the block is
 * streamed or split by `contentIndex`.
 */
export type PiProjectionContentPayloadV1 =
  | {
      role: 'user'
      messageId: string
      text: string
      streaming: false
      clientMutationId?: string
      queueStatus?: 'queued' | 'accepted'
      source?: 'host' | 'pi'
      timestamp?: number
    }
  | {
      role: 'assistant'
      messageId: string
      contentKind: 'text' | 'thinking'
      text: string
      streaming: boolean
      contentIndex: number
      delta?: string
      stopReason?: string
      isIntermediate?: boolean
      isFinal?: boolean
      timestamp?: number
    }
  | {
      role: 'info'
      messageId: string
      content: string
      level: 'info' | 'warning' | 'error'
      customType: string
      timestamp?: number
    }

/** Attachment artifacts remain separate entities but retain message ownership. */
export interface PiProjectionAttachmentPayloadV1 {
  ownerMessageId: string
  attachment: {
    id: string
    name: string
    mediaType?: string
    size?: number
  }
  clientMutationId?: string
  contentEntityId?: string
  order: number
  queueStatus?: 'queued' | 'accepted'
  source?: 'host' | 'pi'
}

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
  /** Wall-clock time when this projection event occurred, in Unix milliseconds. */
  occurredAt?: number
}

export type PiProjectionContentEventV1 = PiProjectionEventV1<PiProjectionContentPayloadV1> & {
  entityType: 'content_block'
}

export type PiProjectionAttachmentEventV1 = PiProjectionEventV1<PiProjectionAttachmentPayloadV1> & {
  entityType: 'artifact_ref'
  kind: 'user_attachment'
}

export interface PiProjectionEntityV1<TPayload = unknown> {
  entityId: string
  entityType: PiProjectionEntityType
  entityVersion: number
  /** Immutable sequence at which this entity first entered the projection. */
  createdSeq: number
  /** Wall-clock time of the first entity event, in Unix milliseconds. */
  createdAt?: number
  /** Wall-clock time of the latest entity event, in Unix milliseconds. */
  updatedAt?: number
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
