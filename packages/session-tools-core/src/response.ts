/**
 * Session Tools Core - Response Helpers
 *
 * Helper functions for creating standardized tool responses.
 * Used by both Claude and Codex implementations.
 *
 * errorResponse and successResponse are re-exported from the canonical
 * implementation in @craft-agent/shared/agent (tool-result.ts).
 */

import type { TextContent } from './types.ts';

// Re-export canonical response helpers from @craft-agent/shared/agent
export { errorResponse, successResponse } from '@craft-agent/shared/agent';

/**
 * Create a text content block
 */
export function textContent(text: string): TextContent {
  return { type: 'text', text };
}
