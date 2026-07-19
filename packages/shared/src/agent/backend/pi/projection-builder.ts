import type { AgentEvent } from '@mortise/core/types'
import {
  PLAN_ARTIFACT_CUSTOM_TYPE,
  PLAN_ARTIFACT_UPDATE_CUSTOM_TYPE,
  PLAN_MODE_STATE_CUSTOM_TYPE,
  parsePlanArtifactMessageDetails,
  parsePlanModeStateMessageDetails,
} from '@mortise/core/types'
import type {
  PiProjectionEntityType,
  PiProjectionEventV1,
  PiProjectionSnapshotV1,
} from '../../../protocol/pi-projection.ts'
import { stripLeadingCraftInjectedUserContext } from '../../../prompts/strip-injected-user-context.ts'
import type { HostQueuedUserProjection, HostRuntimeErrorProjection } from '../types.ts'

type ProjectableAgentEvent = Extract<
  AgentEvent,
  {
    type: 'tool_start' | 'tool_result' | 'complete' | 'error' | 'typed_error'
      | 'status' | 'info' | 'queue_overflow'
  }
>

interface EntityState {
  version: number
  text?: string
  turnId?: string
  payload?: Record<string, unknown>
}

/** Builds Pi-semantic renderer entities without constructing Mortise Message objects. */
export class PiProjectionBuilder {
  private seq = 0
  private turnIndex = 0
  private activeTurnId: string | null = null
  private readonly entities = new Map<string, EntityState>()
  private readonly pendingTurnEntityIds: string[] = []

  constructor(
    readonly sessionId: string,
    readonly runtimeId: string,
    seed?: PiProjectionSnapshotV1,
    private readonly now: () => number = Date.now,
  ) {
    if (seed) this.restoreSeed(seed)
  }

  acceptHostQueuedUser(input: HostQueuedUserProjection): PiProjectionEventV1[] {
    const clientMutationId = input.clientMutationId.trim()
    if (!clientMutationId) throw new TypeError('Queued Pi projection requires a clientMutationId')

    const messageId = input.messageId?.trim() || clientMutationId
    const text = input.message
    const timestamp = this.projectionTimestamp(input)
    const attachments = this.sanitizeUserAttachments(input.attachments)
    const entityId = `content:user:${clientMutationId}`
    const events: PiProjectionEventV1[] = []

    if (text) {
      const state = this.nextEntity(entityId)
      state.payload = {
        role: 'user', text, streaming: false, messageId, clientMutationId,
        queueStatus: 'queued', source: 'host', timestamp,
      }
      events.push(this.createEvent(entityId, 'content_block', state.version, 'user_text', state.payload, undefined, timestamp))
    }

    for (const [index, attachment] of attachments.entries()) {
      const attachmentEntityId = `artifact:attachment:${clientMutationId}:${attachment.id}`
      const state = this.nextEntity(attachmentEntityId)
      state.payload = {
        attachment,
        clientMutationId,
        ownerMessageId: messageId,
        contentEntityId: text ? entityId : undefined,
        order: index,
        queueStatus: 'queued',
        source: 'host',
      }
      events.push(this.createEvent(
        attachmentEntityId,
        'artifact_ref',
        state.version,
        'user_attachment',
        state.payload,
        undefined,
        timestamp,
      ))
    }

    return events
  }

  acceptHostRuntimeError(input: HostRuntimeErrorProjection): PiProjectionEventV1[] {
    return [
      ...this.finalizeRunningTools(true),
      this.errorEvent({ ...input, source: 'host' }),
    ]
  }

  acceptPromptRequest(request: {
    requestId: string
    promptKind: 'permission'
    toolName: string
    description?: string
    command?: string
    permissionType?: string
    appName?: string
    reason?: string
    impact?: string
    requiresSystemPrompt?: boolean
    rememberForMinutes?: number
    commandHash?: string
    approvalTtlSeconds?: number
  }): PiProjectionEventV1[] {
    const entityId = `prompt:${request.requestId}`
    const state = this.nextEntity(entityId)
    return [this.createEvent(entityId, 'prompt_request', state.version, 'permission_request', {
      ...request, status: 'pending',
    })]
  }

  acceptPromptResolution(requestId: string, resolution: 'allowed' | 'denied' | 'cancelled'): PiProjectionEventV1[] {
    const entityId = `prompt:${requestId}`
    const state = this.nextEntity(entityId)
    return [this.createEvent(entityId, 'prompt_request', state.version, 'prompt_resolved', {
      requestId, status: 'resolved', resolution,
    })]
  }

  acceptAuthPromptRequest(request: {
    requestId: string
    authType: 'credential' | 'oauth' | 'oauth-google' | 'oauth-slack' | 'oauth-microsoft'
    sourceSlug: string
    sourceName: string
    mode?: 'bearer' | 'basic' | 'header' | 'query' | 'multi-header'
    labels?: { credential?: string; username?: string; password?: string }
    headerNames?: string[]
    passwordRequired?: boolean
    service?: string
  }): PiProjectionEventV1[] {
    const entityId = `prompt:${request.requestId}`
    const state = this.nextEntity(entityId)
    const promptKind = request.authType === 'credential' ? 'credential' : 'oauth'
    state.payload = {
      requestId: request.requestId,
      promptKind,
      authType: request.authType,
      sourceSlug: request.sourceSlug,
      sourceName: request.sourceName,
      mode: request.mode,
      labels: request.labels,
      headerNames: request.headerNames,
      passwordRequired: request.passwordRequired,
      service: request.service,
      status: 'pending',
    }
    return [this.createEvent(entityId, 'prompt_request', state.version, 'auth_request', state.payload)]
  }

  acceptAuthPromptResolution(
    requestId: string,
    resolution: 'completed' | 'failed' | 'cancelled',
  ): PiProjectionEventV1[] {
    const entityId = `prompt:${requestId}`
    const state = this.nextEntity(entityId)
    state.payload = { ...state.payload, requestId, status: 'resolved', resolution }
    return [this.createEvent(entityId, 'prompt_request', state.version, 'prompt_resolved', state.payload)]
  }

  accept(event: AgentEvent): PiProjectionEventV1[] {
    if (!this.isProjectable(event)) return []

    switch (event.type) {
      case 'tool_start': {
        const entityId = `tool:${event.toolUseId}`
        const state = this.nextEntity(entityId)
        const turnId = event.turnId ?? this.activeTurnId ?? undefined
        state.turnId = turnId
        state.payload = {
          toolCallId: event.toolUseId, toolName: event.toolName, input: event.input,
          intent: event.intent, displayName: event.displayName,
          parentToolUseId: event.parentToolUseId, status: 'running',
        }
        return [this.createEvent(entityId, 'tool_run', state.version, 'tool_execution_start', state.payload, turnId)]
      }
      case 'tool_result': {
        const entityId = `tool:${event.toolUseId}`
        const state = this.nextEntity(entityId)
        const turnId = event.turnId ?? state.turnId ?? this.activeTurnId ?? undefined
        state.turnId = turnId
        state.payload = {
          ...state.payload,
          toolCallId: event.toolUseId, toolName: event.toolName, result: event.result,
          isError: event.isError === true, parentToolUseId: event.parentToolUseId,
          status: event.isError ? 'failed' : 'completed',
        }
        return [this.createEvent(entityId, 'tool_run', state.version, 'tool_execution_end', state.payload, turnId)]
      }
      case 'status':
        if (this.isCompactionCompatibilityMessage(event.message)) return []
        return [this.hostMessageEvent('host_status', {
          message: event.message,
          level: 'info',
          statusType: event.message.startsWith('Retrying') ? 'retrying' : 'status',
        })]
      case 'info':
        if (this.isCompactionCompatibilityMessage(event.message)) return []
        return [this.hostMessageEvent('host_info', {
          message: event.message,
          level: 'info',
          statusType: 'info',
        })]
      case 'queue_overflow':
        return [this.hostMessageEvent('host_info', {
          message: event.message,
          level: 'warning',
          statusType: 'queue_overflow',
          droppedEvents: event.droppedEvents,
          maxQueueSize: event.maxQueueSize,
        })]
      case 'complete':
        return [
          ...this.finalizeRunningTools(false),
          this.lifecycleEvent('agent_end', { status: 'completed', usage: event.usage }),
        ]
      case 'error':
        return [
          ...this.finalizeRunningTools(true),
          this.errorEvent({ message: event.message }),
        ]
      case 'typed_error':
        return [
          ...this.finalizeRunningTools(true),
          this.errorEvent({ error: event.error }),
        ]
    }
  }

  /** Mirrors Pi's final visible tool state when a terminal event races a result. */
  private finalizeRunningTools(failed: boolean): PiProjectionEventV1[] {
    const events: PiProjectionEventV1[] = []
    for (const [entityId, existing] of this.entities) {
      if (!entityId.startsWith('tool:') || existing.payload?.status !== 'running') continue
      const state = this.nextEntity(entityId)
      state.payload = {
        ...existing.payload,
        result: failed ? 'Error occurred' : (existing.payload.result ?? ''),
        isError: failed,
        status: failed ? 'failed' : 'completed',
      }
      events.push(this.createEvent(
        entityId,
        'tool_run',
        state.version,
        'tool_execution_end',
        state.payload,
        existing.turnId,
      ))
    }
    return events
  }

  /** Projects Pi events that intentionally never enter Mortise's AgentEvent model. */
  acceptRuntimeEvent(event: Record<string, unknown>): PiProjectionEventV1[] {
    if (event.type === 'agent_start') {
      return [this.lifecycleEvent('agent_start', { status: 'running' }, this.projectionTimestamp(event))]
    }
    if (event.type === 'turn_start') {
      const turnId = `pi-turn-${this.turnIndex++}`
      this.activeTurnId = turnId
      const entityId = `turn:${turnId}`
      const state = this.nextEntity(entityId)
      const events = [this.createEvent(
        entityId,
        'turn',
        state.version,
        'turn_start',
        { status: 'running' },
        turnId,
        this.projectionTimestamp(event),
      )]
      for (const pendingEntityId of this.pendingTurnEntityIds.splice(0)) {
        const pending = this.nextEntity(pendingEntityId)
        if (!pending.payload) continue
        pending.turnId = turnId
        const entityType: PiProjectionEntityType = pendingEntityId.startsWith('artifact:attachment:')
          ? 'artifact_ref'
          : 'content_block'
        events.push(this.createEvent(
          pendingEntityId,
          entityType,
          pending.version,
          entityType === 'artifact_ref' ? 'user_attachment' : 'user_text',
          pending.payload,
          turnId,
        ))
      }
      return events
    }
    if (event.type === 'turn_end') {
      const turnId = this.activeTurnId ?? `pi-turn-${Math.max(0, this.turnIndex - 1)}`
      this.activeTurnId = null
      const entityId = `turn:${turnId}`
      const state = this.nextEntity(entityId)
      const message = event.message && typeof event.message === 'object'
        ? event.message as { stopReason?: unknown }
        : undefined
      return [this.createEvent(entityId, 'turn', state.version, 'turn_end', {
        status: 'completed',
        stopReason: typeof message?.stopReason === 'string' ? message.stopReason : undefined,
        toolResultCount: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
      }, turnId, this.projectionTimestamp(event))]
    }
    if (event.type === 'compaction_start') {
      return [this.lifecycleEvent('compaction_start', {
        status: 'running', reason: event.reason,
      })]
    }
    if (event.type === 'compaction_end') {
      return [this.lifecycleEvent('compaction_end', {
        status: event.aborted === true || typeof event.errorMessage === 'string' ? 'failed' : 'completed',
        reason: event.reason, aborted: event.aborted === true,
        willRetry: event.willRetry === true,
        errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : undefined,
      })]
    }
    if (event.type === 'message_update') return this.acceptMessageUpdate(event)
    if (event.type !== 'message_end') return []
    const message = event.message
    if (!message || typeof message !== 'object') return []
    const value = message as {
      id?: unknown
      timestamp?: unknown
      role?: unknown
      customType?: unknown
      content?: unknown
      details?: unknown
      display?: unknown
      clientMutationId?: unknown
      attachments?: unknown
    }
    if (value.role === 'custom') return this.acceptCustomMessage(value)
    if (value.role === 'assistant') return this.acceptAssistantMessageEnd(value)
    if (value.role !== 'user') return []
    // Pi stores the full model input, including Mortise's volatile date, session
    // state, and source blocks. Projection payloads are user-visible, so only
    // retain the original user-authored tail.
    const text = stripLeadingCraftInjectedUserContext(this.extractText(value.content))
    const attachments = this.sanitizeUserAttachments(value.attachments)
    if (!text && attachments.length === 0) return []
    const clientMutationId = typeof value.clientMutationId === 'string' && value.clientMutationId.length > 0
      ? value.clientMutationId
      : undefined
    const identity = clientMutationId ?? this.messageIdentity(value)
    const entityId = `content:user:${identity}`
    const turnId = this.activeTurnId ?? undefined
    const events: PiProjectionEventV1[] = []
    if (text) {
      const state = this.nextEntity(entityId)
      const messageId = typeof state.payload?.messageId === 'string'
        ? state.payload.messageId
        : identity
      state.payload = {
        role: 'user', text, streaming: false, messageId,
        clientMutationId, queueStatus: 'accepted', source: 'pi',
        timestamp: this.messageTimestamp(value) ?? state.payload?.timestamp,
      }
      events.push(this.createEvent(
        entityId,
        'content_block',
        state.version,
        'user_text',
        state.payload,
        turnId,
        this.messageTimestamp(value),
      ))
      if (!turnId) this.pendingTurnEntityIds.push(entityId)
    }
    for (const [index, attachment] of attachments.entries()) {
      const attachmentEntityId = `artifact:attachment:${identity}:${attachment.id}`
      const attachmentState = this.nextEntity(attachmentEntityId)
      const ownerMessageId = typeof attachmentState.payload?.ownerMessageId === 'string'
        ? attachmentState.payload.ownerMessageId
        : typeof this.entities.get(entityId)?.payload?.messageId === 'string'
          ? this.entities.get(entityId)!.payload!.messageId as string
          : identity
      attachmentState.payload = {
        attachment,
        clientMutationId,
        ownerMessageId,
        contentEntityId: text ? entityId : undefined,
        order: index,
        queueStatus: 'accepted',
        source: 'pi',
      }
      events.push(this.createEvent(attachmentEntityId, 'artifact_ref', attachmentState.version, 'user_attachment', attachmentState.payload, turnId))
      if (!turnId) this.pendingTurnEntityIds.push(attachmentEntityId)
    }
    return events
  }

  private acceptCustomMessage(message: {
    id?: unknown
    timestamp?: unknown
    customType?: unknown
    content?: unknown
    details?: unknown
    display?: unknown
  }): PiProjectionEventV1[] {
    if (message.customType === PLAN_MODE_STATE_CUSTOM_TYPE) {
      const details = parsePlanModeStateMessageDetails(message.details)
      if (!details) return []
      const entityId = `plan-state:${this.sessionId}`
      const state = this.nextEntity(entityId)
      return [this.createEvent(entityId, 'conversation', state.version, 'plan_mode_state', details.state)]
    }
    if (message.customType !== PLAN_ARTIFACT_CUSTOM_TYPE && message.customType !== PLAN_ARTIFACT_UPDATE_CUSTOM_TYPE) {
      if (message.display !== true) return []
      const content = this.extractText(message.content)
      if (!content) return []
      const messageId = this.messageIdentity(message)
      const entityId = `content:custom:${messageId}`
      const state = this.nextEntity(entityId)
      const details = this.asRecord(message.details)
      const level = details?.level === 'warning' || details?.level === 'error'
        ? details.level
        : 'info'
      state.payload = {
        role: 'info', messageId, content, level,
        customType: typeof message.customType === 'string' ? message.customType : 'custom',
      }
      return [this.createEvent(
        entityId,
        'content_block',
        state.version,
        'custom_display',
        state.payload,
        this.activeTurnId ?? undefined,
      )]
    }
    const details = parsePlanArtifactMessageDetails(message.details)
    if (!details) return []
    const entityId = `artifact:${details.artifact.artifactId}`
    const state = this.nextEntity(entityId)
    return [this.createEvent(
      entityId,
      'artifact_ref',
      state.version,
      message.customType === PLAN_ARTIFACT_UPDATE_CUSTOM_TYPE ? 'plan_artifact_update' : 'plan_artifact',
      {
        artifact: details.artifact,
        content: typeof message.content === 'string' ? message.content : '',
        assistantMessageId: details.assistantMessageId,
      },
    )]
  }

  private acceptMessageUpdate(event: Record<string, unknown>): PiProjectionEventV1[] {
    const update = event.assistantMessageEvent
    if (!update || typeof update !== 'object') return []
    const value = update as { type?: unknown; contentIndex?: unknown; delta?: unknown; content?: unknown }
    const isThinking = value.type === 'thinking_start' || value.type === 'thinking_delta' || value.type === 'thinking_end'
    const isText = value.type === 'text_start' || value.type === 'text_delta' || value.type === 'text_end'
    if (!isThinking && !isText) return []
    if (!Number.isInteger(value.contentIndex) || (value.contentIndex as number) < 0) return []

    const message = event.message && typeof event.message === 'object'
      ? event.message as { id?: unknown; timestamp?: unknown }
      : {}
    const messageId = this.messageIdentity(message)
    const contentKind = isThinking ? 'thinking' : 'text'
    const entityId = `content:${contentKind}:${messageId}:${value.contentIndex}`
    const state = this.nextEntity(entityId)
    if (value.type === 'thinking_delta' || value.type === 'text_delta') {
      state.text = `${state.text ?? ''}${typeof value.delta === 'string' ? value.delta : ''}`
    }
    if ((value.type === 'thinking_end' || value.type === 'text_end') && typeof value.content === 'string') {
      state.text = value.content
    }

    const kind: string = isThinking
      ? String(value.type)
      : value.type === 'text_end' ? 'assistant_text' : 'assistant_text_delta'
    return [this.createEvent(entityId, 'content_block', state.version, kind, {
      role: 'assistant', contentKind, messageId, text: state.text ?? '',
      delta: value.type === 'thinking_delta' || value.type === 'text_delta' ? value.delta : undefined,
      streaming: value.type !== 'thinking_end' && value.type !== 'text_end',
      contentIndex: value.contentIndex,
      timestamp: this.messageTimestamp(message),
    }, this.activeTurnId ?? undefined, this.messageTimestamp(message))]
  }

  private acceptAssistantMessageEnd(message: {
    id?: unknown
    timestamp?: unknown
    content?: unknown
    stopReason?: unknown
  }): PiProjectionEventV1[] {
    const content = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
    if (!Array.isArray(content)) return []
    const messageId = this.messageIdentity(message)
    const events: PiProjectionEventV1[] = []

    for (const [contentIndex, candidate] of content.entries()) {
      if (!candidate || typeof candidate !== 'object') continue
      const part = candidate as Record<string, unknown>
      const contentKind = part.type === 'thinking'
        ? 'thinking'
        : part.type === 'text'
          ? 'text'
          : null
      if (!contentKind) continue
      const text = contentKind === 'thinking'
        ? (typeof part.thinking === 'string' ? part.thinking : '')
        : (typeof part.text === 'string' ? part.text : '')
      const entityId = `content:${contentKind}:${messageId}:${contentIndex}`
      const state = this.nextEntity(entityId)
      state.text = text
      const stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined
      const isIntermediate = stopReason === 'toolUse' || stopReason === 'tool_use'
      state.payload = {
        role: 'assistant', contentKind, messageId, text,
        streaming: false, contentIndex, stopReason,
        isIntermediate,
        isFinal: !isIntermediate,
        timestamp: this.messageTimestamp(message),
      }
      events.push(this.createEvent(
        entityId,
        'content_block',
        state.version,
        contentKind === 'thinking' ? 'thinking_end' : 'assistant_text',
        state.payload,
        this.activeTurnId ?? undefined,
        this.messageTimestamp(message),
      ))
    }

    return events
  }

  private isProjectable(event: AgentEvent): event is ProjectableAgentEvent {
    return event.type === 'tool_start' || event.type === 'tool_result'
      || event.type === 'complete' || event.type === 'error' || event.type === 'typed_error'
      || event.type === 'status' || event.type === 'info' || event.type === 'queue_overflow'
  }

  private messageTimestamp(message: { timestamp?: unknown }): number | undefined {
    return this.projectionTimestamp(message)
  }

  private projectionTimestamp(value: { timestamp?: unknown }): number | undefined {
    if (typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)) return value.timestamp
    if (typeof value.timestamp === 'string') {
      const parsed = Date.parse(value.timestamp)
      if (Number.isFinite(parsed)) return parsed
    }
    return undefined
  }

  private messageIdentity(message: { id?: unknown; timestamp?: unknown }): string {
    if (typeof message.id === 'string' && message.id) return message.id
    const timestamp = this.messageTimestamp(message)
    if (timestamp !== undefined) return `ts-${timestamp}`
    return `seq-${this.seq + 1}`
  }

  private restoreSeed(seed: PiProjectionSnapshotV1): void {
    if (seed.schemaVersion !== 1 || seed.sessionId !== this.sessionId
      || !Number.isSafeInteger(seed.lastSeq) || seed.lastSeq < 0 || !Array.isArray(seed.entities)) {
      throw new TypeError('Invalid Pi projection builder seed')
    }

    const entityIds = new Set<string>()
    let nextTurnIndex = 0
    for (const entity of seed.entities) {
      if (!entity || typeof entity.entityId !== 'string' || !entity.entityId
        || entityIds.has(entity.entityId)
        || !Number.isSafeInteger(entity.entityVersion) || entity.entityVersion < 1
        || !Number.isSafeInteger(entity.createdSeq) || entity.createdSeq < 1
        || !Number.isSafeInteger(entity.lastSeq) || entity.lastSeq < entity.createdSeq
        || entity.lastSeq > seed.lastSeq
        || (entity.createdAt !== undefined && (!Number.isFinite(entity.createdAt) || entity.createdAt < 0))
        || (entity.updatedAt !== undefined && (!Number.isFinite(entity.updatedAt) || entity.updatedAt < 0))) {
        throw new TypeError('Invalid Pi projection builder seed entity')
      }
      entityIds.add(entity.entityId)
      const payload = this.asRecord(entity.payload)
      this.entities.set(entity.entityId, {
        version: entity.entityVersion,
        turnId: entity.turnId,
        payload: payload ? structuredClone(payload) : undefined,
        text: typeof payload?.text === 'string' ? payload.text : undefined,
      })
      const match = /^turn:pi-turn-(\d+)$/.exec(entity.entityId)
      if (match?.[1]) nextTurnIndex = Math.max(nextTurnIndex, Number(match[1]) + 1)
    }

    this.seq = seed.lastSeq
    this.turnIndex = nextTurnIndex
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .map((part) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? (part as { text?: unknown }).text
        : '')
      .filter((part): part is string => typeof part === 'string')
      .join('')
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  }

  private isCompactionCompatibilityMessage(message: string): boolean {
    return message.includes('Compacting context') || message.startsWith('Compacted context')
  }

  private sanitizeUserAttachments(value: unknown): Array<{
    id: string
    name: string
    mediaType?: string
    size?: number
  }> {
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    return value.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const item = candidate as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id.trim().slice(0, 256) : ''
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 512) : ''
      if (!id || !name || seen.has(id)) return []
      seen.add(id)
      const mediaType = typeof item.mediaType === 'string' && item.mediaType.length <= 256
        ? item.mediaType
        : undefined
      const size = typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0
        ? item.size
        : undefined
      return [{ id, name, mediaType, size }]
    })
  }

  private nextEntity(entityId: string): EntityState {
    const state = this.entities.get(entityId) ?? { version: 0 }
    state.version++
    this.entities.set(entityId, state)
    return state
  }

  private lifecycleEvent(kind: string, payload: unknown, occurredAt?: number): PiProjectionEventV1 {
    const entityId = `lifecycle:${kind}:${this.seq + 1}`
    const state = this.nextEntity(entityId)
    return this.createEvent(entityId, 'conversation', state.version, kind, payload, undefined, occurredAt)
  }

  private hostMessageEvent(kind: 'host_status' | 'host_info', payload: unknown): PiProjectionEventV1 {
    const entityId = `host:${kind}:${this.seq + 1}`
    const state = this.nextEntity(entityId)
    return this.createEvent(
      entityId,
      'conversation',
      state.version,
      kind,
      payload,
      this.activeTurnId ?? undefined,
    )
  }

  private errorEvent(payload: unknown): PiProjectionEventV1 {
    const entityId = `error:${this.seq + 1}`
    const state = this.nextEntity(entityId)
    return this.createEvent(entityId, 'conversation', state.version, 'runtime_error', payload, this.activeTurnId ?? undefined)
  }

  private createEvent(
    entityId: string,
    entityType: PiProjectionEntityType,
    entityVersion: number,
    kind: string,
    payload: unknown,
    turnId?: string,
    occurredAt = this.now(),
  ): PiProjectionEventV1 {
    const seq = ++this.seq
    return {
      schemaVersion: 1, eventId: `${this.runtimeId}:${seq}`, seq: this.seq,
      sessionId: this.sessionId, runtimeId: this.runtimeId, turnId,
      entityId, entityType, entityVersion, kind, payload, occurredAt,
    }
  }
}
