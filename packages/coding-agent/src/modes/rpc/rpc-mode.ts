/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import { completeSimple, streamSimple } from "@earendil-works/pi-ai/stream";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/types";
import { VERSION } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { formatNoApiKeyFoundMessage } from "../../core/auth-guidance.ts";
import type {
	ExtensionError,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCapabilities,
	RpcChildSessionInfo,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolDefinition,
	RpcLLMQueryRequest,
	RpcLLMQueryResult,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
	RpcToolExecuteRequest,
	RpcToolExecuteResponse,
	RpcToolPermissionRequest,
	RpcToolPermissionResponse,
	RpcToolResultContent,
} from "./rpc-types.ts";
import {
	PI_HOST_HOOKS_MODULE_ENV,
	PI_LEGACY_FETCH_INTERCEPTOR_MODULE_ENV,
	PI_RPC_COMMANDS,
	PI_RPC_PROTOCOL_VERSION,
} from "./rpc-types.ts";

// Re-export types for consumers
export type {
	RpcCapabilities,
	RpcChildSessionInfo,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolDefinition,
	RpcLLMQueryRequest,
	RpcLLMQueryResult,
	RpcResponse,
	RpcSessionState,
	RpcToolExecuteRequest,
	RpcToolExecuteResponse,
	RpcToolPermissionRequest,
	RpcToolPermissionResponse,
	RpcToolResultContent,
} from "./rpc-types.ts";

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function appendOutputSchemaInstruction(prompt: string, outputSchema: unknown): string {
	if (outputSchema === undefined) return prompt;

	let schemaText: string;
	try {
		schemaText = JSON.stringify(outputSchema, null, 2);
	} catch {
		schemaText = String(outputSchema);
	}

	return `${prompt}\n\nRespond using this output schema. Return only content that satisfies the schema:\n${schemaText}`;
}

function resolveRequestedModel(session: AgentSession, requestedModel?: string): Model<any> {
	if (!requestedModel) {
		if (!session.model) {
			throw new Error("No model selected");
		}
		return session.model;
	}

	const slashIndex = requestedModel.indexOf("/");
	if (slashIndex > 0) {
		const provider = requestedModel.slice(0, slashIndex);
		const modelId = requestedModel.slice(slashIndex + 1);
		const model = session.modelRegistry.find(provider, modelId);
		if (model) return model;
	}

	const allModels = session.modelRegistry.getAll();
	const model = allModels.find((candidate) => candidate.id === requestedModel);
	if (!model) {
		throw new Error(`Model not found: ${requestedModel}`);
	}
	return model;
}

async function getRequestAuth(
	session: AgentSession,
	model: Model<any>,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
	const result = await session.modelRegistry.getApiKeyAndHeaders(model);
	if (!result.ok) {
		if (result.error.startsWith("No API key found")) {
			throw new Error(formatNoApiKeyFoundMessage(model.provider));
		}
		throw new Error(result.error);
	}
	return { apiKey: result.apiKey, headers: result.headers };
}

async function completeWithoutTranscript(
	session: AgentSession,
	request: RpcLLMQueryRequest,
): Promise<RpcLLMQueryResult> {
	const model = resolveRequestedModel(session, request.model);
	const auth = await getRequestAuth(session, model);
	const prompt = appendOutputSchemaInstruction(request.prompt, request.outputSchema);
	const messages: Message[] = [
		{
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		},
	];
	const context: Context = {
		systemPrompt: request.systemPrompt,
		messages,
	};
	const options: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		maxTokens: request.maxTokens,
		temperature: request.temperature,
	};
	if (model.reasoning && session.thinkingLevel !== "off") {
		options.reasoning = session.thinkingLevel;
	}

	const response =
		session.agent.streamFn === streamSimple
			? await completeSimple(model, context, options)
			: await (await session.agent.streamFn(model, context, options)).result();

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "LLM query failed");
	}
	if (response.stopReason === "aborted") {
		throw new Error("LLM query aborted");
	}

	return {
		text: extractAssistantText(response),
		model: response.model,
		provider: response.provider,
		usage: response.usage,
		stopReason: response.stopReason,
	};
}

function toRpcChildSessionInfo(
	session: Awaited<ReturnType<typeof SessionManager.listChildrenBySpawnedFrom>>[number],
): RpcChildSessionInfo {
	return {
		id: session.id,
		path: session.path,
		cwd: session.cwd,
		name: session.name,
		parentSessionPath: session.parentSessionPath,
		spawnedFrom: session.spawnedFrom,
		spawnConfig: session.spawnConfig,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
	};
}

function createRpcCapabilities(): RpcCapabilities {
	return {
		protocolVersion: PI_RPC_PROTOCOL_VERSION,
		packageVersion: VERSION,
		commands: [...PI_RPC_COMMANDS],
		features: {
			hostHooksModule: true,
			legacyFetchInterceptorModule: true,
			toolExecutionMetadata: true,
			hostToolResults: "content",
			extensionCommandResult: true,
			secondaryLlmQuery: true,
			childSessionListing: true,
		},
		hostHooks: {
			moduleEnv: PI_HOST_HOOKS_MODULE_ENV,
			legacyModuleEnv: PI_LEGACY_FETCH_INTERCEPTOR_MODULE_ENV,
			exports: [
				"fetchInterceptor",
				"createFetchInterceptor",
				"createCraftFetchInterceptor",
				"toolMetadataResolver",
				"resolveToolMetadata",
				"resolveCraftToolMetadata",
				"createToolMetadataResolver",
				"createCraftToolMetadataResolver",
			],
		},
	};
}

function normalizeHostToolResult(response: RpcToolExecuteResponse) {
	const content =
		typeof response.content === "string"
			? ([{ type: "text", text: response.content }] satisfies RpcToolResultContent[])
			: response.content;
	return {
		content,
		details: response.details ?? (response.isError ? { isError: true } : {}),
		terminate: response.terminate,
	};
}

function getHostToolErrorMessage(response: RpcToolExecuteResponse): string {
	if (typeof response.content === "string") return response.content;
	const firstText = response.content.find((item): item is Extract<RpcToolResultContent, { type: "text" }> => {
		return item.type === "text";
	});
	return firstText?.text || `Host tool execution failed: ${response.id}`;
}

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	takeOverStdout();
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// Pending tool permission requests waiting for host response
	const pendingToolPermissionRequests = new Map<
		string,
		{ resolve: (value: RpcToolPermissionResponse) => void; reject: (error: Error) => void }
	>();

	// Host-side tool permission gate. Off by default; enabled via the
	// enable_tool_permissions command. When enabled, every tool call emits a
	// tool_permission_request and blocks until the host replies.
	let toolPermissionsEnabled = false;

	const requestToolPermission = (request: {
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
	}): Promise<RpcToolPermissionResponse> => {
		const id = crypto.randomUUID();
		return new Promise<RpcToolPermissionResponse>((resolve, reject) => {
			pendingToolPermissionRequests.set(id, { resolve, reject });
			output({
				type: "tool_permission_request",
				id,
				toolName: request.toolName,
				toolCallId: request.toolCallId,
				input: request.input,
			} satisfies RpcToolPermissionRequest);
		});
	};

	// Pending host proxy-tool executions waiting for the host's result
	const pendingToolExecuteRequests = new Map<
		string,
		{ resolve: (value: RpcToolExecuteResponse) => void; reject: (error: Error) => void }
	>();

	const requestHostToolExecution = (request: {
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
	}): Promise<RpcToolExecuteResponse> => {
		const id = crypto.randomUUID();
		return new Promise<RpcToolExecuteResponse>((resolve, reject) => {
			pendingToolExecuteRequests.set(id, { resolve, reject });
			output({
				type: "tool_execute_request",
				id,
				toolName: request.toolName,
				toolCallId: request.toolCallId,
				input: request.input,
			} satisfies RpcToolExecuteRequest);
		});
	};

	/** Convert host tool declarations into session ToolDefinitions that proxy execution to the host. */
	const buildHostProxyTools = (tools: RpcHostToolDefinition[]) =>
		tools.map((def) => ({
			name: def.name,
			label: def.label ?? def.name.replace(/^mcp__.*?__/, "").replace(/_/g, " "),
			description: def.description,
			promptSnippet:
				def.promptSnippet ??
				(def.description.length > 200 ? `${def.description.slice(0, 197)}...` : def.description),
			parameters: def.inputSchema as never,
			execute: async (toolCallId: string, params: unknown) => {
				const result = await requestHostToolExecution({
					toolName: def.name,
					toolCallId,
					input: (params ?? {}) as Record<string, unknown>,
				});
				const normalized = normalizeHostToolResult(result);
				if (result.isError) {
					const error = new Error(getHostToolErrorMessage(result)) as Error & {
						toolResult?: typeof normalized;
					};
					error.toolResult = normalized;
					throw error;
				}
				return normalized;
			},
		}));

	// Shutdown request flag
	let shutdownRequested = false;
	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI not supported in RPC mode
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			toolPermissionHandler: async (request) => {
				if (!toolPermissionsEnabled) {
					return { action: "allow" };
				}
				const response = await requestToolPermission(request);
				if (response.action === "block") {
					return { action: "block", reason: response.reason };
				}
				if (response.action === "modify") {
					return { action: "modify", input: response.input };
				}
				return { action: "allow" };
			},
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err: ExtensionError) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			output(event);
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						systemPrompt: command.systemPrompt,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			case "run_mini_completion": {
				const result = await completeWithoutTranscript(session, {
					prompt: command.prompt,
					maxTokens: 1024,
				});
				return success(id, "run_mini_completion", { text: result.text || null });
			}

			case "query_llm": {
				const result = await completeWithoutTranscript(session, command.request);
				return success(id, "query_llm", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_capabilities": {
				return success(id, "get_capabilities", createRpcCapabilities());
			}

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			case "list_child_sessions": {
				const children = await SessionManager.listChildrenBySpawnedFrom(command.parentSessionId);
				return success(id, "list_child_sessions", { sessions: children.map(toRpcChildSessionInfo) });
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			case "invoke_extension_command": {
				const extensionCommand = session.extensionRunner.getCommand(command.commandId);
				if (!extensionCommand) {
					return success(id, "invoke_extension_command", {
						invoked: false,
						error: `Extension command not found: ${command.commandId}`,
					});
				}

				try {
					await extensionCommand.handler(command.args ?? "", session.extensionRunner.createCommandContext());
					return success(id, "invoke_extension_command", { invoked: true });
				} catch (commandError: unknown) {
					return success(id, "invoke_extension_command", {
						invoked: false,
						error: commandError instanceof Error ? commandError.message : String(commandError),
					});
				}
			}

			case "enable_tool_permissions": {
				toolPermissionsEnabled = command.enabled;
				if (!command.enabled) {
					// Unblock any in-flight requests so tools don't hang forever.
					for (const [, pending] of pendingToolPermissionRequests) {
						pending.resolve({ type: "tool_permission_response", id: "", action: "allow" });
					}
					pendingToolPermissionRequests.clear();
				}
				return success(id, "enable_tool_permissions");
			}

			case "register_tools": {
				session.registerHostTools(buildHostProxyTools(command.tools) as never);
				return success(id, "register_tools", { registered: command.tools.map((t) => t.name) });
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 * Called after handling each command when waiting for the next command.
	 */
	let detachInput = () => {};

	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		// Unblock in-flight tool permission waits so dispose doesn't hang on them.
		for (const [, pending] of pendingToolPermissionRequests) {
			pending.resolve({ type: "tool_permission_response", id: "", action: "block", reason: "Server shutting down" });
		}
		pendingToolPermissionRequests.clear();
		// Fail in-flight host tool executions so dispose doesn't hang on them.
		for (const [, pending] of pendingToolExecuteRequests) {
			pending.resolve({ type: "tool_execute_response", id: "", content: "Server shutting down", isError: true });
		}
		pendingToolExecuteRequests.clear();
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		// Handle tool permission responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "tool_permission_response"
		) {
			const response = parsed as RpcToolPermissionResponse;
			const pending = pendingToolPermissionRequests.get(response.id);
			if (pending) {
				pendingToolPermissionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		// Handle host proxy-tool execution responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "tool_execute_response"
		) {
			const response = parsed as RpcToolExecuteResponse;
			const pending = pendingToolExecuteRequests.get(response.id);
			if (pending) {
				pendingToolExecuteRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// Keep process alive forever
	return new Promise(() => {});
}
