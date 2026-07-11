export type {
  CapabilityError,
  CapabilityFailureStatus,
  CapabilityProgressV1,
  CapabilityRequestV1,
  CapabilityResultV1,
  ExtensionCapabilityDeclarationV1,
} from '@craft-agent/shared/protocol'

import type {
  CapabilityProgressV1,
  CapabilityRequestV1,
  CapabilityResultV1,
} from '@craft-agent/shared/protocol'

export interface CapabilityProviderContext {
  request: CapabilityRequestV1
  signal: AbortSignal
  reportProgress(progress: unknown): void
}

export interface CapabilityProvider {
  readonly capability: string
  invoke(operation: string, input: unknown, context: CapabilityProviderContext): Promise<unknown>
}

export type CapabilityAuthorization =
  | { allowed: true }
  | { allowed: false; reason?: string }

export interface CapabilityAuditEvent {
  phase: 'started' | 'finished'
  requestId: string
  capability: string
  operation: string
  sessionId: string
  runtimeId: string
  extensionId: string
  status?: CapabilityResultV1['status']
  durationMs?: number
}

export interface CapabilityRouterOptions {
  requireDeclarations?: boolean
  authorize?: (request: CapabilityRequestV1) => CapabilityAuthorization | Promise<CapabilityAuthorization>
  audit?: (event: CapabilityAuditEvent) => void
  onProgress?: (event: CapabilityProgressV1) => void
  defaultTimeoutMs?: number
  completedResultLimit?: number
}
