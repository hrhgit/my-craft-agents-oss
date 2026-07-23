/**
 * Session Tools Core - Response Helpers
 *
 * Helper functions for creating standardized tool responses.
 * Used by both Claude and Codex implementations.
 *
 * This package owns the canonical response contract consumed by shared.
 */

import type { TextContent, ToolResult } from './types.ts';

export function successResponse(text: string): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: {}, isError: false };
}

export function errorResponse(message: string): ToolResult {
  return { content: [{ type: 'text', text: `[ERROR] ${message}` }], structuredContent: {}, isError: true };
}

/**
 * Create a text content block
 */
export function textContent(text: string): TextContent {
  return { type: 'text', text };
}
