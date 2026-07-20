import {
  parseAutomationWorkspaceCommandV1,
  parseAutomationWorkspaceOperationResultV1,
  type AutomationWorkspaceCommandV1,
} from '@mortise/shared/protocol'
import type { AutomationCapabilityResultV1 } from '@mortise/shared/automations'
import {
  AUTOMATION_INGRESS_TOKEN_RPC_CHANNEL,
  AUTOMATION_WORKSPACE_RPC_CHANNEL,
} from '@mortise/server-core/handlers/automation-workspace'
import type { CliRpcClient } from './client.ts'

export async function invokeAutomationWorkspace(
  client: CliRpcClient,
  input: unknown,
): Promise<AutomationCapabilityResultV1<unknown>> {
  const command = parseAutomationWorkspaceCommandV1(input)
  const result = await client.invoke(AUTOMATION_WORKSPACE_RPC_CHANNEL, command)
  return parseAutomationWorkspaceOperationResultV1(command.operation, result)
}

export async function invokeAutomationIngressToken(
  client: CliRpcClient,
  operation: 'show-path' | 'rotate',
): Promise<{ schemaVersion: 1; workspaceId: string; path: string; created?: boolean; rotatedAt?: string }> {
  const result = await client.invoke(AUTOMATION_INGRESS_TOKEN_RPC_CHANNEL, { operation })
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid automation ingress token response')
  const value = result as Record<string, unknown>
  if (value.schemaVersion !== 1 || typeof value.workspaceId !== 'string' || typeof value.path !== 'string') {
    throw new Error('Invalid automation ingress token response')
  }
  return value as Awaited<ReturnType<typeof invokeAutomationIngressToken>>
}

export type { AutomationWorkspaceCommandV1 }
