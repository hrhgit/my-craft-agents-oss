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
  ToolResult,

  // Developer feedback
  DeveloperFeedback,

  // Validation types
  ValidationIssue,
  ValidationResult,

} from './types.ts';

// Response helpers
export {
  errorResponse,
} from './response.ts';

// Validation
export {
  // Result helpers
  validResult,
  invalidResult,
  mergeResults,

  // Formatting
  formatValidationResult,

  // JSON utilities
  readJsonFile,
  validateJsonFileHasFields,
  zodErrorToIssues,

  // Slug validation
  SLUG_REGEX,
  validateSlug,

  // Skill validation
  SkillMetadataSchema,
  validateSkillContent,

} from './validation.ts';

// Context interface
export type {
  SessionToolContext,
  SessionToolCallbacks,
  FileSystemInterface,
  ValidatorInterface,
  // Session query types
  SessionInfo,
  SessionListItem,
  ListSessionsOptions,
  ListSessionsResult,
} from './context.ts';

export { createNodeFileSystem } from './context.ts';

// Handlers
export type {
  ConfigValidateArgs,
  SkillValidateArgs,
  MermaidValidateArgs,
  UpdatePreferencesArgs,
  TransformDataArgs,
  ScriptSandboxArgs,
  SendDeveloperFeedbackArgs,
} from './handlers/index.ts';

// Tool definitions — single source of truth
export {
  // Individual Zod schemas
  ConfigValidateSchema,
  SkillValidateSchema,
  MermaidValidateSchema,
  UpdatePreferencesSchema,
  TransformDataSchema,
  ScriptSandboxSchema,
  // Developer feedback schema
  SendDeveloperFeedbackSchema,
  // Descriptions
  TOOL_DESCRIPTIONS,
  // Registry
  SESSION_TOOL_DEFS,
  SESSION_TOOL_NAMES,
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_REGISTRY_TOOL_NAMES,
  SESSION_SAFE_ALLOWED_TOOL_NAMES,
  SESSION_SAFE_BLOCKED_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  LEGACY_SESSION_TOOL_PREFIX,
  LEGACY_DIRECT_SESSION_TOOL_PREFIX,
  // Filtered helper views
  getSessionToolDefs,
  getSessionBackendToolNames,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  normalizeSessionToolName,
  isSessionToolName,
  // JSON Schema converter
  getToolDefsAsJsonSchema,
} from './tool-defs.ts';

export type {
  JsonSchemaToolDef,
} from './tool-defs.ts';
