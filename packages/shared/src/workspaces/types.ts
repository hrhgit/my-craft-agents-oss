/**
 * Workspace Types
 *
 * Workspaces are the top-level organizational unit. Sessions are stored at
 * ~/.mortise/agent/sessions/.
 *
 * Workspace configuration is stored in ~/.mortise/state.sqlite. Workspace
 * folders contain user-owned project data, not a mirrored configuration file.
 */

/**
 * Workspace configuration (stored in state.sqlite)
 */
export interface WorkspaceConfig {
  id: string;
  name: string;
  slug: string; // Folder name (URL-safe)

  /**
   * Workspace-specific presentation settings.
   */
  defaults?: {
    colorTheme?: string; // Color theme override for this workspace (preset ID). Undefined = inherit from app default.
  };

  createdAt: number;
  updatedAt: number;
}

/**
 * Workspace creation input
 */
export interface CreateWorkspaceInput {
  name: string;
  defaults?: WorkspaceConfig['defaults'];
}

/**
 * Loaded workspace with resolved session state
 */
export interface LoadedWorkspace {
  config: WorkspaceConfig;
  sessionCount: number; // Number of sessions
}

/**
 * Workspace summary for listing (lightweight)
 */
export interface WorkspaceSummary {
  slug: string;
  name: string;
  sessionCount: number;
  createdAt: number;
  updatedAt: number;
}
