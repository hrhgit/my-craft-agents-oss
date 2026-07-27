import type { WorkspaceInfo, WorkspaceLocationInfo } from '@mortise/core/types'
import type { WorkspaceTopologyChangedV1 } from '@mortise/shared/protocol'
import type { ResolvedWorkspaceRoute, WorkspaceRoute } from '../shared/app-layout'

export type WorkspaceTopologyChangeDecision =
  | { status: 'applied'; workspace: WorkspaceInfo; changedLocationIds: string[] }
  | { status: 'ignored'; workspace: WorkspaceInfo }
  | { status: 'resync'; workspaceId: string }

/** Preload-owned redacted topology cache. The host remains the canonical authority. */
export class WorkspaceRuntimeTopologyState {
  private readonly workspaces = new Map<string, WorkspaceInfo>()

  set(workspace: WorkspaceInfo): WorkspaceInfo {
    const snapshot = structuredClone(workspace)
    this.workspaces.set(snapshot.id, snapshot)
    return structuredClone(snapshot)
  }

  get(workspaceId: string): WorkspaceInfo | undefined {
    const workspace = this.workspaces.get(workspaceId)
    return workspace ? structuredClone(workspace) : undefined
  }

  apply(change: WorkspaceTopologyChangedV1): WorkspaceTopologyChangeDecision {
    const current = this.workspaces.get(change.workspaceId)
    if (current && change.revision <= current.revision) {
      return { status: 'ignored', workspace: structuredClone(current) }
    }
    if (!current || current.revision !== change.previousRevision) {
      return { status: 'resync', workspaceId: change.workspaceId }
    }
    const workspace = this.set(change.workspace)
    return { status: 'applied', workspace, changedLocationIds: [...change.changedLocationIds] }
  }

  resolveRoute(route: WorkspaceRoute): ResolvedWorkspaceRoute {
    const workspace = this.workspaces.get(route.workspaceId)
    if (!workspace) throw new Error(`Workspace topology is not loaded: ${route.workspaceId}`)
    const locationId = route.locationId ?? workspace.primaryLocationId
    const location = workspace.locations.find(candidate => candidate.id === locationId)
    if (!location) {
      throw new Error(`Workspace location is not authorized: ${route.workspaceId}::${locationId}`)
    }
    return {
      workspaceId: workspace.id,
      locationId,
      serverId: endpointDisplayId(location),
    }
  }
}

function endpointDisplayId(location: WorkspaceLocationInfo): string {
  return location.endpoint.kind === 'remote' ? location.endpoint.url : 'local'
}
