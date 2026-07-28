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
    workspaceId: workspace.id,
    locationId: location.id,
  }
}

/**
 * FlexLayout still carries endpoint display metadata while its persisted
 * content references use only Workspace and location identity.
 */
export function getPrimaryWorkspaceServerId(workspace: WorkspaceInfo): string {
  const endpoint = getPrimaryWorkspaceLocationInfo(workspace).endpoint
  return endpoint.kind === 'remote' ? endpoint.url : 'local'
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
