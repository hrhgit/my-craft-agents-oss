/**
 * Migrate deprecated Opus 4.5/4.6 IDs to the current default Opus model.
 *
 * Custom/compat endpoints are intentionally skipped because provider-specific aliases may differ.
 */
import type { StoredConfig } from '../storage.ts';
import type { LlmConnection } from '../llm-connections.ts';
import type { ModelDefinition } from '../models.ts';
import { normalizeDeprecatedModelId } from '../models.ts';
import { loadWorkspaceConfig, saveWorkspaceConfig } from '../../workspaces/storage.ts';
import {
  OPUS_DEFAULT_ID,
  OPUS_FALLBACK_ID,
  normalizeConnectionModelId,
  displayNameForMigratedModel,
} from './model-helpers.ts';

/** Returns an updated model entry with a new ID; refreshes display name for Opus 4.5/4.6 entries. */
function withUpdatedModelEntry(
  _connection: LlmConnection,
  entry: ModelDefinition | string,
  nextId: string,
): ModelDefinition | string {
  if (typeof entry === 'string') {
    return nextId;
  }

  const nextEntry: ModelDefinition = { ...entry, id: nextId };
  if (nextEntry.name && /Opus 4\.[56]/.test(nextEntry.name)) {
    nextEntry.name = displayNameForMigratedModel(_connection, nextId);
  }
  return nextEntry;
}

/** Returns the model entry for the default Opus ID. */
function modelEntryForDefault(_connection: LlmConnection, modelId: string): ModelDefinition | string {
  return modelId;
}

/**
 * Migrate deprecated Opus 4.5/4.6 IDs to the current default Opus model.
 * Custom/compat endpoints are intentionally skipped because provider-specific aliases may differ.
 */
export function migrateLegacyOpusToDefaultOpus(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;

  let changed = false;

  for (const connection of config.llmConnections) {
    const providerStr = connection.providerType as string;
    if (providerStr !== 'pi') continue;

    if (connection.defaultModel) {
      let normalizedDefault = normalizeConnectionModelId(connection, connection.defaultModel);
      if (normalizedDefault !== connection.defaultModel) {
        connection.defaultModel = normalizedDefault;
        changed = true;
      }
    }

    if (connection.models && Array.isArray(connection.models)) {
      const nextModels: Array<ModelDefinition | string> = [];
      const seen = new Set<string>();
      let connectionModelsChanged = false;

      for (const entry of connection.models) {
        const currentId = typeof entry === 'string' ? entry : entry.id;
        const nextId = normalizeConnectionModelId(connection, currentId);

        if (seen.has(nextId)) {
          connectionModelsChanged = true;
          continue;
        }
        seen.add(nextId);

        if (nextId !== currentId) {
          nextModels.push(withUpdatedModelEntry(connection, entry, nextId));
          connectionModelsChanged = true;
        } else {
          nextModels.push(entry);
        }
      }

      if (connection.defaultModel && !seen.has(connection.defaultModel)) {
        nextModels.unshift(modelEntryForDefault(connection, connection.defaultModel));
        connectionModelsChanged = true;
      }

      if (connectionModelsChanged) {
        connection.models = nextModels;
        changed = true;
      }
    }
  }

  return changed;
}

/** Migrate deprecated/previous Opus defaults in workspace default models to the current default Opus model. */
export function migrateWorkspaceLegacyOpusToDefaultOpus(config: StoredConfig): void {
  if (!config.workspaces) return;

  for (const workspace of config.workspaces) {
    const wsConfig = loadWorkspaceConfig(workspace.rootPath);
    if (!wsConfig?.defaults?.model) continue;

    const normalized = normalizeDeprecatedModelId(wsConfig.defaults.model);
    const nextModel = normalized === OPUS_FALLBACK_ID ? OPUS_DEFAULT_ID : normalized;
    if (nextModel !== wsConfig.defaults.model) {
      wsConfig.defaults.model = nextModel;
      saveWorkspaceConfig(workspace.rootPath, wsConfig);
    }
  }
}
