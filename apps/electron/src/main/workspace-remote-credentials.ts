import { createHash } from 'node:crypto'
import type { Workspace } from '@mortise/core/types'
import type { CredentialId, StoredCredential } from '@mortise/shared/credentials'
import type { WorkspaceLocationRuntimeConfig } from '../shared/workspace-runtime-config'

export interface WorkspaceRemoteCredentialAuthority {
  get(id: CredentialId): Promise<StoredCredential | null>
  set(id: CredentialId, credential: StoredCredential): Promise<void>
  delete(id: CredentialId): Promise<boolean>
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
  await authority.set(credentialId(input.workspaceId, input.credentialRef), { value: input.token })
}

export async function deleteWorkspaceRemoteCredential(
  authority: WorkspaceRemoteCredentialAuthority,
  input: WorkspaceRemoteCredentialInput,
): Promise<void> {
  validateCredentialInput(input)
  await authority.delete(credentialId(input.workspaceId, input.credentialRef))
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
  const credential = await authority.get(credentialId(workspace.id, location.endpoint.credentialRef))
  if (!credential?.value) {
    throw new Error(`Remote Workspace credential is unavailable for ${workspace.id}::${locationId}`)
  }
  return {
    kind: 'remote',
    workspaceId: workspace.id,
    locationId,
    url: location.endpoint.url,
    remoteWorkspaceId: location.endpoint.remoteWorkspaceId,
    token: credential.value,
    ...(location.endpoint.allowInsecureTls === undefined
      ? {}
      : { allowInsecureTls: location.endpoint.allowInsecureTls }),
  }
}

function credentialId(workspaceId: string, credentialRef: string): CredentialId {
  const digest = createHash('sha256').update(credentialRef).digest('hex')
  return { type: 'automation_secret', workspaceId, name: `remote-location-${digest}` }
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
