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
	ExtensionInteractionCancelReasonV1,
	ExtensionInteractionRequestV1,
	ExtensionInteractionResponseV1,
	ExtensionUIContext,
	ExtensionUIContribution,
	ExtensionUIDialogOptions,
	ExtensionUIValidationDefinitionV1,
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
	RpcExtensionUICancel,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcExtensionUIValidationDeltaV1,
	RpcExtensionUIValidationEvent,
	RpcHostToolDefinition,
	RpcHostUICapabilities,
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
	RpcExtensionUICancel,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcExtensionUIValidationDeltaV1,
	RpcExtensionUIValidationEvent,
	RpcHostToolDefinition,
	RpcHostUICapabilities,
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

type RpcExtensionUIValidationEmission = RpcExtensionUIValidationDeltaV1 extends infer T
	? T extends unknown
		? Omit<T, "schemaVersion" | "revision">
		: never
	: never;

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
			extensionUiValidation: true,
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
		uiCapabilities?: RpcHostUICapabilities;
	};
}

const NO_RPC_HOST_UI: RpcHostUICapabilities = {
	kind: "none",
	dialogs: false,
	widgets: false,
	editorControl: false,
	contributions: false,
	validation: false,
	interactionSchemas: [],
};

function normalizeRpcHostUICapabilities(value: unknown): RpcHostUICapabilities {
	if (value === undefined) return { ...NO_RPC_HOST_UI, interactionSchemas: [] };
	if (typeof value !== "object" || value === null) {
		throw new Error("Invalid RPC host UI capability declaration");
	}
	const candidate = value as Record<string, unknown>;
	const interactionSchemas = candidate.interactionSchemas;
	if (
		Object.keys(candidate).some(
			(key) =>
				![
					"kind",
					"dialogs",
					"widgets",
					"editorControl",
					"contributions",
					"validation",
					"interactionSchemas",
				].includes(key),
		) ||
		(candidate.kind !== "craft" && candidate.kind !== "none") ||
		typeof candidate.dialogs !== "boolean" ||
		typeof candidate.widgets !== "boolean" ||
		typeof candidate.editorControl !== "boolean" ||
		typeof candidate.contributions !== "boolean" ||
		(candidate.validation !== undefined && typeof candidate.validation !== "boolean") ||
		!Array.isArray(interactionSchemas) ||
		interactionSchemas.some((schema) => !Number.isInteger(schema) || schema < 1)
	) {
		throw new Error("Invalid RPC host UI capability declaration");
	}
	const schemas = interactionSchemas as number[];
	if (
		candidate.kind === "none" &&
		(candidate.dialogs ||
			candidate.widgets ||
			candidate.editorControl ||
			candidate.contributions ||
			candidate.validation ||
			schemas.length > 0)
	) {
		throw new Error('RPC host UI kind "none" cannot declare UI features');
	}
	return {
		kind: candidate.kind as RpcHostUICapabilities["kind"],
		dialogs: candidate.dialogs as boolean,
		widgets: candidate.widgets as boolean,
		editorControl: candidate.editorControl as boolean,
		contributions: candidate.contributions as boolean,
		validation: candidate.validation === true,
		interactionSchemas: Array.from(new Set(schemas)).filter((schema) => schema === 1),
	};
}

export function parseRpcHostUICapabilities(value: string | undefined): RpcHostUICapabilities | undefined {
	if (value === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error(
			`Invalid RPC host UI capabilities JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return normalizeRpcHostUICapabilities(parsed);
}

export interface RpcModeOptions {
	uiCapabilities?: RpcHostUICapabilities;
}

export async function runRpcMode(
	runtimeSource: AgentSessionRuntime | RpcGlobalHostRuntimeFactory,
	options: RpcModeOptions = {},
): Promise<never> {
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
		uiCapabilities: RpcHostUICapabilities;
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
				uiCapabilities: normalizeRpcHostUICapabilities(options.uiCapabilities),
				toolPermissionsEnabled: false,
				pendingExtensionReload: false,
			}
		: undefined;
	if (defaultBinding) runtimeBindings.set(defaultRuntimeId, defaultBinding);

	const output = (
		obj: RpcResponse | RpcExtensionUIRequest | RpcExtensionUICancel | object,
		envelope?: { clientId?: string; runtimeId?: string; sessionId?: string; session?: AgentSession },
	) => {
		const sessionId = envelope?.session?.sessionId ?? envelope?.sessionId;
		const value = {
			...obj,
			...(envelope?.clientId ? { clientId: envelope.clientId } : {}),
			...(envelope?.runtimeId ? { runtimeId: envelope.runtimeId } : {}),
			...(sessionId ? { sessionId } : {}),
		};
		const line = serializeJsonLine(value);
		const clientId = "clientId" in value && typeof value.clientId === "string" ? value.clientId : undefined;
		if (clientId) {
			const socket = socketClients.get(clientId);
			if (socket?.writable) socket.write(line);
			else if (stdioConnected && stdioClientIds.has(clientId)) writeRawStdout(line);
			return;
		}
		if (stdioConnected) writeRawStdout(line);
	};
	const contributionRevisions = new Map<string, number>();
	const activeContributions = new Map<string, Map<string, ExtensionUIContribution>>();
	const validationRevisions = new Map<string, number>();
	const activeValidationDefinitions = new Map<string, Map<string, ExtensionUIValidationDefinitionV1>>();
	const nextContributionRevision = (binding: RuntimeBinding, extensionId: string): number => {
		const key = `${binding.runtimeId}\0${extensionId}`;
		const revision = (contributionRevisions.get(key) ?? 0) + 1;
		contributionRevisions.set(key, revision);
		return revision;
	};
	const emitContributionReset = (binding: RuntimeBinding, extensionId: string): void => {
		output(
			{
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				extensionId,
				method: "contribution",
				operation: "reset",
				revision: nextContributionRevision(binding, extensionId),
			} satisfies RpcExtensionUIRequest,
			binding,
		);
	};
	const emitContributionSnapshots = (binding: RuntimeBinding): void => {
		const prefix = `${binding.runtimeId}\0`;
		for (const [key, contributions] of activeContributions) {
			if (!key.startsWith(prefix)) continue;
			const extensionId = key.slice(prefix.length);
			output(
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					extensionId,
					method: "contribution",
					operation: "snapshot",
					revision: nextContributionRevision(binding, extensionId),
					contributions: Array.from(contributions.values()),
				} satisfies RpcExtensionUIRequest,
				binding,
			);
		}
	};
	const nextValidationRevision = (binding: RuntimeBinding, extensionId: string): number => {
		const key = `${binding.runtimeId}\0${extensionId}`;
		const revision = (validationRevisions.get(key) ?? 0) + 1;
		validationRevisions.set(key, revision);
		return revision;
	};
	const emitValidation = (
		binding: RuntimeBinding,
		extensionId: string,
		delta: RpcExtensionUIValidationEmission,
	): void => {
		output(
			{
				type: "extension_ui_validation",
				extensionId,
				delta: { schemaVersion: 1, revision: nextValidationRevision(binding, extensionId), ...delta },
			} as RpcExtensionUIValidationEvent,
			binding,
		);
	};
	const emitValidationSnapshots = (binding: RuntimeBinding): void => {
		if (!binding.uiCapabilities.validation) return;
		const prefix = `${binding.runtimeId}\0`;
		for (const [key, definitions] of activeValidationDefinitions) {
			if (!key.startsWith(prefix)) continue;
			emitValidation(binding, key.slice(prefix.length), {
				operation: "snapshot",
				definitions: Array.from(definitions.values()),
			});
		}
	};
	const resetRuntimeContributions = (binding: RuntimeBinding): void => {
		const prefix = `${binding.runtimeId}\0`;
		for (const key of contributionRevisions.keys()) {
			if (!key.startsWith(prefix)) continue;
			const extensionId = key.slice(prefix.length);
			emitContributionReset(binding, extensionId);
			activeContributions.delete(key);
		}
		for (const key of validationRevisions.keys()) {
			if (!key.startsWith(prefix)) continue;
			const extensionId = key.slice(prefix.length);
			if (binding.uiCapabilities.validation) emitValidation(binding, extensionId, { operation: "reset" });
			activeValidationDefinitions.delete(key);
		}
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
	type PendingExtensionRequest = {
		runtimeId: string;
		sessionId: string;
		clientId?: string;
		extensionId: string;
		method: "interact" | "select" | "confirm" | "input" | "editor";
		interactionRequest?: ExtensionInteractionRequestV1;
		resolve: (value: RpcExtensionUIResponse) => void;
		reject: (error: Error) => void;
	};
	const pendingExtensionRequests = new Map<string, PendingExtensionRequest>();
	const cancelExtensionRequests = (
		predicate: (pending: PendingExtensionRequest) => boolean,
		reason: Exclude<ExtensionInteractionCancelReasonV1, "user">,
	): void => {
		for (const [id, pending] of pendingExtensionRequests) {
			if (!predicate(pending)) continue;
			pendingExtensionRequests.delete(id);
			output(
				{
					type: "extension_ui_cancel",
					id,
					extensionId: pending.extensionId,
					schemaVersion: 1,
					reason,
					method: pending.method,
				} satisfies RpcExtensionUICancel,
				{ runtimeId: pending.runtimeId, sessionId: pending.sessionId, clientId: pending.clientId },
			);
			if (pending.interactionRequest) {
				pending.resolve({
					type: "extension_ui_response",
					id,
					extensionId: pending.extensionId,
					interaction: { schemaVersion: 1, status: "cancelled", reason },
				});
			} else {
				pending.resolve({ type: "extension_ui_response", id, cancelled: true });
			}
		}
	};
	type PendingHostCapabilityRequest = {
		runtimeId: string;
		sessionId: string;
		clientId?: string;
		extensionId: string;
		resolve: (value: RpcExtensionHostCapabilityResponse) => void;
		onProgress?: (progress: unknown, sequence: number) => void;
	};
	const pendingHostCapabilityRequests = new Map<string, PendingHostCapabilityRequest>();
	const cancelHostCapabilityRequests = (
		predicate: (pending: PendingHostCapabilityRequest) => boolean,
		code: "runtime_closed" | "session_rebound" | "host_shutdown",
		message: string,
	): void => {
		for (const [id, pending] of pendingHostCapabilityRequests) {
			if (!predicate(pending)) continue;
			pendingHostCapabilityRequests.delete(id);
			output(
				{
					type: "extension_host_capability_cancel",
					version: 1,
					id,
					extensionId: pending.extensionId,
				} satisfies RpcExtensionHostCapabilityCancel,
				{ runtimeId: pending.runtimeId, sessionId: pending.sessionId, clientId: pending.clientId },
			);
			pending.resolve({
				type: "extension_host_capability_response",
				version: 1,
				id,
				runtimeId: pending.runtimeId,
				sessionId: pending.sessionId,
				status: "cancelled",
				error: { code, message },
			});
		}
	};
	const cancelRuntimeHostCapabilityRequests = (runtimeId: string): void =>
		cancelHostCapabilityRequests(
			(pending) => pending.runtimeId === runtimeId,
			"runtime_closed",
			"Runtime closed before the host capability completed",
		);

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

	const hasOnlyKeys = (value: object, keys: readonly string[]): boolean =>
		Object.keys(value).every((key) => keys.includes(key));
	const interactionIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
	const isBoundedString = (value: unknown, maxLength: number, allowEmpty = false): value is string =>
		typeof value === "string" && value.length <= maxLength && (allowEmpty || value.trim().length > 0);
	const isOptionalBoundedString = (value: unknown, maxLength: number): boolean =>
		value === undefined || isBoundedString(value, maxLength);
	const isStableInteractionId = (value: unknown): value is string =>
		isBoundedString(value, 128) && interactionIdentifierPattern.test(value);
	const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === "boolean";
	const isOptionalBoundedInteger = (value: unknown, min: number, max: number): boolean =>
		value === undefined || (Number.isInteger(value) && Number(value) >= min && Number(value) <= max);

	function assertValidInteractionRequest(request: ExtensionInteractionRequestV1): void {
		if (
			typeof request !== "object" ||
			request === null ||
			!hasOnlyKeys(request, ["schemaVersion", "title", "description", "fields", "submitLabel", "cancelLabel"]) ||
			request.schemaVersion !== 1 ||
			!isOptionalBoundedString(request.title, 256) ||
			!isOptionalBoundedString(request.description, 4_000) ||
			!isOptionalBoundedString(request.submitLabel, 64) ||
			!isOptionalBoundedString(request.cancelLabel, 64) ||
			!Array.isArray(request.fields) ||
			request.fields.length < 1 ||
			request.fields.length > 32
		) {
			throw new Error("Interaction v1 requires at least one field");
		}
		const fieldIds = new Set<string>();
		for (const field of request.fields) {
			if (
				typeof field !== "object" ||
				field === null ||
				!isStableInteractionId(field.id) ||
				fieldIds.has(field.id)
			) {
				const invalidId = typeof field === "object" && field !== null && "id" in field ? field.id : undefined;
				throw new Error(`Invalid or duplicate interaction field id: ${String(invalidId ?? "")}`);
			}
			fieldIds.add(field.id);
			if (
				!isBoundedString(field.label, 256) ||
				!isOptionalBoundedString(field.description, 2_000) ||
				!isOptionalBoolean(field.required)
			)
				throw new Error(`Interaction field ${field.id} requires valid metadata`);
			if (field.kind === "confirm") {
				if (
					!hasOnlyKeys(field, ["id", "kind", "label", "description", "required", "defaultValue"]) ||
					!isOptionalBoolean(field.defaultValue)
				)
					throw new Error(`Confirm field ${field.id} is invalid`);
				continue;
			}
			if (field.kind === "choice") {
				if (
					!hasOnlyKeys(field, [
						"id",
						"kind",
						"label",
						"description",
						"required",
						"options",
						"multiple",
						"minSelections",
						"maxSelections",
						"allowOther",
						"otherLabel",
						"allowComment",
						"commentLabel",
					]) ||
					!Array.isArray(field.options) ||
					field.options.length < 1 ||
					field.options.length > 128 ||
					!isOptionalBoolean(field.multiple) ||
					!isOptionalBoolean(field.allowOther) ||
					!isOptionalBoundedString(field.otherLabel, 128) ||
					!isOptionalBoolean(field.allowComment) ||
					!isOptionalBoundedString(field.commentLabel, 128) ||
					(field.allowOther !== true && field.otherLabel !== undefined) ||
					(field.allowComment !== true && field.commentLabel !== undefined) ||
					!isOptionalBoundedInteger(field.minSelections, 0, field.options.length + (field.allowOther ? 1 : 0)) ||
					!isOptionalBoundedInteger(field.maxSelections, 1, field.options.length + (field.allowOther ? 1 : 0))
				)
					throw new Error(`Choice field ${field.id} is invalid`);
				const optionIds = new Set<string>();
				for (const option of field.options) {
					if (
						typeof option !== "object" ||
						option === null ||
						!hasOnlyKeys(option, ["id", "label", "description"]) ||
						!isStableInteractionId(option.id) ||
						optionIds.has(option.id) ||
						!isBoundedString(option.label, 256) ||
						!isOptionalBoundedString(option.description, 2_000)
					) {
						const invalidId =
							typeof option === "object" && option !== null && "id" in option ? option.id : undefined;
						throw new Error(
							`Invalid or duplicate option id in interaction field ${field.id}: ${String(invalidId ?? "")}`,
						);
					}
					optionIds.add(option.id);
				}
				if (
					field.minSelections !== undefined &&
					field.maxSelections !== undefined &&
					field.minSelections > field.maxSelections
				) {
					throw new Error(`Choice field ${field.id} has minSelections greater than maxSelections`);
				}
				if (field.multiple !== true && ((field.minSelections ?? 0) > 1 || (field.maxSelections ?? 1) > 1)) {
					throw new Error(`Single-choice field ${field.id} cannot require multiple selections`);
				}
				continue;
			}
			if (field.kind !== "text") throw new Error("Interaction field has an invalid kind");
			if (
				!hasOnlyKeys(field, [
					"id",
					"kind",
					"label",
					"description",
					"required",
					"placeholder",
					"defaultValue",
					"multiline",
					"sensitive",
					"minLength",
					"maxLength",
				]) ||
				!isOptionalBoundedString(field.placeholder, 512) ||
				(field.defaultValue !== undefined && !isBoundedString(field.defaultValue, 20_000, true)) ||
				!isOptionalBoolean(field.multiline) ||
				!isOptionalBoolean(field.sensitive) ||
				!isOptionalBoundedInteger(field.minLength, 0, 20_000) ||
				!isOptionalBoundedInteger(field.maxLength, 1, 20_000) ||
				(field.multiline === true && field.sensitive === true) ||
				(field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength)
			)
				throw new Error(`Text field ${field.id} is invalid`);
		}
	}

	function isValidInteractionResponse(request: ExtensionInteractionRequestV1, value: unknown): boolean {
		if (typeof value !== "object" || value === null) return false;
		const response = value as ExtensionInteractionResponseV1;
		if (response.schemaVersion !== 1) return false;
		if (response.status === "cancelled") {
			return (
				hasOnlyKeys(response, ["schemaVersion", "status", "reason"]) &&
				(response.reason === undefined ||
					["user", "timeout", "aborted", "host-disconnected", "runtime-disposed"].includes(response.reason))
			);
		}
		if (
			response.status !== "submitted" ||
			!hasOnlyKeys(response, ["schemaVersion", "status", "answers"]) ||
			!Array.isArray(response.answers)
		)
			return false;
		if (
			response.answers.some(
				(answer) => typeof answer !== "object" || answer === null || !isStableInteractionId(answer.fieldId),
			)
		)
			return false;
		if (response.answers.length !== request.fields.length) return false;
		const answers = new Map(response.answers.map((answer) => [answer.fieldId, answer]));
		if (answers.size !== request.fields.length) return false;
		for (const field of request.fields) {
			const answer = answers.get(field.id);
			if (!answer || answer.kind !== field.kind) return false;
			if (field.kind === "confirm") {
				if (
					answer.kind !== "confirm" ||
					!hasOnlyKeys(answer, ["fieldId", "kind", "value"]) ||
					typeof answer.value !== "boolean"
				)
					return false;
				continue;
			}
			if (field.kind === "text") {
				if (
					answer.kind !== "text" ||
					!hasOnlyKeys(answer, ["fieldId", "kind", "value"]) ||
					!isBoundedString(answer.value, 20_000, true)
				)
					return false;
				if (field.required && answer.value.trim().length === 0) return false;
				if (field.minLength !== undefined && answer.value.length < field.minLength) return false;
				if (field.maxLength !== undefined && answer.value.length > field.maxLength) return false;
				continue;
			}
			if (
				answer.kind !== "choice" ||
				!hasOnlyKeys(answer, ["fieldId", "kind", "selectedOptionIds", "otherText", "comment"]) ||
				!Array.isArray(answer.selectedOptionIds) ||
				answer.selectedOptionIds.length > 128 ||
				answer.selectedOptionIds.some((id) => !isStableInteractionId(id))
			)
				return false;
			const selected = new Set(answer.selectedOptionIds);
			if (selected.size !== answer.selectedOptionIds.length) return false;
			const optionIds = new Set(field.options.map((option) => option.id));
			if (answer.selectedOptionIds.some((id) => !optionIds.has(id))) return false;
			if (answer.otherText !== undefined && (!field.allowOther || !isBoundedString(answer.otherText, 20_000, true)))
				return false;
			if (answer.comment !== undefined && (!field.allowComment || !isBoundedString(answer.comment, 20_000, true)))
				return false;
			const selectionCount = answer.selectedOptionIds.length + (answer.otherText?.trim() ? 1 : 0);
			if (!field.multiple && selectionCount > 1) return false;
			if (field.minSelections !== undefined && selectionCount < field.minSelections) return false;
			if (field.maxSelections !== undefined && selectionCount > field.maxSelections) return false;
			if (field.required && selectionCount === 0) return false;
		}
		return true;
	}

	function isValidLegacyUIResponse(pending: PendingExtensionRequest, response: RpcExtensionUIResponse): boolean {
		if ("interaction" in response) return false;
		const commonKeys = ["type", "id", "clientId", "runtimeId", "sessionId", "extensionId"];
		if ("cancelled" in response) {
			return response.cancelled === true && hasOnlyKeys(response, [...commonKeys, "cancelled"]);
		}
		if (pending.method === "confirm") {
			return (
				"confirmed" in response &&
				typeof response.confirmed === "boolean" &&
				hasOnlyKeys(response, [...commonKeys, "confirmed"])
			);
		}
		return (
			"value" in response && typeof response.value === "string" && hasOnlyKeys(response, [...commonKeys, "value"])
		);
	}

	function assertValidDialogOptions(options: ExtensionUIDialogOptions | undefined): void {
		if (
			options?.timeout !== undefined &&
			(!Number.isSafeInteger(options.timeout) || options.timeout <= 0 || options.timeout > 86_400_000)
		) {
			throw new Error("Extension UI timeout must be between 1 and 86400000 milliseconds");
		}
	}

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		binding: RuntimeBinding,
		extensionId: string,
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		assertValidDialogOptions(opts);
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
		const method = request.method as PendingExtensionRequest["method"];

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			let emitted = false;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				if (emitted) {
					output(
						{ type: "extension_ui_cancel", id, extensionId, schemaVersion: 1, reason: "aborted", method },
						binding,
					);
				}
				cleanup();
				resolve(defaultValue);
			};

			pendingExtensionRequests.set(id, {
				runtimeId: binding.runtimeId,
				sessionId: binding.session.sessionId,
				clientId: binding.clientId,
				extensionId,
				method,
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.signal?.aborted) {
				onAbort();
				return;
			}
			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					if (emitted) {
						output(
							{ type: "extension_ui_cancel", id, extensionId, schemaVersion: 1, reason: "timeout", method },
							binding,
						);
					}
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}
			emitted = true;
			output({ type: "extension_ui_request", id, extensionId, ...request } as RpcExtensionUIRequest, binding);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (binding: RuntimeBinding, extensionId: string): ExtensionUIContext => ({
		capabilities: {
			kind: binding.uiCapabilities.kind,
			dialogs: binding.uiCapabilities.dialogs,
			widgets: binding.uiCapabilities.widgets,
			customComponents: false,
			terminalInput: false,
			editorControl: binding.uiCapabilities.editorControl,
			contributions: binding.uiCapabilities.contributions,
			interactionSchemas: binding.uiCapabilities.interactionSchemas,
		},
		validation: {
			available: binding.uiCapabilities.validation === true,
			protocolVersions: binding.uiCapabilities.validation ? [1] : [],
			upsertDefinition(definition): void {
				if (!binding.uiCapabilities.validation) return;
				const ownerKey = `${binding.runtimeId}\0${extensionId}`;
				const definitions = activeValidationDefinitions.get(ownerKey) ?? new Map();
				definitions.set(definition.id, definition);
				activeValidationDefinitions.set(ownerKey, definitions);
				emitValidation(binding, extensionId, { operation: "upsert", definition });
			},
			updateState(definitionId, state): void {
				if (!binding.uiCapabilities.validation) return;
				const definitions = activeValidationDefinitions.get(`${binding.runtimeId}\0${extensionId}`);
				const current = definitions?.get(definitionId);
				if (!definitions || !current) throw new Error(`Unknown UI validation definition: ${definitionId}`);
				const definition: ExtensionUIValidationDefinitionV1 = { ...current, ...state };
				definitions.set(definitionId, definition);
				emitValidation(binding, extensionId, { operation: "upsert", definition });
			},
			removeDefinition(definitionId): void {
				if (!binding.uiCapabilities.validation) return;
				activeValidationDefinitions.get(`${binding.runtimeId}\0${extensionId}`)?.delete(definitionId);
				emitValidation(binding, extensionId, { operation: "remove", definitionId });
			},
			clearDefinitions(): void {
				if (!binding.uiCapabilities.validation) return;
				activeValidationDefinitions.delete(`${binding.runtimeId}\0${extensionId}`);
				emitValidation(binding, extensionId, { operation: "reset" });
			},
		},
		upsertContribution(contribution): void {
			if (!binding.uiCapabilities.contributions) return;
			const ownerKey = `${binding.runtimeId}\0${extensionId}`;
			const contributions = activeContributions.get(ownerKey) ?? new Map();
			contributions.set(contribution.id, contribution);
			activeContributions.set(ownerKey, contributions);
			output(
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					extensionId,
					method: "contribution",
					operation: "upsert",
					revision: nextContributionRevision(binding, extensionId),
					contribution,
				} satisfies RpcExtensionUIRequest,
				binding,
			);
		},
		removeContribution(contributionId): void {
			if (!binding.uiCapabilities.contributions) return;
			activeContributions.get(`${binding.runtimeId}\0${extensionId}`)?.delete(contributionId);
			output(
				{
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					extensionId,
					method: "contribution",
					operation: "remove",
					revision: nextContributionRevision(binding, extensionId),
					contributionId,
				} satisfies RpcExtensionUIRequest,
				binding,
			);
		},
		clearContributions(): void {
			if (!binding.uiCapabilities.contributions) return;
			activeContributions.delete(`${binding.runtimeId}\0${extensionId}`);
			emitContributionReset(binding, extensionId);
		},
		interact: (request, opts) => {
			assertValidInteractionRequest(request);
			assertValidDialogOptions(opts);
			if (!binding.uiCapabilities.interactionSchemas.includes(1)) {
				return Promise.resolve({ schemaVersion: 1, status: "cancelled", reason: "host-disconnected" });
			}
			if (opts?.signal?.aborted) {
				return Promise.resolve({ schemaVersion: 1, status: "cancelled", reason: "aborted" });
			}
			const id = crypto.randomUUID();
			return new Promise<ExtensionInteractionResponseV1>((resolve, reject) => {
				let timeoutId: ReturnType<typeof setTimeout> | undefined;
				let emitted = false;
				const cleanup = () => {
					if (timeoutId) clearTimeout(timeoutId);
					opts?.signal?.removeEventListener("abort", onAbort);
					pendingExtensionRequests.delete(id);
				};
				const cancel = (reason: "aborted" | "timeout") => {
					if (emitted) {
						output(
							{
								type: "extension_ui_cancel",
								id,
								extensionId,
								schemaVersion: 1,
								reason,
								method: "interact",
							} satisfies RpcExtensionUICancel,
							binding,
						);
					}
					cleanup();
					resolve({ schemaVersion: 1, status: "cancelled", reason });
				};
				const onAbort = () => cancel("aborted");
				pendingExtensionRequests.set(id, {
					runtimeId: binding.runtimeId,
					sessionId: binding.session.sessionId,
					clientId: binding.clientId,
					extensionId,
					method: "interact",
					interactionRequest: request,
					resolve: (response) => {
						cleanup();
						if (!("interaction" in response)) {
							reject(new Error("Host returned a legacy response for an interaction v1 request"));
							return;
						}
						resolve(response.interaction);
					},
					reject: (error) => {
						cleanup();
						reject(error);
					},
				});
				opts?.signal?.addEventListener("abort", onAbort, { once: true });
				if (opts?.signal?.aborted) {
					onAbort();
					return;
				}
				if (opts?.timeout) timeoutId = setTimeout(() => cancel("timeout"), opts.timeout);
				emitted = true;
				output(
					{ type: "extension_ui_request", id, extensionId, method: "interact", request, timeout: opts?.timeout },
					binding,
				);
			});
		},
		select: (title, options, opts) =>
			binding.uiCapabilities.dialogs
				? createDialogPromise(
						binding,
						extensionId,
						opts,
						undefined,
						{ method: "select", title, options, timeout: opts?.timeout },
						(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
					)
				: Promise.resolve(undefined),

		confirm: (title, message, opts) =>
			binding.uiCapabilities.dialogs
				? createDialogPromise(
						binding,
						extensionId,
						opts,
						false,
						{ method: "confirm", title, message, timeout: opts?.timeout },
						(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
					)
				: Promise.resolve(false),

		input: (title, placeholder, opts) =>
			binding.uiCapabilities.dialogs
				? createDialogPromise(
						binding,
						extensionId,
						opts,
						undefined,
						{ method: "input", title, placeholder, timeout: opts?.timeout },
						(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
					)
				: Promise.resolve(undefined),

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
			if (!binding.uiCapabilities.widgets) return;
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
			if (!binding.uiCapabilities.editorControl) return;
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
			if (!binding.uiCapabilities.editorControl) return;
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

		editor: (title: string, prefill?: string): Promise<string | undefined> =>
			binding.uiCapabilities.dialogs
				? createDialogPromise(
						binding,
						extensionId,
						undefined,
						undefined,
						{ method: "editor", title, prefill },
						(response) => ("value" in response ? response.value : undefined),
					)
				: Promise.resolve(undefined),

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
				pendingHostCapabilityRequests.set(id, {
					runtimeId: binding.runtimeId,
					sessionId: binding.session.sessionId,
					clientId: binding.clientId,
					extensionId,
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
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				if (options?.signal?.aborted) {
					onAbort();
					return;
				}
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
				resetRuntimeContributions(binding);
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
			const previousSessionId = binding.session.sessionId;
			cancelExtensionRequests((pending) => pending.runtimeId === binding.runtimeId, "runtime-disposed");
			cancelHostCapabilityRequests(
				(pending) => pending.runtimeId === binding.runtimeId && pending.sessionId === previousSessionId,
				"session_rebound",
				"Session changed before the host capability completed",
			);
			resetRuntimeContributions(binding);
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
	const ensureDefaultBinding = async (clientId?: string): Promise<RuntimeBinding> => {
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
				clientId,
				runtime,
				session: runtime.session,
				extensionTarget: globalHostFactory.defaultRuntime.extensionTarget,
				uiCapabilities: normalizeRpcHostUICapabilities(globalHostFactory.defaultRuntime.uiCapabilities),
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
	const isRuntimeOwner = (binding: RuntimeBinding, clientId: string | undefined): boolean =>
		(binding.runtimeId === defaultRuntimeId && binding.clientId === undefined) || binding.clientId === clientId;

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
				if (!isRuntimeOwner(binding, command.clientId)) {
					return error(id, "open_runtime", `Runtime not found: ${runtimeId}`);
				}
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
				uiCapabilities: normalizeRpcHostUICapabilities(command.uiCapabilities),
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
				runtimes: Array.from(runtimeBindings.values())
					.filter((candidate) => isRuntimeOwner(candidate, command.clientId))
					.map(runtimeSummary),
			});
		}

		if (!binding && runtimeId === defaultRuntimeId && command.runtimeId === undefined) {
			binding = await ensureDefaultBinding(command.clientId);
		}

		if (!binding) {
			return error(id, command.type, `Runtime not found: ${runtimeId}`);
		}
		if (!isRuntimeOwner(binding, command.clientId)) {
			return error(id, command.type, `Runtime not found: ${runtimeId}`);
		}

		if (command.type === "close_runtime") {
			if (runtimeId === defaultRuntimeId) {
				return error(id, "close_runtime", "The v2 compatibility runtime cannot be closed");
			}
			resetRuntimeContributions(binding);
			runtimeBindings.delete(runtimeId);
			cancelExtensionRequests((pending) => pending.runtimeId === runtimeId, "runtime-disposed");
			cancelRuntimeHostCapabilityRequests(runtimeId);
			binding.unsubscribe?.();
			binding.unsubscribeBackpressure?.();
			if (backgroundTasks.activeCount > 0) retiredRuntimes.add(binding.runtime);
			else await binding.runtime.dispose();
			return success(id, "close_runtime", { closed: true });
		}

		if (command.type === "get_runtime_state") {
			emitContributionSnapshots(binding);
			emitValidationSnapshots(binding);
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
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await binding.runtime.fork(command.entryId);
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await binding.runtime.fork(leafId, { position: "at" });
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
						extensionId: command.extensionId,
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
				if (command.ownerExtensionId !== undefined && extensionCommand.extensionId !== command.ownerExtensionId) {
					return success(id, "invoke_extension_command", {
						invoked: false,
						error: `Extension command owner mismatch for ${command.commandId}`,
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
					resetRuntimeContributions(binding);
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
		cancelExtensionRequests(() => true, "runtime-disposed");
		cancelHostCapabilityRequests(
			() => true,
			"host_shutdown",
			"RPC host shut down before the host capability completed",
		);
		const bindings = Array.from(runtimeBindings.values());
		for (const binding of bindings) resetRuntimeContributions(binding);
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
			resetRuntimeContributions(binding);
			runtimeBindings.delete(binding.runtimeId);
			cancelExtensionRequests((pending) => pending.runtimeId === binding.runtimeId, "host-disconnected");
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
			const actualClientId = forcedClientId ?? progress.clientId;
			if (
				pending &&
				progress.runtimeId === pending.runtimeId &&
				progress.sessionId === pending.sessionId &&
				actualClientId === pending.clientId &&
				(forcedClientId === undefined || progress.clientId === undefined || progress.clientId === forcedClientId)
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
			if (!pending) return;
			const actualClientId = forcedClientId ?? response.clientId;
			if (pending.clientId !== undefined && actualClientId !== pending.clientId) return;
			const rejectMalformedResponse = () => {
				pendingExtensionRequests.delete(response.id);
				pending.reject(new Error(`Host returned an invalid ${pending.method} response`));
			};
			if (
				(forcedClientId !== undefined && response.clientId !== undefined && response.clientId !== forcedClientId) ||
				("extensionId" in response && response.extensionId !== pending.extensionId)
			) {
				rejectMalformedResponse();
				return;
			}
			if (response.runtimeId !== pending.runtimeId || response.sessionId !== pending.sessionId) {
				rejectMalformedResponse();
				return;
			}
			if (pending.interactionRequest) {
				if (
					!("interaction" in response) ||
					!hasOnlyKeys(response, [
						"type",
						"id",
						"clientId",
						"runtimeId",
						"sessionId",
						"extensionId",
						"interaction",
					]) ||
					response.extensionId !== pending.extensionId
				) {
					rejectMalformedResponse();
					return;
				}
				if (!isValidInteractionResponse(pending.interactionRequest, response.interaction)) {
					rejectMalformedResponse();
					return;
				}
			} else if (!isValidLegacyUIResponse(pending, response)) {
				rejectMalformedResponse();
				return;
			}
			pendingExtensionRequests.delete(response.id);
			pending.resolve(response);
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
			const actualClientId = forcedClientId ?? response.clientId;
			if (
				pending &&
				response.runtimeId === pending.runtimeId &&
				response.sessionId === pending.sessionId &&
				actualClientId === pending.clientId &&
				(forcedClientId === undefined || response.clientId === undefined || response.clientId === forcedClientId)
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
