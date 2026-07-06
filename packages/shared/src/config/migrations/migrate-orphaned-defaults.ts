/**
 * Fix defaultLlmConnection references that point to non-existent connections.
 *
 * This can happen when a connection is removed or was never created
 * (e.g. "anthropic-api" is set as default but only "claude-max" exists).
 *
 * Fixes both the global defaultLlmConnection and per-workspace defaults.
 * Called on app startup alongside other migrations.
 */
import type { StoredConfig } from '../storage.ts';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../../workspaces/storage.ts';
// Runtime imports from storage.ts — safe circular dep (calls are inside function bodies)
import { loadStoredConfig, saveConfig, getWorkspaces } from '../storage.ts';
import { readPiCraftLlmConnections } from '../pi-global-config.ts';

export function migrateOrphanedDefaultConnections(): void {
  const config = loadStoredConfig();
  if (!config) return;

  let changed = false;
  const connections = readPiCraftLlmConnections();
  const validSlugs = new Set(connections.map(c => c.slug));

  // Fix global default if it points to a non-existent connection
  if (config.defaultLlmConnection && !validSlugs.has(config.defaultLlmConnection)) {
    if (connections[0]) {
      config.defaultLlmConnection = connections[0].slug;
    } else {
      delete config.defaultLlmConnection;
    }
    changed = true;
  } else if (!config.defaultLlmConnection && connections[0]) {
    config.defaultLlmConnection = connections[0].slug;
    changed = true;
  }

  // Fix workspace defaults that point to non-existent connections
  try {
    const workspaces = getWorkspaces();
    for (const ws of workspaces) {
      const wsConfig = loadWorkspaceConfig(ws.rootPath);
      if (wsConfig?.defaults?.defaultLlmConnection) {
        if (!validSlugs.has(wsConfig.defaults.defaultLlmConnection)) {
          delete wsConfig.defaults.defaultLlmConnection;
          saveWorkspaceConfig(ws.rootPath, wsConfig);
        }
      }
    }
  } catch (error) {
    console.error('Failed to clean up workspace default connection references:', error);
  }

  if (changed) {
    saveConfig(config);
  }
}
