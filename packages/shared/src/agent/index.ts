export * from './conversation-summary.ts';

// Canonical ToolResult type and helpers (shared across session-tools-core, subagent-tool, browser-tools)
export type { TextContent, ImageContent, ToolResult } from './tool-result.ts';
export { errorResponse, successResponse, mcpErrorResponse, getResultText } from './tool-result.ts';

export type { PiSpawnChildSessionOptions, PiSpawnChildSessionResult, PiChildSessionInfo } from './pi-agent.ts';
export type {
  SubagentAction,
  SubagentRequest,
  SubagentTask,
  SubagentAgentInfo,
  SubagentListResult,
  SubagentWaitResult,
  SubagentOperationResult,
} from './base-agent.ts';
export * from './errors.ts';

// Export session-scoped-tools - tools scoped to a specific session
export {
  // Session-scoped tools provider
  getSessionScopedTools,
  cleanupSessionScopedTools,
  // Plan file management
  getSessionPlansDir,
  getLastPlanFilePath,
  clearPlanFileState,
  isPathInPlansDir,
  // Callback registry for session-scoped tool notifications
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  getSessionScopedToolCallbacks,
  // Types
  type SessionScopedToolCallbacks,
  type BrowserPaneFns,
} from './session-scoped-tools.ts';

export { executeBrowserToolCommand, getBrowserToolHelp } from './browser-tool-runtime.ts';
export type { BrowserLifecycleActionResult } from './browser-tools.ts';

// Export plan types
export type { Plan, PlanStep, PlanState, PlanReviewRequest, PlanReviewResult } from './plan-types.ts';

// Export thinking-levels - extended reasoning configuration
export {
  type ThinkingLevel,
  type ThinkingLevelDefinition,
  THINKING_LEVELS,
  DEFAULT_THINKING_LEVEL,
  getThinkingTokens,
  getThinkingLevelNameKey,
  isValidThinkingLevel,
} from './thinking-levels.ts';

// Runtime lifecycle factories and AgentBackend are intentionally not part of
// the public package surface. Mortise server composition imports the internal
// backend module directly; product and Extension consumers receive only data
// contracts and host capabilities.
export type { ChildTaskActivityEvent, PiExtensionCommand } from './backend/types.ts';

// Export core utilities for shared agent logic
export * from './core/index.ts';

// Export browser tool name normalization helpers
export {
  normalizeCanonicalBrowserToolName,
  isCanonicalBrowserToolName,
} from './browser-tool-names.ts';

// Export PowerShell validator root setter (for Electron startup on Windows)
export { setPowerShellValidatorRoot } from './powershell-read-patterns.ts';
