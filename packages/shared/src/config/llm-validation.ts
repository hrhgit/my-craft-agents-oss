import { debug } from '../utils/debug.ts';

export interface LlmValidationConfig {
  /** Model to test with */
  model: string;
  /** API key credential (x-api-key header) */
  apiKey?: string;
  /** OAuth/bearer token (Authorization: Bearer header) */
  oauthToken?: string;
  /** Custom base URL for Anthropic-compatible endpoints */
  baseUrl?: string;
  /** Optional timeout in milliseconds */
  timeoutMs?: number;
}

export interface LlmValidationResult {
  success: boolean;
  error?: string;
}

export async function validateAnthropicConnection(
  config: LlmValidationConfig,
): Promise<LlmValidationResult> {
  debug('[llm-validation] Validating connection', {
    model: config.model,
    hasApiKey: !!config.apiKey,
    hasOAuth: !!config.oauthToken,
    baseUrl: config.baseUrl,
  });

  const baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 20_000);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (config.apiKey) {
    headers['x-api-key'] = config.apiKey;
  } else if (config.oauthToken) {
    headers.authorization = `Bearer ${config.oauthToken}`;
  }

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      }),
    });

    if (response.ok) {
      return { success: true };
    }

    const body = await response.text().catch(() => '');
    return {
      success: false,
      error: parseValidationError(`${response.status} ${response.statusText} ${body}`.trim()),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    debug('[llm-validation] Validation failed:', msg);
    return { success: false, error: parseValidationError(msg) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse error messages into user-friendly descriptions.
 * Centralizes error message translation for all connection validation.
 */
export function parseValidationError(msg: string): string {
  const lowerMsg = msg.toLowerCase();

  // Connection errors — server unreachable
  if (lowerMsg.includes('econnrefused') || lowerMsg.includes('enotfound') || lowerMsg.includes('fetch failed') || lowerMsg.includes('aborted')) {
    return 'Cannot connect to API server. Check the URL and ensure the server is running.';
  }

  // Auth errors
  if (lowerMsg.includes('401') || lowerMsg.includes('unauthorized') || lowerMsg.includes('authentication')) {
    return 'Authentication failed. Check your API key or OAuth token.';
  }

  // Permission errors
  if (lowerMsg.includes('403') || lowerMsg.includes('forbidden') || lowerMsg.includes('permission')) {
    return 'Access denied. Check your API key permissions.';
  }

  // Rate limit / quota errors
  if (lowerMsg.includes('429') || lowerMsg.includes('rate limit') || lowerMsg.includes('quota')) {
    return 'Rate limited or quota exceeded. Try again later.';
  }

  // Credit/billing errors
  if (lowerMsg.includes('402') || lowerMsg.includes('credit') || lowerMsg.includes('billing') || lowerMsg.includes('insufficient')) {
    return 'Billing issue. Check your account credits or payment method.';
  }

  // Model not found
  if (lowerMsg.includes('model not found') || lowerMsg.includes('invalid model')) {
    return 'Model not found. Check the connection configuration.';
  }

  // 404 on endpoint
  if (lowerMsg.includes('404') && !lowerMsg.includes('model')) {
    return 'Endpoint not found. Ensure the server supports the Anthropic Messages API.';
  }

  // Service unavailable
  if (lowerMsg.includes('500') || lowerMsg.includes('502') || lowerMsg.includes('503') || lowerMsg.includes('service unavailable')) {
    return 'API temporarily unavailable. Try again in a few seconds.';
  }

  return msg.slice(0, 200);
}
