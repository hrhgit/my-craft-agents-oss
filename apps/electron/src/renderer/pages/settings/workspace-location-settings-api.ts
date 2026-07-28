import type { ElectronAPI } from '../../../shared/types'
import type {
  WorkspaceInfo,
  WorkspaceTopologyChangedV1,
  WorkspaceTopologyCommandV1,
  WorkspaceTopologyResultV1,
} from '../../../shared/types'

export interface WorkspaceRemoteCredentialInput {
  workspaceId: string
  credentialRef: string
  token: string
}

export interface WorkspaceLocationSettingsApi {
  getWorkspaceTopology(workspaceId?: string): Promise<WorkspaceInfo | null>
  workspaceTopologyCommand(command: WorkspaceTopologyCommandV1): Promise<WorkspaceTopologyResultV1>
  onWorkspaceTopologyChanged(callback: (change: WorkspaceTopologyChangedV1) => void): () => void
  setWorkspaceRemoteCredential(input: WorkspaceRemoteCredentialInput): Promise<void>
  deleteWorkspaceRemoteCredential(input: Omit<WorkspaceRemoteCredentialInput, 'token'>): Promise<void>
}

type PendingWorkspaceLocationElectronApi = ElectronAPI & Partial<WorkspaceLocationSettingsApi>

export function resolveWorkspaceLocationSettingsApi(
  electronApi: ElectronAPI,
): WorkspaceLocationSettingsApi | null {
  const candidate = electronApi as PendingWorkspaceLocationElectronApi
  if (
    typeof candidate.getWorkspaceTopology !== 'function'
    || typeof candidate.workspaceTopologyCommand !== 'function'
    || typeof candidate.onWorkspaceTopologyChanged !== 'function'
    || typeof candidate.setWorkspaceRemoteCredential !== 'function'
    || typeof candidate.deleteWorkspaceRemoteCredential !== 'function'
  ) return null

  return {
    getWorkspaceTopology: candidate.getWorkspaceTopology.bind(candidate),
    workspaceTopologyCommand: candidate.workspaceTopologyCommand.bind(candidate),
    onWorkspaceTopologyChanged: candidate.onWorkspaceTopologyChanged.bind(candidate),
    setWorkspaceRemoteCredential: candidate.setWorkspaceRemoteCredential.bind(candidate),
    deleteWorkspaceRemoteCredential: candidate.deleteWorkspaceRemoteCredential.bind(candidate),
  }
}
