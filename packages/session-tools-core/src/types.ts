/**
 * Session Tools Core - Types
 *
 * Shared type definitions for session-scoped tools used by both
 * Claude (in-process) and Codex (subprocess) implementations.
 */

// ============================================================
// Developer Feedback
// ============================================================

/**
 * Freeform feedback from the agent to the development team.
 * Persisted as individual JSON files for later review/batch-send.
 */
export interface DeveloperFeedback {
  id: string;
  timestamp: string;
  sessionId: string;
  message: string;
}

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

// Re-export ToolResult and TextContent from canonical source (@mortise/shared/agent)
export type { TextContent, ToolResult } from '@mortise/shared/agent';
// Re-export getResultText helper for test consumers
export { getResultText } from '@mortise/shared/agent';

// ============================================================
// Validation Result Types
// ============================================================

/**
 * Individual validation issue
 */
export interface ValidationIssue {
  path: string;
  message: string;
  suggestion?: string;
}

/**
 * Result of validation operations
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
