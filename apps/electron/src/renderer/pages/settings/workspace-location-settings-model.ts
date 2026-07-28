import type { WorkspaceInfo, WorkspaceLocationInfo } from '@mortise/core/types'
import type { WorkspaceTopologyCommandV1 } from '../../../shared/types'

export type WorkspaceLocationAction = 'rename' | 'replace' | 'set-primary' | 'detach'

export interface WorkspaceLocationSettingsRow {
  id: string
  name: string
  kind: WorkspaceLocationInfo['endpoint']['kind']
  endpointLabel: string
  role: 'primary' | 'attached'
  availability: 'unreported'
  semanticId: string
  actionSemanticIds: Record<WorkspaceLocationAction, string>
}

export const WORKSPACE_LOCATION_SEMANTIC_IDS = {
  section: 'settings.workspace.locations',
  addLocal: 'settings.workspace.locations.add-local',
  addRemote: 'settings.workspace.locations.add-remote',
  localName: 'settings.workspace.location.local.name',
  localBrowse: 'settings.workspace.location.local.browse',
  localSubmit: 'settings.workspace.location.local.submit',
  remoteName: 'settings.workspace.location.remote.name',
  remoteUrl: 'settings.workspace.location.remote.url',
  remoteToken: 'settings.workspace.location.remote.token',
  remoteWorkspace: 'settings.workspace.location.remote.workspace',
  remoteAllowInsecureTls: 'settings.workspace.location.remote.allow-insecure-tls',
  remoteSubmit: 'settings.workspace.location.remote.submit',
  renameName: 'settings.workspace.location.rename.name',
  renameSubmit: 'settings.workspace.location.rename.submit',
  replaceLocal: 'settings.workspace.location.replace.local',
  replaceRemote: 'settings.workspace.location.replace.remote',
  confirmCancel: 'settings.workspace.location.confirm.cancel',
  confirmSubmit: 'settings.workspace.location.confirm.submit',
} as const

function locationSemanticPart(locationId: string): string {
  return encodeURIComponent(locationId)
}

export function workspaceLocationActionSemanticId(
  locationId: string,
  action: WorkspaceLocationAction,
): string {
  return `settings.workspace.location.${locationSemanticPart(locationId)}.${action}`
}

export function buildWorkspaceLocationSettingsRows(
  workspace: WorkspaceInfo,
): WorkspaceLocationSettingsRow[] {
  return workspace.locations.map((location) => ({
    id: location.id,
    name: location.name,
    kind: location.endpoint.kind,
    endpointLabel: location.endpoint.kind === 'local'
      ? 'Local endpoint'
      : `${location.endpoint.url} / ${location.endpoint.remoteWorkspaceId}`,
    role: workspace.primaryLocationId === location.id ? 'primary' : 'attached',
    // Workspace V2 intentionally does not project runtime availability yet.
    availability: 'unreported',
    semanticId: `settings.workspace.location.${locationSemanticPart(location.id)}`,
    actionSemanticIds: {
      rename: workspaceLocationActionSemanticId(location.id, 'rename'),
      replace: workspaceLocationActionSemanticId(location.id, 'replace'),
      'set-primary': workspaceLocationActionSemanticId(location.id, 'set-primary'),
      detach: workspaceLocationActionSemanticId(location.id, 'detach'),
    },
  }))
}

export function isWorkspaceLocationNameAvailable(
  workspace: WorkspaceInfo,
  name: string,
  excludingLocationId?: string,
): boolean {
  const normalized = name.trim().toLocaleLowerCase('en-US')
  if (!normalized) return false
  return !workspace.locations.some(location => (
    location.id !== excludingLocationId
    && location.name.toLocaleLowerCase('en-US') === normalized
  ))
}

export function createWorkspaceLocationId(operationId: string): string {
  return `location_${operationId.replace(/[^A-Za-z0-9_-]/g, '')}`
}

export function createWorkspaceRemoteCredentialRef(operationId: string): string {
  return `workspace_remote_${operationId.replace(/[^A-Za-z0-9_-]/g, '')}`
}

/** Conservative proof that deleting a just-written credential would be unsafe. */
export function hasProjectedRemoteWorkspaceLocation(
  workspace: WorkspaceInfo,
  locationId: string,
  remoteWorkspaceId: string,
): boolean {
  const location = workspace.locations.find(candidate => candidate.id === locationId)
  return location?.endpoint.kind === 'remote'
    && location.endpoint.remoteWorkspaceId === remoteWorkspaceId
}

type CommandInput =
  | { operation: 'attach-local'; locationId: string; name: string; rootPath: string }
  | { operation: 'attach-remote'; locationId: string; name: string; url: string; remoteWorkspaceId: string; credentialRef: string; allowInsecureTls?: boolean }
  | { operation: 'detach'; locationId: string }
  | { operation: 'replace-endpoint'; locationId: string; endpoint: Extract<WorkspaceTopologyCommandV1, { operation: 'replace-endpoint' }>['endpoint'] }
  | { operation: 'set-primary'; locationId: string }
  | { operation: 'rename'; locationId: string; name: string }

export function createWorkspaceTopologyCommand(
  workspace: Pick<WorkspaceInfo, 'id' | 'revision'>,
  operationId: string,
  input: CommandInput,
): WorkspaceTopologyCommandV1 {
  return {
    schemaVersion: 1,
    workspaceId: workspace.id,
    operationId,
    expectedRevision: workspace.revision,
    ...input,
  } as WorkspaceTopologyCommandV1
}

export function workspaceLocationConsequence(
  action: Extract<WorkspaceLocationAction, 'replace' | 'set-primary' | 'detach'>,
): string {
  if (action === 'set-primary') {
    return 'Changing the primary location interrupts all running, queued, waiting, and resumable work in this Workspace. Interrupted work will not resume automatically.'
  }
  if (action === 'replace') {
    return 'Replacing this endpoint interrupts work that may still use this location. Unrelated work remains running, and interrupted work will not resume automatically.'
  }
  return 'Removing this location interrupts work that may still use it. Unrelated work remains running, and interrupted work will not resume automatically.'
}
