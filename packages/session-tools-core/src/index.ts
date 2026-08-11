/**
 * Session Tools Core
 *
 * Shared utilities for session-scoped tools used by both
 * Claude (in-process) and Codex (subprocess) implementations.
 *
 * @packageDocumentation
 */

// Types
export type {
  // IPC types
  CallbackMessage,

  // Tool result types
  TextContent,
  ImageContent,
  ToolResult,

} from './types.ts';

// Response helpers
export {
  errorResponse,
  successResponse,
} from './response.ts';

export { getResultText } from './types.ts';

// Context interface
export type {
  SessionToolContext,
  SessionToolCallbacks,
  FileSystemInterface,
  // Session query types
  SessionInfo,
  SessionListItem,
  ListSessionsOptions,
  ListSessionsResult,
} from './context.ts';

export { createNodeFileSystem } from './context.ts';

// Tool definitions — single source of truth
export {
  // Descriptions
  TOOL_DESCRIPTIONS,
  // Registry
  SESSION_TOOL_DEFS,
  SESSION_TOOL_NAMES,
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_REGISTRY_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  // Helper views
  getSessionToolDefs,
  getSessionBackendToolNames,
  getSessionToolRegistry,
  normalizeSessionToolName,
  isSessionToolName,
  // JSON Schema converter
  getToolDefsAsJsonSchema,
} from './tool-defs.ts';

export type {
  JsonSchemaToolDef,
} from './tool-defs.ts';
