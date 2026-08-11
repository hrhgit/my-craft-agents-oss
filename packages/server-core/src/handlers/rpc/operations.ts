import { RPC_CHANNELS, type OperationCancelRequest, type OperationGetRequest } from '@mortise/shared/protocol'
import type { RpcServer } from '../../transport/types'
import type { OperationCoordinator } from '../../operations/operation-coordinator'

export function registerOperationHandlers(server: RpcServer, coordinator: OperationCoordinator): void {
  const requireVisibleReceipt = (workspaceId: string | null, operationId: string) => {
    const receipt = coordinator.get(operationId)
    if (!receipt) throw new Error(`Unknown operation ${operationId}`)
    if (receipt.scope.workspaceId && receipt.scope.workspaceId !== workspaceId) {
      throw new Error('Operation is outside the current Workspace')
    }
    return receipt
  }

  coordinator.subscribe((receipt) => {
    const target = receipt.scope.workspaceId
      ? { to: 'workspace' as const, workspaceId: receipt.scope.workspaceId }
      : { to: 'all' as const }
    server.push(RPC_CHANNELS.operations.UPDATED, target, { receipt })
  })

  server.handle(RPC_CHANNELS.operations.GET, (ctx, request: OperationGetRequest) => {
    if (!request?.operationId) throw new Error('Missing operationId')
    const receipt = coordinator.get(request.operationId)
    if (!receipt) return null
    if (receipt.scope.workspaceId && receipt.scope.workspaceId !== ctx.workspaceId) {
      throw new Error('Operation is outside the current Workspace')
    }
    return receipt
  })

  server.handle(RPC_CHANNELS.operations.SUBSCRIBE, (ctx, request: OperationGetRequest) => {
    if (!request?.operationId) throw new Error('Missing operationId')
    return requireVisibleReceipt(ctx.workspaceId, request.operationId)
  })

  server.handle(RPC_CHANNELS.operations.CANCEL, (ctx, request: OperationCancelRequest) => {
    if (!request?.operationId) throw new Error('Missing operationId')
    requireVisibleReceipt(ctx.workspaceId, request.operationId)
    return coordinator.cancel(request.operationId)
  })
}
