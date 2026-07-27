import type { WorkspaceInfo, WorkspaceLocationInfo } from '@mortise/core/types'
import type { WorkspaceTopologyCommandV1, WorkspaceTopologyResultV1 } from '../../../shared/types'

export type RemoteWorkspaceLocationInfo = WorkspaceLocationInfo & {
  endpoint: Extract<WorkspaceLocationInfo['endpoint'], { kind: 'remote' }>
}

export interface WorkspaceRemoteReconnectApi {
  getWorkspaceTopology(workspaceId?: string): Promise<WorkspaceInfo>
  workspaceTopologyCommand(command: WorkspaceTopologyCommandV1): Promise<WorkspaceTopologyResultV1>
  setWorkspaceRemoteCredential(input: {
    workspaceId: string
    credentialRef: string
    token: string
  }): Promise<void>
  deleteWorkspaceRemoteCredential(input: {
    workspaceId: string
    credentialRef: string
  }): Promise<void>
}

export interface WorkspaceRemoteReconnectInput {
  workspaceId: string
  locationId: string
  url: string
  token: string
  allowInsecureTls?: boolean
}

export function getPrimaryRemoteLocation(
  workspace: WorkspaceInfo,
): RemoteWorkspaceLocationInfo | null {
  const primary = workspace.locations.find(
    location => location.id === workspace.primaryLocationId,
  )
  return primary?.endpoint.kind === 'remote'
    ? primary as RemoteWorkspaceLocationInfo
    : null
}

export async function reconnectWorkspaceRemoteLocation(
  api: WorkspaceRemoteReconnectApi,
  input: WorkspaceRemoteReconnectInput,
  createOperationId: () => string = () => crypto.randomUUID(),
): Promise<WorkspaceInfo> {
  const current = await api.getWorkspaceTopology(input.workspaceId)
  const location = current.locations.find(candidate => candidate.id === input.locationId)
  if (!location || location.endpoint.kind !== 'remote') {
    throw new Error('The Workspace remote location is no longer available')
  }

  const operationId = createOperationId()
  const credentialRef = `workspace_remote_${operationId.replace(/[^A-Za-z0-9_-]/g, '')}`
  const endpoint = {
    kind: 'remote' as const,
    url: input.url,
    remoteWorkspaceId: location.endpoint.remoteWorkspaceId,
    credentialRef,
    ...(input.allowInsecureTls ? { allowInsecureTls: true } : {}),
  }

  await api.setWorkspaceRemoteCredential({
    workspaceId: current.id,
    credentialRef,
    token: input.token,
  })

  try {
    const result = await api.workspaceTopologyCommand({
      schemaVersion: 1,
      operation: 'replace-endpoint',
      workspaceId: current.id,
      operationId,
      expectedRevision: current.revision,
      locationId: location.id,
      endpoint,
    })
    return result.workspace
  } catch (error) {
    let preserveCredential = false
    try {
      const authoritative = await api.getWorkspaceTopology(current.id)
      const projected = authoritative.locations.find(candidate => candidate.id === location.id)
      preserveCredential = projected?.endpoint.kind === 'remote'
        && projected.endpoint.url === endpoint.url
        && projected.endpoint.remoteWorkspaceId === endpoint.remoteWorkspaceId
        && projected.endpoint.allowInsecureTls === endpoint.allowInsecureTls
    } catch {
      // If the authority cannot be read, deleting may break a command that committed
      // before its response was lost.
      preserveCredential = true
    }

    if (!preserveCredential) {
      try {
        await api.deleteWorkspaceRemoteCredential({
          workspaceId: current.id,
          credentialRef,
        })
      } catch {
        // Credential cleanup is best-effort; retain the topology failure.
      }
    }
    throw error
  }
}
