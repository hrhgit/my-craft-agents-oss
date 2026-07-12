/** Repair global and workspace defaults against the canonical Pi connection list. */
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../../workspaces/storage.ts';
import {
  getLlmConnections,
  getWorkspaces,
  loadStoredConfig,
  saveConfig,
} from '../storage.ts';

export function repairDefaultLlmConnectionReferences(): void {
  const config = loadStoredConfig();
  if (!config) return;

  const connections = getLlmConnections();
  const validSlugs = new Set(connections.map(connection => connection.slug));
  let configChanged = false;

  if (!config.defaultLlmConnection || !validSlugs.has(config.defaultLlmConnection)) {
    if (connections[0] && config.defaultLlmConnection !== connections[0].slug) {
      config.defaultLlmConnection = connections[0].slug;
      configChanged = true;
    } else if (!connections[0] && config.defaultLlmConnection !== undefined) {
      delete config.defaultLlmConnection;
      configChanged = true;
    }
  }

  for (const workspace of getWorkspaces()) {
    const workspaceConfig = loadWorkspaceConfig(workspace.rootPath);
    const defaults = workspaceConfig?.defaults;
    const workspaceDefault = defaults?.defaultLlmConnection;
    if (!workspaceConfig || !defaults || !workspaceDefault || validSlugs.has(workspaceDefault)) continue;

    delete defaults.defaultLlmConnection;
    saveWorkspaceConfig(workspace.rootPath, workspaceConfig);
  }

  if (configChanged) saveConfig(config);
}
