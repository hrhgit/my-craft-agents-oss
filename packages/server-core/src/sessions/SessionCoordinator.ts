import { randomUUID } from 'node:crypto'
import { requirePrimaryLocalWorkspaceRoot, type Workspace } from '@mortise/core/types'
import type {
  CreateSessionRequest,
  CreateSessionResult,
  ListSessionsOptions,
  ListSessionsResult,
  ReadSessionOptions,
  ReadSessionResult,
  SendMessageToSessionRequest,
  SendMessageToSessionResult,
  SessionReadTurn,
} from '@mortise/session-tools-core'
import { getMidStreamBehavior } from '@mortise/shared/config'
import type { FileAttachment, Session, SendMessageOptions } from '@mortise/shared/protocol'
import { getActivePiBranchEntries, type PiBranchProjectionEntry } from '../projection/pi-branch'

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
const DEFAULT_TURN_LIMIT = 10
const MAX_TURN_LIMIT = 50
const DEFAULT_ITEM_CHAR_LIMIT = 4_000
const MAX_ITEM_CHAR_LIMIT = 20_000

export interface SessionCoordinatorGateway {
  getSessions(workspaceId?: string): Session[]
  getSession(sessionId: string): Promise<Session | null>
  getWorkspaces(): Workspace[]
  readPiProjection(
    workspaceId: string,
    workspaceRootPath: string,
    sessionId: string,
  ): Promise<{ leafId: string | null; entries: PiBranchProjectionEntry[] } | null>
  createAndSendFirstTurn(input: {
    workspaceId: string
    message: string
    createOptions?: {
      name?: string
      provider?: string
      model?: string
      thinkingLevel?: CreateSessionRequest['thinkingLevel']
    }
    sendOptions?: SendMessageOptions
  }): Promise<{ session: Session; messageId: string; publication: 'pending' | 'published' }>
  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: undefined,
    options?: SendMessageOptions,
    existingMessageId?: string,
    isAuthRetry?: boolean,
    onAck?: (messageId: string) => void,
    rpcContext?: undefined,
    isQueuedReplay?: boolean,
    onAccepted?: (messageId: string) => void,
  ): Promise<void>
}

export interface SessionCoordinatorOptions {
  resolveAttachments?: (
    workspaceId: string,
    paths: Array<{ path: string; name?: string }>,
  ) => Promise<FileAttachment[] | undefined>
}

export class SessionCoordinator {
  constructor(
    private readonly gateway: SessionCoordinatorGateway,
    private readonly options: SessionCoordinatorOptions = {},
  ) {}

  list(workspaceId: string, options: ListSessionsOptions = {}): ListSessionsResult {
    const limit = clamp(options.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)
    let sessions = this.gateway.getSessions(workspaceId)
    if (options.search?.trim()) {
      const needle = options.search.trim().toLocaleLowerCase()
      sessions = sessions.filter(session => (
        session.name?.toLocaleLowerCase().includes(needle)
        || session.preview?.toLocaleLowerCase().includes(needle)
      ))
    }
    const sortBy = options.sortBy ?? 'recent'
    sessions.sort(sortBy === 'name'
      ? (a, b) => (a.name ?? '').localeCompare(b.name ?? '')
      : (a, b) => (b.lastMessageAt ?? b.createdAt ?? 0) - (a.lastMessageAt ?? a.createdAt ?? 0))

    const offset = decodeListCursor(options.cursor)
    const page = sessions.slice(offset, offset + limit)
    const nextOffset = offset + page.length
    return {
      sessions: page.map(session => ({
        id: session.id,
        name: session.name ?? session.id,
        preview: session.preview,
        createdAt: session.createdAt ?? 0,
        updatedAt: session.lastMessageAt,
        status: session.deletionState === 'deleting'
          ? 'deleting'
          : session.isProcessing ? 'running' : 'idle',
        provider: session.provider,
        model: session.model,
      })),
      nextCursor: nextOffset < sessions.length ? encodeCursor({ offset: nextOffset }) : undefined,
      hasMore: nextOffset < sessions.length,
    }
  }

  async create(workspaceId: string, request: CreateSessionRequest): Promise<CreateSessionResult> {
    const message = request.message.trim()
    if (!message) throw new Error('message is required')
    const operationId = randomUUID()
    const result = await this.gateway.createAndSendFirstTurn({
      workspaceId,
      message,
      createOptions: {
        ...(request.name?.trim() ? { name: request.name.trim() } : {}),
        ...(request.provider ? { provider: request.provider } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      },
      sendOptions: {
        operationId,
        optimisticMessageId: operationId,
        source: { type: 'session', sessionId: request.sourceSessionId },
      },
    })
    return {
      sessionId: result.session.id,
      messageId: result.messageId,
      operationId,
      publication: result.publication,
    }
  }

  async read(workspaceId: string, sessionId: string, options: ReadSessionOptions = {}): Promise<ReadSessionResult> {
    const session = await this.requireWorkspaceSession(workspaceId, sessionId)
    const workspace = this.gateway.getWorkspaces().find(candidate => candidate.id === workspaceId)
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
    const projection = await this.gateway.readPiProjection(
      workspaceId,
      requirePrimaryLocalWorkspaceRoot(workspace),
      sessionId,
    )
    if (!projection) throw new Error(`Pi Session projection ${sessionId} not found`)

    const requestedLeafId = options.branchNodeId ?? projection.leafId
    const branchEntries = getActivePiBranchEntries({
      leafId: requestedLeafId,
      entries: projection.entries,
    })
    const turns = buildTurnSummaries(branchEntries, clamp(
      options.maxCharsPerItem ?? DEFAULT_ITEM_CHAR_LIMIT,
      200,
      MAX_ITEM_CHAR_LIMIT,
    ))
    const limit = clamp(options.turnLimit ?? DEFAULT_TURN_LIMIT, 1, MAX_TURN_LIMIT)
    const cursor = decodeReadCursor(options.cursor, sessionId, requestedLeafId)
    const end = Math.min(cursor?.end ?? turns.length, turns.length)
    const start = Math.max(0, end - limit)
    const page = turns.slice(start, end)

    return {
      session: {
        id: session.id,
        name: session.name ?? session.id,
        preview: session.preview,
        createdAt: session.createdAt ?? 0,
        updatedAt: session.lastMessageAt,
        status: session.deletionState === 'deleting'
          ? 'deleting'
          : session.isProcessing ? 'running' : 'idle',
        provider: session.provider,
        model: session.model,
      },
      branch: {
        leafId: requestedLeafId,
        currentLeafId: projection.leafId,
        isCurrent: requestedLeafId === projection.leafId,
      },
      turns: page,
      nextCursor: start > 0
        ? encodeCursor({ version: 1, sessionId, leafId: requestedLeafId, end: start })
        : undefined,
      hasMore: start > 0,
    }
  }

  async send(
    workspaceId: string,
    request: SendMessageToSessionRequest,
  ): Promise<SendMessageToSessionResult> {
    await this.requireWorkspaceSession(workspaceId, request.sessionId)
    const message = request.message.trim()
    if (!message) throw new Error('message is required')
    const operationId = randomUUID()
    const attachments = request.attachments?.length
      ? await this.options.resolveAttachments?.(workspaceId, request.attachments)
      : undefined
    const desiredBehavior = request.delivery === 'steer' ? 'steer' : 'queue'
    const midStreamSendIntent = getMidStreamBehavior() === desiredBehavior ? 'default' : 'alternate'

    return await new Promise<SendMessageToSessionResult>((resolve, reject) => {
      let accepted = false
      void this.gateway.sendMessage(
        request.sessionId,
        message,
        attachments,
        undefined,
        {
          operationId,
          optimisticMessageId: operationId,
          midStreamSendIntent,
          source: { type: 'session', sessionId: request.sourceSessionId },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        messageId => {
          if (accepted) return
          accepted = true
          resolve({ operationId, messageId, accepted: true, delivery: request.delivery ?? 'followUp' })
        },
      ).then(() => {
        if (!accepted) reject(new Error(`Session ${request.sessionId} did not accept the message`))
      }).catch(error => {
        if (!accepted) reject(error)
      })
    })
  }

  private async requireWorkspaceSession(workspaceId: string, sessionId: string): Promise<Session> {
    const session = await this.gateway.getSession(sessionId)
    if (!session || session.workspaceId !== workspaceId) {
      throw new Error(`Session ${sessionId} not found in Workspace ${workspaceId}`)
    }
    return session
  }
}

function buildTurnSummaries(entries: PiBranchProjectionEntry[], charLimit: number): SessionReadTurn[] {
  const turns: SessionReadTurn[] = []
  let current: SessionReadTurn | undefined
  for (const entry of entries) {
    if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue
    const message = entry.message as Record<string, unknown>
    const role = message.role
    if (role === 'user') {
      if (current) turns.push(current)
      const content = truncateText(extractText(message.content), charLimit)
      current = {
        id: entry.id,
        user: content.text,
        userTruncated: content.truncated,
        startedAt: parseTimestamp(message.timestamp, entry.timestamp),
      }
      continue
    }
    if (role !== 'assistant' || !current) continue
    const content = truncateText(extractText(message.content), charLimit)
    if (!content.text) continue
    current.agent = content.text
    current.agentTruncated = content.truncated
    current.completedAt = parseTimestamp(message.timestamp, entry.timestamp)
  }
  if (current) turns.push(current)
  return turns
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => {
    if (!part || typeof part !== 'object') return []
    const block = part as Record<string, unknown>
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('')
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

function parseTimestamp(value: unknown, fallback: string): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  const parsed = Date.parse(fallback)
  return Number.isFinite(parsed) ? parsed : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeListCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const decoded = decodeCursor(cursor)
  if (typeof decoded.offset !== 'number' || decoded.offset < 0) throw new Error('Invalid session list cursor')
  return Math.trunc(decoded.offset)
}

function decodeReadCursor(
  cursor: string | undefined,
  sessionId: string,
  leafId: string | null,
): { end: number } | undefined {
  if (!cursor) return undefined
  const decoded = decodeCursor(cursor)
  if (decoded.version !== 1 || decoded.sessionId !== sessionId || decoded.leafId !== leafId
    || typeof decoded.end !== 'number' || decoded.end < 0) {
    throw new Error('Invalid session read cursor')
  }
  return { end: Math.trunc(decoded.end) }
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
    return value as Record<string, unknown>
  } catch {
    throw new Error('Invalid session cursor')
  }
}
