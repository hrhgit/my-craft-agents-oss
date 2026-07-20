/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@mortise/pi-agent-core";
import type { ImageContent } from "@mortise/pi-ai/types";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import { PI_GLOBAL_HOST_INSTANCE_ID_ENV, readPiGlobalHostState } from "../../core/global-host-state.ts";
import type {
	HostExtensionsResult,
	HostGlobalConfig,
	HostGlobalProvider,
	HostModelCatalog,
	HostResolvedSkill,
	HostSessionProjection,
	HostSkillsResult,
} from "../../core/host-facade.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcBackgroundTaskEvent,
	RpcCapabilities,
	RpcChildSessionInfo,
	RpcCommand,
	RpcCommandType,
	RpcEnvelope,
	RpcExtensionCommandResult,
	RpcExtensionHostCapabilityCancel,
	RpcExtensionHostCapabilityDeclaration,
	RpcExtensionHostCapabilityProgress,
	RpcExtensionHostCapabilityRequest,
	RpcExtensionHostCapabilityResponse,
	RpcExtensionHostCapabilityRouteRejected,
	RpcExtensionUICancel,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcExtensionUIValidationEvent,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcLLMQueryRequest,
	RpcLLMQueryResult,
	RpcResponse,
	RpcRuntimeOpenOptions,
	RpcRuntimeSummary,
	RpcSessionState,
	RpcSlashCommand,
	RpcToolExecuteRequest,
	RpcToolExecuteResponse,
	RpcToolPermissionRequest,
	RpcToolPermissionResponse,
	RpcToolResultRequest,
	RpcToolResultResponse,
} from "./rpc-types.ts";
import { PI_HOST_HOOKS_MODULE_ENV, PI_LEGACY_FETCH_INTERCEPTOR_MODULE_ENV } from "./rpc-types.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;
type RpcRuntimeCommandBody = DistributiveOmit<RpcCommand, "id" | "runtimeId" | "clientId">;
type RpcWritable = NodeJS.WritableStream & { destroyed: boolean; writable: boolean };

export interface RpcClientOptions {
	/** Discover and connect to an existing user-level Pi GlobalHost before spawning. */
	globalHost?: { enabled: boolean; agentDir?: string; instanceId?: string };
	/** Command used to launch the CLI entry point (default: node) */
	command?: string;
	/** Arguments placed before the CLI entry point, useful for tsx/register-based dev runs */
	commandArgs?: string[];
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Launch command itself as the Pi executable, without inserting a CLI entry-point argument. */
	directExecutable?: boolean;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/**
	 * How to build the child process environment.
	 *
	 * - inherit: process.env is merged first, then env overrides (default).
	 * - replace: env is used as the full child environment.
	 */
	envMode?: "inherit" | "replace";
	/**
	 * Optional host hooks module loaded inside the RPC subprocess.
	 *
	 * The module may export `fetchInterceptor`/`createFetchInterceptor` and/or
	 * `toolMetadataResolver`/`createToolMetadataResolver`.
	 */
	hostHooksModule?: string;
	/**
	 * @deprecated Use `hostHooksModule`. Kept as an alias for older embedders.
	 */
	fetchInterceptorModule?: string;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Mirror child stderr to the parent stderr (default: true) */
	pipeStderr?: boolean;
}

export interface ConnectPiGlobalHostOptions extends Omit<RpcClientOptions, "globalHost"> {
	agentDir?: string;
	instanceId?: string;
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export interface RpcExtensionErrorEvent {
	type: "extension_error";
	clientId?: string;
	runtimeId?: string;
	extensionId: string;
	extensionPath: string;
	event: string;
	error: string;
}

export type RpcProcessLifecycleEvent =
	| { type: "process_exit"; code: number | null; signal: string | null; message: string; stderr: string }
	| { type: "process_error"; message: string; stderr: string }
	| { type: "stdin_error"; message: string; stderr: string };

export type RpcClientEvent =
	| (AgentEvent & RpcEnvelope)
	| RpcBackgroundTaskEvent
	| RpcExtensionUIRequest
	| RpcExtensionUICancel
	| RpcExtensionHostCapabilityDeclaration
	| RpcExtensionHostCapabilityRequest
	| RpcExtensionHostCapabilityCancel
	| RpcExtensionHostCapabilityRouteRejected
	| RpcExtensionUIValidationEvent
	| RpcExtensionErrorEvent
	| RpcProcessLifecycleEvent
	| RpcToolPermissionRequest
	| RpcToolResultRequest
	| RpcToolExecuteRequest;
export type RpcEventListener = (event: AgentEvent & RpcEnvelope) => void;
export type RpcClientEventListener = (event: RpcClientEvent) => void;

/** Host-side permission handler invoked for every tool_permission_request. */
export type RpcToolPermissionHandler = (
	request: RpcToolPermissionRequest,
) => Promise<
	{ action: "allow" } | { action: "block"; reason?: string } | { action: "modify"; input: Record<string, unknown> }
>;

/** Host-side observer invoked for every finalized tool_result_request. */
export type RpcToolResultHandler = (request: RpcToolResultRequest) => Promise<void>;

/** Host-side executor invoked for every tool_execute_request (host proxy tools). */
export type RpcToolExecutor = (request: RpcToolExecuteRequest) => Promise<RpcHostToolResult>;

export type LLMQueryRequest = RpcLLMQueryRequest;
export type LLMQueryResult = RpcLLMQueryResult;
export type PiChildSessionInfo = RpcChildSessionInfo;

const SECONDARY_LLM_TIMEOUT_MS = 120000;

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private socket: Socket | null = null;
	private spawnedGlobalHost = false;
	private readonly clientId = randomUUID();
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private clientEventListeners: RpcClientEventListener[] = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private options: RpcClientOptions;
	private toolPermissionHandler: RpcToolPermissionHandler | null = null;
	private toolResultHandler: RpcToolResultHandler | null = null;
	private toolExecutor: RpcToolExecutor | null = null;
	private runtimeToolPermissionHandlers = new Map<string, RpcToolPermissionHandler>();
	private runtimeToolResultHandlers = new Map<string, RpcToolResultHandler>();
	private runtimeToolExecutors = new Map<string, RpcToolExecutor>();
	private extensionUIOwners = new Map<
		string,
		{ clientId?: string; runtimeId?: string; sessionId?: string; extensionId: string }
	>();

	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process || this.socket) {
			throw new Error("Client already started");
		}

		this.exitError = null;
		if (this.options.globalHost?.enabled) {
			const state = readPiGlobalHostState(this.options.globalHost.agentDir, this.options.globalHost.instanceId);
			if (state && (await this.connectToGlobalHost(state.port, state.token))) return;
		}

		const command = this.options.command ?? "node";
		const commandArgs = this.options.commandArgs ?? [];
		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const hostHooksModule = this.options.hostHooksModule ?? this.options.fetchInterceptorModule;
		const baseEnv = this.options.envMode === "replace" ? {} : process.env;
		const env = {
			...baseEnv,
			...this.options.env,
			...(this.options.globalHost?.enabled ? { PI_GLOBAL_HOST_PROCESS: "1" } : {}),
			...(this.options.globalHost?.instanceId
				? { [PI_GLOBAL_HOST_INSTANCE_ID_ENV]: this.options.globalHost.instanceId }
				: {}),
			...(hostHooksModule
				? {
						[PI_HOST_HOOKS_MODULE_ENV]: hostHooksModule,
						[PI_LEGACY_FETCH_INTERCEPTOR_MODULE_ENV]: hostHooksModule,
					}
				: {}),
		};

		const launchArgs = this.options.directExecutable ? [...commandArgs, ...args] : [...commandArgs, cliPath, ...args];
		const childProcess = spawn(command, launchArgs, {
			cwd: this.options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;
		this.spawnedGlobalHost = this.options.globalHost?.enabled === true;

		// Collect stderr for debugging
		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			if (this.options.pipeStderr !== false) {
				process.stderr.write(data);
			}
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.emitClientEvent({
				type: "process_exit",
				code,
				signal,
				message: error.message,
				stderr: this.stderr,
			});
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.emitClientEvent({
				type: "process_error",
				message: processError.message,
				stderr: this.stderr,
			});
			this.rejectPendingRequests(processError);
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.emitClientEvent({
				type: "stdin_error",
				message: stdinError.message,
				stderr: this.stderr,
			});
			this.rejectPendingRequests(stdinError);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (this.socket) {
			const socket = this.socket;
			this.socket = null;
			this.stopReadingStdout?.();
			this.stopReadingStdout = null;
			socket.end();
			socket.destroy();
			this.rejectPendingRequests(new Error("Pi GlobalHost client stopped"));
			return;
		}
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		if (this.spawnedGlobalHost) {
			const childProcess = this.process;
			childProcess.stdin?.end();
			childProcess.stdout?.destroy();
			childProcess.stderr?.destroy();
			childProcess.unref();
			this.process = null;
			this.spawnedGlobalHost = false;
			this.pendingRequests.clear();
			return;
		}
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.pendingRequests.clear();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to all client events, including extension UI events.
	 */
	onClientEvent(listener: RpcClientEventListener): () => void {
		this.clientEventListeners.push(listener);
		return () => {
			const index = this.clientEventListeners.indexOf(listener);
			if (index !== -1) {
				this.clientEventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Get the RPC protocol and feature capabilities exposed by the subprocess.
	 */
	async getCapabilities(): Promise<RpcCapabilities> {
		const response = await this.send({ type: "get_capabilities" });
		return this.getData<RpcCapabilities>(response);
	}

	/**
	 * Convenience helper for embedders that want to gate optional commands.
	 */
	async supportsCommand(command: RpcCommandType): Promise<boolean> {
		const capabilities = await this.getCapabilities();
		return capabilities.commands.includes(command);
	}

	/** Open an independent session runtime on the already-running RPC process. */
	async openRuntime(options: RpcRuntimeOpenOptions): Promise<PiRuntimeHandle> {
		const response = await this.send({
			type: "open_runtime",
			...options,
			runtimeId: options.runtimeId ?? randomUUID(),
		});
		return new PiRuntimeHandle(this, this.getData<RpcRuntimeSummary>(response));
	}

	async closeRuntime(runtimeId: string): Promise<boolean> {
		const response = await this.send({ type: "close_runtime", runtimeId });
		this.runtimeToolPermissionHandlers.delete(runtimeId);
		this.runtimeToolResultHandlers.delete(runtimeId);
		this.runtimeToolExecutors.delete(runtimeId);
		return this.getData<{ closed: boolean }>(response).closed;
	}

	async getRuntimeState(runtimeId: string): Promise<{ runtime: RpcRuntimeSummary; state: RpcSessionState }> {
		const response = await this.send({ type: "get_runtime_state", runtimeId });
		return this.getData(response);
	}

	async listRuntimes(): Promise<RpcRuntimeSummary[]> {
		const response = await this.send({ type: "list_runtimes" });
		return this.getData<{ runtimes: RpcRuntimeSummary[] }>(response).runtimes;
	}

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(
		message: string,
		images?: ImageContent[],
		options?: {
			systemPrompt?: string;
			clearSystemPrompt?: boolean;
			appendSystemPrompt?: string;
			clientMutationId?: string;
			attachments?: import("@mortise/pi-ai/types").UserAttachmentMetadata[];
		},
	): Promise<void> {
		await this.send({
			type: "prompt",
			message,
			images,
			systemPrompt: options?.systemPrompt,
			clearSystemPrompt: options?.clearSystemPrompt,
			appendSystemPrompt: options?.appendSystemPrompt,
			clientMutationId: options?.clientMutationId,
			attachments: options?.attachments,
		});
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[], options?: { clientMutationId?: string }): Promise<void> {
		await this.send({ type: "steer", message, images, clientMutationId: options?.clientMutationId });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[], options?: { clientMutationId?: string }): Promise<void> {
		await this.send({ type: "follow_up", message, images, clientMutationId: options?.clientMutationId });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Respond to an extension UI request emitted by an RPC worker.
	 */
	respondToExtensionUI(response: RpcExtensionUIResponse): void {
		const stdin = this.getWritableInput();
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new Error("Client not started");
		}
		const owner = this.extensionUIOwners.get(response.id);
		stdin.write(serializeJsonLine(owner ? { ...response, ...owner } : response));
		if (owner) this.extensionUIOwners.delete(response.id);
	}

	/** Respond to a host capability request emitted by an extension. */
	respondToExtensionHostCapability(response: RpcExtensionHostCapabilityResponse): void {
		const stdin = this.getWritableInput();
		if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("Client not started");
		stdin.write(serializeJsonLine(response));
	}

	reportExtensionHostCapabilityProgress(progress: RpcExtensionHostCapabilityProgress): void {
		const stdin = this.getWritableInput();
		if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("Client not started");
		stdin.write(serializeJsonLine(progress));
	}

	/**
	 * Install a host-side tool permission gate.
	 *
	 * Sends `enable_tool_permissions` to the agent; every subsequent tool call
	 * emits a `tool_permission_request` which is routed to `handler`. The
	 * handler's result is sent back as a `tool_permission_response`. Pass
	 * `null` to disable the gate.
	 */
	async setToolPermissionHandler(handler: RpcToolPermissionHandler | null): Promise<void> {
		this.toolPermissionHandler = handler;
		await this.send({ type: "enable_tool_permissions", enabled: handler !== null });
	}

	/** Install a host-side observer for finalized tool results. */
	async setToolResultHandler(handler: RpcToolResultHandler | null): Promise<void> {
		this.toolResultHandler = handler;
		await this.send({ type: "enable_tool_results", enabled: handler !== null });
	}

	/**
	 * Register host proxy tools with the agent.
	 *
	 * Each declared tool becomes available to the LLM; execution is proxied
	 * back to `executor` via `tool_execute_request`/`tool_execute_response`.
	 * Calling again replaces tools by name and swaps the executor.
	 */
	async registerTools(tools: RpcHostToolDefinition[], executor: RpcToolExecutor): Promise<string[]> {
		this.toolExecutor = executor;
		const response = await this.send({ type: "register_tools", tools });
		const data = this.getData<{ registered: string[] }>(response);
		return data.registered;
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Run a small secondary completion using the current Pi model/auth.
	 * Does not append to the active session transcript.
	 */
	async runMiniCompletion(prompt: string): Promise<string | null> {
		const response = await this.send({ type: "run_mini_completion", prompt }, SECONDARY_LLM_TIMEOUT_MS);
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Run a secondary LLM query using Pi provider runtime.
	 * Does not append to the active session transcript.
	 */
	async queryLlm(request: RpcLLMQueryRequest): Promise<RpcLLMQueryResult> {
		const response = await this.send({ type: "query_llm", request }, SECONDARY_LLM_TIMEOUT_MS);
		return this.getData<RpcLLMQueryResult>(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	async setActiveTools(toolNames: string[]): Promise<void> {
		await this.send({ type: "set_active_tools", toolNames });
	}

	async setCompactionPrompt(prompt?: string): Promise<void> {
		await this.send({ type: "set_compaction_prompt", prompt });
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * List child sessions whose Pi session header has spawnedFrom=parentSessionId.
	 */
	async listChildSessions(parentSessionId: string): Promise<RpcChildSessionInfo[]> {
		const response = await this.send({ type: "list_child_sessions", parentSessionId });
		return this.getData<{ sessions: RpcChildSessionInfo[] }>(response).sessions;
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	/**
	 * Invoke a Pi extension command directly, without encoding it as a slash prompt.
	 */
	async invokeExtensionCommandResult(
		commandId: string,
		args?: string,
		ownerExtensionId?: string,
	): Promise<RpcExtensionCommandResult> {
		const response = await this.send({
			type: "invoke_extension_command",
			commandId,
			args,
			...(ownerExtensionId !== undefined ? { ownerExtensionId } : {}),
		});
		return this.getData<RpcExtensionCommandResult>(response);
	}

	/**
	 * Invoke a Pi extension command and return only the legacy boolean ack.
	 */
	async invokeExtensionCommand(commandId: string, args?: string, ownerExtensionId?: string): Promise<boolean> {
		return (await this.invokeExtensionCommandResult(commandId, args, ownerExtensionId)).invoked;
	}

	/**
	 * Read Pi-owned global host config: providers, settings, display metadata,
	 * and Mortise opaque metadata stored under Pi's models.json.
	 */
	async getGlobalConfig(): Promise<HostGlobalConfig> {
		const response = await this.send({ type: "get_global_config" });
		return this.getData<HostGlobalConfig>(response);
	}

	/**
	 * Save or replace a Pi global provider. Credentials are persisted via Pi
	 * AuthStorage; masked placeholders are ignored by the facade.
	 */
	async saveGlobalProvider(key: string, provider: HostGlobalProvider, apiKey?: string): Promise<void> {
		await this.send({ type: "save_global_provider", key, provider, apiKey });
	}

	async deleteGlobalProvider(key: string): Promise<void> {
		await this.send({ type: "delete_global_provider", key });
	}

	async setGlobalDefault(provider: string, model: string, thinkingLevel?: string, cwd?: string): Promise<void> {
		await this.send({ type: "set_global_default", provider, model, thinkingLevel, cwd });
	}

	async setCraftCredential(slug: string, credential: unknown): Promise<void> {
		await this.send({ type: "set_mortise_credential", slug, credential });
	}

	async getSessionProjection(
		sessionPath: string,
		options: { sessionDir?: string; cwdOverride?: string } = {},
	): Promise<HostSessionProjection> {
		const response = await this.send({
			type: "get_session_projection",
			sessionPath,
			sessionDir: options.sessionDir,
			cwdOverride: options.cwdOverride,
		});
		return this.getData<HostSessionProjection>(response);
	}

	async setCraftSessionMetadata(
		sessionPath: string,
		options: { sessionDir?: string; cwdOverride?: string; name?: string; metadata?: unknown; customType?: string },
	): Promise<HostSessionProjection> {
		const response = await this.send({
			type: "set_mortise_session_metadata",
			sessionPath,
			sessionDir: options.sessionDir,
			cwdOverride: options.cwdOverride,
			name: options.name,
			metadata: options.metadata,
			customType: options.customType,
		});
		return this.getData<HostSessionProjection>(response);
	}

	async forkSession(
		sourcePath: string,
		targetCwd: string,
		options: { sessionDir?: string; id?: string; parentSession?: string } = {},
	): Promise<HostSessionProjection> {
		const response = await this.send({
			type: "fork_session",
			sourcePath,
			targetCwd,
			sessionDir: options.sessionDir,
			idOverride: options.id,
			parentSession: options.parentSession,
		});
		return this.getData<HostSessionProjection>(response);
	}

	async listSkills(
		options: { cwd?: string; agentDir?: string; skillPaths?: string[] } = {},
	): Promise<HostSkillsResult> {
		const response = await this.send({
			type: "list_skills",
			cwd: options.cwd,
			agentDir: options.agentDir,
			skillPaths: options.skillPaths,
		});
		return this.getData<HostSkillsResult>(response);
	}

	async resolveSkill(
		name: string,
		options: { cwd?: string; agentDir?: string; skillPaths?: string[] } = {},
	): Promise<HostResolvedSkill | null> {
		const response = await this.send({
			type: "resolve_skill",
			name,
			cwd: options.cwd,
			agentDir: options.agentDir,
			skillPaths: options.skillPaths,
		});
		return this.getData<HostResolvedSkill | null>(response);
	}

	async getExtensions(options: { cwd?: string; agentDir?: string } = {}): Promise<HostExtensionsResult> {
		const response = await this.send({ type: "get_extensions", cwd: options.cwd, agentDir: options.agentDir });
		return this.getData<HostExtensionsResult>(response);
	}

	async setExtensionConfig(name: string, config: Record<string, unknown>): Promise<void> {
		await this.send({ type: "set_extension_config", name, config });
	}

	async reloadExtensions(): Promise<{ reloaded: boolean; deferred: boolean }> {
		const response = await this.send({ type: "reload_extensions" });
		return this.getData<{ reloaded: boolean; deferred: boolean }>(response);
	}

	async getModelCatalog(provider?: string): Promise<HostModelCatalog> {
		const response = await this.send({ type: "get_model_catalog", provider });
		return this.getData<HostModelCatalog>(response);
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/** @internal Shared transport entry point used by PiRuntimeHandle. */
	requestRuntime(runtimeId: string, command: RpcRuntimeCommandBody, timeoutMs?: number): Promise<RpcResponse> {
		return this.send({ ...command, runtimeId } as RpcCommandBody, timeoutMs);
	}

	/** @internal Decode a typed response for PiRuntimeHandle. */
	readResponseData<T>(response: RpcResponse): T {
		return this.getData<T>(response);
	}

	/** @internal Install a runtime-scoped permission handler. */
	async setRuntimeToolPermissionHandler(runtimeId: string, handler: RpcToolPermissionHandler | null): Promise<void> {
		if (handler) this.runtimeToolPermissionHandlers.set(runtimeId, handler);
		else this.runtimeToolPermissionHandlers.delete(runtimeId);
		await this.requestRuntime(runtimeId, { type: "enable_tool_permissions", enabled: handler !== null });
	}

	/** @internal Install a runtime-scoped finalized tool-result observer. */
	async setRuntimeToolResultHandler(runtimeId: string, handler: RpcToolResultHandler | null): Promise<void> {
		if (handler) this.runtimeToolResultHandlers.set(runtimeId, handler);
		else this.runtimeToolResultHandlers.delete(runtimeId);
		await this.requestRuntime(runtimeId, { type: "enable_tool_results", enabled: handler !== null });
	}

	/** @internal Register tools without replacing another runtime's executor. */
	async registerRuntimeTools(
		runtimeId: string,
		tools: RpcHostToolDefinition[],
		executor: RpcToolExecutor,
	): Promise<string[]> {
		this.runtimeToolExecutors.set(runtimeId, executor);
		const response = await this.requestRuntime(runtimeId, { type: "register_tools", tools });
		return this.getData<{ registered: string[] }>(response).registered;
	}

	/** @internal Send an extension UI response to one runtime. */
	respondToRuntimeExtensionUI(runtimeId: string, sessionId: string, response: RpcExtensionUIResponse): void {
		this.respondToExtensionUI({ ...response, runtimeId, sessionId });
	}

	/** @internal Send an extension host capability response to one runtime. */
	respondToRuntimeExtensionHostCapability(
		runtimeId: string,
		sessionId: string,
		response: RpcExtensionHostCapabilityResponse,
	): void {
		this.respondToExtensionHostCapability({ ...response, runtimeId, sessionId });
	}

	reportRuntimeExtensionHostCapabilityProgress(
		runtimeId: string,
		sessionId: string,
		progress: RpcExtensionHostCapabilityProgress,
	): void {
		this.reportExtensionHostCapabilityProgress({ ...progress, runtimeId, sessionId });
	}

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		return new Promise((resolve, reject) => {
			const events: AgentEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private getWritableInput(): RpcWritable | null {
		return (this.socket ?? this.process?.stdin ?? null) as RpcWritable | null;
	}

	private connectToGlobalHost(port: number, token: string): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = connect({ host: "127.0.0.1", port });
			let authenticated = false;
			let settled = false;
			const timer = setTimeout(() => finish(false), 1_500);
			const detachReader = attachJsonlLineReader(socket, (line) => {
				if (!authenticated) {
					try {
						const message = JSON.parse(line) as { type?: string; clientId?: string };
						if (message.type === "host_connected" && message.clientId === this.clientId) {
							authenticated = true;
							this.socket = socket;
							this.stopReadingStdout = detachReader;
							finish(true);
						}
					} catch {
						finish(false);
					}
					return;
				}
				this.handleLine(line);
			});

			const finish = (success: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (!success) {
					detachReader();
					socket.destroy();
				}
				resolve(success);
			};

			socket.setNoDelay(true);
			socket.once("connect", () => {
				socket.write(serializeJsonLine({ type: "host_connect", token, clientId: this.clientId }));
			});
			socket.on("error", (error) => {
				if (!authenticated) {
					finish(false);
					return;
				}
				const processError = new Error(`Pi GlobalHost socket error: ${error.message}`);
				this.exitError = processError;
				this.emitClientEvent({ type: "process_error", message: processError.message, stderr: this.stderr });
				this.rejectPendingRequests(processError);
			});
			socket.once("close", () => {
				if (!authenticated) {
					finish(false);
					return;
				}
				if (this.socket !== socket) return;
				this.socket = null;
				const error = new Error("Pi GlobalHost connection closed");
				this.exitError = error;
				this.emitClientEvent({
					type: "process_exit",
					code: null,
					signal: null,
					message: error.message,
					stderr: this.stderr,
				});
				this.rejectPendingRequests(error);
			});
		});
	}

	private emitClientEvent(event: RpcClientEvent): void {
		// Snapshot listeners so one callback can unsubscribe itself without
		// shifting the live array and causing the next callback to miss the event.
		for (const listener of [...this.clientEventListeners]) {
			listener(event);
		}
	}

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Otherwise it's an event
			const event = data as RpcClientEvent;
			if (
				event.type === "extension_ui_request" &&
				["interact", "select", "confirm", "input", "editor"].includes(event.method)
			) {
				this.extensionUIOwners.set(event.id, {
					clientId: event.clientId,
					runtimeId: event.runtimeId,
					sessionId: event.sessionId,
					extensionId: event.extensionId,
				});
			} else if (event.type === "extension_ui_cancel") {
				this.extensionUIOwners.delete(event.id);
			}
			this.emitClientEvent(event);
			if (event.type === "tool_permission_request") {
				this.handleToolPermissionRequest(event);
				return;
			}
			if (event.type === "tool_result_request") {
				this.handleToolResultRequest(event);
				return;
			}
			if (event.type === "tool_execute_request") {
				this.handleToolExecuteRequest(event);
				return;
			}
			if (
				event.type === "extension_ui_request" ||
				event.type === "extension_ui_cancel" ||
				event.type === "extension_error" ||
				event.type === "extension_host_capability_route_rejected"
			) {
				return;
			}
			if (event.type === "process_exit" || event.type === "process_error" || event.type === "stdin_error") {
				return;
			}
			for (const listener of [...this.eventListeners]) {
				listener(event as AgentEvent);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private handleToolPermissionRequest(request: RpcToolPermissionRequest): void {
		const handler =
			(request.runtimeId && this.runtimeToolPermissionHandlers.get(request.runtimeId)) ?? this.toolPermissionHandler;
		const respond = (response: RpcToolPermissionResponse) => {
			const stdin = this.getWritableInput();
			if (!stdin || stdin.destroyed || !stdin.writable) return;
			stdin.write(
				serializeJsonLine({
					...response,
					clientId: request.clientId,
					runtimeId: request.runtimeId,
				}),
			);
		};

		if (!handler) {
			// No handler installed (gate disabled or handler cleared mid-flight):
			// allow so the agent never hangs.
			respond({ type: "tool_permission_response", id: request.id, action: "allow" });
			return;
		}

		void handler(request)
			.then((result) => {
				if (result.action === "block") {
					respond({ type: "tool_permission_response", id: request.id, action: "block", reason: result.reason });
				} else if (result.action === "modify") {
					respond({ type: "tool_permission_response", id: request.id, action: "modify", input: result.input });
				} else {
					respond({ type: "tool_permission_response", id: request.id, action: "allow" });
				}
			})
			.catch((err: unknown) => {
				respond({
					type: "tool_permission_response",
					id: request.id,
					action: "block",
					reason: `Permission handler failed: ${err instanceof Error ? err.message : String(err)}`,
				});
			});
	}

	private handleToolResultRequest(request: RpcToolResultRequest): void {
		const handler = request.runtimeId
			? (this.runtimeToolResultHandlers.get(request.runtimeId) ??
				(request.runtimeId === "default" ? this.toolResultHandler : null))
			: this.toolResultHandler;
		const respond = (response: RpcToolResultResponse) => {
			const stdin = this.getWritableInput();
			if (!stdin || stdin.destroyed || !stdin.writable) return;
			stdin.write(
				serializeJsonLine({
					...response,
					clientId: request.clientId,
					runtimeId: request.runtimeId,
					sessionId: request.sessionId,
				}),
			);
		};

		if (!handler) {
			respond({ type: "tool_result_response", id: request.id, status: "acknowledged" });
			return;
		}

		void handler(request)
			.then(() => {
				respond({ type: "tool_result_response", id: request.id, status: "acknowledged" });
			})
			.catch((error: unknown) => {
				respond({
					type: "tool_result_response",
					id: request.id,
					status: "failed",
					error: `Tool result handler failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			});
	}

	private handleToolExecuteRequest(request: RpcToolExecuteRequest): void {
		const executor = (request.runtimeId && this.runtimeToolExecutors.get(request.runtimeId)) ?? this.toolExecutor;
		const respond = (response: RpcToolExecuteResponse) => {
			const stdin = this.getWritableInput();
			if (!stdin || stdin.destroyed || !stdin.writable) return;
			stdin.write(
				serializeJsonLine({
					...response,
					clientId: request.clientId,
					runtimeId: request.runtimeId,
				}),
			);
		};

		if (!executor) {
			// Tool registered but executor cleared — fail the call instead of hanging.
			respond({
				type: "tool_execute_response",
				id: request.id,
				content: `No host executor installed for tool "${request.toolName}"`,
				isError: true,
			});
			return;
		}

		void executor(request)
			.then((result) => {
				respond({
					type: "tool_execute_response",
					id: request.id,
					content: result.content,
					details: result.details,
					isError: result.isError,
					terminate: result.terminate,
				});
			})
			.catch((err: unknown) => {
				respond({
					type: "tool_execute_response",
					id: request.id,
					content: `Host tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				});
			});
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
		this.extensionUIOwners.clear();
	}

	private async send(command: RpcCommandBody, timeoutMs = 30000): Promise<RpcResponse> {
		const childProcess = this.process;
		const stdin = this.getWritableInput();
		if (!stdin) {
			throw new Error("Client not started");
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (childProcess && childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, clientId: this.clientId, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			try {
				stdin.write(serializeJsonLine(fullCommand));
			} catch (error: unknown) {
				const writeError = error instanceof Error ? error : new Error(String(error));
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.reject(writeError);
			}
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			const error = new Error(errorResponse.userMessage ?? errorResponse.error) as Error & {
				errorKind?: string;
				recoverable?: boolean;
				rawError?: string;
			};
			error.errorKind = errorResponse.errorKind;
			error.recoverable = errorResponse.recoverable;
			error.rawError = errorResponse.error;
			throw error;
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}

export async function connectPiGlobalHost(options: ConnectPiGlobalHostOptions = {}): Promise<RpcClient> {
	const { agentDir, instanceId, ...clientOptions } = options;
	const client = new RpcClient({
		...clientOptions,
		globalHost: { enabled: true, agentDir, instanceId },
	});
	await client.start();
	return client;
}

/**
 * Runtime-scoped facade over one shared RpcClient transport.
 *
 * It owns no process. Closing the handle releases only its SessionRuntime;
 * stopping the parent RpcClient terminates the shared host process.
 */
export class PiRuntimeHandle {
	readonly runtimeId: string;
	private readonly client: RpcClient;
	private readonly unsubscribeSummaryEvents: () => void;
	private summary: RpcRuntimeSummary;

	constructor(client: RpcClient, summary: RpcRuntimeSummary) {
		this.client = client;
		this.runtimeId = summary.runtimeId;
		this.summary = summary;
		this.unsubscribeSummaryEvents = client.onClientEvent((event) => {
			if (
				"runtimeId" in event &&
				event.runtimeId === this.runtimeId &&
				"sessionId" in event &&
				typeof event.sessionId === "string"
			) {
				this.summary = { ...this.summary, sessionId: event.sessionId };
			}
		});
	}

	get runtimeSummary(): RpcRuntimeSummary {
		return { ...this.summary };
	}

	getStderr(): string {
		return this.client.getStderr();
	}

	onEvent(listener: RpcEventListener): () => void {
		return this.client.onEvent((event) => {
			if (event.runtimeId === this.runtimeId) listener(event);
		});
	}

	onClientEvent(listener: RpcClientEventListener): () => void {
		return this.client.onClientEvent((event) => {
			if (
				"runtimeId" in event
					? event.runtimeId === this.runtimeId
					: event.type.startsWith("process_") ||
						event.type === "stdin_error" ||
						event.type === "background_task_event"
			) {
				listener(event);
			}
		});
	}

	async refreshState(): Promise<RpcSessionState> {
		const result = await this.client.getRuntimeState(this.runtimeId);
		this.summary = result.runtime;
		return result.state;
	}

	getState(): Promise<RpcSessionState> {
		return this.requestData({ type: "get_state" });
	}

	getLastAssistantText(): Promise<string | null> {
		return this.requestData<{ text: string | null }>({ type: "get_last_assistant_text" }).then((result) => result.text);
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.requestVoid({ type: "set_active_tools", toolNames });
	}

	setCompactionPrompt(prompt?: string): Promise<void> {
		return this.requestVoid({ type: "set_compaction_prompt", prompt });
	}

	prompt(
		message: string,
		images?: ImageContent[],
		options?: {
			systemPrompt?: string;
			clearSystemPrompt?: boolean;
			appendSystemPrompt?: string;
			clientMutationId?: string;
			attachments?: import("@mortise/pi-ai/types").UserAttachmentMetadata[];
		},
	): Promise<void> {
		return this.requestVoid({
			type: "prompt",
			message,
			images,
			systemPrompt: options?.systemPrompt,
			clearSystemPrompt: options?.clearSystemPrompt,
			appendSystemPrompt: options?.appendSystemPrompt,
			clientMutationId: options?.clientMutationId,
			attachments: options?.attachments,
		});
	}

	steer(message: string, images?: ImageContent[], options?: { clientMutationId?: string }): Promise<void> {
		return this.requestVoid({ type: "steer", message, images, clientMutationId: options?.clientMutationId });
	}

	followUp(message: string, images?: ImageContent[], options?: { clientMutationId?: string }): Promise<void> {
		return this.requestVoid({ type: "follow_up", message, images, clientMutationId: options?.clientMutationId });
	}

	abort(): Promise<void> {
		return this.requestVoid({ type: "abort" });
	}

	setAutoCompaction(enabled: boolean): Promise<void> {
		return this.requestVoid({ type: "set_auto_compaction", enabled });
	}

	compact(customInstructions?: string): Promise<CompactionResult> {
		return this.requestData({ type: "compact", customInstructions });
	}

	setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		return this.requestData({ type: "set_model", provider, modelId });
	}

	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.requestVoid({ type: "set_thinking_level", level });
	}

	setSessionName(name: string): Promise<void> {
		return this.requestVoid({ type: "set_session_name", name });
	}

	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const result = await this.requestData<{ cancelled: boolean }>({ type: "new_session", parentSession });
		if (!result.cancelled) await this.refreshState();
		return result;
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const result = await this.requestData<{ cancelled: boolean }>({ type: "switch_session", sessionPath });
		if (!result.cancelled) await this.refreshState();
		return result;
	}

	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const result = await this.requestData<{ text: string; cancelled: boolean }>({ type: "fork", entryId });
		if (!result.cancelled) await this.refreshState();
		return result;
	}

	async clone(): Promise<{ cancelled: boolean }> {
		const result = await this.requestData<{ cancelled: boolean }>({ type: "clone" });
		if (!result.cancelled) await this.refreshState();
		return result;
	}

	runMiniCompletion(prompt: string): Promise<string | null> {
		return this.requestData<{ text: string | null }>(
			{ type: "run_mini_completion", prompt },
			SECONDARY_LLM_TIMEOUT_MS,
		).then((result) => result.text);
	}

	queryLlm(request: RpcLLMQueryRequest): Promise<RpcLLMQueryResult> {
		return this.requestData({ type: "query_llm", request }, SECONDARY_LLM_TIMEOUT_MS);
	}

	listChildSessions(parentSessionId: string): Promise<RpcChildSessionInfo[]> {
		return this.requestData<{ sessions: RpcChildSessionInfo[] }>({
			type: "list_child_sessions",
			parentSessionId,
		}).then((result) => result.sessions);
	}

	getCommands(): Promise<RpcSlashCommand[]> {
		return this.requestData<{ commands: RpcSlashCommand[] }>({ type: "get_commands" }).then(
			(result) => result.commands,
		);
	}

	invokeExtensionCommandResult(
		commandId: string,
		args?: string,
		ownerExtensionId?: string,
	): Promise<RpcExtensionCommandResult> {
		return this.requestData({
			type: "invoke_extension_command",
			commandId,
			args,
			...(ownerExtensionId !== undefined ? { ownerExtensionId } : {}),
		});
	}

	reloadExtensions(): Promise<{ reloaded: boolean; deferred: boolean }> {
		return this.requestData({ type: "reload_extensions" });
	}

	setToolPermissionHandler(handler: RpcToolPermissionHandler | null): Promise<void> {
		return this.client.setRuntimeToolPermissionHandler(this.runtimeId, handler);
	}

	setToolResultHandler(handler: RpcToolResultHandler | null): Promise<void> {
		return this.client.setRuntimeToolResultHandler(this.runtimeId, handler);
	}

	registerTools(tools: RpcHostToolDefinition[], executor: RpcToolExecutor): Promise<string[]> {
		return this.client.registerRuntimeTools(this.runtimeId, tools, executor);
	}

	respondToExtensionUI(response: RpcExtensionUIResponse): void {
		this.client.respondToRuntimeExtensionUI(this.runtimeId, this.summary.sessionId, response);
	}

	respondToExtensionHostCapability(response: RpcExtensionHostCapabilityResponse): void {
		this.client.respondToRuntimeExtensionHostCapability(this.runtimeId, this.summary.sessionId, response);
	}

	reportExtensionHostCapabilityProgress(progress: RpcExtensionHostCapabilityProgress): void {
		this.client.reportRuntimeExtensionHostCapabilityProgress(this.runtimeId, this.summary.sessionId, progress);
	}

	waitForIdle(timeout = 60_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(
					new Error(`Timeout waiting for runtime ${this.runtimeId} to become idle. Stderr: ${this.getStderr()}`),
				);
			}, timeout);
			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	async close(): Promise<void> {
		try {
			await this.client.closeRuntime(this.runtimeId);
		} finally {
			this.unsubscribeSummaryEvents();
		}
	}

	private async requestVoid(command: RpcRuntimeCommandBody, timeoutMs?: number): Promise<void> {
		const response = await this.client.requestRuntime(this.runtimeId, command, timeoutMs);
		this.client.readResponseData<unknown>(response);
	}

	private async requestData<T>(command: RpcRuntimeCommandBody, timeoutMs?: number): Promise<T> {
		const response = await this.client.requestRuntime(this.runtimeId, command, timeoutMs);
		return this.client.readResponseData<T>(response);
	}
}
