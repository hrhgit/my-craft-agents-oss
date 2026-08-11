/**
 * Session Tools Core - Types
 *
 * Shared type definitions for session-scoped tools used by both
 * Claude (in-process) and Codex (subprocess) implementations.
 */

// ============================================================
// Callback Message (IPC)
// ============================================================

/**
 * Callback message for IPC with main process.
 * Used by Codex subprocess to communicate via stderr.
 */
export interface CallbackMessage {
  __callback__: string;
  [key: string]: unknown;
}

// ============================================================
// Tool Result Types
// ============================================================

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolResult {
  [x: string]: unknown;
  content: Array<TextContent | ImageContent>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function getResultText(result: ToolResult, index = 0): string {
  const block = result.content[index];
  return block?.type === 'text' ? block.text : '';
}
