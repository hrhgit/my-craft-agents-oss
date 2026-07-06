/**
 * Backfill models and defaultModel on ALL connections.
 *
 * Ensures built-in connections (anthropic, openai) always have models populated,
 * not just compat connections.
 */
import type { StoredConfig } from '../storage.ts';
import type { LlmConnection } from '../llm-connections.ts';
import {
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
  isPiProvider,
} from '../llm-connections.ts';
import { debug } from '../../utils/debug.ts';
import {
  normalizeModelIds,
  modelSetEquals,
} from './model-helpers.ts';
import {
  shouldRepairPiApiKeyCodexProvider,
  shouldMigratePiOpenAiProvider,
  inferModelSelectionMode,
} from './predicates.ts';

/**
 * Backfill models and defaultModel on ALL connections.
 * Ensures built-in connections (anthropic, openai) always have models populated,
 * not just compat connections.
 */
export function backfillAllConnectionModels(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;
  let changed = false;
  for (const connection of config.llmConnections) {
    // Repair previously broken API-key migration first.
    if (shouldRepairPiApiKeyCodexProvider(connection)) {
      connection.piAuthProvider = 'openai';
      changed = true;
    }

    // Migrate only legacy OAuth-backed Pi OpenAI connections to ChatGPT backend provider key.
    if (shouldMigratePiOpenAiProvider(connection)) {
      connection.piAuthProvider = 'openai-codex';
      changed = true;
    }

    const defaultModels = getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider);
    const defaultModel = getDefaultModelForConnection(connection.providerType, connection.piAuthProvider);
    const providerDefaultModelIds = normalizeModelIds(defaultModels as Array<{ id: string } | string>);

    // Note: bedrock connections are migrated to pi + amazon-bedrock by migrateLegacyProviderTypes()
    // before this function runs, so no bedrock-specific normalization needed here.

    if (isPiProvider(connection.providerType) && connection.piAuthProvider) {
      // Copilot models are always server-managed (GitHub policy controls which
      // models are enabled), so force automaticallySyncedFromProvider regardless
      // of what inferModelSelectionMode would compute from stale static SDK data.
      const isCopilot = connection.piAuthProvider === 'github-copilot';
      const mode = isCopilot
        ? 'automaticallySyncedFromProvider' as const
        : (connection.modelSelectionMode ?? inferModelSelectionMode(connection, providerDefaultModelIds));
      if (connection.modelSelectionMode !== mode) {
        debug('[storage] backfill mode inferred', {
          slug: connection.slug,
          piAuthProvider: connection.piAuthProvider,
          from: connection.modelSelectionMode,
          to: mode,
          currentModelCount: normalizeModelIds(connection.models).length,
        });
        connection.modelSelectionMode = mode;
        changed = true;
      }

      if (mode === 'automaticallySyncedFromProvider') {
        const currentIds = normalizeModelIds(connection.models);
        if (providerDefaultModelIds.length > 0 && !modelSetEquals(currentIds, providerDefaultModelIds)) {
          connection.models = defaultModels;
          changed = true;
        }
      } else {
        const currentIds = normalizeModelIds(connection.models);
        if (providerDefaultModelIds.length > 0) {
          const allowedIds = new Set(providerDefaultModelIds);
          const canonicalCurrentIds = currentIds.map((id) => {
            if (allowedIds.has(id)) return id;
            if (!id.startsWith('pi/')) {
              const prefixed = `pi/${id}`;
              if (allowedIds.has(prefixed)) return prefixed;
            }
            return id;
          });
          const filtered = canonicalCurrentIds.filter(id => allowedIds.has(id));

          if (!modelSetEquals(canonicalCurrentIds, currentIds) || filtered.length !== currentIds.length) {
            debug('[storage] backfill userDefined filtered', {
              slug: connection.slug,
              piAuthProvider: connection.piAuthProvider,
              beforeCount: currentIds.length,
              canonicalCount: canonicalCurrentIds.length,
              afterCount: filtered.length,
              beforeFirst5: currentIds.slice(0, 5),
              afterFirst5: filtered.slice(0, 5),
            });
            connection.models = filtered;
            changed = true;
          }

          if (filtered.length === 0) {
            debug('[storage] backfill userDefined fallback-to-defaults', {
              slug: connection.slug,
              piAuthProvider: connection.piAuthProvider,
              defaultCount: providerDefaultModelIds.length,
            });
            connection.models = defaultModels;
            changed = true;
          }
        }
      }
    }

    if (defaultModels.length > 0 && (!connection.models || (Array.isArray(connection.models) && connection.models.length === 0))) {
      connection.models = defaultModels;
      changed = true;
    }

    if (!connection.defaultModel && defaultModel) {
      connection.defaultModel = defaultModel;
      changed = true;
    }

    // Validate that existing defaultModel is in the models list
    if (connection.defaultModel && connection.models && Array.isArray(connection.models) && connection.models.length > 0) {
      const modelIds = connection.models.map(m => typeof m === 'string' ? m : m.id);
      if (!modelIds.includes(connection.defaultModel)) {
        // Reset to first available model in the list
        const firstModelId = modelIds[0];
        if (firstModelId) {
          connection.defaultModel = firstModelId;
        }
        changed = true;
      }
    }
  }
  return changed;
}
