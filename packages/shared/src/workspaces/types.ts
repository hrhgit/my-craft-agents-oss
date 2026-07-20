/**
 * Workspace Types
 *
 * Workspaces are the top-level organizational unit. Sessions are stored at
 * ~/.pi/agent/sessions/.
 *
 * Directory structure:
 * ~/.mortise/workspaces/{slug}/
 *   ├── config.json      - Workspace settings
 */

import type { PermissionMode } from '../agent/mode-manager.ts';

/**
 * Workspace configuration (stored in config.json)
 */
export interface WorkspaceConfig {
  id: string;
  name: string;
  slug: string; // Folder name (URL-safe)

  /**
   * Default settings for new sessions in this workspace
   */
  defaults?: {
    permissionMode?: PermissionMode; // Default permission mode ('safe', 'ask', 'allow-all')
    cyclablePermissionModes?: PermissionMode[]; // Which modes can be cycled with SHIFT+TAB (min 2, default: all 3)
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
