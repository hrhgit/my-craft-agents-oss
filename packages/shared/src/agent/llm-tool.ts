/**
 * LLM Query Types & Helpers (shared)
 *
 * call_llm 工具已移除（双方均不保留，pi 不再提供 call_llm 扩展）。
 *
 * 本文件保留 queryLlm / runMiniCompletion 流程所依赖的共享类型与超时辅助函数。
 */

// ============================================================================
// QUERY INTERFACES (used by agent backends to implement queryLlm)
// ============================================================================

/**
 * Request passed to the agent-native queryFn callback.
 * The prompt includes serialized file content (attachments are pre-processed by the tool).
 */
export interface LLMQueryRequest {
  /** Full prompt including serialized file content */
  prompt: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Model to use (validated against registry) */
  model?: string;
  /** Max output tokens */
  maxTokens?: number;
  /** Sampling temperature 0-1 */
  temperature?: number;
  /** Structured output JSON schema — backends handle natively when possible */
  outputSchema?: Record<string, unknown>;
}

/**
 * Result from an agent-native queryFn callback.
 */
export interface LLMQueryResult {
  text: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Non-fatal warning attached to a partially-successful result (e.g. SDK stopped at max_turns). */
  warning?: string;
}

/**
 * Unified timeout for secondary LLM calls (mini-completion flows).
 * Keep this consistent across backends to avoid model-specific timeout behavior.
 */
export const LLM_QUERY_TIMEOUT_MS = 120000;

// ============================================================================
// UTILITY: TIMEOUT HELPER
// Races a promise against a timeout, cleaning up the timer on completion
// ============================================================================

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer!));
}
