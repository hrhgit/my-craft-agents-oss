/**
 * Provider Setup Logic
 *
 * Pure functions extracted from ipc.ts for testability.
 * No dependency on ipcMain, sessionManager, credential manager, or file I/O.
 */

import type { ModelDefinition } from '@mortise/shared/config/models'
import {
  type PiCustomApi,
} from '@mortise/shared/config'

// ============================================================
// Error Parsing
// ============================================================

/**
 * Parse an error message from a connection test into a user-friendly string.
 */
export function parseTestConnectionError(msg: string): string {
  const lower = msg.toLowerCase()

  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed')) {
    return 'Cannot connect to API server. Check the URL and ensure the server is running.'
  }
  if (lower.includes('no api key found for')) {
    return 'Provider mismatch during setup. Select a provider preset in Pi API Key mode, or use a compatible custom endpoint.'
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('authentication')) {
    return 'Invalid API key'
  }
  if (lower.includes('404') && lower.includes('model')) {
    return 'Model not found. Check the model name and try again.'
  }
  if (lower.includes('404')) {
    return 'API endpoint not found. Check the URL.'
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return 'Rate limit exceeded. Please try again.'
  }
  if (lower.includes('403')) {
    return 'API key does not have permission to access this resource'
  }

  return msg.slice(0, 300)
}

/**
 * Guard against ambiguous Pi custom endpoint tests where no provider routing is selected.
 */
export function validateSetupTestInput(params: {
  provider: 'pi'
  baseUrl?: string
  piAuthProvider?: string
}): { valid: true } | { valid: false; error: string } {
  const hasCustomEndpoint = !!params.baseUrl?.trim()
  if (params.provider === 'pi' && hasCustomEndpoint && !params.piAuthProvider) {
    return {
      valid: false,
      error: 'Custom endpoint in Pi API Key mode requires selecting a provider preset.',
    }
  }

  return { valid: true }
}

/**
 * Returns true when a URL points to local loopback.
 * Used to permit keyless setup tests for local model runtimes (e.g. Ollama).
 */
export function isLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1'
  } catch {
    return false
  }
}

/**
 * Setup tests require API keys for non-local endpoints, but local loopback
 * endpoints may be keyless.
 */
export function setupTestRequiresApiKey(baseUrl?: string): boolean {
  return !isLoopbackBaseUrl(baseUrl)
}

/**
 * Decide how a custom OpenAI/Anthropic-compatible endpoint should be persisted.
 *
 * - Loopback URL with no credential → keyless local model (Ollama, LM Studio).
 * - Loopback URL *with* a credential → real local OpenAI-compat server (vLLM, LiteLLM, etc.);
 *   must be treated like a remote custom endpoint so `piAuthProvider` is set, otherwise
 *   `getPiAuth()` returns null at runtime and chat requests fail with 401 (#636).
 * - Remote URL → always keyed with provider hint for the correct icon.
 *
 * Pure: caller spreads the result into the connection updates patch.
 */
export function resolveCustomEndpointSetup(input: {
  baseUrl: string | undefined
  credential: string | undefined
  customEndpointApi: PiCustomApi
}): {
  authType: 'none' | 'api_key_with_endpoint'
  name?: 'Local Model'
  piAuthProvider?: 'openai' | 'anthropic'
} {
  const isKeylessLoopback = isLoopbackBaseUrl(input.baseUrl) && !input.credential
  if (isKeylessLoopback) {
    return { authType: 'none', name: 'Local Model' }
  }
  return {
    authType: 'api_key_with_endpoint',
    piAuthProvider: input.customEndpointApi === 'anthropic-messages' ? 'anthropic' : 'openai',
  }
}

// ============================================================
// Pi Auth Provider Display Names
// ============================================================

const PI_AUTH_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI',
  google: 'Google AI Studio',
  openrouter: 'OpenRouter',
  'azure-openai-responses': 'Azure OpenAI',
  'amazon-bedrock': 'Amazon Bedrock',
  groq: 'Groq',
  mistral: 'Mistral',
  xai: 'xAI',
  cerebras: 'Cerebras',
  zai: 'z.ai',
  huggingface: 'Hugging Face',
  minimax: 'Minimax',
  'minimax-cn': 'Minimax CN',
  'kimi-coding': 'Kimi (Coding)',
  'vercel-ai-gateway': 'Vercel AI Gateway',
}

/** Get a human-readable display name for a Pi auth provider key */
export function piAuthProviderDisplayName(piAuthProvider: string): string | null {
  return PI_AUTH_PROVIDER_DISPLAY_NAMES[piAuthProvider] ?? null
}

// ============================================================
// Model Validation
// ============================================================

/**
 * Validate that the default model exists in the provided model list.
 * Handles both string and ModelDefinition model entries.
 *
 * Handles both string IDs and structured provider model entries.
 */
export function validateModelList(
  models: Array<ModelDefinition | string>,
  defaultModel: string | undefined,
): { valid: boolean; error?: string; resolvedDefaultModel?: string } {
  if (!models || models.length === 0) {
    return { valid: true }
  }

  const modelIds = models.map(m => typeof m === 'string' ? m : m.id)

  if (defaultModel && !modelIds.includes(defaultModel)) {
    return {
      valid: false,
      error: `Default model "${defaultModel}" is not in the provided model list.`,
    }
  }

  if (!defaultModel) {
    const firstModel = models[0]
    const firstModelId = typeof firstModel === 'string' ? firstModel : firstModel!.id
    return {
      valid: true,
      resolvedDefaultModel: firstModelId,
    }
  }

  return { valid: true }
}
