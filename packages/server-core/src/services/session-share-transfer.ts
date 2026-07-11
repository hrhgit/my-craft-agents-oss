import { VIEWER_URL } from '@craft-agent/shared/branding'
import type {
  ImportRemoteSessionTransferResult,
  RemoteSessionTransferPayload,
  ShareResult,
} from '@craft-agent/shared/protocol'
import type { PermissionMode } from '@craft-agent/shared/agent/mode-types'
import type { Logger } from '../runtime/platform'

export interface ShareTransferSessionRecord {
  id: string
  workspaceId: string
  workspaceRootPath: string
  isProcessing: boolean
  sharedId?: string
  sharedUrl?: string
  name?: string
  sessionStatus?: string
  labels?: string[]
  permissionMode?: PermissionMode
}

export interface SessionShareTransferStore {
  resolve(sessionId: string): ShareTransferSessionRecord | null
  loadStoredSession(session: ShareTransferSessionRecord): unknown | null
  setAsyncOperation(sessionId: string, ongoing: boolean): void
  updateShareMetadata(sessionId: string, metadata: { sharedId?: string; sharedUrl?: string }): Promise<void>
  emitShareEvent(event: { type: 'session_shared'; sessionId: string; sharedUrl: string } | { type: 'session_unshared'; sessionId: string }, workspaceId: string): void
  persistAndFlush(sessionId: string): Promise<void>
  summarize(sessionId: string): Promise<string | null>
  createImported(workspaceId: string, payload: RemoteSessionTransferPayload): Promise<ImportRemoteSessionTransferResult>
}

export interface SessionShareTransferServiceOptions {
  store: SessionShareTransferStore
  logger: Logger
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  viewerUrl?: string
}

/** Host-owned share and summary-transfer business logic shared by RPC and capabilities. */
export class SessionShareTransferService {
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  private readonly viewerUrl: string

  constructor(private readonly options: SessionShareTransferServiceOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.viewerUrl = options.viewerUrl ?? VIEWER_URL
  }

  status(sessionId: string): { published: boolean; url?: string } {
    const session = this.options.store.resolve(sessionId)
    if (!session) throw new Error('Session not found')
    return session.sharedUrl ? { published: true, url: session.sharedUrl } : { published: false }
  }

  async publish(sessionId: string): Promise<ShareResult> {
    const session = this.options.store.resolve(sessionId)
    if (!session) return { success: false, error: 'Session not found' }
    return this.withAsyncOperation(session, async () => {
      const stored = this.options.store.loadStoredSession(session)
      if (!stored) return { success: false, error: 'Session file not found' }
      try {
        const response = await this.fetchImpl(`${this.viewerUrl}/s/api`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stored),
        })
        if (!response.ok) return this.uploadFailure(response.status, 'Failed to upload session')
        const data = await response.json() as { id: string; url: string }
        await this.options.store.updateShareMetadata(sessionId, { sharedId: data.id, sharedUrl: data.url })
        this.options.store.emitShareEvent({ type: 'session_shared', sessionId, sharedUrl: data.url }, session.workspaceId)
        return { success: true, url: data.url }
      } catch (error) {
        this.options.logger.error('Share error:', error)
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    })
  }

  async refresh(sessionId: string): Promise<ShareResult> {
    const session = this.options.store.resolve(sessionId)
    if (!session) return { success: false, error: 'Session not found' }
    if (!session.sharedId) return { success: false, error: 'Session not shared' }
    return this.withAsyncOperation(session, async () => {
      const stored = this.options.store.loadStoredSession(session)
      if (!stored) return { success: false, error: 'Session file not found' }
      try {
        const response = await this.fetchImpl(`${this.viewerUrl}/s/api/${session.sharedId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stored),
        })
        if (!response.ok) return this.uploadFailure(response.status, 'Failed to update shared session')
        return { success: true, url: session.sharedUrl }
      } catch (error) {
        this.options.logger.error('Update share error:', error)
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    })
  }

  async revoke(sessionId: string): Promise<ShareResult> {
    const session = this.options.store.resolve(sessionId)
    if (!session) return { success: false, error: 'Session not found' }
    if (!session.sharedId) return { success: false, error: 'Session not shared' }
    return this.withAsyncOperation(session, async () => {
      try {
        const response = await this.fetchImpl(`${this.viewerUrl}/s/api/${session.sharedId}`, { method: 'DELETE' })
        if (!response.ok) return { success: false, error: 'Failed to revoke share' }
        await this.options.store.updateShareMetadata(sessionId, { sharedId: undefined, sharedUrl: undefined })
        this.options.store.emitShareEvent({ type: 'session_unshared', sessionId }, session.workspaceId)
        return { success: true }
      } catch (error) {
        this.options.logger.error('Revoke error:', error)
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
      }
    })
  }

  async exportSummary(sessionId: string, workspaceId?: string): Promise<RemoteSessionTransferPayload | null> {
    const session = this.options.store.resolve(sessionId)
    if (!session || (workspaceId !== undefined && session.workspaceId !== workspaceId) || session.isProcessing) return null
    await this.options.store.persistAndFlush(sessionId)
    const summary = await this.options.store.summarize(sessionId)
    if (!summary) return null
    return {
      sourceSessionId: session.id, name: session.name, sessionStatus: session.sessionStatus,
      labels: session.labels, permissionMode: session.permissionMode, summary,
    }
  }

  async importSummary(workspaceId: string, payload: RemoteSessionTransferPayload): Promise<ImportRemoteSessionTransferResult> {
    if (!payload || typeof payload !== 'object' || typeof payload.summary !== 'string' || !payload.summary.trim()) {
      throw new Error('Invalid remote session transfer payload')
    }
    return this.options.store.createImported(workspaceId, { ...payload, summary: payload.summary.trim() })
  }

  private async withAsyncOperation(session: ShareTransferSessionRecord, operation: () => Promise<ShareResult>): Promise<ShareResult> {
    this.options.store.setAsyncOperation(session.id, true)
    try { return await operation() } finally { this.options.store.setAsyncOperation(session.id, false) }
  }

  private uploadFailure(status: number, fallback: string): ShareResult {
    if (status === 413) return { success: false, error: 'Session file is too large to share' }
    return { success: false, error: fallback }
  }
}
