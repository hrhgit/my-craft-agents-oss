/**
 * Migrate legacy provider types to the active set (pi, pi_compat).
 */
import type { StoredConfig } from '../storage.ts';
import type { LlmProviderType } from '../llm-connections.ts';
import { toBedrockNativeId } from '../llm-connections.ts';
import { normalizeDeprecatedModelId } from '../models.ts';

/** Normalize a pi/-prefixed model ID for Bedrock: pi/claude-opus-4-8 → pi/us.anthropic.claude-opus-4-8 */
function normalizePiBedrockId(id: string): string {
  const bare = id.startsWith('pi/') ? id.slice(3) : id;
  const native = toBedrockNativeId(normalizeDeprecatedModelId(bare));
  return `pi/${native}`;
}

/**
 * Migrate legacy provider types to the active set (pi, pi_compat).
 *
 * 1. providerType==='bedrock' → 'pi' with piAuthProvider='amazon-bedrock'.
 *    Model IDs are normalized to Bedrock-native (pi-prefixed) for Pi SDK resolution.
 *
 * 2. providerType==='vertex' → 'pi' with piAuthProvider='google-vertex'.
 *
 * 3. providerType==='anthropic_compat' → 'pi_compat' with customEndpoint.api='anthropic-messages'.
 *    Preserves baseUrl and models; authType 'api_key_with_endpoint' stays the same.
 *
 * Also normalizes Pi+Bedrock connections that already have correct providerType.
 */
export function migrateLegacyProviderTypes(config: StoredConfig): boolean {
  if (!config.llmConnections) return false;

  let changed = false;

  for (const connection of config.llmConnections) {
    // Cast to string for legacy values removed from LlmProviderType
    const providerStr = connection.providerType as string;

    // --- bedrock → pi + amazon-bedrock ---
    if (providerStr === 'bedrock') {
      (connection as { providerType: LlmProviderType }).providerType = 'pi';
      connection.piAuthProvider = connection.piAuthProvider || 'amazon-bedrock';
      // Normalize model IDs to Bedrock-native (pi-prefixed) for Pi SDK
      if (connection.defaultModel) {
        connection.defaultModel = normalizePiBedrockId(connection.defaultModel);
      }
      if (connection.models && Array.isArray(connection.models)) {
        for (let i = 0; i < connection.models.length; i++) {
          const model = connection.models[i];
          if (typeof model === 'string') {
            connection.models[i] = normalizePiBedrockId(model);
          } else if (model && typeof model === 'object') {
            model.id = normalizePiBedrockId(model.id);
          }
        }
      }
      changed = true;
      continue;
    }

    // --- vertex → pi + google-vertex ---
    if (providerStr === 'vertex') {
      (connection as { providerType: LlmProviderType }).providerType = 'pi';
      connection.piAuthProvider = 'google-vertex';
      changed = true;
      continue;
    }

    // --- anthropic_compat → pi_compat + customEndpoint ---
    if (providerStr === 'anthropic_compat') {
      (connection as { providerType: LlmProviderType }).providerType = 'pi_compat';
      connection.customEndpoint = { api: 'anthropic-messages' };
      // authType 'api_key_with_endpoint' stays; baseUrl and models are preserved
      changed = true;
      continue;
    }

    // Forward: Pi+Bedrock connections need Bedrock-native IDs (pi-prefixed) for Pi SDK resolution
    if (connection.providerType === 'pi' && connection.piAuthProvider === 'amazon-bedrock') {
      if (connection.defaultModel) {
        const normalized = normalizePiBedrockId(connection.defaultModel);
        if (normalized !== connection.defaultModel) {
          connection.defaultModel = normalized;
          changed = true;
        }
      }
      if (connection.models && Array.isArray(connection.models)) {
        for (let i = 0; i < connection.models.length; i++) {
          const model = connection.models[i];
          if (typeof model === 'string') {
            const normalized = normalizePiBedrockId(model);
            if (normalized !== model) { connection.models[i] = normalized; changed = true; }
          } else if (model && typeof model === 'object') {
            const normalized = normalizePiBedrockId(model.id);
            if (normalized !== model.id) { model.id = normalized; changed = true; }
          }
        }
      }
    }
  }

  return changed;
}
