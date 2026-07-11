import type { CapabilityProvider } from '../types.ts'

function requireObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object')
  return input as Record<string, unknown>
}

function requireEmpty(input: unknown): void {
  if (input === undefined || input === null) return
  const value = requireObject(input)
  if (Object.keys(value).length) throw new Error('input must be empty')
}

function requireString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} characters`)
  }
  return value
}

export interface MessagingSessionStatus {
  enabled: boolean
  platforms: Array<{ platform: string; configured: boolean; connected: boolean; state: string }>
}

export interface MessagingSessionBinding {
  id: string
  platform: string
  channelId: string
  threadId?: number
  channelName?: string
  enabled: boolean
  createdAt: number
}

export interface MessagingSessionCapabilityAdapter {
  status(sessionId: string): Promise<MessagingSessionStatus>
  listBindings(sessionId: string): Promise<MessagingSessionBinding[]>
  pair(sessionId: string, platform: string): Promise<{ code: string; expiresAt: number; botUsername?: string }>
  unbind(sessionId: string, platform?: string): Promise<{ removed: number }>
}

export function createMessagingSessionCapabilityProvider(adapter: MessagingSessionCapabilityAdapter): CapabilityProvider {
  return {
    capability: 'messaging.session',
    async invoke(operation, input, context) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error('Capability request cancelled')
      const sessionId = context.request.sessionId
      if (operation === 'status') {
        requireEmpty(input)
        return adapter.status(sessionId)
      }
      if (operation === 'list-bindings') {
        requireEmpty(input)
        return adapter.listBindings(sessionId)
      }
      if (operation === 'pair') {
        const value = requireObject(input)
        if (Object.keys(value).some(key => key !== 'platform')) throw new Error('input contains unsupported pairing fields')
        return adapter.pair(sessionId, requireString(value.platform, 'platform', 50))
      }
      if (operation === 'unbind') {
        const value = requireObject(input)
        if (Object.keys(value).some(key => key !== 'platform')) throw new Error('input contains unsupported unbind fields')
        const platform = value.platform === undefined ? undefined : requireString(value.platform, 'platform', 50)
        return adapter.unbind(sessionId, platform)
      }
      throw new Error(`Unsupported messaging.session operation: ${operation}`)
    },
  }
}

export interface AutomationSummary {
  id: string
  event: string
  name?: string
  enabled: boolean
  actionTypes: string[]
}

export interface AutomationWorkspaceStatus {
  automationCount: number
  schedulerRunning: boolean
}

export interface AutomationWorkspaceCapabilityAdapter {
  status(sessionId: string): Promise<AutomationWorkspaceStatus>
  list(sessionId: string): Promise<AutomationSummary[]>
  setEnabled(sessionId: string, automationId: string, enabled: boolean): Promise<{ id: string; enabled: boolean }>
}

export function createAutomationWorkspaceCapabilityProvider(adapter: AutomationWorkspaceCapabilityAdapter): CapabilityProvider {
  return {
    capability: 'automation.workspace',
    async invoke(operation, input, context) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error('Capability request cancelled')
      const sessionId = context.request.sessionId
      if (operation === 'status') {
        requireEmpty(input)
        return adapter.status(sessionId)
      }
      if (operation === 'list') {
        requireEmpty(input)
        return adapter.list(sessionId)
      }
      if (operation === 'set-enabled') {
        const value = requireObject(input)
        if (Object.keys(value).some(key => key !== 'id' && key !== 'enabled')) throw new Error('input contains unsupported automation fields')
        if (typeof value.enabled !== 'boolean') throw new Error('enabled must be a boolean')
        return adapter.setEnabled(sessionId, requireString(value.id, 'id', 100), value.enabled)
      }
      throw new Error(`Unsupported automation.workspace operation: ${operation}`)
    },
  }
}

export type ScopedAutomationKind = 'scheduler' | 'webhook'

/** Separate named surfaces keep scheduler/webhook grants narrower than general automation access. */
export function createScopedAutomationCapabilityProvider(
  kind: ScopedAutomationKind,
  adapter: AutomationWorkspaceCapabilityAdapter,
): CapabilityProvider {
  const base = createAutomationWorkspaceCapabilityProvider(adapter)
  return { ...base, capability: `${kind}.workspace` }
}
