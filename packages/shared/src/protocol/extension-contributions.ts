export type ExtensionContributionKind = 'block' | 'action' | 'prompt' | 'inspector_panel'

export interface ExtensionContributionV1 {
  schemaVersion: 1
  contributionId: string
  extensionId: string
  sessionId: string
  runtimeId: string
  kind: ExtensionContributionKind
  placement?: 'above_editor' | 'below_editor' | 'transcript' | 'inspector'
  payload: unknown
}

export function validateExtensionContributionV1(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Contribution must be an object'
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1) return 'Unsupported contribution schema version'
  for (const key of ['contributionId', 'extensionId', 'sessionId', 'runtimeId'] as const) {
    if (typeof item[key] !== 'string' || !item[key].trim() || item[key].length > 256) return `${key} must be a non-empty bounded string`
  }
  if (item.kind !== 'block' && item.kind !== 'action' && item.kind !== 'prompt' && item.kind !== 'inspector_panel') return 'Unsupported contribution kind'
  if (item.placement !== undefined && item.placement !== 'above_editor' && item.placement !== 'below_editor'
    && item.placement !== 'transcript' && item.placement !== 'inspector') return 'Unsupported contribution placement'
  if (!item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) return 'payload must be an object'
  const payload = item.payload as Record<string, unknown>
  if ('html' in payload || 'component' in payload || 'script' in payload) return 'Executable or DOM contribution payloads are forbidden'
  if (item.kind === 'block') {
    if (payload.format !== 'markdown' && payload.format !== 'json' && payload.format !== 'text') return 'Block format must be markdown, json, or text'
    if (typeof payload.content !== 'string' || payload.content.length > 100_000) return 'Block content must be a bounded string'
  }
  if (item.kind === 'action' && (typeof payload.command !== 'string' || !payload.command.trim())) return 'Action command is required'
  return null
}
