/**
 * Migrate modelDefaults onto connection.defaultModel, then delete modelDefaults.
 */
import type { StoredConfig } from '../storage.ts';
import type { LlmConnection } from '../llm-connections.ts';

/**
 * Migrate modelDefaults onto connection.defaultModel, then delete modelDefaults.
 * If user had set modelDefaults.openai, apply it to the default openai connection.
 * Then remove modelDefaults from config.
 */
export function migrateModelDefaultsToConnections(config: StoredConfig): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAny = config as any;
  if (!configAny.modelDefaults || !config.llmConnections) return false;
  let changed = false;

  // Apply openai model default to the default openai connection.
  // After migrateCodexCopilotToPi runs first, OpenAI connections become
  // providerType='pi' with piAuthProvider='openai'. Also accept legacy
  // 'openai'/'openai_compat' providerType for pre-migration configs.
  if (configAny.modelDefaults.openai) {
    const defaultSlug = config.defaultLlmConnection;
    const isOpenai = (c: LlmConnection) =>
      (c.providerType === 'pi' && c.piAuthProvider === 'openai') ||
      (c.providerType as string) === 'openai' ||
      (c.providerType as string) === 'openai_compat';
    const openaiConn = config.llmConnections.find(c => c.slug === defaultSlug && isOpenai(c))
      || config.llmConnections.find(isOpenai);
    if (openaiConn) {
      openaiConn.defaultModel = configAny.modelDefaults.openai;
      changed = true;
    }
  }

  // Delete modelDefaults
  delete configAny.modelDefaults;
  changed = true;

  return changed;
}
