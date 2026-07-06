/**
 * Migrate legacy auth config to LLM connections.
 *
 * One-time migration converts:
 * - Legacy authType field → LlmConnection in llmConnections array
 * - Legacy anthropicBaseUrl → LlmConnection.baseUrl
 * - Legacy customModel → LlmConnection.defaultModel
 * - Legacy model → modelDefaults (per provider)
 *
 * Also runs the ongoing startup migration for already-migrated configs:
 * - Codex/Copilot → Pi backend
 * - Anthropic → Pi-backed Anthropic
 * - Opus/Sonnet ID normalization
 * - Model defaults migration
 * - Legacy provider types migration
 */
import type { StoredConfig } from '../storage.ts';
import type { LlmConnection } from '../llm-connections.ts';
import type { ModelDefinition } from '../models.ts';
import type { AuthType } from '@craft-agent/core/types';
import {
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
  isValidProviderAuthCombination,
} from '../llm-connections.ts';
import { getModelProvider } from '../models.ts';
import { normalizeDeprecatedModelId } from '../models.ts';
import { readPiCraftLlmConnections, writePiCraftLlmConnections } from '../pi-global-config.ts';
// Runtime imports from storage.ts — safe circular dep (calls are inside function bodies)
import { loadStoredConfig, saveConfig, ensureDefaultLlmConnection } from '../storage.ts';
import { normalizeModelIds } from './model-helpers.ts';
import { migrateLegacyOpusToDefaultOpus, migrateWorkspaceLegacyOpusToDefaultOpus } from './migrate-opus-models.ts';
import { migrateLegacyProviderTypes } from './migrate-provider-types.ts';
import { migrateModelDefaultsToConnections } from './migrate-model-defaults.ts';
import { backfillAllConnectionModels } from './backfill-connection-models.ts';

/** Legacy top-level fields that existed on StoredConfig before LLM connections. */
type LegacyStoredConfig = StoredConfig & {
  authType?: AuthType;
  anthropicBaseUrl?: string;
  customModel?: string;
  model?: string;
  modelDefaults?: Record<string, string>;
};

/**
 * Migrate Codex (OpenAI) and Copilot connections to Pi backend.
 * Runs on startup — transparently routes existing users through PiAgent.
 *
 * No re-auth needed: credentials are keyed by connection slug (not provider),
 * and PiAgent reads the same OAuth tokens via piAuthProvider.
 *
 * Migration rules:
 * - openai + oauth       → pi + openai-codex
 * - openai + api_key     → pi + openai
 * - openai_compat        → pi + openai  (keep baseUrl)
 * - copilot              → pi + github-copilot
 * - defaultModel reset to Pi's default (stale Codex/Copilot model IDs dropped)
 * - codexPath removed (no longer needed)
 */
export function migrateCodexCopilotToPi(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;
  let changed = false;

  for (const connection of config.llmConnections) {
    // Cast to string for legacy providerType values that were removed from LlmProviderType
    // but may still exist on disk in old configs. Cast to any for legacy codexPath field.
    const providerStr = connection.providerType as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connAny = connection as any;
    if (providerStr === 'openai' && connection.authType === 'oauth') {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'openai-codex';
      connection.name = 'ChatGPT Plus (via Pi)';
      delete connAny.codexPath;
      connection.defaultModel = undefined; // reset — backfill picks Pi default
      connection.models = undefined;
      changed = true;
    } else if (providerStr === 'openai' && (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint')) {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'openai';
      connection.name = 'OpenAI API (via Pi)';
      delete connAny.codexPath;
      connection.defaultModel = undefined;
      connection.models = undefined;
      changed = true;
    } else if (providerStr === 'openai_compat') {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'openai';
      // keep baseUrl for custom endpoints
      delete connAny.codexPath;
      connection.defaultModel = undefined;
      connection.models = undefined;
      changed = true;
    } else if (providerStr === 'copilot') {
      connection.providerType = 'pi';
      connection.piAuthProvider = 'github-copilot';
      connection.name = 'GitHub Copilot (via Pi)';
      delete connAny.codexPath;
      connection.defaultModel = undefined;
      connection.models = undefined;
      changed = true;
    }
  }

  // Clean up openaiVariant config field (Codex-specific A/B testing, no longer relevant)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  if (configAny.openaiVariant) {
    delete configAny.openaiVariant;
    changed = true;
  }

  return changed;
}


/** Merge config.llmConnections into ~/.pi/agent/models.json by slug (dedup), then delete from config. */
function persistMigratedConnectionsToPi(config: StoredConfig): void {
  const mergedBySlug = new Map<string, LlmConnection>();
  for (const connection of readPiCraftLlmConnections()) {
    mergedBySlug.set(connection.slug, connection);
  }
  for (const connection of config.llmConnections ?? []) {
    if (mergedBySlug.has(connection.slug)) continue;
    mergedBySlug.set(connection.slug, connection);
  }
  writePiCraftLlmConnections([...mergedBySlug.values()]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (config as any).llmConnections;
}

/** Delete legacy top-level fields; derive modelDefaults from legacy `model` field if set. */
function cleanupLegacyTopLevelFields(config: LegacyStoredConfig): boolean {
  let changed = false;
  if ('authType' in config) {
    delete config.authType;
    changed = true;
  }
  if ('anthropicBaseUrl' in config) {
    delete config.anthropicBaseUrl;
    changed = true;
  }
  if ('customModel' in config) {
    delete config.customModel;
    changed = true;
  }
  if ('model' in config) {
    const legacyModel = config.model;
    if (legacyModel) {
      const provider = getModelProvider(legacyModel) ?? 'anthropic';
      config.modelDefaults = { ...(config.modelDefaults ?? {}), [provider]: legacyModel };
    }
    delete config.model;
    changed = true;
  }
  return changed;
}

export function migrateLegacyLlmConnectionsConfig(): void {
  const config = loadStoredConfig();
  if (!config) return;

  const configAny = config as LegacyStoredConfig;

  // Already migrated - llmConnections array exists
  if (config.llmConnections !== undefined) {
    // Clean up any remaining legacy fields from previous runs
    let needsSave = cleanupLegacyTopLevelFields(configAny);
    // Note: applyCompatDefaults() is NOT called here for already-migrated configs.
    // Compat connections are user-owned after creation — the app should not
    // silently extend or override the user's model list on every startup.
    // Compat defaults are only applied during fresh connection creation or
    // first-time legacy migration (the config.llmConnections === undefined path below).

    // Phase 1a-bis: Migrate Codex/Copilot connections to Pi backend
    if (migrateCodexCopilotToPi(config)) {
      needsSave = true;
    }
    // Phase 1b: Normalize legacy Opus IDs/defaults before Pi model-list filtering.
    if (migrateLegacyOpusToDefaultOpus(config)) {
      needsSave = true;
    }
    // Phase 1c: Backfill models/defaultModel on ALL connections (not just compat)
    // This ensures Pi provider connections always have models populated
    if (backfillAllConnectionModels(config)) {
      needsSave = true;
    }
    // Phase 1d: Migrate modelDefaults onto connection.defaultModel, then delete modelDefaults
    if (migrateModelDefaultsToConnections(config)) {
      needsSave = true;
    }
    // Phase 1e: Normalize anything introduced by modelDefaults.
    if (migrateLegacyOpusToDefaultOpus(config)) {
      needsSave = true;
    }
    // Phase 1f: Migrate legacy/previous Opus workspace defaults → current default Opus
    migrateWorkspaceLegacyOpusToDefaultOpus(config);
    // Phase 1j: Migrate legacy provider types (bedrock/vertex/anthropic_compat → pi/pi_compat)
    if (migrateLegacyProviderTypes(config)) {
      needsSave = true;
    }
    // Phase 1k: Normalize legacy Opus IDs introduced by provider-type migration.
    // Important for old Bedrock connections: they become Pi+Bedrock first, then can
    // fall back from Opus 4.8 to 4.7 while Pi's catalog lacks 4.8.
    if (migrateLegacyOpusToDefaultOpus(config)) {
      needsSave = true;
    }

    persistMigratedConnectionsToPi(config);
    needsSave = true;

    if (needsSave) {
      saveConfig(config);
    }
    return;
  }

  // Legacy migration: if user had authType set, create a connection for them.
  const legacyAuthType = configAny.authType;
  const legacyBaseUrl = configAny.anthropicBaseUrl;
  const legacyCustomModel = configAny.customModel;
  const legacyModel = configAny.model;

  if (!legacyAuthType) {
    if (cleanupLegacyTopLevelFields(configAny)) {
      saveConfig(config);
    }
    return;
  }

  // Build migrated connections in-memory, then persist them to ~/.pi/agent/models.json.
  config.llmConnections = [];

  if (legacyAuthType) {
    let migrated: LlmConnection | null = null;

    if (legacyAuthType === 'oauth_token') {
      // Legacy Anthropic OAuth → Pi-backed Anthropic OAuth
      migrated = {
        slug: 'pi-anthropic-oauth',
        name: 'Pi (Anthropic OAuth)',
        providerType: 'pi',
        authType: 'oauth',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        models: getDefaultModelsForConnection('pi', 'anthropic'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'codex_oauth') {
      // ChatGPT Plus OAuth → Pi backend
      migrated = {
        slug: 'codex',
        name: 'ChatGPT Plus (via Pi)',
        providerType: 'pi',
        authType: 'oauth',
        piAuthProvider: 'openai-codex',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        models: getDefaultModelsForConnection('pi', 'openai-codex'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'codex_api_key') {
      // OpenAI API Key → Pi backend
      migrated = {
        slug: 'codex-api',
        name: 'OpenAI API (via Pi)',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'openai',
        modelSelectionMode: 'automaticallySyncedFromProvider',
        models: getDefaultModelsForConnection('pi', 'openai'),
        createdAt: Date.now(),
      };
    } else if (legacyAuthType === 'api_key') {
      // Legacy Anthropic API Key - now routes through Pi
      const hasCustomEndpoint = !!legacyBaseUrl;
      if (hasCustomEndpoint) {
        migrated = {
          slug: 'pi-anthropic',
          name: 'Custom Anthropic-Compatible',
          providerType: 'pi_compat',
          authType: 'api_key_with_endpoint',
          piAuthProvider: 'anthropic',
          customEndpoint: { api: 'anthropic-messages' },
          models: getDefaultModelsForConnection('pi_compat'),
          createdAt: Date.now(),
        };
      } else {
        migrated = {
          slug: 'pi-anthropic',
          name: 'Pi (Anthropic)',
          providerType: 'pi',
          authType: 'api_key',
          piAuthProvider: 'anthropic',
          modelSelectionMode: 'automaticallySyncedFromProvider',
          models: getDefaultModelsForConnection('pi', 'anthropic'),
          createdAt: Date.now(),
        };
      }
    }

    if (migrated) {
      // Validate the migrated connection has a valid provider/auth combination
      if (!isValidProviderAuthCombination(migrated.providerType, migrated.authType)) {
        console.warn(
          `[config] Legacy migration created invalid provider/auth combination: ` +
          `providerType=${migrated.providerType}, authType=${migrated.authType} ` +
          `(slug: ${migrated.slug}). Skipping migration for this connection.`
        );
      } else {
        // Apply legacy baseUrl if set
        if (legacyBaseUrl) {
          migrated.baseUrl = legacyBaseUrl;
        }

        // Apply legacy customModel if set
        if (legacyCustomModel) {
          migrated.defaultModel = legacyCustomModel;
        }

        config.llmConnections.push(migrated);
        config.defaultLlmConnection = migrated.slug;
      }
    }
  }

  cleanupLegacyTopLevelFields(configAny);

  // Run the same backfill and migration on newly created connections
  migrateCodexCopilotToPi(config);
  backfillAllConnectionModels(config);
  migrateModelDefaultsToConnections(config);
  migrateLegacyOpusToDefaultOpus(config);
  migrateWorkspaceLegacyOpusToDefaultOpus(config);

  persistMigratedConnectionsToPi(config);
  saveConfig(config);
}
