export const EXECUTION_ROUTE_ERROR_CODES = {
  unsupported: 'UNSUPPORTED',
  noInteractiveClient: 'NO_INTERACTIVE_CLIENT',
  targetUnavailable: 'TARGET_UNAVAILABLE',
  permissionDenied: 'LOCATION_PERMISSION_DENIED',
  versionMismatch: 'LOCATION_VERSION_UNSUPPORTED',
} as const

export type ExecutionRouteErrorCode = typeof EXECUTION_ROUTE_ERROR_CODES[keyof typeof EXECUTION_ROUTE_ERROR_CODES]
export type LocationExecutionPermission = 'read' | 'write' | 'search' | 'runCommands'

export type CapabilityExecutionTargetV1 =
  | { owner: 'location-backend'; workspaceId: string; locationId: string }
  | { owner: 'requesting-client'; clientId?: string }

const REQUESTING_CLIENT_CAPABILITIES = new Set([
  'browser.command',
  'browser.control',
  'browser.open',
  'browser.operate',
  'files.pick',
  'system.notification',
])

export function isRequestingClientCapability(capability: string): boolean {
  return REQUESTING_CLIENT_CAPABILITIES.has(capability)
}

export function capabilityStatusForExecutionRouteError(
  code: ExecutionRouteErrorCode,
): 'denied' | 'unsupported' | 'failed' {
  if (code === EXECUTION_ROUTE_ERROR_CODES.permissionDenied) return 'denied'
  if (code === EXECUTION_ROUTE_ERROR_CODES.unsupported || code === EXECUTION_ROUTE_ERROR_CODES.noInteractiveClient) {
    return 'unsupported'
  }
  return 'failed'
}

export function isExecutionRouteErrorCode(value: unknown): value is ExecutionRouteErrorCode {
  return typeof value === 'string' && Object.values(EXECUTION_ROUTE_ERROR_CODES).includes(value as ExecutionRouteErrorCode)
}

/** Maps a routed RPC operation to the permission enforced by its selected location backend. */
export function requiredLocationPermission(channel: string): LocationExecutionPermission | null {
  const normalized = channel.toLowerCase()
  if (normalized.startsWith('sessions:') || normalized.includes('command') || normalized.includes('shell')) return 'runCommands'
  if (normalized.includes('search')) return 'search'
  if (/(write|create|rename|delete|store|import|setdraft)/.test(normalized)) return 'write'
  if (normalized.startsWith('file:') || normalized.startsWith('fs:') || normalized.includes('read') || normalized.includes('list') || normalized.includes('watch') || normalized.includes('export')) return 'read'
  return null
}
