import type {
  PiProjectionEntityV1,
  PiProjectionEventV1,
} from '@mortise/shared/protocol'
import type { PiProjectionState } from '@/atoms/pi-projection'

export interface PiAgentEndHandoff {
  sessionId: string
  preview?: string
}

function readVisibleAssistantText(entity: PiProjectionEntityV1): string | undefined {
  if (entity.entityType !== 'content_block') return undefined
  if (entity.kind !== 'assistant_text' && entity.kind !== 'assistant_text_delta') return undefined
  if (!entity.payload || typeof entity.payload !== 'object') return undefined

  const payload = entity.payload as Record<string, unknown>
  if (payload.role !== 'assistant'
    || payload.isIntermediate === true
    || payload.intermediate === true
    || typeof payload.text !== 'string') {
    return undefined
  }
  const text = payload.text.trim()
  return text || undefined
}

/**
 * Returns a completion handoff only when this live event was accepted by the
 * normalized projection store. This prevents replayed events from repeating
 * notifications and cleanup side effects.
 */
export function getPiAgentEndHandoff(
  previous: PiProjectionState,
  current: PiProjectionState,
  event: PiProjectionEventV1,
): PiAgentEndHandoff | null {
  if (event.kind !== 'agent_end' || event.entityType !== 'conversation') return null
  if (current.syncState !== 'synced' || current.lastSeq !== event.seq) return null
  if (previous.lastSeq >= event.seq || previous.seenEventIds.has(event.eventId)) return null

  let latest: PiProjectionEntityV1 | undefined
  for (const entityId of current.entityIds) {
    const entity = current.entitiesById[entityId]
    if (!entity || !readVisibleAssistantText(entity)) continue
    if (!latest || entity.lastSeq > latest.lastSeq) latest = entity
  }

  return {
    sessionId: event.sessionId,
    preview: latest ? readVisibleAssistantText(latest) : undefined,
  }
}
