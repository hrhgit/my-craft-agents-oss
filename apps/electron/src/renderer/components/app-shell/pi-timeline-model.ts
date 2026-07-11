import type { CredentialRequest, PermissionRequest, PiProjectionEntityV1 } from '@craft-agent/shared/protocol'
import { isPlanArtifactV1, isPlanModeStateV1, type PlanArtifactV1, type PlanModeStateV1 } from '@craft-agent/core'

export type PiTimelineItem =
  | {
      type: 'content'
      id: string
      turnId?: string
      seq: number
      role: 'user' | 'assistant'
      contentKind: 'text' | 'thinking'
      text: string
      streaming: boolean
    }
  | {
      type: 'tool'
      id: string
      turnId?: string
      seq: number
      toolCallId: string
      toolName: string
      displayName?: string
      status: 'running' | 'completed' | 'failed'
      input?: unknown
      result?: unknown
      isError: boolean
    }
  | {
      type: 'artifact'
      id: string
      turnId?: string
      seq: number
      artifact: PlanArtifactV1
      content: string
    }
  | {
      type: 'attachment'
      id: string
      turnId?: string
      seq: number
      attachmentId: string
      name: string
      mediaType?: string
      size?: number
      clientMutationId?: string
    }
  | {
      type: 'error'
      id: string
      turnId?: string
      seq: number
      message: string
    }
  | {
      type: 'auth'
      id: string
      seq: number
      request: {
        requestId: string
        type: 'oauth' | 'oauth-google' | 'oauth-slack' | 'oauth-microsoft'
        sourceSlug: string
        sourceName: string
        status: 'pending' | 'completed' | 'cancelled' | 'failed'
      }
    }

export interface PiRuntimeState {
  isProcessing: boolean
  isCompacting: boolean
}

export interface PiTimelineSearchMatch {
  matchId: string
  itemId: string
  itemIndex: number
  matchIndexInItem: number
}

export function getPiTimelineSearchText(item: PiTimelineItem): string {
  if (item.type === 'content') return item.text
  if (item.type === 'error') return item.message
  if (item.type === 'tool') {
    return [item.displayName, item.toolName, item.input, item.result]
      .map(value => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value))
      .join('\n')
  }
  if (item.type === 'auth') return `${item.request.sourceName}\n${item.request.type}\n${item.request.status}`
  if (item.type === 'attachment') return `${item.name}\n${item.mediaType ?? ''}`
  return item.content
}

/** Search projection entities directly; this never reconstructs legacy messages or turns. */
export function findPiTimelineMatches(items: readonly PiTimelineItem[], rawQuery: string): PiTimelineSearchMatch[] {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (query.length < 2) return []
  const matches: PiTimelineSearchMatch[] = []
  items.forEach((item, itemIndex) => {
    const text = getPiTimelineSearchText(item).toLocaleLowerCase()
    let offset = 0
    let matchIndexInItem = 0
    while ((offset = text.indexOf(query, offset)) !== -1) {
      matches.push({
        matchId: `${item.id}-match-${matchIndexInItem}`,
        itemId: item.id,
        itemIndex,
        matchIndexInItem,
      })
      matchIndexInItem += 1
      offset += query.length
    }
  })
  return matches
}

export function getPiTimelinePageStart(
  itemCount: number,
  visibleItemCount: number,
  matches: readonly PiTimelineSearchMatch[] = [],
): number {
  if (matches.length > 0) return Math.max(0, Math.min(...matches.map(match => match.itemIndex)) - 5)
  return Math.max(0, itemCount - visibleItemCount)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Converts Pi-native projection entities without reconstructing Craft Message objects. */
export function buildPiTimelineItems(entities: readonly PiProjectionEntityV1[]): PiTimelineItem[] {
  return entities
    .flatMap((entity): PiTimelineItem[] => {
      const payload = record(entity.payload)
      if (!payload) return []

      if (entity.entityType === 'content_block') {
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (!text) return []
        return [{
          type: 'content', id: entity.entityId, turnId: entity.turnId, seq: entity.lastSeq,
          role: payload.role === 'user' ? 'user' : 'assistant', text,
          contentKind: payload.contentKind === 'thinking' ? 'thinking' : 'text',
          streaming: payload.streaming === true,
        }]
      }

      if (entity.entityType === 'tool_run') {
        const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : entity.entityId
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool'
        const status = payload.status === 'running' || payload.status === 'failed'
          ? payload.status
          : 'completed'
        return [{
          type: 'tool', id: entity.entityId, turnId: entity.turnId, seq: entity.lastSeq,
          toolCallId, toolName,
          displayName: typeof payload.displayName === 'string' ? payload.displayName : undefined,
          status, input: payload.input, result: payload.result, isError: payload.isError === true,
        }]
      }

      if (entity.entityType === 'artifact_ref' && isPlanArtifactV1(payload.artifact)) {
        return [{
          type: 'artifact', id: entity.entityId, turnId: entity.turnId, seq: entity.lastSeq,
          artifact: payload.artifact,
          content: typeof payload.content === 'string' ? payload.content : '',
        }]
      }

      if (entity.entityType === 'artifact_ref' && entity.kind === 'user_attachment') {
        const attachment = record(payload.attachment)
        if (!attachment || typeof attachment.id !== 'string' || typeof attachment.name !== 'string') return []
        return [{
          type: 'attachment', id: entity.entityId, turnId: entity.turnId, seq: entity.lastSeq,
          attachmentId: attachment.id,
          name: attachment.name,
          mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : undefined,
          size: typeof attachment.size === 'number' ? attachment.size : undefined,
          clientMutationId: typeof payload.clientMutationId === 'string' ? payload.clientMutationId : undefined,
        }]
      }

      if (entity.entityType === 'prompt_request'
        && (entity.kind === 'auth_request' || entity.kind === 'prompt_resolved')
        && (payload.authType === 'oauth' || payload.authType === 'oauth-google'
          || payload.authType === 'oauth-slack' || payload.authType === 'oauth-microsoft')
        && typeof payload.requestId === 'string'
        && typeof payload.sourceSlug === 'string'
        && typeof payload.sourceName === 'string') {
        const status = payload.status === 'pending' ? 'pending'
          : payload.resolution === 'completed' ? 'completed'
          : payload.resolution === 'cancelled' ? 'cancelled'
          : 'failed'
        return [{
          type: 'auth', id: entity.entityId, seq: entity.lastSeq,
          request: {
            requestId: payload.requestId,
            type: payload.authType,
            sourceSlug: payload.sourceSlug,
            sourceName: payload.sourceName,
            status,
          },
        }]
      }

      if (entity.kind === 'runtime_error') {
        const error = record(payload.error)
        const message = typeof payload.message === 'string'
          ? payload.message
          : typeof error?.message === 'string' ? error.message : 'Pi runtime error'
        return [{ type: 'error', id: entity.entityId, turnId: entity.turnId, seq: entity.lastSeq, message }]
      }

      return []
    })
}

export function selectPiRuntimeState(entities: readonly PiProjectionEntityV1[]): PiRuntimeState {
  const lifecycle = entities
    .filter(entity => entity.kind === 'agent_start' || entity.kind === 'agent_end'
      || entity.kind === 'turn_start' || entity.kind === 'turn_end'
      || entity.kind === 'compaction_start' || entity.kind === 'compaction_end'
      || entity.kind === 'runtime_error')
    .sort((a, b) => b.lastSeq - a.lastSeq)[0]
  return {
    isProcessing: lifecycle?.kind === 'agent_start' || lifecycle?.kind === 'turn_start' || lifecycle?.kind === 'compaction_start',
    isCompacting: lifecycle?.kind === 'compaction_start',
  }
}

/** Selects the newest Host-approved prompt; raw Pi permission checks never enter this view. */
export function selectPendingPiPermission(
  entities: readonly PiProjectionEntityV1[],
  sessionId: string,
): PermissionRequest | undefined {
  const entity = entities
    .filter(candidate => candidate.entityType === 'prompt_request' && candidate.kind === 'permission_request')
    .sort((a, b) => b.lastSeq - a.lastSeq)
    .find(candidate => record(candidate.payload)?.status === 'pending')
  const payload = entity ? record(entity.payload) : null
  if (!payload || typeof payload.requestId !== 'string' || typeof payload.toolName !== 'string') return undefined
  return {
    sessionId,
    requestId: payload.requestId,
    toolName: payload.toolName,
    description: typeof payload.description === 'string' ? payload.description : payload.toolName,
    command: typeof payload.command === 'string' ? payload.command : undefined,
    type: payload.permissionType === 'bash' || payload.permissionType === 'file_write'
      || payload.permissionType === 'mcp_mutation' || payload.permissionType === 'api_mutation'
      || payload.permissionType === 'admin_approval' ? payload.permissionType : undefined,
    appName: typeof payload.appName === 'string' ? payload.appName : undefined,
    reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    impact: typeof payload.impact === 'string' ? payload.impact : undefined,
    requiresSystemPrompt: typeof payload.requiresSystemPrompt === 'boolean' ? payload.requiresSystemPrompt : undefined,
    rememberForMinutes: typeof payload.rememberForMinutes === 'number' ? payload.rememberForMinutes : undefined,
    commandHash: typeof payload.commandHash === 'string' ? payload.commandHash : undefined,
    approvalTtlSeconds: typeof payload.approvalTtlSeconds === 'number' ? payload.approvalTtlSeconds : undefined,
  }
}

/** Maps a secret-free Host auth prompt onto the existing credential form contract. */
export function selectPendingPiCredential(
  entities: readonly PiProjectionEntityV1[],
  sessionId: string,
): CredentialRequest | undefined {
  const entity = entities
    .filter(candidate => candidate.entityType === 'prompt_request' && candidate.kind === 'auth_request')
    .sort((a, b) => b.lastSeq - a.lastSeq)
    .find(candidate => record(candidate.payload)?.status === 'pending')
  const payload = entity ? record(entity.payload) : null
  if (!payload || payload.authType !== 'credential'
    || typeof payload.requestId !== 'string'
    || typeof payload.sourceSlug !== 'string'
    || typeof payload.sourceName !== 'string') return undefined

  const mode = payload.mode === 'basic' || payload.mode === 'header' || payload.mode === 'query'
    || payload.mode === 'multi-header' ? payload.mode : 'bearer'
  const labels = record(payload.labels)
  const headerNames = Array.isArray(payload.headerNames)
    ? payload.headerNames.filter((name): name is string => typeof name === 'string')
    : undefined

  return {
    type: 'credential', sessionId, requestId: payload.requestId,
    sourceSlug: payload.sourceSlug, sourceName: payload.sourceName, mode,
    labels: labels ? {
      credential: typeof labels.credential === 'string' ? labels.credential : undefined,
      username: typeof labels.username === 'string' ? labels.username : undefined,
      password: typeof labels.password === 'string' ? labels.password : undefined,
    } : undefined,
    headerNames,
    passwordRequired: typeof payload.passwordRequired === 'boolean' ? payload.passwordRequired : undefined,
  }
}

export function selectPiPlanModeState(entities: readonly PiProjectionEntityV1[]): PlanModeStateV1 | undefined {
  const entity = entities
    .filter(candidate => candidate.kind === 'plan_mode_state')
    .sort((a, b) => b.lastSeq - a.lastSeq)[0]
  return entity && isPlanModeStateV1(entity.payload) ? entity.payload : undefined
}

export function selectActivePiPlanArtifact(
  entities: readonly PiProjectionEntityV1[],
  activeArtifactId?: string,
): PlanArtifactV1 | undefined {
  const artifacts = entities
    .filter(candidate => candidate.entityType === 'artifact_ref')
    .sort((a, b) => b.lastSeq - a.lastSeq)
    .flatMap(candidate => {
      const payload = record(candidate.payload)
      return payload && isPlanArtifactV1(payload.artifact) ? [payload.artifact] : []
    })
  return (activeArtifactId ? artifacts.find(artifact => artifact.artifactId === activeArtifactId) : undefined)
    ?? artifacts[0]
}
