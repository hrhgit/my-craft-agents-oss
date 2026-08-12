export type ExtensionCapabilityScopeV1 = 'global' | 'workspace' | 'session'
export type ExtensionCapabilityServiceOperationV1 = { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }
export type ExtensionCapabilityBindingV1 = {
  alias: string
  capability: string
  version: string
  required: boolean
  requestedFacets: Array<'service' | 'ui'>
  status: 'bound' | 'missing' | 'version-mismatch' | 'provider-mismatch' | 'ambiguous' | 'facet-missing'
  providerExtensionId?: string
  providerVersion?: string
  scope?: ExtensionCapabilityScopeV1
  candidateProviderIds?: string[]
}

export const EXTENSION_SERVICES_PROTOCOL_VERSION = 1 as const

export interface ExtensionServiceProviderDTO {
  extensionId: string
  capability: string
  version: string
  scope: ExtensionCapabilityScopeV1
  operations: Record<string, ExtensionCapabilityServiceOperationV1>
}

export interface ExtensionServiceCatalogDTO {
  protocolVersion: typeof EXTENSION_SERVICES_PROTOCOL_VERSION
  runtimeId: string
  scope: ExtensionCapabilityScopeV1
  providers: ExtensionServiceProviderDTO[]
  consumers: Array<{ extensionId: string; bindings: ExtensionCapabilityBindingV1[] }>
}

export interface ExtensionServiceInvokeDTO {
  protocolVersion: typeof EXTENSION_SERVICES_PROTOCOL_VERSION
  requestId: string
  runtimeId: string
  sessionId?: string
  capability: string
  operation: string
  provider?: string
  input: unknown
  timeoutMs?: number
}

export type ExtensionServiceResultStatus = 'succeeded' | 'unavailable' | 'ambiguous' | 'invalid_input' | 'invalid_output' | 'cancelled' | 'timed_out' | 'failed' | 'runtime_stale'

export interface ExtensionServiceResultDTO {
  protocolVersion: typeof EXTENSION_SERVICES_PROTOCOL_VERSION
  requestId: string
  runtimeId: string
  status: ExtensionServiceResultStatus
  output?: unknown
  error?: { code: string; message: string; details?: unknown }
  progress?: unknown[]
}
