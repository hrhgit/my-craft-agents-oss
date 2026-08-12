/**
 * Session Tool Definitions — Single Source of Truth
 *
 * Canonical Zod schemas, descriptions, and handler registry for all
 * session-scoped tools. Consumers derive what they need:
 *
 * - In-process tools → `.shape` extracts the plain `{ key: z.string() }` literal
 * - MCP / Pi         → `getToolDefsAsJsonSchema()` auto-converts to JSON Schema
 *
 * Adding a new tool: define the schema, description, handler import, and
 * one entry in SESSION_TOOL_DEFS.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { SessionToolContext } from './context.ts';
import type { ToolResult } from './types.ts';

// Handlers
import { handleCreateSession } from './handlers/create-session.ts';
import { handleListSessions } from './handlers/list-sessions.ts';
import { handleReadSession } from './handlers/read-session.ts';
import { handleSendMessageToSession } from './handlers/send-message-to-session.ts';
import { handleListMessagingChannels, handleUnbindMessagingChannel } from './handlers/messaging.ts';

// ============================================================
// Canonical Zod Schemas
// ============================================================

export const BrowserToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Browser command as a string (e.g., "click @e1") or array (e.g., ["evaluate", "var x = 1; x + 2"]). Array mode preserves semicolons and whitespace in arguments.'),
});

export const SubagentSchema = z.object({
  action: z.enum(['start', 'list', 'inspect', 'message', 'resume', 'interrupt', 'wait']).optional()
    .describe('Operation to perform. Defaults to start.'),
  prompt: z.string().optional().describe('Task instructions for start, or a follow-up message for message.'),
  taskId: z.string().optional().describe('Task ID for inspect, message, resume, or interrupt.'),
  taskIds: z.array(z.string()).min(1).optional().describe('Task IDs to wait for. Returns when any task reaches a terminal state.'),
  agent: z.string().optional().describe('Local Agent configuration ID. Omit to use the default Agent configuration.'),
  forkTurns: z.union([z.number().int().positive(), z.literal('all')]).optional()
    .describe('Inherit the current parent branch: a positive number of recent turns, or all reliable turns. Omit for no inherited history.'),
  systemPrompt: z.string().optional().describe('System prompt replacement for this run only.'),
  tools: z.array(z.string()).optional().describe('Tool list replacement for this run only.'),
  model: z.string().optional().describe('Model override for this run.'),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    .describe('Reasoning level override for this run.'),
  schema: z.record(z.unknown()).optional().describe('Optional JSON Schema for structured result data.'),
  timeoutMs: z.number().int().min(0).max(300_000).optional()
    .describe('Wait timeout in milliseconds. Defaults to 30000 and does not cancel tasks.'),
});

export const ListSessionsSchema = z.object({
  search: z.string().optional().describe('Substring match on session name'),
  sortBy: z.enum(['recent', 'name']).optional().describe('Sort order (default: recent)'),
  limit: z.number().optional().describe('Max sessions to return (default 20, max 100)'),
  cursor: z.string().optional().describe('Opaque cursor returned by an earlier list_sessions call'),
});

export const CreateSessionSchema = z.object({
  message: z.string().describe('First user message for the new ordinary Session'),
  name: z.string().optional().describe('Optional Session name'),
  provider: z.string().optional().describe('Optional provider override'),
  model: z.string().optional().describe('Optional model override'),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    .describe('Optional reasoning level override'),
});

export const ReadSessionSchema = z.object({
  sessionId: z.string().describe('Session ID to read'),
  cursor: z.string().optional().describe('Opaque cursor for older turns on the selected branch'),
  turnLimit: z.number().optional().describe('Maximum recent turns to return (default 10, max 50)'),
  branchNodeId: z.string().optional().describe('Explicit Pi tree node to read instead of the current leaf'),
  maxCharsPerItem: z.number().optional().describe('Maximum characters per user or Agent message'),
});

export const SendMessageToSessionSchema = z.object({
  sessionId: z.string().describe('Target session ID to send the message to'),
  message: z.string().describe('The message to send to the target session'),
  delivery: z.enum(['followUp', 'steer']).optional()
    .describe('Delivery intent. Defaults to followUp; steer explicitly redirects the active turn.'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional().describe('Files to include with the message'),
});

export const ListMessagingChannelsSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to list bindings for. Defaults to current session.'),
});

export const UnbindMessagingChannelSchema = z.object({
  platform: z.enum(['telegram', 'whatsapp']).optional().describe('Platform to unbind. If omitted, unbinds all.'),
});

// ============================================================
// Canonical Tool Descriptions (base — no DOC_REFS)
// ============================================================

export const TOOL_DESCRIPTIONS = {
  browser_tool: `Run browser actions using a CLI-like command (string or array input).

All browser interactions use this single tool with strict validation and actionable feedback.
String mode supports batching with semicolons: \`fill @e1 value; fill @e2 value; click @e3\`
Batch stops after navigation commands (click, navigate, back, forward) since page state may change.

Array mode bypasses string parsing and preserves raw arguments exactly (recommended for semicolons, tabs, and newlines):
- \`["evaluate", "var x = 1; var y = 2; x + y"]\`
- \`["paste", "Name\\tAge\\nAlice\\t30"]\`

Examples:
- \`--help\`
- \`open\`
- \`navigate https://example.com\`
- \`snapshot\`
- \`find login button\` — search elements by keyword
- \`click @e12\`
- \`click-at 350 200\` — click at pixel coordinates (for canvas elements)
- \`fill @e5 user@example.com\`
- \`type Hello World\` — type into currently focused element (no ref needed)
- \`select @e3 optionValue\`
- \`select @e75 CNAME --assert-text Target --timeout 3000\`
- \`set-clipboard Name\\tAge\\nAlice\\t30\` — write text to clipboard
- \`get-clipboard\` — read clipboard text content
- \`paste Name\\tAge\\nAlice\\t30\` — set clipboard and trigger Ctrl/Cmd+V
- \`scroll down 800\`
- \`evaluate document.title\`
- \`console 50 error\`
- \`screenshot\` — raw screenshot
- \`screenshot --annotated\` — screenshot with @eN labels overlaid on interactive elements
- \`screenshot-region 100 200 640 480\`
- \`screenshot-region --ref @e12 --padding 8\`
- \`screenshot-region --selector div[data-testid="chart"]\`
- \`window-resize 1440 900\`
- \`network 50 failed\`
- \`wait network-idle 8000\`
- \`key Enter\`
- \`key k meta\`
- \`downloads wait 15000\`
- \`focus [windowId]\` — focus existing browser window (no new window)
- \`windows\` — list current browser windows and ownership state
- \`release\` — dismiss the agent control overlay when done
- \`close\` — close and destroy the browser window
- \`hide\` — hide the window while preserving state`,

  subagent: `Delegate work to persistent private subagents owned by the current Session.

Start is the default action and requires only prompt. It returns taskId immediately. Use wait to wait for any of several tasks, inspect to read one task, message to steer or queue work, resume to continue interrupted work, and interrupt to stop it.

Use list to discover configured Agents and current private tasks. Agent configurations are local Markdown files. Optional systemPrompt, tools, model, and thinkingLevel replace configuration values for this run only.

forkTurns optionally inherits reliable messages from the current parent branch. Omit it for an independent context, pass a positive turn count for recent context, or "all" for the complete reliable branch.

Child tasks never appear in the ordinary Session list. Completion is recorded as a process event and never inserted as a user message. Optional schema validates structured result data; ordinary final text always remains available.`,

  list_sessions: `List ordinary Sessions in the current Workspace using cursor pagination.

Use search to narrow results instead of fetching everything. Default limit is 20 sessions.
Use read_session to inspect the current branch of a specific Session.`,

  create_session: `Create an ordinary Session and send its first user message through the normal publication transaction.

The Session is published only after Pi durably accepts the first user message. This is not subagent and does not create a private child task.`,

  read_session: `Read a bounded projection of an ordinary Session.

By default this follows Pi's persisted current leaf and returns recent user intent plus final Agent results from that tree branch. It does not mix sibling branches or include full reasoning and tool output. Use the returned cursor for older turns, or branchNodeId to explicitly inspect another branch.`,

  send_message_to_session: `Send a normal user message to another ordinary Session through the same delivery path used by UI and CLI.

The source Session is recorded as structured metadata rather than text inserted into the message. Delivery defaults to followUp; use steer only when you explicitly need to redirect the target's active turn.`,

  list_messaging_channels: `List messaging channels (Telegram, WhatsApp) bound to a session.
Shows which external chat apps are connected and can send/receive messages.`,

  unbind_messaging_channel: `Disconnect a messaging channel from the current session.
Messages will no longer be forwarded between the chat app and this session.`,
} as const;

// ============================================================
// Tool Definition Type
// ============================================================

/** Handler function signature for session tools. */
export type SessionToolHandler = (ctx: SessionToolContext, args: any) => Promise<ToolResult>;

/** Where a session tool is executed. */
export type SessionToolExecutionMode = 'registry' | 'backend';

interface SessionToolDefBase {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Whether this tool only reads data (no side effects). Enables parallel execution in backends that support it. */
  readOnly?: boolean;
}

/** Tool executed from the canonical registry (requires a concrete handler). */
export interface RegistrySessionToolDef extends SessionToolDefBase {
  executionMode: 'registry';
  handler: SessionToolHandler;
}

/** Tool executed by backend-specific adapters (Pi/Claude/session-mcp-server). */
export interface BackendSessionToolDef extends SessionToolDefBase {
  executionMode: 'backend';
  handler: null;
}

/** A single session tool definition combining name, description, schema, mode, and handler. */
export type SessionToolDef = RegistrySessionToolDef | BackendSessionToolDef;

// ============================================================
// Canonical Tool Registry
// ============================================================

export const SESSION_TOOL_DEFS: SessionToolDef[] = [
  { name: 'subagent', description: TOOL_DESCRIPTIONS.subagent, inputSchema: SubagentSchema, executionMode: 'backend', handler: null },
  // Browser tool (backend-specific — requires BrowserPaneManager in Electron)
  // Single CLI-like tool that handles all browser actions via command string.
  { name: 'browser_tool', description: TOOL_DESCRIPTIONS.browser_tool, inputSchema: BrowserToolSchema, executionMode: 'backend', handler: null },
  // Ordinary Session coordination tools
  { name: 'list_sessions', description: TOOL_DESCRIPTIONS.list_sessions, inputSchema: ListSessionsSchema, executionMode: 'registry', readOnly: true, handler: handleListSessions },
  { name: 'create_session', description: TOOL_DESCRIPTIONS.create_session, inputSchema: CreateSessionSchema, executionMode: 'registry', handler: handleCreateSession },
  { name: 'read_session', description: TOOL_DESCRIPTIONS.read_session, inputSchema: ReadSessionSchema, executionMode: 'registry', readOnly: true, handler: handleReadSession },
  { name: 'send_message_to_session', description: TOOL_DESCRIPTIONS.send_message_to_session, inputSchema: SendMessageToSessionSchema, executionMode: 'registry', handler: handleSendMessageToSession },
  // Messaging gateway tools
  { name: 'list_messaging_channels', description: TOOL_DESCRIPTIONS.list_messaging_channels, inputSchema: ListMessagingChannelsSchema, executionMode: 'registry', readOnly: true, handler: handleListMessagingChannels },
  { name: 'unbind_messaging_channel', description: TOOL_DESCRIPTIONS.unbind_messaging_channel, inputSchema: UnbindMessagingChannelSchema, executionMode: 'registry', handler: handleUnbindMessagingChannel },
];

/**
 * Return session tools.
 *
 * Callers should use this helper instead of filtering ad hoc so tool visibility
 * stays consistent across Claude, Pi, and session-mcp-server backends.
 */
export function getSessionToolDefs(): SessionToolDef[] {
  return SESSION_TOOL_DEFS;
}

/**
 * Build a name->definition registry.
 */
export function getSessionToolRegistry(): Map<string, SessionToolDef> {
  return new Map(getSessionToolDefs().map(def => [def.name, def]));
}

/**
 * Return session tool names.
 */
export function getSessionToolNames(): Set<string> {
  return new Set(getSessionToolDefs().map(def => def.name));
}

/**
 * Return backend-executed tool names.
 */
export function getSessionBackendToolNames(): Set<string> {
  return new Set(getSessionToolDefs().filter(d => d.executionMode === 'backend').map(d => d.name));
}

// ============================================================
// Derived Lookups
// ============================================================

/** Set of session tool names for quick membership checks. */
export const SESSION_TOOL_NAMES = new Set(SESSION_TOOL_DEFS.map(d => d.name));

/**
 * Resolve an exact canonical session-tool name.
 *
 * Former `mcp__session__*` and `session__*` aliases are intentionally rejected.
 */
export function normalizeSessionToolName(toolName: string): string | null {
  return SESSION_TOOL_NAMES.has(toolName) ? toolName : null;
}

export function isSessionToolName(toolName: string): boolean {
  return normalizeSessionToolName(toolName) !== null;
}

/** Session tool names that must be handled by backend-specific adapters (Pi/Claude/session-mcp-server). */
export const SESSION_BACKEND_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'backend').map(d => d.name)
);

/** Session tool names that are always executable from the canonical registry. */
export const SESSION_REGISTRY_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'registry').map(d => d.name)
);

/** Map from tool name → definition for O(1) lookup. */
export const SESSION_TOOL_REGISTRY = new Map(SESSION_TOOL_DEFS.map(d => [d.name, d]));

// ============================================================
// JSON Schema Converter (for MCP / Pi consumers)
// ============================================================

export interface JsonSchemaToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Convert session tool definitions to JSON Schema format.
 *
 * @returns Array of tool definitions with JSON Schema inputSchema
 */
export function getToolDefsAsJsonSchema(): JsonSchemaToolDef[] {
  const defs = getSessionToolDefs();

  return defs.map(def => {
    // Explicit `as any` avoids TS2589 ("type instantiation is excessively deep")
    // caused by zodToJsonSchema inferring deep generic chains from union schemas.
    const jsonSchema = zodToJsonSchema(def.inputSchema as any, { $refStrategy: 'none' }) as Record<string, unknown>;
    // Strip metadata not needed by MCP/Pi consumers
    delete jsonSchema.$schema;
    delete jsonSchema.additionalProperties;
    return {
      name: def.name,
      description: def.description,
      inputSchema: jsonSchema,
    };
  });
}
