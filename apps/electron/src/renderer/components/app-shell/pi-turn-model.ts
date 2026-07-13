import { isPlanArtifactV1, type PlanArtifactV1 } from '@craft-agent/core'
import type { PiProjectionEntityV1 } from '@craft-agent/shared/protocol'
import type { ActivityItem, AssistantTurn, Turn } from '@craft-agent/ui'
import type { Message, StoredAttachment } from '../../../shared/types'

export interface PiMessageUiOverlay {
  annotations?: Message['annotations']
  attachments?: StoredAttachment[]
  badges?: Message['badges']
  isPending?: boolean
  isQueued?: boolean
  timestamp?: number
}

export type PiTurnOverlay = ReadonlyMap<string, PiMessageUiOverlay>

/** Extracts Craft-owned UI metadata without using Craft message content or order. */
export function buildPiTurnOverlay(messages: readonly Message[]): PiTurnOverlay {
  const overlay = new Map<string, PiMessageUiOverlay>()
  for (const message of messages) {
    const value = {
      annotations: message.annotations,
      attachments: message.attachments,
      badges: message.badges,
      isPending: message.isPending,
      isQueued: message.isQueued,
      timestamp: message.timestamp,
    }
    overlay.set(message.id, value)
  }
  return overlay
}

interface UserAttachmentRef {
  seq: number
  order: number
  value: Record<string, unknown>
}

interface UserRecord {
  messageId: string
  aliases: Set<string>
  turnId?: string
  seq: number
  timestamp: number
  text: string
  optimistic: boolean
  queued?: boolean
  attachments: UserAttachmentRef[]
}

type MessageDisposition = 'final' | 'intermediate' | 'unknown'

interface AssistantTextBlock {
  entityId: string
  seq: number
  lastSeq: number
  contentIndex: number
  text: string
  streaming: boolean
  timestamp?: number
  disposition: MessageDisposition
}

interface AssistantMessageRecord {
  messageId: string
  aliases: Set<string>
  seq: number
  blocks: AssistantTextBlock[]
}

interface PlanArtifactRecord {
  entityId: string
  seq: number
  turnId?: string
  messageId?: string
  artifact: PlanArtifactV1
  content: string
}

interface AssistantRecord {
  turnId: string
  seq: number
  turnEntity?: PiProjectionEntityV1
  messages: Map<string, AssistantMessageRecord>
  activities: Array<ActivityItem & { __seq: number }>
  artifacts: PlanArtifactRecord[]
}

interface TimelineEntry {
  seq: number
  priority: number
  turn: Turn
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function wallClockTimestamp(value: unknown): number | undefined {
  const timestamp = numberValue(value)
  return timestamp !== undefined && timestamp >= 1_000_000_000_000 ? timestamp : undefined
}

function infoLevel(value: unknown): Message['infoLevel'] {
  return value === 'warning' || value === 'error' || value === 'success' ? value : 'info'
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function contentMessageId(entity: PiProjectionEntityV1, payload: Record<string, unknown>): string {
  const explicit = stringValue(payload.messageId)
  if (explicit) return explicit

  const mutationId = stringValue(payload.clientMutationId)
  if (payload.role === 'user' && mutationId) return mutationId

  if (entity.entityId.startsWith('content:user:')) {
    return entity.entityId.slice('content:user:'.length)
  }
  for (const prefix of ['content:text:', 'content:thinking:']) {
    if (!entity.entityId.startsWith(prefix)) continue
    const identity = entity.entityId.slice(prefix.length)
    const contentIndexSeparator = identity.lastIndexOf(':')
    return contentIndexSeparator > 0 ? identity.slice(0, contentIndexSeparator) : identity
  }
  return entity.entityId
}

function attachmentMessageId(entity: PiProjectionEntityV1, payload: Record<string, unknown>): string {
  return stringValue(payload.messageId)
    ?? stringValue(payload.ownerMessageId)
    ?? stringValue(payload.clientMutationId)
    ?? stringValue(payload.contentEntityId)?.replace(/^content:user:/, '')
    ?? entity.entityId
}

function assistantDisposition(payload: Record<string, unknown>): MessageDisposition {
  if (payload.isIntermediate === true || payload.finality === 'intermediate') return 'intermediate'
  if (payload.isIntermediate === false || payload.isFinal === true || payload.final === true || payload.finality === 'final') return 'final'
  const stopReason = stringValue(payload.stopReason)
  if (stopReason === 'toolUse' || stopReason === 'tool_use') return 'intermediate'
  if (stopReason === 'stop' || stopReason === 'end_turn') return 'final'
  return 'unknown'
}

function queuedState(payload: Record<string, unknown>): boolean | undefined {
  if (payload.queueStatus === 'queued') return true
  if (payload.queueStatus === 'accepted' || payload.queueStatus === 'processing') return false
  return undefined
}

function attachmentType(mediaType: string): StoredAttachment['type'] {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType.startsWith('text/')) return 'text'
  if (mediaType.startsWith('audio/')) return 'audio'
  if (mediaType === 'application/pdf') return 'pdf'
  if (/officedocument|msword|ms-excel|ms-powerpoint/.test(mediaType)) return 'office'
  return 'unknown'
}

function resolveAttachment(ref: UserAttachmentRef, overlay: PiMessageUiOverlay | undefined): StoredAttachment | null {
  const id = stringValue(ref.value.id)
  const name = stringValue(ref.value.name)
  if (!id || !name) return null
  const persisted = overlay?.attachments?.find(attachment => attachment.id === id)
  if (persisted) return persisted

  const mimeType = stringValue(ref.value.mediaType) ?? stringValue(ref.value.mimeType) ?? 'application/octet-stream'
  return {
    id,
    type: attachmentType(mimeType),
    name,
    mimeType,
    size: numberValue(ref.value.size) ?? 0,
    storedPath: '',
  }
}

function activityStatus(payload: Record<string, unknown>): ActivityItem['status'] {
  if (payload.status === 'running' || payload.status === 'pending' || payload.status === 'backgrounded') return payload.status
  if (payload.status === 'failed' || payload.isError === true) return 'error'
  return 'completed'
}

function calculateDepths(activities: ActivityItem[]): void {
  const byToolUseId = new Map(activities.flatMap(activity => activity.toolUseId ? [[activity.toolUseId, activity] as const] : []))
  for (const activity of activities) {
    let parentId = activity.parentId
    let depth = 0
    const seen = new Set<string>()
    while (parentId && depth < 10 && !seen.has(parentId)) {
      seen.add(parentId)
      depth += 1
      parentId = byToolUseId.get(parentId)?.parentId
    }
    activity.depth = depth
  }
}

function extractTodos(activities: ActivityItem[]): AssistantTurn['todos'] {
  const latest = [...activities]
    .reverse()
    .find(activity => activity.toolName === 'TodoWrite' && activity.status === 'completed' && Array.isArray(activity.toolInput?.todos))
  if (!latest || !Array.isArray(latest.toolInput?.todos)) return undefined
  return latest.toolInput.todos.flatMap(candidate => {
    const todo = record(candidate)
    if (!todo || typeof todo.content !== 'string') return []
    if (todo.status !== 'pending' && todo.status !== 'in_progress' && todo.status !== 'completed') return []
    return [{
      content: todo.content,
      status: todo.status,
      activeForm: stringValue(todo.activeForm),
    }]
  })
}

function getAssistantRecord(records: Map<string, AssistantRecord>, turnId: string, seq: number): AssistantRecord {
  const existing = records.get(turnId)
  if (existing) {
    existing.seq = Math.min(existing.seq, seq)
    return existing
  }
  const created: AssistantRecord = {
    turnId,
    seq,
    messages: new Map(),
    activities: [],
    artifacts: [],
  }
  records.set(turnId, created)
  return created
}

/**
 * Pi emits turn_start before the user message that opens that turn. Anchor an
 * empty assistant turn after its user message, while keeping populated turns
 * at their first visible activity so prompts/errors between the two remain in
 * chronological order.
 */
function assistantTimelineSeq(
  assistant: AssistantRecord,
  users: Iterable<UserRecord>,
): number {
  const visibleSequences = [
    ...assistant.activities.map(activity => activity.__seq),
    ...[...assistant.messages.values()].flatMap(message => message.blocks.map(block => block.seq)),
    ...assistant.artifacts.map(artifact => artifact.seq),
  ]
  if (visibleSequences.length > 0) return Math.min(...visibleSequences)

  const userSequences = [...users]
    .filter(user => user.turnId === assistant.turnId)
    .map(user => user.seq)
  return Math.max(assistant.seq, ...userSequences)
}

function latestRuntimeTerminal(entities: readonly PiProjectionEntityV1[]): PiProjectionEntityV1 | undefined {
  return entities
    .filter(entity => entity.kind === 'agent_start' || entity.kind === 'agent_end' || entity.kind === 'runtime_error')
    .sort((a, b) => b.lastSeq - a.lastSeq)[0]
}

function isRuntimeStopped(entities: readonly PiProjectionEntityV1[]): boolean {
  const latest = latestRuntimeTerminal(entities)
  return latest?.kind === 'agent_end' || latest?.kind === 'runtime_error'
}

function buildAssistantTurn(
  recordValue: AssistantRecord,
  overlay: PiTurnOverlay,
  batchComplete: boolean,
  startedAt?: number,
  completedAtOverride?: number,
): AssistantTurn {
  const messages = [...recordValue.messages.values()].sort((a, b) => a.seq - b.seq)
  const tools = recordValue.activities.filter(activity => activity.type === 'tool')
  const lastToolSeq = tools.reduce((latest, activity) => Math.max(latest, activity.__seq), -1)
  const turnComplete = batchComplete

  const artifact = [...recordValue.artifacts].sort((a, b) => a.seq - b.seq).at(-1)
  const artifactTarget = artifact?.messageId
    ? messages.find(message => message.messageId === artifact.messageId || message.aliases.has(artifact.messageId!))
    : undefined
  const explicitFinal = [...messages].reverse().find(message => message.blocks.some(block => block.disposition === 'final'))
  const inferredFinal = [...messages].reverse().find(message => {
    if (message.blocks.every(block => block.disposition === 'intermediate')) return false
    return lastToolSeq < 0 || message.seq > lastToolSeq
  })
  const responseMessage = artifactTarget ?? explicitFinal ?? inferredFinal ?? (turnComplete ? messages.at(-1) : undefined)

  const activities = recordValue.activities.map(({ __seq: _seq, ...activity }) => activity)
  for (const message of messages) {
    if (message === responseMessage) continue
    const blocks = [...message.blocks].sort((a, b) => a.contentIndex - b.contentIndex || a.seq - b.seq)
    const content = blocks.map(block => block.text).filter(Boolean).join('\n\n')
    activities.push({
      id: blocks[0]?.entityId ?? `content:${message.messageId}`,
      type: 'intermediate',
      status: blocks.some(block => block.streaming) && !turnComplete ? 'running' : 'completed',
      content,
      messageId: message.messageId,
      annotations: overlay.get(message.messageId)?.annotations,
      timestamp: blocks[0]?.seq ?? message.seq,
    })
  }
  activities.sort((a, b) => a.timestamp - b.timestamp)
  calculateDepths(activities)

  let response: AssistantTurn['response']
  if (responseMessage || artifact) {
    const blocks = responseMessage
      ? [...responseMessage.blocks].sort((a, b) => a.contentIndex - b.contentIndex || a.seq - b.seq)
      : []
    const messageId = artifact?.messageId ?? responseMessage?.messageId
    const ui = messageId ? overlay.get(messageId) : undefined
    response = {
      text: artifact?.content || blocks.map(block => block.text).filter(Boolean).join('\n\n'),
      isStreaming: !turnComplete && blocks.some(block => block.streaming),
      streamStartTime: !turnComplete && blocks.some(block => block.streaming) ? blocks[0]?.seq : undefined,
      messageId,
      annotations: ui?.annotations,
      artifact: artifact?.artifact,
    }
  }

  const isStreaming = !turnComplete && (
    response?.isStreaming === true
    || activities.some(activity => activity.status === 'running' || activity.status === 'pending' || activity.status === 'backgrounded')
    || recordValue.turnEntity?.kind === 'turn_start'
  )
  const responseCompletedAt = responseMessage?.blocks.reduce<number | undefined>((latest, block) => {
    if (block.timestamp === undefined) return latest
    return latest === undefined || block.timestamp > latest ? block.timestamp : latest
  }, undefined)
  const completedAt = turnComplete
    ? wallClockTimestamp(recordValue.turnEntity?.updatedAt)
      ?? completedAtOverride
      ?? (responseCompletedAt !== undefined && Number.isFinite(responseCompletedAt) ? responseCompletedAt : undefined)
    : undefined
  const durationMs = startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt
    ? completedAt - startedAt
    : undefined
  return {
    type: 'assistant',
    turnId: recordValue.turnId,
    activities,
    response,
    intent: activities.find(activity => activity.intent)?.intent,
    isStreaming,
    isComplete: turnComplete,
    timestamp: recordValue.seq,
    startedAt,
    completedAt,
    durationMs,
    todos: extractTodos(activities),
  }
}

interface AssistantBatch {
  record: AssistantRecord
  userSeq?: number
  startedAt?: number
}

/** Pi turns are model-call boundaries. The chat card boundary is the user request. */
function batchAssistantRecords(
  records: Iterable<AssistantRecord>,
  users: Iterable<UserRecord>,
): AssistantBatch[] {
  const sortedUsers = [...users].sort((a, b) => a.seq - b.seq)
  const batches = new Map<number | undefined, AssistantRecord>()
  const ownerAt = (seq: number): UserRecord | undefined =>
    [...sortedUsers].reverse().find(user => user.seq <= seq)

  const getBatch = (owner: UserRecord | undefined, source: AssistantRecord): AssistantRecord => {
    const batchKey = owner?.seq
    const existing = batches.get(batchKey)
    if (existing) return existing
    const created: AssistantRecord = {
      turnId: owner?.turnId ?? source.turnId,
      seq: owner?.seq ?? source.seq,
      messages: new Map(),
      activities: [],
      artifacts: [],
    }
    batches.set(batchKey, created)
    return created
  }

  for (const source of records) {
    let assignedVisibleEntity = false

    for (const message of source.messages.values()) {
      assignedVisibleEntity = true
      const target = getBatch(ownerAt(message.seq), source)
      const existing = target.messages.get(message.messageId)
      if (!existing) {
        target.messages.set(message.messageId, message)
      } else {
        message.aliases.forEach(alias => existing.aliases.add(alias))
        existing.seq = Math.min(existing.seq, message.seq)
        existing.blocks.push(...message.blocks)
      }
    }

    for (const activity of source.activities) {
      assignedVisibleEntity = true
      getBatch(ownerAt(activity.__seq), source).activities.push(activity)
    }

    for (const artifact of source.artifacts) {
      assignedVisibleEntity = true
      getBatch(ownerAt(artifact.seq), source).artifacts.push(artifact)
    }

    if (source.turnEntity) {
      const matchingUser = sortedUsers.find(user => user.turnId === source.turnId)
      const target = getBatch(matchingUser ?? ownerAt(source.turnEntity.createdSeq), source)
      if (!target.turnEntity || source.turnEntity.createdSeq >= target.turnEntity.createdSeq) {
        target.turnEntity = source.turnEntity
      }
    } else if (!assignedVisibleEntity) {
      getBatch(sortedUsers.find(user => user.turnId === source.turnId) ?? ownerAt(source.seq), source)
    }
  }

  return [...batches.entries()]
    .map(([userSeq, recordValue]) => ({
      record: recordValue,
      userSeq,
      startedAt: wallClockTimestamp(sortedUsers.find(user => user.seq === userSeq)?.timestamp),
    }))
    .sort((a, b) => assistantTimelineSeq(a.record, sortedUsers) - assistantTimelineSeq(b.record, sortedUsers))
}

/**
 * Adapts the normalized Pi projection to the existing TurnCard view model.
 * Craft data is consulted only for UI overlays keyed by Pi message identity.
 */
export function buildPiTurns(
  inputEntities: readonly PiProjectionEntityV1[],
  overlay: PiTurnOverlay = new Map(),
): Turn[] {
  const entities = [...inputEntities].sort((a, b) => a.createdSeq - b.createdSeq || a.entityId.localeCompare(b.entityId))
  const users = new Map<string, UserRecord>()
  const assistants = new Map<string, AssistantRecord>()
  const artifacts: PlanArtifactRecord[] = []
  const entries: TimelineEntry[] = []

  for (const entity of entities) {
    const payload = record(entity.payload)
    if (!payload) continue

    if (entity.entityType === 'turn') {
      const turnId = entity.turnId ?? entity.entityId.replace(/^turn:/, '')
      getAssistantRecord(assistants, turnId, entity.createdSeq).turnEntity = entity
      continue
    }

    if (entity.entityType === 'content_block' && payload.role === 'user') {
      const messageId = contentMessageId(entity, payload)
      const aliases = new Set([messageId, entity.entityId])
      const mutationId = stringValue(payload.clientMutationId)
      if (mutationId) aliases.add(mutationId)
      const existing = users.get(messageId)
      const timestamp = numberValue(payload.timestamp)
        ?? overlay.get(messageId)?.timestamp
        ?? wallClockTimestamp(entity.createdAt)
        ?? entity.createdSeq
      if (existing) {
        existing.turnId ??= entity.turnId
        existing.text = typeof payload.text === 'string' ? payload.text : existing.text
        existing.optimistic = payload.optimistic === true
        existing.queued = queuedState(payload) ?? existing.queued
        aliases.forEach(alias => existing.aliases.add(alias))
      } else {
        users.set(messageId, {
          messageId,
          aliases,
          turnId: entity.turnId,
          seq: entity.createdSeq,
          timestamp,
          text: typeof payload.text === 'string' ? payload.text : '',
          optimistic: payload.optimistic === true,
          queued: queuedState(payload),
          attachments: [],
        })
      }
      continue
    }

    if (entity.entityType === 'artifact_ref' && entity.kind === 'user_attachment') {
      const attachment = record(payload.attachment)
      if (!attachment) continue
      const messageId = attachmentMessageId(entity, payload)
      const aliases = new Set([messageId])
      const mutationId = stringValue(payload.clientMutationId)
      if (mutationId) aliases.add(mutationId)
      const existing = users.get(messageId)
      const ui = overlay.get(messageId)
      const user = existing ?? {
        messageId,
        aliases,
        turnId: entity.turnId,
        seq: entity.createdSeq,
        timestamp: ui?.timestamp ?? wallClockTimestamp(entity.createdAt) ?? entity.createdSeq,
        text: '',
        optimistic: payload.optimistic === true,
        queued: queuedState(payload),
        attachments: [],
      }
      user.turnId ??= entity.turnId
      aliases.forEach(alias => user.aliases.add(alias))
      user.seq = Math.min(user.seq, entity.createdSeq)
      user.attachments.push({
        seq: entity.createdSeq,
        order: numberValue(payload.order) ?? user.attachments.length,
        value: attachment,
      })
      users.set(messageId, user)
      continue
    }

    if (entity.entityType === 'content_block' && payload.role === 'assistant') {
      const messageId = contentMessageId(entity, payload)
      const contentKind = payload.contentKind === 'thinking' || entity.kind.startsWith('thinking') ? 'thinking' : 'text'
      const turnId = entity.turnId ?? `message:${messageId}`
      const assistant = getAssistantRecord(assistants, turnId, entity.createdSeq)
      if (contentKind === 'thinking') {
        assistant.activities.push({
          __seq: entity.createdSeq,
          id: entity.entityId,
          type: 'intermediate',
          status: payload.streaming === true ? 'running' : 'completed',
          content: typeof payload.text === 'string' ? payload.text : '',
          messageId,
          annotations: overlay.get(messageId)?.annotations,
          timestamp: numberValue(payload.timestamp) ?? entity.createdSeq,
        })
        continue
      }

      const message = assistant.messages.get(messageId) ?? {
        messageId,
        aliases: new Set([messageId]),
        seq: entity.createdSeq,
        blocks: [],
      }
      message.aliases.add(entity.entityId)
      const mutationId = stringValue(payload.clientMutationId)
      if (mutationId) message.aliases.add(mutationId)
      message.blocks.push({
        entityId: entity.entityId,
        seq: entity.createdSeq,
        lastSeq: entity.lastSeq,
        contentIndex: numberValue(payload.contentIndex) ?? message.blocks.length,
        text: typeof payload.text === 'string' ? payload.text : '',
        streaming: payload.streaming === true,
        timestamp: wallClockTimestamp(payload.timestamp),
        disposition: assistantDisposition(payload),
      })
      assistant.messages.set(messageId, message)
      continue
    }

    if (entity.entityType === 'content_block' && payload.role === 'info') {
      const message: Message = {
        id: contentMessageId(entity, payload),
        role: 'info',
        content: stringValue(payload.content) ?? stringValue(payload.text) ?? '',
        timestamp: numberValue(payload.timestamp) ?? entity.createdSeq,
        infoLevel: infoLevel(payload.level),
        customType: stringValue(payload.customType),
        customDisplay: true,
      }
      entries.push({
        seq: entity.createdSeq,
        priority: 2,
        turn: { type: 'system', message, timestamp: message.timestamp },
      })
      continue
    }

    if (entity.entityType === 'tool_run') {
      const turnId = entity.turnId ?? `tool:${entity.entityId}`
      const assistant = getAssistantRecord(assistants, turnId, entity.createdSeq)
      const input = record(payload.input)
      const status = activityStatus(payload)
      const result = payload.result
      assistant.activities.push({
        __seq: entity.createdSeq,
        id: entity.entityId,
        type: 'tool',
        status,
        toolName: stringValue(payload.toolName) ?? 'tool',
        toolUseId: stringValue(payload.toolCallId) ?? entity.entityId,
        toolInput: input ?? undefined,
        content: formatValue(result),
        error: status === 'error' ? formatValue(result) || 'Tool failed' : undefined,
        intent: stringValue(payload.intent),
        displayName: stringValue(payload.displayName),
        parentId: stringValue(payload.parentToolUseId),
        timestamp: numberValue(payload.timestamp) ?? entity.createdSeq,
      })
      continue
    }

    if (entity.entityType === 'artifact_ref' && isPlanArtifactV1(payload.artifact)) {
      artifacts.push({
        entityId: entity.entityId,
        seq: entity.createdSeq,
        turnId: entity.turnId,
        messageId: stringValue(payload.messageId) ?? stringValue(payload.assistantMessageId),
        artifact: payload.artifact,
        content: typeof payload.content === 'string' ? payload.content : '',
      })
      continue
    }

    if (entity.entityType === 'prompt_request'
      && (entity.kind === 'auth_request' || entity.kind === 'prompt_resolved')) {
      const authType = payload.authType
      if (authType !== 'credential' && authType !== 'oauth' && authType !== 'oauth-google'
        && authType !== 'oauth-slack' && authType !== 'oauth-microsoft') continue
      const requestId = stringValue(payload.requestId)
      if (!requestId) continue
      const labels = record(payload.labels)
      const resolution = payload.resolution
      const status = payload.status === 'pending' ? 'pending'
        : resolution === 'completed' ? 'completed'
        : resolution === 'cancelled' ? 'cancelled'
        : 'failed'
      const message: Message = {
        id: `auth:${requestId}`,
        role: 'auth-request',
        content: [stringValue(payload.sourceName), authType, status].filter(Boolean).join(' '),
        timestamp: numberValue(payload.timestamp) ?? entity.createdSeq,
        authRequestId: requestId,
        authRequestType: authType,
        authSourceSlug: stringValue(payload.sourceSlug),
        authSourceName: stringValue(payload.sourceName),
        authStatus: status,
        authCredentialMode: payload.mode === 'basic' || payload.mode === 'header' || payload.mode === 'query'
          || payload.mode === 'multi-header' ? payload.mode : 'bearer',
        authHeaderNames: Array.isArray(payload.headerNames)
          ? payload.headerNames.filter((name): name is string => typeof name === 'string')
          : undefined,
        authLabels: labels ? {
          credential: stringValue(labels.credential),
          username: stringValue(labels.username),
          password: stringValue(labels.password),
        } : undefined,
        authPasswordRequired: typeof payload.passwordRequired === 'boolean' ? payload.passwordRequired : undefined,
        authError: stringValue(payload.error),
      }
      entries.push({ seq: entity.createdSeq, priority: 2, turn: { type: 'auth-request', message, timestamp: message.timestamp } })
      continue
    }

    if (entity.kind === 'host_status' || entity.kind === 'host_info') {
      const message: Message = {
        id: entity.entityId,
        role: entity.kind === 'host_status' ? 'status' : 'info',
        content: stringValue(payload.message) ?? '',
        timestamp: numberValue(payload.timestamp) ?? entity.createdSeq,
        infoLevel: infoLevel(payload.level),
      }
      entries.push({
        seq: entity.createdSeq,
        priority: 2,
        turn: { type: 'system', message, timestamp: message.timestamp },
      })
      continue
    }

    if (entity.kind === 'runtime_error') {
      const error = record(payload.error)
      const messageText = stringValue(payload.message) ?? stringValue(error?.message) ?? 'Pi runtime error'
      const message: Message = {
        id: entity.entityId,
        role: 'error',
        content: messageText,
        timestamp: numberValue(payload.timestamp) ?? entity.createdSeq,
        isError: true,
        errorCode: stringValue(error?.code) ?? stringValue(payload.code),
        errorTitle: stringValue(error?.title) ?? stringValue(payload.title),
        errorOriginal: stringValue(error?.originalError),
        errorCanRetry: typeof error?.canRetry === 'boolean' ? error.canRetry : undefined,
      }
      entries.push({ seq: entity.createdSeq, priority: 3, turn: { type: 'system', message, timestamp: message.timestamp } })
    }
  }

  for (const user of users.values()) {
    const ui = overlay.get(user.messageId)
    const attachments = user.attachments
      .sort((a, b) => a.order - b.order || a.seq - b.seq)
      .flatMap(ref => {
        const attachment = resolveAttachment(ref, ui)
        return attachment ? [attachment] : []
      })
    const message: Message = {
      id: user.messageId,
      role: 'user',
      content: user.text,
      timestamp: user.timestamp,
      attachments,
      badges: ui?.badges,
      isPending: user.optimistic || ui?.isPending,
      isQueued: user.queued ?? ui?.isQueued,
    }
    entries.push({ seq: user.seq, priority: 0, turn: { type: 'user', message, timestamp: message.timestamp } })
  }

  for (const artifact of artifacts.sort((a, b) => a.seq - b.seq)) {
    let target = artifact.turnId ? assistants.get(artifact.turnId) : undefined
    if (!target && artifact.messageId) {
      target = [...assistants.values()].find(assistant => [...assistant.messages.values()]
        .some(message => message.messageId === artifact.messageId || message.aliases.has(artifact.messageId!)))
    }
    target ??= [...assistants.values()].filter(assistant => assistant.seq <= artifact.seq).sort((a, b) => b.seq - a.seq)[0]
    target ??= getAssistantRecord(assistants, artifact.turnId ?? `artifact:${artifact.artifact.artifactId}`, artifact.seq)
    target.artifacts.push(artifact)
  }

  const runtimeTerminal = latestRuntimeTerminal(entities)
  const runtimeStopped = runtimeTerminal?.kind === 'agent_end' || runtimeTerminal?.kind === 'runtime_error'
  const runtimeCompletedAt = wallClockTimestamp(runtimeTerminal?.updatedAt)
  const hasAgentLifecycle = entities.some(entity =>
    entity.kind === 'agent_start' || entity.kind === 'agent_end' || entity.kind === 'runtime_error'
  )
  const sortedUsers = [...users.values()].sort((a, b) => a.seq - b.seq)
  for (const batch of batchAssistantRecords(assistants.values(), sortedUsers)) {
    const assistant = batch.record
    const timelineSeq = assistantTimelineSeq(assistant, sortedUsers)
    const hasLaterUser = sortedUsers.some(user => user.seq > (batch.userSeq ?? timelineSeq))
    const turnPayload = record(assistant.turnEntity?.payload)
    const latestTurnComplete = assistant.turnEntity?.kind === 'turn_end' || turnPayload?.status === 'completed'
    const batchComplete = hasLaterUser || runtimeStopped || (!hasAgentLifecycle && latestTurnComplete)
    const completedAtOverride = !hasLaterUser ? runtimeCompletedAt : undefined
    const turn = buildAssistantTurn(assistant, overlay, batchComplete, batch.startedAt, completedAtOverride)
    turn.timestamp = timelineSeq
    const hasVisibleContent = turn.activities.length > 0 || turn.response !== undefined
    if (hasVisibleContent || assistant.turnEntity?.kind === 'turn_start') {
      entries.push({ seq: timelineSeq, priority: 1, turn })
    }
  }

  return entries
    .sort((a, b) => a.seq - b.seq || a.priority - b.priority)
    .map(entry => entry.turn)
}

export function getPiTurnSearchText(turn: Turn): string {
  if (turn.type === 'user') {
    return [turn.message.content, ...turn.message.attachments?.map(attachment => attachment.name) ?? []].join('\n')
  }
  if (turn.type === 'system' || turn.type === 'auth-request') return turn.message.content
  return [
    turn.response?.text,
    ...turn.activities.flatMap(activity => [
      activity.displayName,
      activity.toolName,
      activity.intent,
      activity.toolInput,
      activity.content,
      activity.error,
    ]),
  ].map(formatValue).filter(Boolean).join('\n')
}
