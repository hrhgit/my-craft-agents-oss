/**
 * Model helper functions used by LLM connection migrations.
 *
 * Pure data transformations — no IO, no side effects.
 */
import type { LlmConnection } from '../llm-connections.ts';
import type { ModelDefinition } from '../models.ts';
import {
  getDefaultModelsForConnection,
  toBedrockNativeId,
} from '../llm-connections.ts';
import {
  getModelDisplayName,
  normalizeDeprecatedModelId,
} from '../models.ts';

// Opus model IDs used during migration.
// Pi 0.73.1 does not yet expose Opus 4.8 — keep 4.7 as the selectable fallback
// until the upstream catalog adds 4.8; the preferred-default list is already future-proofed.
export const OPUS_DEFAULT_ID = 'claude-opus-4-8';
export const OPUS_FALLBACK_ID = 'claude-opus-4-7';

/** Extract string IDs from a mixed model list. */
export function normalizeModelIds(models?: Array<{ id: string } | string>): string[] {
  if (!models) return [];
  return models
    .map(m => typeof m === 'string' ? m : m.id)
    .filter((id): id is string => !!id && id.trim().length > 0);
}

/** Set-equality comparison on model ID arrays. */
export function modelSetEquals(a: string[], b: string[]): boolean {
  const as = new Set(a);
  const bs = new Set(b);
  if (as.size !== bs.size) return false;
  for (const id of as) {
    if (!bs.has(id)) return false;
  }
  return true;
}

/** Returns the set of default model IDs for a connection's provider. */
export function defaultModelIdsForConnection(connection: LlmConnection): Set<string> {
  return new Set(
    getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider)
      .map(model => typeof model === 'string' ? model : model.id),
  );
}

/**
 * Normalize a model ID for a connection.
 * Handles Bedrock native IDs, `pi/` prefixing, and Opus 4.8→4.7 fallback
 * when Pi catalog lacks 4.8.
 */
export function normalizeConnectionModelId(connection: LlmConnection, modelId: string): string {
  const normalized = normalizeDeprecatedModelId(modelId);

  // Bedrock connections run through Pi and need native inference-profile IDs.
  if (connection.providerType === 'pi' && connection.piAuthProvider === 'amazon-bedrock') {
    const hasPiPrefix = normalized.startsWith('pi/');
    const bare = hasPiPrefix ? normalized.slice(3) : normalized;
    const native = toBedrockNativeId(bare);
    const defaults = defaultModelIdsForConnection(connection);
    const prefixedCandidate = `pi/${native}`;
    const candidate = hasPiPrefix || defaults.has(prefixedCandidate) ? prefixedCandidate : native;

    if (bare === OPUS_DEFAULT_ID || native.endsWith(`.${OPUS_DEFAULT_ID}`)) {
      const fallbackNative = toBedrockNativeId(OPUS_FALLBACK_ID);
      const prefixedFallback = `pi/${fallbackNative}`;
      const fallback = defaults.has(prefixedFallback) ? prefixedFallback : fallbackNative;
      if (!defaults.has(candidate) && defaults.has(fallback)) return fallback;
    }
    return candidate;
  }

  if (connection.providerType === 'pi') {
    const defaults = defaultModelIdsForConnection(connection);
    const hasPiPrefix = normalized.startsWith('pi/');
    const bare = hasPiPrefix ? normalized.slice(3) : normalized;
    const prefixedCandidate = `pi/${bare}`;
    const candidate = hasPiPrefix || defaults.has(prefixedCandidate) ? prefixedCandidate : normalized;
    const prefixedFallback = `pi/${OPUS_FALLBACK_ID}`;
    const fallback = defaults.has(prefixedFallback) ? prefixedFallback : OPUS_FALLBACK_ID;
    if ((bare === OPUS_DEFAULT_ID)
      && !defaults.has(candidate)
      && defaults.has(fallback)) {
      return fallback;
    }
    if (bare === OPUS_DEFAULT_ID && candidate !== normalized) {
      return candidate;
    }
  }

  return normalized;
}

/** Looks up a model's display name from Pi defaults, falling back to getModelDisplayName. */
export function displayNameForMigratedModel(connection: LlmConnection, modelId: string): string {
  const piModel = getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider)
    .find(model => typeof model !== 'string' && model.id === modelId);
  if (piModel && typeof piModel !== 'string') return piModel.name;
  const bareModelId = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  return getModelDisplayName(bareModelId);
}
