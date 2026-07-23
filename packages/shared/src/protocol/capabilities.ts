export interface CapabilityRequestV1 {
  version: 1
  requestId: string
  capability: string
  sessionId: string
  runtimeId: string
  extensionId: string
  operation: string
  input: unknown
  timeoutMs?: number
}

export interface CapabilityDeclarationV1 {
  capability: string
  operations: string[]
}

export interface ExtensionCapabilityDeclarationV1 {
  version: 1
  sessionId: string
  runtimeId: string
  extensionId: string
  declarations: CapabilityDeclarationV1[]
}

export interface CapabilityError {
  code: string
  message: string
  retryable?: boolean
}

export type CapabilityFailureStatus = 'denied' | 'cancelled' | 'unsupported' | 'failed'

export type CapabilityResultV1 =
  | { requestId: string; status: 'success'; output: unknown }
  | { requestId: string; status: CapabilityFailureStatus; error?: CapabilityError }

export interface CapabilityProgressV1 {
  version: 1
  requestId: string
  sequence: number
  progress: unknown
}

export const PLATFORM_CAPABILITY_SNAPSHOT_SCHEMA_VERSION = 1 as const
export const CAPABILITY_UNAVAILABLE_ERROR_CODE = 'CAPABILITY_UNAVAILABLE' as const

export type PlatformRuntimeV1 = 'electron' | 'web'
export type PlatformCapabilityStatusV1 = 'supported' | 'degraded' | 'unavailable'

export interface PlatformCapabilityDescriptorV1 {
  status: PlatformCapabilityStatusV1
  reason?: string
}

export interface PlatformCapabilitySnapshotV1 {
  schemaVersion: typeof PLATFORM_CAPABILITY_SNAPSHOT_SCHEMA_VERSION
  platform: PlatformRuntimeV1
  capabilities: Readonly<Record<string, Readonly<PlatformCapabilityDescriptorV1>>>
}

export interface CapabilityUnavailableErrorDataV1 {
  schemaVersion: 1
  code: typeof CAPABILITY_UNAVAILABLE_ERROR_CODE
  platform: PlatformRuntimeV1
  capability: string
  message: string
  retryable: false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createPlatformCapabilitySnapshotV1(
  platform: PlatformRuntimeV1,
  capabilities: Record<string, PlatformCapabilityDescriptorV1>,
): PlatformCapabilitySnapshotV1 {
  const frozenCapabilities = Object.fromEntries(
    Object.entries(capabilities).map(([name, descriptor]) => [name, Object.freeze({ ...descriptor })]),
  )

  return Object.freeze({
    schemaVersion: PLATFORM_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    platform,
    capabilities: Object.freeze(frozenCapabilities),
  })
}

export function isPlatformCapabilitySnapshotV1(value: unknown): value is PlatformCapabilitySnapshotV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) return false
  if (value.platform !== 'electron' && value.platform !== 'web') return false
  if (!isRecord(value.capabilities)) return false

  return Object.entries(value.capabilities).every(([name, descriptor]) => {
    if (name.length === 0 || !isRecord(descriptor)) return false
    if (descriptor.status !== 'supported' && descriptor.status !== 'degraded' && descriptor.status !== 'unavailable') return false
    return descriptor.reason === undefined || typeof descriptor.reason === 'string'
  })
}

export function createCapabilityUnavailableErrorDataV1(
  platform: PlatformRuntimeV1,
  capability: string,
  reason?: string,
): CapabilityUnavailableErrorDataV1 {
  const message = `Capability "${capability}" is unavailable on ${platform}${reason ? `: ${reason}` : '.'}`
  return {
    schemaVersion: 1,
    code: CAPABILITY_UNAVAILABLE_ERROR_CODE,
    platform,
    capability,
    message,
    retryable: false,
  }
}

export function isCapabilityUnavailableErrorDataV1(value: unknown): value is CapabilityUnavailableErrorDataV1 {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.code === CAPABILITY_UNAVAILABLE_ERROR_CODE
    && (value.platform === 'electron' || value.platform === 'web')
    && typeof value.capability === 'string'
    && value.capability.length > 0
    && typeof value.message === 'string'
    && value.retryable === false
}
