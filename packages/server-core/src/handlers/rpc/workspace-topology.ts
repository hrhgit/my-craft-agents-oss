import type { Workspace } from '@mortise/core/types'
import {
  RPC_CHANNELS,
  WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION,
  parseWorkspaceTopologyCommandV1,
  parseWorkspaceV2,
  type WorkspaceTopologyChangedV1,
} from '@mortise/shared/protocol'
import {
  WorkspaceTopologyStore,
  getDefaultWorkspaceTopologyStore,
  type LegacyWorkspaceV1,
} from '@mortise/shared/workspaces'
import { pushTyped, type RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'

interface WorkspaceTopologySessionCoordinator {
  interruptWorkspaceSessionsForTopologyChange(target:
    | { workspaceId: string; scope: 'workspace' }
    | { workspaceId: string; scope: 'location'; locationId: string }
  ): Promise<unknown>
  updateWorkspaceTopology(workspace: Workspace): void
}

export const WORKSPACE_TOPOLOGY_HANDLED_CHANNELS = [
  RPC_CHANNELS.workspaces.GET_TOPOLOGY,
  RPC_CHANNELS.workspaces.TOPOLOGY_COMMAND,
] as const

export function registerWorkspaceTopologyHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  store: WorkspaceTopologyStore = getDefaultWorkspaceTopologyStore(),
): void {
  server.handle(RPC_CHANNELS.workspaces.GET_TOPOLOGY, async (ctx, requestedWorkspaceId?: string) => {
    if (ctx.workspaceId && requestedWorkspaceId && ctx.workspaceId !== requestedWorkspaceId) {
      throw new Error(
        `Workspace mismatch: authenticated workspace (${ctx.workspaceId}) does not match requested (${requestedWorkspaceId})`,
      )
    }
    const workspaceId = requestedWorkspaceId ?? ctx.workspaceId
    if (!workspaceId) throw new Error('A Workspace identity is required')
    const current = store.getInfo(workspaceId)
    if (current) return current
    const candidate = deps.sessionManager.getWorkspaces().find(workspace => workspace.id === workspaceId)
    if (!candidate) throw new Error(`Workspace not found: ${workspaceId}`)
    return ensureWorkspaceTopology(store, candidate)
  })

  server.handle(RPC_CHANNELS.workspaces.TOPOLOGY_COMMAND, async (ctx, commandValue: unknown) => {
    const command = parseWorkspaceTopologyCommandV1(commandValue)
    if (ctx.workspaceId && ctx.workspaceId !== command.workspaceId) {
      throw new Error(
        `Workspace mismatch: authenticated workspace (${ctx.workspaceId}) does not match requested (${command.workspaceId})`,
      )
    }
    if (!store.get(command.workspaceId)) {
      const candidate = deps.sessionManager.getWorkspaces().find(workspace => workspace.id === command.workspaceId)
      if (!candidate) throw new Error(`Workspace not found: ${command.workspaceId}`)
      ensureWorkspaceTopology(store, candidate)
    }
    const replay = store.getAppliedResult(command)
    if (replay) return replay

    const interruption = topologyInterruption(command)
    const coordinator = deps.sessionManager as unknown as Partial<WorkspaceTopologySessionCoordinator>
    if (typeof coordinator.updateWorkspaceTopology !== 'function') {
      throw new Error('Workspace topology Session projection coordinator is unavailable')
    }
    if (interruption) {
      if (typeof coordinator.interruptWorkspaceSessionsForTopologyChange !== 'function') {
        throw new Error('Workspace topology interruption coordinator is unavailable')
      }
      await coordinator.interruptWorkspaceSessionsForTopologyChange(interruption)
    }
    const result = store.apply(command)
    if (result.status === 'applied') {
      const persisted = store.get(command.workspaceId)
      if (!persisted) throw new Error(`Workspace topology not found after mutation: ${command.workspaceId}`)
      coordinator.updateWorkspaceTopology(persisted)
      const change: WorkspaceTopologyChangedV1 = {
        schemaVersion: WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION,
        workspaceId: command.workspaceId,
        operationId: command.operationId,
        operation: command.operation,
        previousRevision: result.previousRevision,
        revision: result.workspace.revision,
        changedLocationIds: [command.locationId],
        workspace: result.workspace,
      }
      pushTyped(server, RPC_CHANNELS.workspaces.TOPOLOGY_CHANGED, { to: 'all', exclude: ctx.clientId }, change)
    }
    return result
  })
}

function topologyInterruption(command: ReturnType<typeof parseWorkspaceTopologyCommandV1>) {
  if (command.operation === 'set-primary') {
    return { workspaceId: command.workspaceId, scope: 'workspace' as const }
  }
  if (command.operation === 'detach' || command.operation === 'replace-endpoint') {
    return {
      workspaceId: command.workspaceId,
      scope: 'location' as const,
      locationId: command.locationId,
    }
  }
  return null
}

/** Persist one V2 record once; ordinary topology reads never consult the legacy candidate. */
export function ensureWorkspaceTopology(
  store: WorkspaceTopologyStore,
  candidate: Workspace | LegacyWorkspaceV1,
) {
  const current = store.get(candidate.id)
  if (current) return store.getInfo(candidate.id)!
  let workspace: Workspace | null = null
  try {
    workspace = parseWorkspaceV2(candidate)
  } catch { /* legacy single-root candidate */ }
  const persisted = workspace
    ? store.create(workspace)
    : store.migrateLegacy(candidate as LegacyWorkspaceV1)
  return store.getInfo(persisted.id)!
}
