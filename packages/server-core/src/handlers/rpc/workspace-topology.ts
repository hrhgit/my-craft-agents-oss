import type { Workspace } from '@mortise/core/types'
import {
  CodedError,
  EXECUTION_ROUTE_ERROR_CODES,
  RPC_CHANNELS,
  WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION,
  parseWorkspaceTopologyCommandV1,
  parseWorkspaceV2,
  type WorkspaceTopologyChangedV1,
} from '@mortise/shared/protocol'
import {
  WorkspaceTopologyStore,
  getDefaultWorkspaceTopologyStore,
  removeWorkspaceMarker,
  WorkspaceTopologyError,
  initializeWorkspace,
  type LegacyWorkspaceV1,
} from '@mortise/shared/workspaces'
import {
  CLIENT_ROUTE_WORKSPACE_MARKER_DETACH,
  pushTyped,
  type RpcServer,
  type WorkspaceMarkerDetachRouteRequest,
} from '../../transport'
import type { HandlerDeps } from '../handler-deps'

export const WORKSPACE_TOPOLOGY_HANDLED_CHANNELS = [
  RPC_CHANNELS.workspaces.GET_TOPOLOGY,
  RPC_CHANNELS.workspaces.TOPOLOGY_COMMAND,
  RPC_CHANNELS.workspaces.DETACH_MARKER,
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

  server.handle(RPC_CHANNELS.workspaces.DETACH_MARKER, async (ctx, request: {
    schemaVersion: 1
    workspaceId: string
    operationId: string
  }) => {
    if (!request || request.schemaVersion !== 1 || !request.operationId?.trim() || !request.workspaceId?.trim()) {
      throw new TypeError('Invalid Workspace marker detach request')
    }
    if (!ctx.workspaceId || ctx.workspaceId !== request.workspaceId) {
      throw new Error('Workspace marker detach requires the authenticated Workspace identity')
    }
    const workspace = store.get(request.workspaceId)
    if (!workspace) throw new Error(`Workspace topology not found: ${request.workspaceId}`)
    const primary = workspace.locations.find(location => location.id === workspace.primaryLocationId)
    if (!primary || primary.endpoint.kind !== 'local') {
      throw new CodedError(
        EXECUTION_ROUTE_ERROR_CODES.unsupported,
        'The target backend does not own a local Workspace marker',
      )
    }
    try {
      removeWorkspaceMarker(primary.endpoint.rootPath, workspace.id)
      return { schemaVersion: 1 as const, operationId: request.operationId, status: 'removed' as const }
    } catch (error) {
      if (error instanceof WorkspaceTopologyError && error.code === 'WORKSPACE_MARKER_MISSING') {
        return { schemaVersion: 1 as const, operationId: request.operationId, status: 'already-absent' as const }
      }
      throw error
    }
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
    const automationHost = interruption
      ? deps.sessionManager.getAutomationHost(command.workspaceId)
      : null
    let automationInterruptionRequested = false
    try {
      if (interruption) {
        automationInterruptionRequested = automationHost !== null
        const automationInterruption = automationHost?.interruptForWorkspaceTopologyChange(interruption)
        const sessionInterruption = deps.sessionManager.interruptWorkspaceSessionsForTopologyChange(interruption)
        await Promise.all([automationInterruption, sessionInterruption])
      }
      if (command.operation === 'detach') {
        const workspace = store.get(command.workspaceId)
        const location = workspace?.locations.find(candidate => candidate.id === command.locationId)
        if (location?.endpoint.kind === 'remote') {
          if (!server.hasClientCapability(ctx.clientId, CLIENT_ROUTE_WORKSPACE_MARKER_DETACH)) {
            throw new CodedError(
              EXECUTION_ROUTE_ERROR_CODES.targetUnavailable,
              `The requesting client cannot reach Workspace location ${command.locationId}`,
            )
          }
          const request: WorkspaceMarkerDetachRouteRequest = {
            workspaceId: command.workspaceId,
            locationId: command.locationId,
            operationId: command.operationId,
          }
          await server.invokeClient(ctx.clientId, CLIENT_ROUTE_WORKSPACE_MARKER_DETACH, request)
        }
      }
      const result = store.apply(command)
      if (result.status === 'applied') {
        const persisted = store.get(command.workspaceId)
        if (!persisted) throw new Error(`Workspace topology not found after mutation: ${command.workspaceId}`)
        // Topology mutations can introduce a new local root. Re-run the same
        // initializer used by creation/startup before publishing the change,
        // so marker, SQLite config, plugin metadata, and runtime all observe a
        // complete Workspace rather than a partially attached location.
        const initialized = initializeWorkspace(persisted, { topologyStore: store })
        const initializedInfo = store.getInfo(initialized.id)
        if (!initializedInfo) throw new Error(`Workspace topology projection missing after initialization: ${initialized.id}`)
        deps.sessionManager.updateWorkspaceTopology(initialized)
        const change: WorkspaceTopologyChangedV1 = {
          schemaVersion: WORKSPACE_TOPOLOGY_CHANGE_SCHEMA_VERSION,
          workspaceId: command.workspaceId,
          operationId: command.operationId,
          operation: command.operation,
          previousRevision: result.previousRevision,
          revision: result.workspace.revision,
          changedLocationIds: command.operation === 'rename-workspace' ? [] : [command.locationId],
          workspace: initializedInfo,
        }
        pushTyped(server, RPC_CHANNELS.workspaces.TOPOLOGY_CHANGED, { to: 'all', exclude: ctx.clientId }, change)
      }
      return result
    } finally {
      if (automationInterruptionRequested) {
        await automationHost!.resumeAfterWorkspaceTopologyChange()
      }
    }
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
  if (current) {
    initializeWorkspace(current, { topologyStore: store })
    return store.getInfo(candidate.id)!
  }
  let workspace: Workspace | null = null
  try {
    workspace = parseWorkspaceV2(candidate)
  } catch { /* legacy single-root candidate */ }
  const persisted = workspace
    ? initializeWorkspace(workspace, { topologyStore: store })
    : store.migrateLegacy(candidate as LegacyWorkspaceV1)
  return store.getInfo(persisted.id)!
}
