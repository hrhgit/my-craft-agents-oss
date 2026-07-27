import type { Workspace } from '@mortise/core/types'
import type { WorkspaceLocationRuntimeConfig } from '../shared/workspace-runtime-config'

export interface WorkspaceRemoteCredentialAuthority {
  getWorkspaceRemoteBearer(workspaceId: string, credentialRef: string): Promise<string | null>
  setWorkspaceRemoteBearer(workspaceId: string, credentialRef: string, token: string): Promise<void>
  deleteWorkspaceRemoteBearer(workspaceId: string, credentialRef: string): Promise<boolean>
}

export interface WorkspaceRemoteCredentialInput {
  workspaceId: string
  credentialRef: string
}

export async function setWorkspaceRemoteCredential(
  authority: WorkspaceRemoteCredentialAuthority,
  input: WorkspaceRemoteCredentialInput & { token: string },
): Promise<void> {
  validateCredentialInput(input)
  if (typeof input.token !== 'string' || !input.token || input.token.length > 65_536) {
    throw new Error('A bounded remote Workspace token is required')
  }
  await authority.setWorkspaceRemoteBearer(input.workspaceId, input.credentialRef, input.token)
}

export async function deleteWorkspaceRemoteCredential(
  authority: WorkspaceRemoteCredentialAuthority,
  input: WorkspaceRemoteCredentialInput,
): Promise<void> {
  validateCredentialInput(input)
  await authority.deleteWorkspaceRemoteBearer(input.workspaceId, input.credentialRef)
}

export async function resolveWorkspaceLocationRuntime(
  authority: WorkspaceRemoteCredentialAuthority,
  workspace: Workspace,
  locationId: string,
): Promise<WorkspaceLocationRuntimeConfig> {
  if (typeof locationId !== 'string' || !locationId.trim()) {
    throw new Error('A Workspace location identity is required')
  }
  const location = workspace.locations.find(candidate => candidate.id === locationId)
  if (!location) throw new Error(`Workspace location not found: ${workspace.id}::${locationId}`)
  if (location.endpoint.kind === 'local') {
    return { kind: 'local', workspaceId: workspace.id, locationId }
  }
  const token = await authority.getWorkspaceRemoteBearer(workspace.id, location.endpoint.credentialRef)
  if (!token) {
    throw new Error(`Remote Workspace credential is unavailable for ${workspace.id}::${locationId}`)
  }
  return {
    kind: 'remote',
    workspaceId: workspace.id,
    locationId,
    url: location.endpoint.url,
    remoteWorkspaceId: location.endpoint.remoteWorkspaceId,
    token,
    ...(location.endpoint.allowInsecureTls === undefined
      ? {}
      : { allowInsecureTls: location.endpoint.allowInsecureTls }),
  }
}

function validateCredentialInput(input: WorkspaceRemoteCredentialInput): void {
  if (!input || typeof input !== 'object') throw new Error('Remote Workspace credential input is required')
  if (
    typeof input.workspaceId !== 'string'
    || !input.workspaceId
    || input.workspaceId.trim() !== input.workspaceId
    || input.workspaceId.length > 256
  ) {
    throw new Error('A bounded Workspace identity is required')
  }
  if (
    typeof input.credentialRef !== 'string'
    || !input.credentialRef
    || input.credentialRef.trim() !== input.credentialRef
    || input.credentialRef.length > 256
  ) {
    throw new Error('A bounded remote Workspace credential reference is required')
  }
}
