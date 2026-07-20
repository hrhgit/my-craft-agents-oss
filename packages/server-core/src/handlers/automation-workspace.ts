import {
  RPC_CHANNELS,
  parseAutomationWorkspaceCommandV1,
  parseAutomationWorkspaceOperationResultV1,
  type AutomationWorkspaceCommandV1,
} from '@mortise/shared/protocol'
import type { RpcServer } from '../transport/types.ts'
import type { AutomationWorkspaceDispatcherV1 } from '../services/automation-ingress.ts'
import { AutomationIngressTokenRegistry } from '../services/automation-ingress-token-registry.ts'

export const AUTOMATION_WORKSPACE_RPC_CHANNEL = RPC_CHANNELS.automations.COMMAND
export const AUTOMATION_INGRESS_TOKEN_RPC_CHANNEL = 'automation.workspace:ingress-token'

export interface AutomationWorkspaceRpcDependencies {
  dispatcher: AutomationWorkspaceDispatcherV1
  tokens: AutomationIngressTokenRegistry
}

/** Authenticated WebSocket ingress for CLI and other first-party Host clients. */
export function registerAutomationWorkspaceRpcHandlers(
  server: RpcServer,
  dependencies: AutomationWorkspaceRpcDependencies,
): void {
  server.handle(AUTOMATION_WORKSPACE_RPC_CHANNEL, async (context, input: unknown) => {
    if (!context.workspaceId) throw new Error('automation.workspace requires an authenticated workspace binding')
    const command = parseAutomationWorkspaceCommandV1(input)
    const result = await dependencies.dispatcher.execute(context.workspaceId, command, {
      eventSourceKind: 'mortise',
      ...(context.signal ? { signal: context.signal } : {}),
    })
    return parseAutomationWorkspaceOperationResultV1(command.operation, result)
  })

  server.handle(AUTOMATION_INGRESS_TOKEN_RPC_CHANNEL, async (context, input: unknown) => {
    if (!context.workspaceId) throw new Error('Automation ingress token operations require an authenticated workspace binding')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be an object')
    const value = input as Record<string, unknown>
    if (Object.keys(value).some(key => key !== 'operation')) throw new Error('input contains unsupported fields')
    if (value.operation === 'show-path') {
      const ensured = dependencies.tokens.ensure(context.workspaceId)
      return { schemaVersion: 1, workspaceId: context.workspaceId, path: ensured.path, created: ensured.created }
    }
    if (value.operation === 'rotate') {
      const rotated = dependencies.tokens.rotate(context.workspaceId)
      return { schemaVersion: 1, workspaceId: context.workspaceId, path: rotated.path, rotatedAt: rotated.rotatedAt }
    }
    throw new Error('operation must be show-path or rotate')
  })
}

export type { AutomationWorkspaceCommandV1 }
