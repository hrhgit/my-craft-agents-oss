export const EXTENSION_FRONTEND_PROTOCOL_VERSION = 2 as const

export type ExtensionFrontendModeV2 = 'append' | 'replace' | 'overlay'
export type ExtensionFrontendScopeV2 = 'session' | 'workspace' | 'global'
export type ExtensionFrontendSurfaceV2 = string

export type ExtensionUIModuleKindV2 = 'module'
export interface ExtensionUIModuleDescriptorV2 {
  schemaVersion: typeof EXTENSION_FRONTEND_PROTOCOL_VERSION
  extensionId: string
  moduleId: string
  entryUrl: string
  styleUrls: string[]
  apiVersion: string
  revision: number
}

export type ExtensionUIOverrideModeV2 = 'decorate' | 'replace'
export interface ExtensionUIOverrideDescriptorV2 {
  schemaVersion: typeof EXTENSION_FRONTEND_PROTOCOL_VERSION
  extensionId: string
  overrideId: string
  target: { extensionId: string; kind: 'frontend' | 'module'; id: string }
  mode: ExtensionUIOverrideModeV2
  entryUrl: string
  styleUrls: string[]
  revision: number
}

/** Host-generated URLs. Renderer must never derive a filesystem path from this DTO. */
export interface ExtensionFrontendDescriptorV2 {
  schemaVersion: typeof EXTENSION_FRONTEND_PROTOCOL_VERSION
  extensionId: string
  frontendId: string
  entryUrl: string
  styleUrls: string[]
  surface: ExtensionFrontendSurfaceV2
  mode: ExtensionFrontendModeV2
  scope: ExtensionFrontendScopeV2
  revision: number
  title?: string
  page?: { id: string; title: string; description?: string; icon?: string; order?: number }
}

export interface ExtensionFrontendDiagnosticsV2 {
  extensionId: string
  frontendId?: string
  code: string
  severity: 'warning' | 'error'
  message: string
}

function boundedString(value: unknown, max = 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function validateExtensionFrontendDescriptorV2(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Frontend descriptor must be an object'
  const descriptor = value as Record<string, unknown>
  const required = ['extensionId', 'frontendId', 'entryUrl', 'surface', 'mode', 'scope', 'revision']
  for (const key of required) if (!boundedString(descriptor[key])) return `${key} must be a bounded string`
  if (descriptor.schemaVersion !== EXTENSION_FRONTEND_PROTOCOL_VERSION) return 'Unsupported frontend descriptor schema version'
  if (!Array.isArray(descriptor.styleUrls) || descriptor.styleUrls.some((url) => !boundedString(url))) return 'styleUrls must be bounded strings'
  if (!['append', 'replace', 'overlay'].includes(String(descriptor.mode))) return 'mode is invalid'
  if (!['session', 'workspace', 'global'].includes(String(descriptor.scope))) return 'scope is invalid'
  if (!Number.isSafeInteger(descriptor.revision) || Number(descriptor.revision) < 0) return 'revision must be a non-negative integer'
  return null
}
