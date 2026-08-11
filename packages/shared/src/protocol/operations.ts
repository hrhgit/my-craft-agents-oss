export type OperationStatus = 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface OperationScope {
  workspaceId?: string
  sessionId?: string
  transferId?: string
  extensionId?: string
}

export interface OperationError {
  code: string
  message: string
}

export interface OperationReceipt {
  operationId: string
  operationType: string
  status: OperationStatus
  revision: number
  createdAt: string
  updatedAt: string
  scope: OperationScope
  resultRef?: string
  error?: OperationError
}

export interface OperationAccepted {
  accepted: true
  operationId: string
  status: OperationStatus
  revision: number
  duplicate: boolean
}

export interface OperationUpdatedEvent {
  receipt: OperationReceipt
}

export interface OperationStartRequest {
  operationId: string
  operationType: string
  scope?: OperationScope
}

export interface OperationGetRequest {
  operationId: string
}

export interface OperationCancelRequest {
  operationId: string
}
