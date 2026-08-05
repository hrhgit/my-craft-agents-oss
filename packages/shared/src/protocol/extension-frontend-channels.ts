export const EXTENSION_FRONTEND_CHANNEL_SCHEMA_VERSION = 2 as const

export type ExtensionFrontendChannelScope = 'session' | 'workspace' | 'global'

export interface ExtensionFrontendStateV2 {
  schemaVersion: typeof EXTENSION_FRONTEND_CHANNEL_SCHEMA_VERSION
  channelId: string
  scope: ExtensionFrontendChannelScope
  revision: number
  state: unknown
}

export interface ExtensionFrontendMessageV2 {
  schemaVersion: typeof EXTENSION_FRONTEND_CHANNEL_SCHEMA_VERSION
  extensionId: string
  channelId: string
  scope: ExtensionFrontendChannelScope
  message: unknown
  route: { workspaceId?: string; sessionId?: string }
  runtimeId?: string
}

export function isSerializableFrontendValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value !== 'number' || Number.isFinite(value)
  }
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every((item) => isSerializableFrontendValue(item, seen))
  return Object.entries(value).every(([key, item]) => key.length <= 256 && isSerializableFrontendValue(item, seen))
}

export function validateExtensionFrontendStateV2(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Frontend state must be an object'
  const state = value as Record<string, unknown>
  if (state.schemaVersion !== EXTENSION_FRONTEND_CHANNEL_SCHEMA_VERSION) return 'Unsupported frontend channel schema version'
  if (typeof state.channelId !== 'string' || !state.channelId || state.channelId.length > 128) return 'channelId is invalid'
  if (!['session', 'workspace', 'global'].includes(String(state.scope))) return 'scope is invalid'
  if (!Number.isSafeInteger(state.revision) || Number(state.revision) < 0) return 'revision is invalid'
  if (!isSerializableFrontendValue(state.state)) return 'state must be serializable'
  return null
}
