import { debug } from '../utils/debug.ts';
import type { AgentError } from '../agent/errors.ts';

export interface UrlValidationResult {
  valid: boolean;
  /** Simple error message for validation failures */
  error?: string;
  /** Typed error for API/billing failures - display as ErrorBanner */
  typedError?: AgentError;
}

const CRAFT_MCP_HOST = 'mcp.craft.do';
const LINK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function validateMcpUrl(url: string): Promise<UrlValidationResult> {
  debug('[url-validator] Validating URL:', url);

  const trimmed = url.trim();
  if (!trimmed) {
    return { valid: false, error: 'Enter a Craft MCP URL.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'URL must include https:// and be syntactically valid.' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Craft MCP URLs must start with https://.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Remove credentials from the URL.' };
  }

  if (parsed.hostname !== CRAFT_MCP_HOST) {
    return { valid: false, error: `Host must be exactly ${CRAFT_MCP_HOST}.` };
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'links' || parts[2] !== 'mcp') {
    return { valid: false, error: 'Path must match /links/{linkId}/mcp.' };
  }

  if (!LINK_ID_PATTERN.test(parts[1] ?? '')) {
    return { valid: false, error: 'Link ID may only contain letters, numbers, hyphens, and underscores.' };
  }

  return { valid: true };
}
