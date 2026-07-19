/**
 * Canonical ToolResult type and helpers.
 *
 * Unified across:
 * - packages/session-tools-core (session-scoped MCP tools)
 * - packages/shared/src/agent/spawn-session-tool.ts
 * - packages/shared/src/agent/browser-tools.ts
 *
 * Content blocks support both text and image, matching MCP CallToolResult.
 */

/**
 * Text content block for tool responses
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Image content block for tool responses (base64-encoded)
 */
export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/**
 * Standard tool result type compatible with both SDK and MCP patterns.
 * Content supports text and image blocks.
 *
 * The `[x: string]: unknown` index signature is required for MCP SDK
 * `CallToolResult` compatibility (the SDK expects a loose object shape).
 */
export interface ToolResult {
  [x: string]: unknown;
  content: Array<TextContent | ImageContent>;
  /**
   * Optional structured payload for MCP clients.
   * Keep this as an object (not null) for compatibility with strict tool_result parsers.
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Create a successful text response.
 */
export function successResponse(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: {},
    isError: false,
  };
}

/**
 * Create an error response.
 *
 * IMPORTANT — OpenAI Responses API limitation (discovered 2025-02):
 * The `function_call_output` input item only has `type`, `call_id`, and
 * `output` (a plain string). There is NO `success`, `status`, or `error`
 * field. Our Codex fork's FunctionCallOutputPayload has a `success: bool`
 * field, but its custom Serialize impl (codex-rs/protocol/src/models.rs)
 * drops it entirely — only the content string is serialized to the API.
 *
 * This means `isError: true` is invisible to the model. To make errors
 * distinguishable from successes, we prefix the output text with "[ERROR]".
 * The model can then parse this prefix to understand the tool call failed.
 *
 * This covers all session host-tool errors (source_test, config_validate,
 * skill_validate, credential_prompt, oauth triggers, browser_tool,
 * spawn_session, etc.).
 *
 * See also: blockWithReason() in packages/shared/src/agent/mode-manager.ts
 * which applies the same prefix for permission-mode blocks, and
 * stripErrorTags() in packages/ui/src/components/chat/turn-utils.ts which
 * removes the prefix for clean UI display.
 */
export function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `[ERROR] ${message}` }],
    structuredContent: {},
    isError: true,
  };
}

/**
 * Create an MCP error response using the message verbatim (no prefix).
 *
 * Unlike `errorResponse`, this does NOT prepend "[ERROR] " — the message is
 * used as-is. Callers MUST pass a self-describing error message (e.g.,
 * "API Error 500: ...", "Request failed: ...", "Validation failed: ...")
 * because `isError: true` is invisible to the model in the OpenAI Responses
 * API path (see `errorResponse` doc above). Without the `[ERROR]` prefix,
 * the only signal the model receives is the message text itself — so the
 * text must clearly indicate failure.
 *
 * Unifies the scattered `{ content: [{ type: 'text', text }], isError: true }`
 * literals.
 */
export function mcpErrorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: {},
    isError: true,
  };
}

/**
 * Get the text of a content block at the given index (or empty string if
 * the block is missing or not text). Convenience helper for tests and
 * simple consumers that only need to read text content.
 */
export function getResultText(result: ToolResult, index = 0): string {
  const block = result.content[index];
  return block?.type === 'text' ? block.text : '';
}
