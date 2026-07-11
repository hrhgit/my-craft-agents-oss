import type {
  ImportRemoteSessionTransferResult,
  RemoteSessionTransferPayload,
  ShareResult,
} from '@craft-agent/shared/protocol'
import type { CapabilityProvider } from '../types.ts'

export const TRANSFER_SUMMARY_MAX_LENGTH = 200_000
export const TRANSFER_NAME_MAX_LENGTH = 500
export const TRANSFER_LABEL_LIMIT = 100
export const TRANSFER_LABEL_MAX_LENGTH = 200

export interface SessionShareStatus {
  published: boolean
  url?: string
}

export interface SessionShareAdapter {
  status(sessionId: string): Promise<SessionShareStatus>
  publish(sessionId: string): Promise<ShareResult>
  refresh(sessionId: string): Promise<ShareResult>
  revoke(sessionId: string): Promise<ShareResult>
}

function requireEmptyInput(input: unknown): void {
  if (input === undefined || input === null) return
  if (typeof input === 'object' && !Array.isArray(input) && Object.keys(input as object).length === 0) return
  throw new Error('input must be empty')
}

function requireShareSuccess(result: ShareResult): { published: boolean; url?: string } {
  if (!result.success) throw new Error(result.error || 'Share operation failed')
  return result.url ? { published: true, url: result.url } : { published: false }
}

export function createSessionShareCapabilityProvider(adapter: SessionShareAdapter): CapabilityProvider {
  return {
    capability: 'session.share',
    async invoke(operation, input, context) {
      requireEmptyInput(input)
      if (context.signal.aborted) throw context.signal.reason ?? new Error('Capability request cancelled')
      const sessionId = context.request.sessionId
      switch (operation) {
        case 'status': return adapter.status(sessionId)
        case 'publish': return requireShareSuccess(await adapter.publish(sessionId))
        case 'refresh': return requireShareSuccess(await adapter.refresh(sessionId))
        case 'revoke': return requireShareSuccess(await adapter.revoke(sessionId))
        default: throw new Error(`Unsupported session.share operation: ${operation}`)
      }
    },
  }
}

export interface SessionTransferAdapter {
  exportSummary(sessionId: string): Promise<RemoteSessionTransferPayload | null>
  importSummary(sessionId: string, payload: RemoteSessionTransferPayload): Promise<ImportRemoteSessionTransferResult>
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} characters`)
  }
  return value
}

function parseTransferPayload(input: unknown): RemoteSessionTransferPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be a transfer summary object')
  const value = input as Record<string, unknown>
  const allowed = new Set(['sourceSessionId', 'name', 'sessionStatus', 'labels', 'permissionMode', 'summary'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('input contains unsupported transfer fields')
  const sourceSessionId = optionalString(value.sourceSessionId, 'sourceSessionId', 200)
  const summary = optionalString(value.summary, 'summary', TRANSFER_SUMMARY_MAX_LENGTH)
  if (!sourceSessionId || !summary) throw new Error('sourceSessionId and summary are required')
  let labels: string[] | undefined
  if (value.labels !== undefined) {
    if (!Array.isArray(value.labels) || value.labels.length > TRANSFER_LABEL_LIMIT
      || value.labels.some(label => typeof label !== 'string' || !label.trim() || label.length > TRANSFER_LABEL_MAX_LENGTH)) {
      throw new Error('labels are invalid or exceed the transfer limit')
    }
    labels = value.labels as string[]
  }
  const sessionStatus = optionalString(value.sessionStatus, 'sessionStatus', 200)
  if (value.permissionMode !== undefined && !['safe', 'ask', 'allow-all'].includes(String(value.permissionMode))) {
    throw new Error('permissionMode is invalid')
  }
  return {
    sourceSessionId,
    summary,
    ...(optionalString(value.name, 'name', TRANSFER_NAME_MAX_LENGTH) ? { name: value.name as string } : {}),
    ...(labels ? { labels } : {}),
    ...(sessionStatus ? { sessionStatus } : {}),
    ...(value.permissionMode ? { permissionMode: value.permissionMode as RemoteSessionTransferPayload['permissionMode'] } : {}),
  }
}

export function createSessionTransferCapabilityProvider(adapter: SessionTransferAdapter): CapabilityProvider {
  return {
    capability: 'session.transfer',
    async invoke(operation, input, context) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error('Capability request cancelled')
      if (operation === 'export-summary') {
        requireEmptyInput(input)
        context.reportProgress({ phase: 'summarizing' })
        const payload = await adapter.exportSummary(context.request.sessionId)
        if (!payload) throw new Error('Session could not be exported')
        context.reportProgress({ phase: 'complete' })
        return payload
      }
      if (operation === 'import-summary') {
        const payload = parseTransferPayload(input)
        context.reportProgress({ phase: 'importing' })
        const result = await adapter.importSummary(context.request.sessionId, payload)
        context.reportProgress({ phase: 'complete' })
        return result
      }
      throw new Error(`Unsupported session.transfer operation: ${operation}`)
    },
  }
}
