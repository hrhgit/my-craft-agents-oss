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
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { completeSimple, streamSimple } from "@earendil-works/pi-ai/stream";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/types";
import { getAgentDir, VERSION } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import { formatNoApiKeyFoundMessage } from "../../core/auth-guidance.ts";
import type {
	ExtensionCapabilitiesContext,
	ExtensionError,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	HostCapabilityInvokeOptions,
	HostCapabilityResult,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { getProcessGlobalBackgroundTaskCoordinator } from "../../core/global-background-tasks.ts";
import { getPiGlobalHostStatePath, readPiGlobalHostState } from "../../core/global-host-state.ts";
import {
	deleteGlobalProvider,
	forkSession,
	getExtensions,
	getGlobalConfig,
	getModelCatalog,
	getSessionProjection,
	listSkills,
	resolveSkill,
	saveGlobalProvider,
	setCraftCredential,
	setCraftSessionMetadata,
	setExtensionConfig,
	setGlobalDefault,
	toHostErrorPayload,
} from "../../core/host-facade.ts";
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
	RpcExtensionHostCapabilityCancel,
	RpcExtensionHostCapabilityDeclaration,
	RpcExtensionHostCapabilityProgress,
	RpcExtensionHostCapabilityRequest,
	RpcExtensionHostCapabilityResponse,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolDefinition,
	RpcLLMQueryRequest,
	RpcLLMQueryResult,
	RpcResponse,
	RpcRuntimeSummary,
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
			extensionHostCapabilities: true,
			secondaryLlmQuery: true,
			childSessionListing: true,
			multiRuntime: true,
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
export interface RpcGlobalHostRuntimeFactory {
	kind: "global-host";
	agentDir: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
	defaultRuntime: {
		cwd: string;
		sessionManager: SessionManager;
		extensionTarget: "pi" | "craft";
		deferResourceLoad?: boolean;
		persistInitialState?: boolean;
	};
}

export async function runRpcMode(runtimeSource: AgentSessionRuntime | RpcGlobalHostRuntimeFactory): Promise<never> {
	takeOverStdout();
	const defaultRuntimeId = "default";
	const globalHostFactory =
		"kind" in runtimeSource && runtimeSource.kind === "global-host"
			? (runtimeSource as RpcGlobalHostRuntimeFactory)
			: undefined;
	const runtimeHost = globalHostFactory ? undefined : (runtimeSource as AgentSessionRuntime);
	const hostAgentDir = globalHostFactory
		? globalHostFactory.agentDir
		: (runtimeHost?.services?.agentDir ?? getAgentDir());
	type RuntimeBinding = {
		runtimeId: string;
		clientId?: string;
		runtime: AgentSessionRuntime;
		session: AgentSession;
		extensionTarget: "pi" | "craft";
		toolPermissionsEnabled: boolean;
		pendingExtensionReload: boolean;
		unsubscribe?: () => void;
		unsubscribeBackpressure?: () => void;
	};
	const runtimeBindings = new Map<string, RuntimeBinding>();
	const socketClients = new Map<string, Socket>();
	const retiredRuntimes = new Set<AgentSessionRuntime>();
	const backgroundTasks = getProcessGlobalBackgroundTaskCoordinator();
	const stdioClientIds = new Set<string>();
	let stdioConnected = true;
	let globalHostIdleTimer: ReturnType<typeof setTimeout> | undefined;
	let cleanupGlobalHostServer = () => {};
	let unsubscribeBackgroundTasks = () => {};
	const defaultBinding: RuntimeBinding | undefined = runtimeHost
		? {
				runtimeId: defaultRuntimeId,
				runtime: runtimeHost,
				session: runtimeHost.session,
				extensionTarget: runtimeHost.extensionTarget,
				toolPermissionsEnabled: false,
				pendingExtensionReload: false,
			}
		: undefined;
	if (defaultBinding) runtimeBindings.set(defaultRuntimeId, defaultBinding);

	const output = (
		obj: RpcResponse | RpcExtensionUIRequest | object,
		envelope?: { clientId?: string; runtimeId?: string },
	) => {
		const value = {
			...obj,
			...(envelope?.clientId ? { clientId: envelope.clientId } : {}),
			...(envelope?.runtimeId ? { runtimeId: envelope.runtimeId } : {}),
		};
		const line = serializeJsonLine(value);
		const clientId = "clientId" in value && typeof value.clientId === "string" ? value.clientId : undefined;
		const socket = clientId ? socketClients.get(clientId) : undefined;
		if (socket?.writable) socket.write(line);
		else if (stdioConnected) writeRawStdout(line);
	};
	const broadcast = (obj: object): void => {
		const line = serializeJsonLine(obj);
		if (stdioConnected) writeRawStdout(line);
		for (const socket of socketClients.values()) {
			if (socket.writable) socket.write(line);
		}
	};
	unsubscribeBackgroundTasks = backgroundTasks.subscribe((snapshot) => {
		broadcast({ type: "background_task_event", task: snapshot });
		if (backgroundTasks.activeCount > 0 || retiredRuntimes.size === 0) return;
		const runtimes = Array.from(retiredRuntimes);
		retiredRuntimes.clear();
		void Promise.allSettled(runtimes.map((runtime) => runtime.dispose())).finally(scheduleGlobalHostIdleExit);
	});

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

	const error = (id: string | undefined, command: string, cause: unknown): RpcResponse => {
		const payload =
			typeof cause === "string"
				? { errorKind: "unknown", userMessage: cause, recoverable: true, message: cause }
				: toHostErrorPayload(cause);
		return {
			id,
			type: "response",
			command,
			success: false,
			error: payload.message,
			errorKind: payload.errorKind,
			userMessage: payload.userMessage,
			recoverable: payload.recoverable,
		};
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();
	const pendingHostCapabilityRequests = new Map<
		string,
		{
			runtimeId: string;
			clientId?: string;
			resolve: (value: RpcExtensionHostCapabilityResponse) => void;
			onProgress?: (progress: unknown, sequence: number) => void;
		}
	>();
	const cancelRuntimeHostCapabilityRequests = (runtimeId: string): void => {
		for (const [id, pending] of pendingHostCapabilityRequests) {
			if (pending.runtimeId !== runtimeId) continue;
			pendingHostCapabilityRequests.delete(id);
			pending.resolve({
				type: "extension_host_capability_response",
				version: 1,
				id,
				runtimeId,
				status: "cancelled",
				error: { code: "runtime_closed", message: "Runtime closed before the host capability completed" },
			});
		}
	};

	// Pending tool permission requests waiting for host response
	const pendingToolPermissionRequests = new Map<
		string,
		{ resolve: (value: RpcToolPermissionResponse) => void; reject: (error: Error) => void }
	>();

	const requestToolPermission = (
		binding: RuntimeBinding,
		request: {
			toolName: string;
			toolCallId: string;
			input: Record<string, unknown>;
		},
	): Promise<RpcToolPermissionResponse> => {
		const id = crypto.randomUUID();
		return new Promise<RpcToolPermissionResponse>((resolve, reject) => {
			pendingToolPermissionRequests.set(id, { resolve, reject });
			output(
				{
					type: "tool_permission_request",
					id,
					toolName: request.toolName,
					toolCallId: request.toolCallId,
					input: request.input,
				} satisfies RpcToolPermissionRequest,
				binding,
			);
		});
	};

	// Pending host proxy-tool executions waiting for the host's result
	const pendingToolExecuteRequests = new Map<
		string,
		{ resolve: (value: RpcToolExecuteResponse) => void; reject: (error: Error) => void }
	>();

	const requestHostToolExecution = (
		binding: RuntimeBinding,
		request: {
			toolName: string;
			toolCallId: string;
			input: Record<string, unknown>;
		},
	): Promise<RpcToolExecuteResponse> => {
		const id = crypto.randomUUID();
		return new Promise<RpcToolExecuteResponse>((resolve, reject) => {
			pendingToolExecuteRequests.set(id, { resolve, reject });
			output(
				{
					type: "tool_execute_request",
					id,
					toolName: request.toolName,
					toolCallId: request.toolCallId,
					input: request.input,
				} satisfies RpcToolExecuteRequest,
				binding,
			);
		});
	};

	/** Convert host tool declarations into session ToolDefinitions that proxy execution to the host. */
	const buildHostProxyTools = (binding: RuntimeBinding, tools: RpcHostToolDefinition[]) =>
		tools.map((def) => ({
			name: def.name,
			label: def.label ?? def.name.replace(/^mcp__.*?__/, "").replace(/_/g, " "),
			description: def.description,
			promptSnippet:
				def.promptSnippet ??
				(def.description.length > 200 ? `${def.description.slice(0, 197)}...` : def.description),
			parameters: def.inputSchema as never,
			execute: async (toolCallId: string, params: unknown) => {
				const result = await requestHostToolExecution(binding, {
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
		binding: RuntimeBinding,
		extensionId: string,
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
			output({ type: "extension_ui_request", id, extensionId, ...request } as RpcExtensionUIRequest, binding);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (binding: RuntimeBinding, extensionId: string): ExtensionUIContext => ({
		capabilities: {
			kind: "craft",
			dialogs: true,
			widgets: true,
			customComponents: false,
			terminalInput: false,
			editorControl: true,
		},
		select: (title, options, opts) =>
			createDialogPromise(
				binding,
				extensionId,
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		confirm: (title, message, opts) =>
			createDialogPromise(
				binding,
				extensionId,
				opts,
				false,
				{ method: "confirm", title, message, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(
				binding,
				extensionId,
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output(
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					extensionId,
					method: "notify",
					message,
					notifyType: type,
				} as RpcExtensionUIRequest,
				binding,
			);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output(
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					extensionId,
					method: "setStatus",
					statusKey: key,
					statusText: text,
				} as RpcExtensionUIRequest,
				binding,
			);
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
				output(
					{
						type: "extension_ui_request",
						id: crypto.randomUUID(),
						extensionId,
						method: "setWidget",
						widgetKey: key,
						widgetLines: content as string[] | undefined,
						widgetPlacement: options?.placement,
					} as RpcExtensionUIRequest,
					binding,
				);
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
			output(
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					extensionId,
					method: "setTitle",
					title,
				} as RpcExtensionUIRequest,
				binding,
			);
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
			output(
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					extensionId,
					method: "set_editor_text",
					text,
				} as RpcExtensionUIRequest,
				binding,
			);
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
				output(
					{
						type: "extension_ui_request",
						id,
						extensionId,
						method: "editor",
						title,
						prefill,
					} as RpcExtensionUIRequest,
					binding,
				);
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

	const createExtensionCapabilitiesContext = (
		binding: RuntimeBinding,
		extensionId: string,
	): ExtensionCapabilitiesContext => ({
		supported: ["*"],
		invoke: <TOutput = unknown>(
			capability: string,
			operation: string,
			input?: unknown,
			options?: HostCapabilityInvokeOptions,
		): Promise<HostCapabilityResult<TOutput>> => {
			if (options?.signal?.aborted) return Promise.resolve({ status: "cancelled" });
			const id = crypto.randomUUID();
			const extension = binding.session.resourceLoader
				.getExtensions()
				.extensions.find((candidate) => candidate.id === extensionId);
			output(
				{
					type: "extension_host_capability_declaration",
					version: 1,
					extensionId,
					declarations:
						extension?.hostCapabilities?.map((declaration) => ({
							capability: declaration.capability,
							operations: [...declaration.operations],
						})) ?? [],
				} satisfies RpcExtensionHostCapabilityDeclaration,
				binding,
			);
			return new Promise((resolve) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const cleanup = () => {
					if (timer) clearTimeout(timer);
					options?.signal?.removeEventListener("abort", onAbort);
					pendingHostCapabilityRequests.delete(id);
				};
				const onAbort = () => {
					output(
						{
							type: "extension_host_capability_cancel",
							version: 1,
							id,
							extensionId,
						} satisfies RpcExtensionHostCapabilityCancel,
						binding,
					);
					cleanup();
					resolve({ status: "cancelled" });
				};
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				if (options?.timeoutMs) {
					timer = setTimeout(() => {
						output(
							{
								type: "extension_host_capability_cancel",
								version: 1,
								id,
								extensionId,
							} satisfies RpcExtensionHostCapabilityCancel,
							binding,
						);
						cleanup();
						resolve({
							status: "failed",
							error: {
								code: "host_capability_timeout",
								message: `Host capability timed out after ${options.timeoutMs}ms`,
								recoverable: true,
							},
						});
					}, options.timeoutMs);
				}
				pendingHostCapabilityRequests.set(id, {
					runtimeId: binding.runtimeId,
					clientId: binding.clientId,
					onProgress: options?.onProgress,
					resolve: (response) => {
						cleanup();
						resolve(
							response.status === "success"
								? { status: "success", output: response.output as TOutput }
								: { status: response.status, error: response.error },
						);
					},
				});
				output(
					{
						type: "extension_host_capability_request",
						version: 1,
						id,
						extensionId,
						capability,
						operation,
						input,
						timeoutMs: options?.timeoutMs,
					} satisfies RpcExtensionHostCapabilityRequest,
					binding,
				);
			});
		},
	});

	const bindRuntime = async (binding: RuntimeBinding): Promise<void> => {
		binding.session = binding.runtime.session;
		const session = binding.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(binding, "unknown-extension"),
			uiContextFactory: (extensionId) => createExtensionUIContext(binding, extensionId),
			capabilitiesContextFactory: (extensionId) => createExtensionCapabilitiesContext(binding, extensionId),
			toolPermissionHandler: async (request) => {
				if (!binding.toolPermissionsEnabled) {
					return { action: "allow" };
				}
				const response = await requestToolPermission(binding, request);
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
				newSession: async (options) => binding.runtime.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await binding.runtime.fork(entryId, forkOptions);
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
					return binding.runtime.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err: ExtensionError) => {
				output(
					{
						type: "extension_error",
						extensionId: err.extensionId,
						extensionPath: err.extensionPath,
						event: err.event,
						error: err.error,
					},
					binding,
				);
			},
		});
		for (const extension of session.resourceLoader.getExtensions().extensions) {
			output(
				{
					type: "extension_host_capability_declaration",
					version: 1,
					extensionId: extension.id,
					declarations: (extension.hostCapabilities ?? []).map((declaration) => ({
						capability: declaration.capability,
						operations: [...declaration.operations],
					})),
				} satisfies RpcExtensionHostCapabilityDeclaration,
				binding,
			);
		}

		binding.unsubscribe?.();
		binding.unsubscribeBackpressure?.();
		binding.unsubscribe = session.subscribe((event) => {
			output(event, binding);
			if (event.type === "agent_settled" && binding.pendingExtensionReload) {
				binding.pendingExtensionReload = false;
				void session.reload().catch((reloadError: unknown) => {
					output(
						{
							type: "extension_error",
							extensionId: "pi-runtime",
							extensionPath: "",
							event: "reload_extensions",
							error: reloadError instanceof Error ? reloadError.message : String(reloadError),
						},
						binding,
					);
				});
			}
		});
		binding.unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	const registerRuntime = async (binding: RuntimeBinding): Promise<void> => {
		binding.runtime.setRebindSession(async () => {
			await bindRuntime(binding);
		});
		await bindRuntime(binding);
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

	if (defaultBinding) await registerRuntime(defaultBinding);
	registerSignalHandlers();
	let defaultBindingPromise: Promise<RuntimeBinding> | undefined;
	const ensureDefaultBinding = async (): Promise<RuntimeBinding> => {
		const existing = runtimeBindings.get(defaultRuntimeId);
		if (existing) return existing;
		if (!globalHostFactory) throw new Error("Default RPC runtime is unavailable");
		if (defaultBindingPromise) return defaultBindingPromise;
		defaultBindingPromise = (async () => {
			const runtime = await createAgentSessionRuntime(globalHostFactory.createRuntime, {
				...globalHostFactory.defaultRuntime,
				agentDir: globalHostFactory.agentDir,
			});
			const binding: RuntimeBinding = {
				runtimeId: defaultRuntimeId,
				runtime,
				session: runtime.session,
				extensionTarget: globalHostFactory.defaultRuntime.extensionTarget,
				toolPermissionsEnabled: false,
				pendingExtensionReload: false,
			};
			runtimeBindings.set(defaultRuntimeId, binding);
			try {
				await registerRuntime(binding);
				return binding;
			} catch (error) {
				runtimeBindings.delete(defaultRuntimeId);
				await runtime.dispose();
				throw error;
			}
		})().finally(() => {
			defaultBindingPromise = undefined;
		});
		return defaultBindingPromise;
	};

	const runtimeSummary = (binding: RuntimeBinding): RpcRuntimeSummary => ({
		runtimeId: binding.runtimeId,
		clientId: binding.clientId,
		cwd: binding.runtime.cwd,
		sessionId: binding.session.sessionId,
		sessionFile: binding.session.sessionFile,
		isStreaming: binding.session.isStreaming,
	});

	const sessionState = (session: AgentSession): RpcSessionState => ({
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
	});

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;
		const runtimeId = command.runtimeId ?? defaultRuntimeId;
		let binding = runtimeBindings.get(runtimeId);
		if (command.type === "get_capabilities") {
			return success(id, "get_capabilities", createRpcCapabilities());
		}

		if (command.type === "open_runtime") {
			if (binding) {
				return success(id, "open_runtime", runtimeSummary(binding));
			}
			let sessionManager: SessionManager;
			if (command.forkFromSessionPath) {
				sessionManager = SessionManager.forkFrom(command.forkFromSessionPath, command.cwd, command.sessionDir, {
					id: command.sessionId,
					parentSession: command.parentSession,
				});
			} else if (command.sessionPath) {
				sessionManager = SessionManager.open(command.sessionPath, command.sessionDir, command.cwd);
			} else {
				const existing = command.sessionId
					? (await SessionManager.list(command.cwd, command.sessionDir)).find(
							(candidate) => candidate.id === command.sessionId,
						)
					: undefined;
				sessionManager = existing
					? SessionManager.open(existing.path, command.sessionDir, command.cwd)
					: SessionManager.create(command.cwd, command.sessionDir, {
							id: command.sessionId,
							parentSession: command.parentSession,
						});
			}
			const runtime = runtimeHost
				? await runtimeHost.createSibling({
						cwd: sessionManager.getCwd(),
						agentDir: command.agentDir,
						sessionManager,
						sessionStartEvent: {
							type: "session_start",
							reason: command.forkFromSessionPath
								? "fork"
								: command.sessionPath || command.sessionId
									? "resume"
									: "new",
						},
						deferResourceLoad: command.deferResourceLoad,
						persistInitialState: command.persistInitialState,
						extensionTarget: command.extensionTarget,
						extensionPaths: command.extensionPaths,
					})
				: await createAgentSessionRuntime(globalHostFactory!.createRuntime, {
						cwd: sessionManager.getCwd(),
						agentDir: command.agentDir ?? globalHostFactory!.agentDir,
						sessionManager,
						sessionStartEvent: {
							type: "session_start",
							reason: command.forkFromSessionPath
								? "fork"
								: command.sessionPath || command.sessionId
									? "resume"
									: "new",
						},
						deferResourceLoad: command.deferResourceLoad,
						persistInitialState: command.persistInitialState,
						extensionTarget: command.extensionTarget,
						extensionPaths: command.extensionPaths,
					});
			binding = {
				runtimeId,
				clientId: command.clientId,
				runtime,
				session: runtime.session,
				extensionTarget: command.extensionTarget,
				toolPermissionsEnabled: false,
				pendingExtensionReload: false,
			};
			runtimeBindings.set(runtimeId, binding);
			try {
				await registerRuntime(binding);
			} catch (bindError) {
				runtimeBindings.delete(runtimeId);
				await runtime.dispose();
				throw bindError;
			}
			return success(id, "open_runtime", runtimeSummary(binding));
		}

		if (command.type === "list_runtimes") {
			return success(id, "list_runtimes", {
				runtimes: Array.from(runtimeBindings.values(), runtimeSummary),
			});
		}

		if (!binding && runtimeId === defaultRuntimeId && command.runtimeId === undefined) {
			binding = await ensureDefaultBinding();
		}

		if (!binding) {
			return error(id, command.type, `Runtime not found: ${runtimeId}`);
		}

		if (command.type === "close_runtime") {
			if (runtimeId === defaultRuntimeId) {
				return error(id, "close_runtime", "The v2 compatibility runtime cannot be closed");
			}
			runtimeBindings.delete(runtimeId);
			cancelRuntimeHostCapabilityRequests(runtimeId);
			binding.unsubscribe?.();
			binding.unsubscribeBackpressure?.();
			if (backgroundTasks.activeCount > 0) retiredRuntimes.add(binding.runtime);
			else await binding.runtime.dispose();
			return success(id, "close_runtime", { closed: true });
		}

		if (command.type === "get_runtime_state") {
			return success(id, "get_runtime_state", {
				runtime: runtimeSummary(binding),
				state: sessionState(binding.session),
			});
		}

		const session = binding.session;

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
						clientMutationId: command.clientMutationId,
						attachments: command.attachments,
						systemPrompt: command.systemPrompt,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"), binding);
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message), binding);
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images, { clientMutationId: command.clientMutationId });
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images, { clientMutationId: command.clientMutationId });
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await binding.runtime.newSession(options);
				if (!result.cancelled) {
					await bindRuntime(binding);
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

			case "get_state": {
				return success(id, "get_state", sessionState(session));
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
				const result = await binding.runtime.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await bindRuntime(binding);
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await binding.runtime.fork(command.entryId);
				if (!result.cancelled) {
					await bindRuntime(binding);
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await binding.runtime.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await bindRuntime(binding);
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
					const messageCountBeforeCommand = session.messages.length;
					await extensionCommand.handler(
						command.args ?? "",
						session.extensionRunner.createCommandContext(extensionCommand.extensionId),
					);
					const customMessages = session.messages
						.slice(messageCountBeforeCommand)
						.filter((message) => message.role === "custom");
					return success(id, "invoke_extension_command", {
						invoked: true,
						...(customMessages.length > 0 ? { customMessages } : {}),
					});
				} catch (commandError: unknown) {
					return success(id, "invoke_extension_command", {
						invoked: false,
						error: commandError instanceof Error ? commandError.message : String(commandError),
					});
				}
			}

			case "reload_extensions": {
				if (!session.isStreaming) {
					await session.reload();
					return success(id, "reload_extensions", { reloaded: true, deferred: false });
				}
				binding.pendingExtensionReload = true;
				return success(id, "reload_extensions", { reloaded: false, deferred: true });
			}

			// =================================================================
			// Host Facade
			// =================================================================

			case "get_global_config": {
				return success(id, "get_global_config", getGlobalConfig());
			}

			case "save_global_provider": {
				saveGlobalProvider({ key: command.key, provider: command.provider, apiKey: command.apiKey });
				return success(id, "save_global_provider");
			}

			case "delete_global_provider": {
				await deleteGlobalProvider(command.key);
				return success(id, "delete_global_provider");
			}

			case "set_global_default": {
				await setGlobalDefault({
					provider: command.provider,
					model: command.model,
					thinkingLevel: command.thinkingLevel,
					cwd: command.cwd,
				});
				return success(id, "set_global_default");
			}

			case "set_craft_credential": {
				setCraftCredential(command.slug, command.credential);
				return success(id, "set_craft_credential");
			}

			case "get_session_projection": {
				return success(
					id,
					"get_session_projection",
					getSessionProjection({
						sessionPath: command.sessionPath,
						sessionDir: command.sessionDir,
						cwdOverride: command.cwdOverride,
					}),
				);
			}

			case "set_craft_session_metadata": {
				return success(
					id,
					"set_craft_session_metadata",
					setCraftSessionMetadata({
						sessionPath: command.sessionPath,
						sessionDir: command.sessionDir,
						cwdOverride: command.cwdOverride,
						name: command.name,
						metadata: command.metadata,
						customType: command.customType,
					}),
				);
			}

			case "fork_session": {
				return success(
					id,
					"fork_session",
					forkSession({
						sourcePath: command.sourcePath,
						targetCwd: command.targetCwd,
						sessionDir: command.sessionDir,
						id: command.idOverride,
						parentSession: command.parentSession,
					}),
				);
			}

			case "list_skills": {
				return success(
					id,
					"list_skills",
					await listSkills({ cwd: command.cwd, agentDir: command.agentDir, skillPaths: command.skillPaths }),
				);
			}

			case "resolve_skill": {
				return success(
					id,
					"resolve_skill",
					await resolveSkill({
						name: command.name,
						cwd: command.cwd,
						agentDir: command.agentDir,
						skillPaths: command.skillPaths,
					}),
				);
			}

			case "get_extensions": {
				return success(
					id,
					"get_extensions",
					await getExtensions({
						cwd: command.cwd,
						agentDir: command.agentDir,
						extensionTarget: binding.extensionTarget,
					}),
				);
			}

			case "set_extension_config": {
				await setExtensionConfig(command.name, command.config);
				return success(id, "set_extension_config");
			}

			case "get_model_catalog": {
				return success(id, "get_model_catalog", getModelCatalog({ provider: command.provider }));
			}

			case "enable_tool_permissions": {
				binding.toolPermissionsEnabled = command.enabled;
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
				session.registerHostTools(buildHostProxyTools(binding, command.tools) as never);
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
		if (globalHostIdleTimer) clearTimeout(globalHostIdleTimer);
		cleanupGlobalHostServer();
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
		const bindings = Array.from(runtimeBindings.values());
		runtimeBindings.clear();
		unsubscribeBackgroundTasks();
		for (const binding of bindings) {
			binding.unsubscribe?.();
			binding.unsubscribeBackpressure?.();
		}
		await Promise.allSettled([
			...bindings.map((binding) => binding.runtime.dispose()),
			...Array.from(retiredRuntimes, (runtime) => runtime.dispose()),
		]);
		retiredRuntimes.clear();
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

	const disposeClientRuntimes = async (clientId: string): Promise<void> => {
		const bindings = Array.from(runtimeBindings.values()).filter(
			(binding) => binding.runtimeId !== defaultRuntimeId && binding.clientId === clientId,
		);
		for (const binding of bindings) {
			runtimeBindings.delete(binding.runtimeId);
			cancelRuntimeHostCapabilityRequests(binding.runtimeId);
			binding.unsubscribe?.();
			binding.unsubscribeBackpressure?.();
			if (backgroundTasks.activeCount > 0) retiredRuntimes.add(binding.runtime);
			else await binding.runtime.dispose();
		}
	};

	function scheduleGlobalHostIdleExit(): void {
		if (process.env.PI_GLOBAL_HOST_PROCESS !== "1") return;
		if (globalHostIdleTimer) clearTimeout(globalHostIdleTimer);
		globalHostIdleTimer = undefined;
		if (stdioConnected || socketClients.size > 0 || runtimeBindings.size > 0 || backgroundTasks.activeCount > 0)
			return;
		globalHostIdleTimer = setTimeout(() => {
			globalHostIdleTimer = undefined;
			void shutdown();
		}, 30_000);
	}

	const handleInputLine = async (line: string, forcedClientId?: string) => {
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
			parsed.type === "extension_host_capability_progress"
		) {
			const progress = parsed as RpcExtensionHostCapabilityProgress;
			const pending = pendingHostCapabilityRequests.get(progress.id);
			if (
				pending &&
				(!progress.runtimeId || progress.runtimeId === pending.runtimeId) &&
				(!progress.clientId || progress.clientId === pending.clientId)
			)
				pending.onProgress?.(progress.progress, progress.sequence);
			return;
		}

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

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_host_capability_response"
		) {
			const response = parsed as RpcExtensionHostCapabilityResponse;
			const pending = pendingHostCapabilityRequests.get(response.id);
			if (
				pending &&
				(!response.runtimeId || response.runtimeId === pending.runtimeId) &&
				(!response.clientId || response.clientId === pending.clientId)
			)
				pending.resolve(response);
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
		if (forcedClientId) command.clientId = forcedClientId;
		else if (command.clientId) stdioClientIds.add(command.clientId);
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response, {
					clientId: command.clientId,
					runtimeId: command.runtimeId ?? defaultRuntimeId,
				});
				await waitForRawStdoutBackpressure();
			}
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			output(error(command.id, command.type, commandError), {
				clientId: command.clientId,
				runtimeId: command.runtimeId ?? defaultRuntimeId,
			});
			await waitForRawStdoutBackpressure();
		}
	};

	if (process.env.PI_GLOBAL_HOST_PROCESS === "1") {
		const statePath = getPiGlobalHostStatePath(hostAgentDir);
		const hostDir = dirname(statePath);
		const lockPath = join(hostDir, "host.lock");
		mkdirSync(hostDir, { recursive: true });
		let lockFd: number | undefined;
		try {
			lockFd = openSync(lockPath, "wx");
		} catch {
			const existing = readPiGlobalHostState(hostAgentDir);
			let existingAlive = false;
			if (existing) {
				try {
					process.kill(existing.pid, 0);
					existingAlive = true;
				} catch (error) {
					existingAlive = (error as NodeJS.ErrnoException).code === "EPERM";
				}
			}
			if (!existingAlive) {
				rmSync(lockPath, { force: true });
				lockFd = openSync(lockPath, "wx");
			}
		}
		if (lockFd !== undefined) {
			const token = crypto.randomBytes(32).toString("hex");
			const server = createServer((socket) => {
				let clientId: string | undefined;
				const detach = attachJsonlLineReader(socket, (line) => {
					if (!clientId) {
						try {
							const hello = JSON.parse(line) as { type?: string; token?: string; clientId?: string };
							if (hello.type !== "host_connect" || hello.token !== token || !hello.clientId) {
								socket.destroy();
								return;
							}
							clientId = hello.clientId;
							socketClients.get(clientId)?.destroy();
							socketClients.set(clientId, socket);
							socket.write(serializeJsonLine({ type: "host_connected", clientId }));
						} catch {
							socket.destroy();
						}
						return;
					}
					void handleInputLine(line, clientId);
				});
				socket.once("close", () => {
					detach();
					if (!clientId || socketClients.get(clientId) !== socket) return;
					socketClients.delete(clientId);
					void disposeClientRuntimes(clientId).finally(scheduleGlobalHostIdleExit);
				});
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Pi GlobalHost did not get a TCP port");
			const tempStatePath = `${statePath}.${process.pid}.tmp`;
			writeFileSync(
				tempStatePath,
				`${JSON.stringify(
					{
						version: 1,
						pid: process.pid,
						port: address.port,
						token,
						agentDir: hostAgentDir,
						startedAt: new Date().toISOString(),
						protocolVersion: PI_RPC_PROTOCOL_VERSION,
						packageVersion: VERSION,
					},
					null,
					2,
				)}\n`,
				"utf8",
			);
			renameSync(tempStatePath, statePath);
			cleanupGlobalHostServer = () => {
				server.close();
				for (const socket of socketClients.values()) socket.destroy();
				socketClients.clear();
				rmSync(statePath, { force: true });
				try {
					closeSync(lockFd);
				} catch {}
				rmSync(lockPath, { force: true });
			};
		}
	}

	const onInputEnd = () => {
		if (process.env.PI_GLOBAL_HOST_PROCESS !== "1") {
			void shutdown();
			return;
		}
		stdioConnected = false;
		const clientIds = Array.from(stdioClientIds);
		stdioClientIds.clear();
		void Promise.allSettled(clientIds.map(disposeClientRuntimes)).finally(scheduleGlobalHostIdleExit);
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
