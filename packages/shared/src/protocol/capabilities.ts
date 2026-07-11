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
