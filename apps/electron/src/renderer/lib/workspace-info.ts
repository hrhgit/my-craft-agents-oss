import type { WorkspaceInfo, WorkspaceLocationInfo } from '@mortise/core/types'
import type { ResolvedWorkspaceRoute } from '../../shared/app-layout'

export function getPrimaryWorkspaceLocationInfo(workspace: WorkspaceInfo): WorkspaceLocationInfo {
  const location = workspace.locations.find(candidate => candidate.id === workspace.primaryLocationId)
  if (!location) {
    throw new Error(`Workspace ${workspace.id} has no primary location ${workspace.primaryLocationId}`)
  }
  return location
}

export function getPrimaryWorkspaceRoute(workspace: WorkspaceInfo): ResolvedWorkspaceRoute {
  const location = getPrimaryWorkspaceLocationInfo(workspace)
  return {
    serverId: location.endpoint.kind === 'remote' ? location.endpoint.url : 'local',
    workspaceId: workspace.id,
    locationId: location.id,
  }
}

export function getPrimaryRemoteWorkspaceId(workspace: WorkspaceInfo): string | undefined {
  const endpoint = getPrimaryWorkspaceLocationInfo(workspace).endpoint
  return endpoint.kind === 'remote' ? endpoint.remoteWorkspaceId : undefined
}

export function isPrimaryWorkspaceLocal(workspace: WorkspaceInfo): boolean {
  return getPrimaryWorkspaceLocationInfo(workspace).endpoint.kind === 'local'
}

export function isPrimaryWorkspaceRemote(workspace: WorkspaceInfo): boolean {
  return !isPrimaryWorkspaceLocal(workspace)
}
