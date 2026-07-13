/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, StopReason, Usage, UserAttachmentMetadata } from "@earendil-works/pi-ai/types";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type {
	ExtensionInteractionCancelReasonV1,
	ExtensionInteractionRequestV1,
	ExtensionInteractionResponseV1,
	ExtensionUIContribution,
} from "../../core/extensions/types.ts";
import type { GlobalBackgroundTaskSnapshot } from "../../core/global-background-tasks.ts";
import type {
	HostExtensionsResult,
	HostGlobalConfig,
	HostGlobalProvider,
	HostModelCatalog,
	HostResolvedSkill,
	HostSessionProjection,
	HostSkillsResult,
} from "../../core/host-facade.ts";
import type { SessionHeader } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";

export const PI_RPC_PROTOCOL_VERSION = 3;
export const PI_HOST_HOOKS_MODULE_ENV = "PI_HOST_HOOKS_MODULE";
export const PI_LEGACY_FETCH_INTERCEPTOR_MODULE_ENV = "PI_FETCH_INTERCEPTOR_MODULE";
export const PI_RPC_UI_CAPABILITIES_ENV = "PI_RPC_UI_CAPABILITIES";

export const PI_RPC_COMMANDS = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"run_mini_completion",
	"query_llm",
	"get_capabilities",
	"open_runtime",
	"close_runtime",
	"get_runtime_state",
	"list_runtimes",
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
	"reload_extensions",
	"get_global_config",
	"save_global_provider",
	"delete_global_provider",
	"set_global_default",
	"set_craft_credential",
	"get_session_projection",
	"set_craft_session_metadata",
	"fork_session",
	"list_skills",
	"resolve_skill",
	"get_extensions",
	"set_extension_config",
	"get_model_catalog",
] as const;

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export interface RpcEnvelope {
	clientId?: string;
	runtimeId?: string;
	/** Trusted active session owner injected by Pi on events and echoed by hosts in responses. */
	sessionId?: string;
}

/** Host-renderable UI features explicitly offered to one RPC runtime. */
export interface RpcHostUICapabilities {
	kind: "craft" | "none";
	dialogs: boolean;
	widgets: boolean;
	editorControl: boolean;
	contributions: boolean;
	interactionSchemas: number[];
}

export interface RpcRuntimeOpenOptions {
	runtimeId?: string;
	cwd: string;
	extensionTarget: "pi" | "craft";
	extensionPaths?: string[];
	agentDir?: string;
	sessionPath?: string;
	forkFromSessionPath?: string;
	sessionDir?: string;
	sessionId?: string;
	parentSession?: string;
	deferResourceLoad?: boolean;
	persistInitialState?: boolean;
	/** Omit to expose no host UI. Extension target selection does not imply UI support. */
	uiCapabilities?: RpcHostUICapabilities;
}

export interface RpcRuntimeSummary {
	runtimeId: string;
	clientId?: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	isStreaming: boolean;
}

export type RpcCommand = RpcEnvelope &
	// Prompting
	(
		| {
				id?: string;
				type: "prompt";
				message: string;
				images?: ImageContent[];
				streamingBehavior?: "steer" | "followUp";
				/** Host-generated identity preserved on the persisted user message. */
				clientMutationId?: string;
				/** Sanitized display metadata only; paths and attachment contents are forbidden. */
				attachments?: UserAttachmentMetadata[];
				/** Host system-prompt override for this turn onward (see PromptOptions.systemPrompt). */
				systemPrompt?: string;
		  }
		| { id?: string; type: "steer"; message: string; images?: ImageContent[]; clientMutationId?: string }
		| { id?: string; type: "follow_up"; message: string; images?: ImageContent[]; clientMutationId?: string }
		| { id?: string; type: "abort" }
		| { id?: string; type: "new_session"; parentSession?: string }
		| { id?: string; type: "run_mini_completion"; prompt: string }
		| { id?: string; type: "query_llm"; request: RpcLLMQueryRequest }

		// State
		| { id?: string; type: "get_capabilities" }
		| ({ id?: string; type: "open_runtime" } & RpcRuntimeOpenOptions)
		| { id?: string; type: "close_runtime" }
		| { id?: string; type: "get_runtime_state" }
		| { id?: string; type: "list_runtimes" }
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
		| { id?: string; type: "invoke_extension_command"; commandId: string; args?: string; ownerExtensionId?: string }
		| { id?: string; type: "reload_extensions" }

		// Host facade (config/credentials/session/resources)
		| { id?: string; type: "get_global_config" }
		| { id?: string; type: "save_global_provider"; key: string; provider: HostGlobalProvider; apiKey?: string }
		| { id?: string; type: "delete_global_provider"; key: string }
		| {
				id?: string;
				type: "set_global_default";
				provider: string;
				model: string;
				thinkingLevel?: string;
				cwd?: string;
		  }
		| { id?: string; type: "set_craft_credential"; slug: string; credential: unknown }
		| { id?: string; type: "get_session_projection"; sessionPath: string; sessionDir?: string; cwdOverride?: string }
		| {
				id?: string;
				type: "set_craft_session_metadata";
				sessionPath: string;
				sessionDir?: string;
				cwdOverride?: string;
				name?: string;
				metadata?: unknown;
				customType?: string;
		  }
		| {
				id?: string;
				type: "fork_session";
				sourcePath: string;
				targetCwd: string;
				sessionDir?: string;
				idOverride?: string;
				parentSession?: string;
		  }
		| { id?: string; type: "list_skills"; cwd?: string; agentDir?: string; skillPaths?: string[] }
		| { id?: string; type: "resolve_skill"; name: string; cwd?: string; agentDir?: string; skillPaths?: string[] }
		| { id?: string; type: "get_extensions"; cwd?: string; agentDir?: string }
		| { id?: string; type: "set_extension_config"; name: string; config: Record<string, unknown> }
		| { id?: string; type: "get_model_catalog"; provider?: string }
	);

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
		extensionHostCapabilities: boolean;
		secondaryLlmQuery: boolean;
		childSessionListing: boolean;
		multiRuntime: boolean;
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
	/** Custom messages synchronously published by the command before its ack. */
	customMessages?: Array<Extract<AgentMessage, { role: "custom" }>>;
}

export interface RpcBackgroundTaskEvent {
	type: "background_task_event";
	task: GlobalBackgroundTaskSnapshot;
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
	/** Stable extension owner for host-side action authorization. */
	extensionId?: string;
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
export type RpcResponse = RpcEnvelope &
	// Prompting (async - events follow)
	(
		| { id?: string; type: "response"; command: "prompt"; success: true }
		| { id?: string; type: "response"; command: "steer"; success: true }
		| { id?: string; type: "response"; command: "follow_up"; success: true }
		| { id?: string; type: "response"; command: "abort"; success: true }
		| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
		| { id?: string; type: "response"; command: "run_mini_completion"; success: true; data: { text: string | null } }
		| { id?: string; type: "response"; command: "query_llm"; success: true; data: RpcLLMQueryResult }

		// State
		| { id?: string; type: "response"; command: "get_capabilities"; success: true; data: RpcCapabilities }
		| { id?: string; type: "response"; command: "open_runtime"; success: true; data: RpcRuntimeSummary }
		| { id?: string; type: "response"; command: "close_runtime"; success: true; data: { closed: boolean } }
		| {
				id?: string;
				type: "response";
				command: "get_runtime_state";
				success: true;
				data: { runtime: RpcRuntimeSummary; state: RpcSessionState };
		  }
		| {
				id?: string;
				type: "response";
				command: "list_runtimes";
				success: true;
				data: { runtimes: RpcRuntimeSummary[] };
		  }
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
		| {
				id?: string;
				type: "response";
				command: "reload_extensions";
				success: true;
				data: { reloaded: boolean; deferred: boolean };
		  }

		// Host facade
		| { id?: string; type: "response"; command: "get_global_config"; success: true; data: HostGlobalConfig }
		| { id?: string; type: "response"; command: "save_global_provider"; success: true }
		| { id?: string; type: "response"; command: "delete_global_provider"; success: true }
		| { id?: string; type: "response"; command: "set_global_default"; success: true }
		| { id?: string; type: "response"; command: "set_craft_credential"; success: true }
		| {
				id?: string;
				type: "response";
				command: "get_session_projection";
				success: true;
				data: HostSessionProjection;
		  }
		| {
				id?: string;
				type: "response";
				command: "set_craft_session_metadata";
				success: true;
				data: HostSessionProjection;
		  }
		| { id?: string; type: "response"; command: "fork_session"; success: true; data: HostSessionProjection }
		| { id?: string; type: "response"; command: "list_skills"; success: true; data: HostSkillsResult }
		| { id?: string; type: "response"; command: "resolve_skill"; success: true; data: HostResolvedSkill | null }
		| { id?: string; type: "response"; command: "get_extensions"; success: true; data: HostExtensionsResult }
		| { id?: string; type: "response"; command: "set_extension_config"; success: true }
		| { id?: string; type: "response"; command: "get_model_catalog"; success: true; data: HostModelCatalog }

		// Error response (any command can fail)
		| {
				id?: string;
				type: "response";
				command: string;
				success: false;
				error: string;
				errorKind?: string;
				userMessage?: string;
				recoverable?: boolean;
		  }
	);

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest = RpcEnvelope & { extensionId: string } & (
		| {
				type: "extension_ui_request";
				id: string;
				method: "interact";
				request: ExtensionInteractionRequestV1;
				timeout?: number;
		  }
		| {
				type: "extension_ui_request";
				id: string;
				method: "select";
				title: string;
				options: string[];
				timeout?: number;
		  }
		| {
				type: "extension_ui_request";
				id: string;
				method: "confirm";
				title: string;
				message: string;
				timeout?: number;
		  }
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
		| {
				type: "extension_ui_request";
				id: string;
				method: "contribution";
				operation: "upsert";
				revision: number;
				contribution: ExtensionUIContribution;
		  }
		| {
				type: "extension_ui_request";
				id: string;
				method: "contribution";
				operation: "remove";
				revision: number;
				contributionId: string;
		  }
		| {
				type: "extension_ui_request";
				id: string;
				method: "contribution";
				operation: "reset";
				revision: number;
		  }
		| {
				type: "extension_ui_request";
				id: string;
				method: "contribution";
				operation: "snapshot";
				revision: number;
				contributions: ExtensionUIContribution[];
		  }
		| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
		| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	);

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse = RpcEnvelope &
	(
		| {
				type: "extension_ui_response";
				id: string;
				extensionId: string;
				interaction: ExtensionInteractionResponseV1;
		  }
		| { type: "extension_ui_response"; id: string; value: string }
		| { type: "extension_ui_response"; id: string; confirmed: boolean }
		| { type: "extension_ui_response"; id: string; cancelled: true }
	);

/** Emitted when Pi settles an interaction before the host responds. */
export interface RpcExtensionUICancel extends RpcEnvelope {
	type: "extension_ui_cancel";
	id: string;
	extensionId: string;
	schemaVersion: 1;
	reason: Exclude<ExtensionInteractionCancelReasonV1, "user">;
	/** Dialog method being dismissed. Omitted by older interaction-v1 producers. */
	method?: "interact" | "select" | "confirm" | "input" | "editor";
}

// ============================================================================
// Extension Host Capabilities (stdout request / stdin response)
// ============================================================================

export interface RpcExtensionHostCapabilityDeclaration extends RpcEnvelope {
	type: "extension_host_capability_declaration";
	version: 1;
	extensionId: string;
	declarations: Array<{ capability: string; operations: string[] }>;
}

export interface RpcExtensionHostCapabilityRequest extends RpcEnvelope {
	type: "extension_host_capability_request";
	version: 1;
	id: string;
	extensionId: string;
	capability: string;
	operation: string;
	input?: unknown;
	timeoutMs?: number;
}

export interface RpcExtensionHostCapabilityCancel extends RpcEnvelope {
	type: "extension_host_capability_cancel";
	version: 1;
	id: string;
	extensionId: string;
}

export interface RpcExtensionHostCapabilityProgress extends RpcEnvelope {
	type: "extension_host_capability_progress";
	version: 1;
	id: string;
	sequence: number;
	progress: unknown;
}

export type RpcExtensionHostCapabilityResponse = RpcEnvelope &
	({ type: "extension_host_capability_response"; version: 1; id: string } & (
		| { status: "success"; output: unknown }
		| {
				status: "denied" | "cancelled" | "unsupported" | "failed";
				error?: { code: string; message: string; recoverable?: boolean };
		  }
	));

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
	clientId?: string;
	runtimeId?: string;
	toolName: string;
	toolCallId: string;
	/** Tool input after extension tool_call handlers have run. */
	input: Record<string, unknown>;
}

/** Host reply to a `tool_permission_request`. */
export type RpcToolPermissionResponse = RpcEnvelope &
	(
		| { type: "tool_permission_response"; id: string; action: "allow" }
		| { type: "tool_permission_response"; id: string; action: "block"; reason?: string }
		| { type: "tool_permission_response"; id: string; action: "modify"; input: Record<string, unknown> }
	);

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
	clientId?: string;
	runtimeId?: string;
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

/** Host reply to a `tool_execute_request`. */
export interface RpcToolExecuteResponse {
	type: "tool_execute_response";
	id: string;
	clientId?: string;
	runtimeId?: string;
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
