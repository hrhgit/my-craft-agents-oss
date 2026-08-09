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

export type { TextContent, ImageContent, ToolResult } from '@mortise/session-tools-core';
export { successResponse, errorResponse, getResultText } from '@mortise/session-tools-core';
import type { ToolResult } from '@mortise/session-tools-core';

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
 * This covers all session host-tool errors (config_validate,
 * skill_validate, browser_tool,
 * spawn_session, etc.).
 *
 * stripErrorTags() in packages/ui/src/components/chat/turn-utils.ts
 * removes the prefix for clean UI display.
 */
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
