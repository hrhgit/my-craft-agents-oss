import type { HostSessionProjection } from '@earendil-works/pi-coding-agent/host-facade'
import type { PiProjectionEntityV1, PiProjectionEventV1, PiProjectionSnapshotV1 } from '../../../protocol/pi-projection.ts'
import { PiProjectionBuilder } from './projection-builder.ts'

export type PiHostSessionProjectionLike = Pick<HostSessionProjection, 'leafId' | 'entries'>

/** Rebuilds the active Pi branch without constructing Craft transcript DTOs. */
export function buildPiProjectionSnapshotFromHostProjection(
  sessionId: string,
  runtimeId: string,
  projection: PiHostSessionProjectionLike,
): PiProjectionSnapshotV1 {
  let projectionClock = 0
  const builder = new PiProjectionBuilder(sessionId, runtimeId, undefined, () => projectionClock)
  const events: PiProjectionEventV1[] = []
  const append = (next: PiProjectionEventV1[]): void => { events.push(...next) }

  let agentOpen = false
  let turnOpen = false
  let turnMessage: Record<string, unknown> | undefined
  let toolResultCount = 0
  let lastObservedAt: number | undefined

  const startAgent = (startedAt?: number): void => {
    if (agentOpen) return
    append(builder.acceptRuntimeEvent({ type: 'agent_start', timestamp: startedAt }))
    agentOpen = true
  }

  const startTurn = (startedAt?: number): void => {
    startAgent(startedAt)
    if (turnOpen) return
    append(builder.acceptRuntimeEvent({ type: 'turn_start', timestamp: startedAt }))
    turnOpen = true
  }

  const closeTurn = (completedAt = lastObservedAt): void => {
    if (!turnOpen) return
    append(builder.acceptRuntimeEvent({
      type: 'turn_end',
      timestamp: completedAt,
      message: turnMessage,
      toolResults: Array.from({ length: toolResultCount }, () => ({})),
    }))
    if (turnMessage?.stopReason === 'error') {
      append(builder.accept({
        type: 'error',
        message: typeof turnMessage.errorMessage === 'string'
          ? turnMessage.errorMessage
          : 'Pi runtime error',
      }))
    }
    turnOpen = false
    turnMessage = undefined
    toolResultCount = 0
  }

  const closeAgent = (completedAt = lastObservedAt): void => {
    if (!agentOpen) return
    closeTurn(completedAt)
    append(builder.accept({ type: 'complete' }))
    agentOpen = false
  }

  for (const entry of getActiveBranchEntries(projection)) {
    const entryTimestamp = Date.parse(entry.timestamp)
    const observedAt = Number.isFinite(entryTimestamp) ? entryTimestamp : undefined
    if (observedAt !== undefined) projectionClock = observedAt
    if (entry.type === 'custom_message') {
      append(builder.acceptRuntimeEvent({
        type: 'message_end',
        message: {
          role: 'custom',
          customType: entry.customType,
          content: entry.content,
          details: entry.details,
          display: entry.display,
          timestamp: observedAt,
        },
      }))
      lastObservedAt = observedAt ?? lastObservedAt
      continue
    }
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue

    const rawMessage = entry.message as unknown as Record<string, unknown>
    const message: Record<string, unknown> = {
      ...rawMessage,
      id: typeof rawMessage.id === 'string' && rawMessage.id ? rawMessage.id : entry.id,
      timestamp: rawMessage.timestamp ?? observedAt,
    }
    const messageTimestamp = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
      ? message.timestamp
      : observedAt
    if (message.role === 'user') {
      closeAgent(lastObservedAt)
      startTurn(messageTimestamp)
      append(builder.acceptRuntimeEvent({ type: 'message_end', message }))
      lastObservedAt = messageTimestamp ?? lastObservedAt
      continue
    }

    if (message.role === 'assistant') {
      if (turnMessage) {
        closeTurn(lastObservedAt)
        startTurn(messageTimestamp)
      } else {
        startTurn(messageTimestamp)
      }
      append(builder.acceptRuntimeEvent({ type: 'message_end', message }))
      for (const toolCall of getAssistantToolCalls(message.content)) {
        append(builder.accept({
          type: 'tool_start',
          toolUseId: toolCall.id,
          toolName: toolCall.name,
          input: toolCall.arguments,
        }))
      }
      turnMessage = message
      lastObservedAt = messageTimestamp ?? lastObservedAt
      continue
    }

    if (message.role === 'toolResult') {
      startTurn(messageTimestamp)
      append(builder.accept({
        type: 'tool_result',
        toolUseId: typeof message.toolCallId === 'string' ? message.toolCallId : `orphan-${entry.id}`,
        toolName: typeof message.toolName === 'string' ? message.toolName : undefined,
        result: extractVisibleText(message.content),
        isError: message.isError === true,
      }))
      toolResultCount++
      lastObservedAt = messageTimestamp ?? lastObservedAt
      continue
    }

    if (message.role === 'custom') {
      append(builder.acceptRuntimeEvent({ type: 'message_end', message }))
      lastObservedAt = messageTimestamp ?? lastObservedAt
    }
  }

  closeAgent(lastObservedAt)
  return snapshotFromEvents(sessionId, runtimeId, events)
}

function getActiveBranchEntries(
  projection: PiHostSessionProjectionLike,
): HostSessionProjection['entries'] {
  if (projection.leafId === null) return []

  const byId = new Map(projection.entries.map(entry => [entry.id, entry]))
  const leaf = byId.get(projection.leafId)
  if (!leaf) throw new TypeError(`Invalid Pi session projection leaf: ${projection.leafId}`)

  const result: HostSessionProjection['entries'] = []
  const seen = new Set<string>()
  let current: typeof leaf | undefined = leaf
  while (current) {
    if (seen.has(current.id)) throw new TypeError('Cyclic Pi session projection branch')
    seen.add(current.id)
    result.unshift(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return result
}

function getAssistantToolCalls(value: unknown): Array<{
  id: string
  name: string
  arguments: Record<string, unknown>
}> {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const part = candidate as Record<string, unknown>
    if (part.type !== 'toolCall' || typeof part.id !== 'string' || !part.id
      || typeof part.name !== 'string' || !part.name) return []
    const args = part.arguments && typeof part.arguments === 'object' && !Array.isArray(part.arguments)
      ? part.arguments as Record<string, unknown>
      : {}
    return [{ id: part.id, name: part.name, arguments: args }]
  })
}

function extractVisibleText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const part = candidate as Record<string, unknown>
    return part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  }).join('')
}

function snapshotFromEvents(
  sessionId: string,
  runtimeId: string,
  events: PiProjectionEventV1[],
): PiProjectionSnapshotV1 {
  const entities = new Map<string, PiProjectionEntityV1>()
  for (const event of events) {
    const existing = entities.get(event.entityId)
    entities.set(event.entityId, {
      entityId: event.entityId,
      entityType: event.entityType,
      entityVersion: event.entityVersion,
      createdSeq: existing?.createdSeq ?? event.seq,
      createdAt: existing?.createdAt ?? event.occurredAt,
      updatedAt: event.occurredAt ?? existing?.updatedAt,
      turnId: event.turnId,
      kind: event.kind,
      payload: structuredClone(event.payload),
      lastEventId: event.eventId,
      lastSeq: event.seq,
    })
  }
  return {
    schemaVersion: 1,
    sessionId,
    runtimeId,
    lastSeq: events.at(-1)?.seq ?? 0,
    entities: [...entities.values()].sort((a, b) => a.createdSeq - b.createdSeq),
  }
}
