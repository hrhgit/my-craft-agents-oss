/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, StopReason, Usage } from "@earendil-works/pi-ai/types";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionHeader } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";

export const PI_RPC_PROTOCOL_VERSION = 2;
export const PI_HOST_HOOKS_MODULE_ENV = "PI_HOST_HOOKS_MODULE";
export const PI_LEGACY_FETCH_INTERCEPTOR_MODULE_ENV = "PI_FETCH_INTERCEPTOR_MODULE";

export const PI_RPC_COMMANDS = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"run_mini_completion",
	"query_llm",
	"get_capabilities",
	"get_state",
	"set_model",
	"cycle_model",
	"get_available_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_steering_mode",
	"set_follow_up_mode",
	"compact",
	"set_auto_compaction",
	"set_auto_retry",
	"abort_retry",
	"bash",
	"abort_bash",
	"get_session_stats",
	"export_html",
	"switch_session",
	"fork",
	"clone",
	"get_fork_messages",
	"get_last_assistant_text",
	"set_session_name",
	"list_child_sessions",
	"get_messages",
	"enable_tool_permissions",
	"register_tools",
	"get_commands",
	"invoke_extension_command",
] as const;

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| {
			id?: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
			/** Host system-prompt override for this turn onward (see PromptOptions.systemPrompt). */
			systemPrompt?: string;
	  }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "run_mini_completion"; prompt: string }
	| { id?: string; type: "query_llm"; request: RpcLLMQueryRequest }

	// State
	| { id?: string; type: "get_capabilities" }
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "list_child_sessions"; parentSessionId: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Tool permissions (host-side gate; see RpcToolPermissionRequest)
	| { id?: string; type: "enable_tool_permissions"; enabled: boolean }

	// Host proxy tools (executed in the host process; see RpcToolExecuteRequest)
	| { id?: string; type: "register_tools"; tools: RpcHostToolDefinition[] }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }
	| { id?: string; type: "invoke_extension_command"; commandId: string; args?: string };

export interface RpcLLMQueryRequest {
	prompt: string;
	systemPrompt?: string;
	model?: string;
	maxTokens?: number;
	temperature?: number;
	outputSchema?: unknown;
}

export interface RpcLLMQueryResult {
	text: string;
	model?: string;
	provider?: string;
	usage?: Usage;
	stopReason?: StopReason;
}

export interface RpcChildSessionInfo {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	spawnedFrom: string;
	spawnConfig?: SessionHeader["spawnConfig"];
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

export interface RpcCapabilities {
	protocolVersion: number;
	packageVersion: string;
	commands: RpcCommandType[];
	features: {
		hostHooksModule: boolean;
		legacyFetchInterceptorModule: boolean;
		toolExecutionMetadata: boolean;
		hostToolResults: "text" | "content";
		extensionCommandResult: boolean;
		secondaryLlmQuery: boolean;
		childSessionListing: boolean;
	};
	hostHooks: {
		moduleEnv: typeof PI_HOST_HOOKS_MODULE_ENV;
		legacyModuleEnv: typeof PI_LEGACY_FETCH_INTERCEPTOR_MODULE_ENV;
		exports: string[];
	};
}

/**
 * Host-provided tool definition for the `register_tools` command.
 *
 * The agent registers the tool and proxies every execution back to the host
 * as a `tool_execute_request`. `inputSchema` is a JSON Schema object (TypeBox
 * schemas are JSON Schema, so plain JSON Schema is accepted at runtime).
 */
export interface RpcHostToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** Human-readable label for UI. Defaults to a prettified name. */
	label?: string;
	/** One-line snippet for the system prompt's Available tools section. Defaults to a truncated description. */
	promptSnippet?: string;
}

export type RpcToolResultContent =
	| { type: "text"; text: string; textSignature?: string }
	| { type: "image"; data: string; mimeType: string };

export interface RpcHostToolResult {
	content: string | RpcToolResultContent[];
	details?: unknown;
	isError?: boolean;
	terminate?: boolean;
}

export interface RpcExtensionCommandResult {
	invoked: boolean;
	error?: string;
}

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "run_mini_completion"; success: true; data: { text: string | null } }
	| { id?: string; type: "response"; command: "query_llm"; success: true; data: RpcLLMQueryResult }

	// State
	| { id?: string; type: "response"; command: "get_capabilities"; success: true; data: RpcCapabilities }
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| {
			id?: string;
			type: "response";
			command: "list_child_sessions";
			success: true;
			data: { sessions: RpcChildSessionInfo[] };
	  }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Tool permissions
	| { id?: string; type: "response"; command: "enable_tool_permissions"; success: true }

	// Host proxy tools
	| { id?: string; type: "response"; command: "register_tools"; success: true; data: { registered: string[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "invoke_extension_command";
			success: true;
			data: RpcExtensionCommandResult;
	  }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Tool Permission Events (stdout) / Responses (stdin)
// ============================================================================

/**
 * Emitted before a tool executes when the host has enabled the permission
 * gate (`enable_tool_permissions`). The host must reply with a
 * `tool_permission_response` carrying the same `id`.
 */
export interface RpcToolPermissionRequest {
	type: "tool_permission_request";
	id: string;
	toolName: string;
	toolCallId: string;
	/** Tool input after extension tool_call handlers have run. */
	input: Record<string, unknown>;
}

/** Host reply to a `tool_permission_request`. */
export type RpcToolPermissionResponse =
	| { type: "tool_permission_response"; id: string; action: "allow" }
	| { type: "tool_permission_response"; id: string; action: "block"; reason?: string }
	| { type: "tool_permission_response"; id: string; action: "modify"; input: Record<string, unknown> };

// ============================================================================
// Host Proxy Tool Execution (stdout request / stdin response)
// ============================================================================

/**
 * Emitted when a host-registered tool (see `register_tools`) is called by the
 * LLM. The host executes the tool in its own process and replies with a
 * `tool_execute_response` carrying the same `id`.
 */
export interface RpcToolExecuteRequest {
	type: "tool_execute_request";
	id: string;
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

/** Host reply to a `tool_execute_request`. */
export interface RpcToolExecuteResponse {
	type: "tool_execute_response";
	id: string;
	/** Tool result content. String is accepted as shorthand for one text block. */
	content: string | RpcToolResultContent[];
	details?: unknown;
	isError?: boolean;
	terminate?: boolean;
}

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
