/**
 * Workspace Module
 *
 * Re-exports types and storage functions for workspaces.
 */

// Types
export type {
  WorkspaceConfig,
  CreateWorkspaceInput,
  LoadedWorkspace,
  WorkspaceSummary,
} from './types.ts';

export {
  getWorkspaceConfigRecordIdentity,
  normalizeWorkspaceRecordNamespace,
  WORKSPACE_CONFIG_RECORD_KEY,
  getWorkspaceTopologyOperationIdentity,
  getWorkspaceTopologyRecordIdentity,
  WORKSPACE_TOPOLOGY_OPERATION_NAMESPACE,
  WORKSPACE_TOPOLOGY_RECORD_KEY,
  WORKSPACE_TOPOLOGY_RECORD_NAMESPACE,
} from './state-contract.ts';

export {
  WorkspaceTopologyError,
  ensureWorkspaceMarker,
  getWorkspaceMarkerPath,
  readWorkspaceMarker,
} from './marker.ts';

export {
  WorkspaceTopologyStore,
  closeWorkspaceTopologyStorage,
  getDefaultWorkspaceTopologyStore,
  type ApplyWorkspaceTopologyResult,
  type LegacyWorkspaceV1,
  type WorkspaceTopologyStoreOptions,
} from './topology-storage.ts';

// Storage functions
export {
  // Path utilities
  getDefaultWorkspacesDir,
  ensureDefaultWorkspacesDir,
  getWorkspacePath,
  getWorkspaceSkillsPath,
  // Session view aggregation
  countSessionsByCwd,
  getWorkspaceSessionsDir,
  // Config operations
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  // Load operations
  loadWorkspace,
  getWorkspaceSummary,
  // Create/Delete operations
  generateSlug,
  generateUniqueWorkspacePath,
  createWorkspaceAtPath,
  deleteWorkspaceFolder,
  isValidWorkspace,
  renameWorkspaceFolder,
  // Auto-discovery
  discoverWorkspacesInDefaultLocation,
  // Constants
  CONFIG_DIR,
  DEFAULT_WORKSPACES_DIR,
} from './storage.ts';
