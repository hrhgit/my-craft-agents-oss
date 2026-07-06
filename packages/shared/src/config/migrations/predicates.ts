/**
 * Predicate functions for LLM connection migrations.
 *
 * Pure predicates — no IO, no side effects.
 */
import type { LlmConnection } from '../llm-connections.ts';
import { isPiProvider } from '../llm-connections.ts';
import { normalizeModelIds, modelSetEquals } from './model-helpers.ts';

/**
 * Legacy cleanup: old ChatGPT Plus OAuth connections may still be tagged as `openai`.
 * Only migrate those to `openai-codex`.
 *
 * IMPORTANT: Do NOT migrate API-key or custom-endpoint connections:
 * - `api_key` / `api_key_with_endpoint` with `openai` must remain regular OpenAI API auth.
 * - forcing them to `openai-codex` routes requests to ChatGPT backend auth and breaks on restart.
 */
export function shouldMigratePiOpenAiProvider(connection: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'authType' | 'baseUrl'>): boolean {
  if (!isPiProvider(connection.providerType)) return false;
  if (connection.piAuthProvider !== 'openai') return false;
  if (connection.authType !== 'oauth') return false;
  if (typeof connection.baseUrl === 'string' && connection.baseUrl.trim().length > 0) return false;
  return true;
}

/**
 * Repair broken state from previous startup migrations:
 * API-key connections tagged as `openai-codex` try ChatGPT backend JWT auth and fail.
 */
export function shouldRepairPiApiKeyCodexProvider(connection: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'authType'>): boolean {
  if (!isPiProvider(connection.providerType)) return false;
  if (connection.piAuthProvider !== 'openai-codex') return false;
  return connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint';
}

/** Infers model selection mode by comparing current models to provider defaults. */
export function inferModelSelectionMode(
  connection: Pick<LlmConnection, 'models'>,
  providerDefaultModelIds: string[],
): 'automaticallySyncedFromProvider' | 'userDefined3Tier' {
  const currentIds = normalizeModelIds(connection.models);
  if (currentIds.length === 0) return 'automaticallySyncedFromProvider';
  return modelSetEquals(currentIds, providerDefaultModelIds)
    ? 'automaticallySyncedFromProvider'
    : 'userDefined3Tier';
}
