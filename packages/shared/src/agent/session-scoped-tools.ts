/**
 * Session-Scoped Tools
 *
 * Tools that are scoped to a specific session. Each session gets its own
 * instance of these tools with session-specific callbacks and state.
 *
 * This file is a thin adapter that wraps the shared handlers from
 * @mortise/session-tools-core for use as in-process MCP tools.
 *
 * All tool definitions, schemas, and handlers live in session-tools-core.
 * This adapter only handles:
 * - Session callback registry (per-session plan and query callbacks)
 * - Plan state management
 * - MCP tool wrapping with DOC_REF-enriched descriptions
 * - spawn_session, browser_tool (backend-specific, not in registry)
 */

import { getSessionPlansPath } from '../sessions/storage.ts';
import { DOC_REFS } from '../docs/index.ts';
import { createSessionToolContext } from './session-tool-context.ts';
import {
  createInProcessMcpServer,
  createMcpTool,
  type InProcessMcpServer,
  type InProcessMcpTool,
} from '../mcp/server-factory.ts';

// Import from session-tools-core: registry + schemas + base descriptions
import {
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  getSessionToolDefs,
  TOOL_DESCRIPTIONS as BASE_DESCRIPTIONS,
  // Types
  type ToolResult,
  type TextContent,
} from '@mortise/session-tools-core';
import { createSpawnSessionTool, type SpawnSessionFn } from './spawn-session-tool.ts';
import { createBrowserTools, type BrowserPaneFns } from './browser-tools.ts';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import { getBrowserToolEnabled } from '../config/storage.ts';

// Re-export browser pane types for session manager wiring
export type { BrowserPaneFns } from './browser-tools.ts';

// ============================================================
// Session-Scoped Tool Callbacks (re-exported from dedicated registry module)
// ============================================================

// Re-export for all downstream consumers (index.ts, pi-agent.ts, etc.)
export {
  type SessionScopedToolCallbacks,
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  getSessionScopedToolCallbacks,
} from './session-scoped-tool-callback-registry.ts';

// Local imports for use within this file's factory function
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';

/** Backend-executed session tools currently supported by the in-process adapter layer. */
export const IN_PROCESS_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
  'spawn_session',
  'browser_tool',
]);

/**
 * Guardrail: ensure Claude adapter wiring stays in sync with backend-mode tools
 * declared in session-tools-core. Fail fast during setup instead of runtime drift.
 */
function assertInProcessBackendSessionToolParity(): void {
  const missing = [...SESSION_BACKEND_TOOL_NAMES].filter(
    (name) => !IN_PROCESS_BACKEND_SESSION_TOOL_NAMES.has(name),
  );

  if (missing.length > 0) {
    throw new Error(
      `Session tools missing in-process backend adapter implementations: ${missing.join(', ')}`,
    );
  }
}

// ============================================================
// Plan State Management
// ============================================================

// Map of sessionId -> last submitted plan path (for retrieval after submission)
const sessionPlanFilePaths = new Map<string, string>();

/**
 * Get the last submitted plan file path for a session
 */
export function getLastPlanFilePath(sessionId: string): string | null {
  return sessionPlanFilePaths.get(sessionId) ?? null;
}

/**
 * Set the last submitted plan file path for a session
 */
export function setLastPlanFilePath(sessionId: string, path: string): void {
  sessionPlanFilePaths.set(sessionId, path);
}

/**
 * Clear plan file state for a session
 */
export function clearPlanFileState(sessionId: string): void {
  sessionPlanFilePaths.delete(sessionId);
}

// ============================================================
// Plan Path Helpers
// ============================================================

/**
 * Get the plans directory for a session
 */
export function getSessionPlansDir(workspacePath: string, sessionId: string): string {
  return getSessionPlansPath(workspacePath, sessionId);
}

/**
 * Check if a path is within a session's plans directory
 */
export function isPathInPlansDir(path: string, workspacePath: string, sessionId: string): boolean {
  const plansDir = getSessionPlansDir(workspacePath, sessionId);
  return path.startsWith(plansDir);
}

// ============================================================
// Tool Result Converter
// ============================================================

/**
 * Convert shared ToolResult to SDK format
 */
function convertResult(result: ToolResult): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return {
    content: result.content
      .filter((c): c is TextContent => c.type === 'text')
      .map(c => ({ type: 'text' as const, text: c.text })),
    ...(result.isError ? { isError: true } : {}),
  };
}

// ============================================================
// Cache for Session-Scoped Tools
// ============================================================

// Cache tools by session to avoid recreating them on every query.
// We cache the tools array (expensive to build) but NOT the MCP server wrapper,
// because McpServer instances hold transport state.
const sessionToolsCache = new Map<string, InProcessMcpTool[]>();

/**
 * Invalidate ALL session tool caches (e.g., when a global setting like browserToolEnabled changes).
 * This forces tools to be rebuilt on the next message for every session.
 */
export function invalidateAllSessionToolsCaches(): void {
  sessionToolsCache.clear();
}

/**
 * Clean up cached tools for a session
 */
export function cleanupSessionScopedTools(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const key of sessionToolsCache.keys()) {
    if (key.startsWith(prefix)) {
      sessionToolsCache.delete(key);
    }
  }
}

// ============================================================
// Tool Descriptions (base from registry + DOC_REF enrichments)
// ============================================================

let toolDescriptionsCache: Record<string, string> | undefined;

function getToolDescriptions(): Record<string, string> {
  if (!toolDescriptionsCache) {
    toolDescriptionsCache = {
      ...BASE_DESCRIPTIONS,
      // Session tool enrichments with DOC_REFs
      config_validate: BASE_DESCRIPTIONS.config_validate,
      skill_validate: BASE_DESCRIPTIONS.skill_validate + `\n\n**Reference:** ${DOC_REFS.skills}`,
      mermaid_validate: BASE_DESCRIPTIONS.mermaid_validate + `\n\n**Reference:** ${DOC_REFS.mermaid}`,
    };
  }
  return toolDescriptionsCache;
}

// ============================================================
// Main Factory Function
// ============================================================

/**
 * Get or create session-scoped tools for a session.
 * Returns an MCP server with all session-scoped tools registered.
 *
 * All tools come from the canonical SESSION_TOOL_DEFS registry in session-tools-core,
 * except spawn_session and browser_tool which are backend-specific.
 */
export function getSessionScopedTools(
  sessionId: string,
  workspaceRootPath: string,
): InProcessMcpServer {
  const cacheKey = `${sessionId}::${workspaceRootPath}`;

  // Return cached tools if available, but always create a fresh MCP server wrapper
  let tools: InProcessMcpTool[] | undefined = sessionToolsCache.get(cacheKey);
  if (!tools) {
    const ctx = createSessionToolContext({
      sessionId,
      workspacePath: workspaceRootPath,
      onPlanSubmitted: (planPath: string) => {
        setLastPlanFilePath(sessionId, planPath);
        const callbacks = getSessionScopedToolCallbacks(sessionId);
        callbacks?.onPlanSubmitted?.(planPath);
      },
    });

    // Attach session self-management bindings (lazy getters from callback registry)
    attachSessionSelfManagementBindings(ctx, sessionId);

    // Helper to create a tool from the canonical registry.
    // The `as any` on schema bridges a Zod generic-variance issue when .shape
    // types (ZodType<string>) flow into Record<string, ZodType<unknown>>.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function registryTool(name: string, schema: any) {
      const def = SESSION_TOOL_REGISTRY.get(name)!;
      const descriptions = getToolDescriptions();
      return createMcpTool(name, descriptions[name] || def.description, schema, async (args: any) => {
        const result = await def.handler!(ctx, args);
        return convertResult(result);
      }, def.readOnly ? { annotations: { readOnlyHint: true } } : undefined);
    }

    // Ensure backend-mode tool wiring is in sync with core metadata.
    assertInProcessBackendSessionToolParity();

    // Create tools from the canonical registry — all tools with handlers.
    // Tool visibility is centrally filtered in session-tools-core to avoid backend drift.
    tools = getSessionToolDefs({ includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback })
      .filter(def => def.handler !== null) // Skip backend-specific tools (spawn_session, browser_tool)
      .map(def => registryTool(def.name, def.inputSchema.shape));

    // Add spawn_session — backend-specific (not in registry handler)
    tools.push(
      createSpawnSessionTool({
        sessionId,
        getSpawnSessionFn: () => {
          const callbacks = getSessionScopedToolCallbacks(sessionId);
          return callbacks?.spawnSessionFn;
        },
      }),
    );

    // Add browser_* tools — backend-specific (requires BrowserPaneManager in Electron)
    // Gated by the "Built-in browser" setting so users with external browser tools
    // (Playwright, Puppeteer, etc.) can disable the built-in one.
    if (getBrowserToolEnabled()) {
      tools.push(
        ...createBrowserTools({
          sessionId,
          getBrowserPaneFns: () => {
            const callbacks = getSessionScopedToolCallbacks(sessionId);
            return callbacks?.browserPaneFns;
          },
        }),
      );
    }

    sessionToolsCache.set(cacheKey, tools);
  }

  // Always create a fresh MCP server wrapper to avoid transport reuse when
  // queries are sent back-to-back (see comment on sessionToolsCache).
  return createInProcessMcpServer({
    name: 'session',
    version: '1.0.0',
    tools,
  });
}
