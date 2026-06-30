import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai/types";
import { createAssistantMessageDiagnostic } from "@earendil-works/pi-ai/utils/diagnostics";
import { NetworkRouteDispatcher } from "./network-dispatcher.ts";
import { SidecarManager, type SidecarState } from "./network-sidecar.ts";
import type {
	AgentRetryContext,
	EffectiveNetworkSettings,
	NetworkRequestClass,
	NetworkRequestContext,
	NetworkRequestOptions,
	NetworkRetryDecision,
	NetworkRoutePath,
	NetworkSettings,
	SidecarTransportOutcome,
} from "./network-types.ts";
import type { SettingsManager } from "./settings-manager.ts";

const DEFAULT_NETWORK_SETTINGS: EffectiveNetworkSettings = {
	mode: "auto",
	proxy: {
		enabled: true,
		candidates: ["http://127.0.0.1:7890", "http://127.0.0.1:7897", "http://127.0.0.1:7899"],
		probeTimeoutMs: 500,
		statusCacheMs: 15_000,
	},
	sidecar: {
		enabled: true,
		binaryPath: "",
		restartBackoffMs: 2_000,
		healthCheckIntervalMs: 15_000,
	},
	bypass: {
		hosts: ["localhost", "127.0.0.1", "::1", "*.local"],
		cidrs: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
	},
	routeRules: [],
	timeouts: {
		connectMs: 15_000,
		tlsMs: 15_000,
		responseHeaderTimeoutMs: 60_000,
		idleStreamMs: 90_000,
		totalMs: 300_000,
	},
	retry: {
		maxAttempts: 2,
		baseDelayMs: 500,
		maxDelayMs: 3_000,
		jitter: true,
	},
	circuitBreaker: {
		failureThreshold: 3,
		cooldownMs: 60_000,
	},
};

interface ActiveRequestRecord {
	requestClass: NetworkRequestClass;
	context: NetworkRequestContext;
}

export interface NetworkRuntimeResetResult {
	mode: EffectiveNetworkSettings["mode"];
	sidecarEnabled: boolean;
	sidecarReady: boolean;
	sidecarHealthState?: SidecarState["healthState"];
	sidecarBaseUrl?: string;
	clearedActiveRequests: number;
	clearedPendingRetryPaths: number;
}

export class NetworkManager {
	private readonly settingsManager: SettingsManager;
	private settings: EffectiveNetworkSettings;
	private readonly sidecarManager: SidecarManager;
	private dispatcher: NetworkRouteDispatcher;
	private readonly activeRequests = new Map<string, ActiveRequestRecord>();
	private readonly pendingRetryPaths = new Map<string, NetworkRoutePath>();
	private lastKnownPath: NetworkRoutePath = "direct";

	constructor(settingsManager: SettingsManager) {
		this.settingsManager = settingsManager;
		this.settings = this.mergeSettings(settingsManager.getNetworkSettings());
		this.sidecarManager = new SidecarManager(this.settings);
		this.dispatcher = new NetworkRouteDispatcher(this.settings);
	}

	async initialize(): Promise<void> {
		await this.refreshSidecarIfPreferred();
	}

	async dispose(): Promise<void> {
		await this.dispatcher.destroy();
		await this.sidecarManager.stop();
	}

	async applySettings(settings?: NetworkSettings): Promise<void> {
		this.settings = this.mergeSettings(settings ?? this.settingsManager.getNetworkSettings());
		this.dispatcher.applySettings(this.settings);
		this.sidecarManager.applySettings(this.settings);
		await this.refreshSidecarIfPreferred();
	}

	getEffectiveSettings(): EffectiveNetworkSettings {
		return this.settings;
	}

	async resetRuntimeState(): Promise<NetworkRuntimeResetResult> {
		const clearedActiveRequests = this.activeRequests.size;
		const clearedPendingRetryPaths = this.pendingRetryPaths.size;
		this.activeRequests.clear();
		this.pendingRetryPaths.clear();
		this.lastKnownPath = "direct";
		this.dispatcher.reset();
		await this.sidecarManager.reset();
		await this.applySettings();
		const sidecarState = this.sidecarManager.getState();
		return {
			mode: this.settings.mode,
			sidecarEnabled: sidecarState.enabled,
			sidecarReady: sidecarState.ready,
			sidecarHealthState: sidecarState.healthState,
			sidecarBaseUrl: sidecarState.baseUrl,
			clearedActiveRequests,
			clearedPendingRetryPaths,
		};
	}

	beginRequest(url: string | URL, options: NetworkRequestOptions): NetworkRequestContext {
		const resolvedUrl = typeof url === "string" ? new URL(url) : url;
		const requestId = options.requestId ?? randomUUID();
		const traceId = options.traceId ?? requestId;
		const forcedPath = this.consumePendingRetryPath(resolvedUrl, options.requestClass);
		const fallbackPaths = this.resolveFallbackPaths(options.requestClass);
		const decision = this.dispatcher.select(resolvedUrl, {
			...options,
			requestId,
			traceId,
			fallbackPaths: forcedPath ? [forcedPath] : fallbackPaths,
		});
		if (!decision) {
			throw this.createStrictProxyUnavailableError(resolvedUrl, requestId, traceId);
		}
		const fallbackReason: NetworkRequestContext["fallbackReason"] =
			decision.context.path === "direct" && decision.context.fallbackUsed ? "sidecar_unavailable" : undefined;
		const context: NetworkRequestContext = {
			...decision.context,
			requestId,
			traceId,
			attempt: 1,
			fallbackReason,
			sidecarBaseUrl: decision.context.path === "sidecar" ? this.sidecarManager.getState().baseUrl : undefined,
		};
		this.lastKnownPath = context.path;
		this.activeRequests.set(requestId, {
			requestClass: options.requestClass,
			context,
		});
		return context;
	}

	createHttpFetch(
		requestContext: NetworkRequestContext | undefined,
		options?: { timeoutMs?: number; maxAttempts?: number },
	): typeof fetch | undefined {
		if (!requestContext || requestContext.path !== "sidecar") {
			return undefined;
		}
		return this.sidecarManager.createFetch(requestContext, {
			totalTimeoutMs: options?.timeoutMs ?? this.settings.timeouts.totalMs,
			connectTimeoutMs: this.settings.timeouts.connectMs,
			tlsTimeoutMs: this.settings.timeouts.tlsMs,
			responseHeaderTimeoutMs: this.settings.timeouts.responseHeaderTimeoutMs,
			idleStreamTimeoutMs: this.settings.timeouts.idleStreamMs,
			maxAttempts: options?.maxAttempts ?? this.settings.retry.maxAttempts,
			retryBaseDelayMs: this.settings.retry.baseDelayMs,
			retryMaxDelayMs: this.settings.retry.maxDelayMs,
			proxyMode: requestContext.sidecarProxyMode,
		});
	}

	markFirstByte(requestId: string): void {
		const record = this.activeRequests.get(requestId);
		if (!record) return;
		record.context.firstByteReceived = true;
	}

	completeRequest(requestId: string, success: boolean): void {
		const record = this.activeRequests.get(requestId);
		if (!record) return;
		if (success) {
			this.dispatcher.noteSuccess(record.context);
		} else {
			this.dispatcher.noteFailure(record.context);
		}
		this.activeRequests.delete(requestId);
	}

	attachRequestContext(message: AssistantMessage, requestContext: NetworkRequestContext): void {
		message.diagnostics = [
			...(message.diagnostics ?? []),
			createAssistantMessageDiagnostic("network_request_context", new Error("network_request_context"), {
				requestId: requestContext.requestId,
				traceId: requestContext.traceId,
				targetHost: requestContext.host,
				routeMode: requestContext.routeMode,
				selectedPath: requestContext.path,
				attemptCount: requestContext.attempt,
				requestClass: requestContext.requestClass,
				method: requestContext.method,
				firstByteReceived: requestContext.firstByteReceived,
				matchedRoutePolicy: requestContext.matchedRoutePolicy,
				sidecarRequired: requestContext.sidecarRequired,
				sidecarAvailable: requestContext.sidecarAvailable,
				sidecarProxyMode: requestContext.sidecarProxyMode,
				sidecarBaseUrl: requestContext.sidecarBaseUrl,
				circuitState: requestContext.circuitState,
				sidecarFinalStatus: requestContext.transportOutcome?.finalStatus,
				sidecarResponseStatus: requestContext.transportOutcome?.responseStatus,
				sidecarAttemptCount: requestContext.transportOutcome?.attemptCount,
				sidecarRetryCount: requestContext.transportOutcome?.retryCount,
				sidecarStreamingResponse: requestContext.transportOutcome?.streamingResponse,
				sidecarStreamStarted: requestContext.transportOutcome?.streamStarted,
				sidecarFailureStage: requestContext.transportOutcome?.failureStage,
				sidecarTimeoutKind: requestContext.transportOutcome?.timeoutKind,
				sidecarErrorMessage: requestContext.transportOutcome?.errorMessage,
			}),
		];
	}

	annotateAssistantFailure(message: AssistantMessage, requestContext?: NetworkRequestContext): void {
		const resolvedContext = requestContext ?? this.findContextFromDiagnostics(message);
		const fallbackContext =
			resolvedContext ??
			({
				requestId: randomUUID(),
				traceId: randomUUID(),
				requestClass: "model_pre_first_byte",
				attempt: 1,
				host: "unknown",
				method: "POST",
				path: this.lastKnownPath,
				routeMode: this.settings.mode,
				firstByteReceived: false,
				poolRebuilt: false,
				fallbackUsed: false,
				sidecarRequired: this.settings.mode === "proxy",
				sidecarAvailable: this.dispatcher.getSidecarAvailable(),
				sidecarProxyMode: this.settings.mode === "proxy" ? "required" : undefined,
				circuitState: this.dispatcher.getCircuitState(this.lastKnownPath),
				startedAt: Date.now(),
			} satisfies NetworkRequestContext);
		const durationMs = Date.now() - fallbackContext.startedAt;
		const sidecarHealth = this.sidecarManager.getState().health;
		message.diagnostics = [
			...(message.diagnostics ?? []),
			createAssistantMessageDiagnostic(
				"network_request_failure",
				new Error(message.errorMessage ?? "Request failed"),
				{
					requestId: fallbackContext.requestId,
					traceId: fallbackContext.traceId,
					targetHost: fallbackContext.host,
					routeMode: fallbackContext.routeMode,
					selectedPath: fallbackContext.path,
					attemptCount: fallbackContext.attempt,
					durationMs,
					poolRebuilt: fallbackContext.poolRebuilt,
					fallbackUsed: fallbackContext.fallbackUsed,
					fallbackReason: fallbackContext.fallbackReason,
					matchedRoutePolicy: fallbackContext.matchedRoutePolicy,
					sidecarRequired: fallbackContext.sidecarRequired,
					sidecarAvailable: fallbackContext.sidecarAvailable,
					sidecarProxyMode: fallbackContext.sidecarProxyMode,
					sidecarBaseUrl: fallbackContext.sidecarBaseUrl,
					sidecarFinalStatus: fallbackContext.transportOutcome?.finalStatus,
					sidecarResponseStatus: fallbackContext.transportOutcome?.responseStatus,
					sidecarAttemptCount: fallbackContext.transportOutcome?.attemptCount,
					sidecarRetryCount: fallbackContext.transportOutcome?.retryCount,
					sidecarStreamingResponse: fallbackContext.transportOutcome?.streamingResponse,
					sidecarStreamStarted: fallbackContext.transportOutcome?.streamStarted,
					sidecarFailureStage: fallbackContext.transportOutcome?.failureStage,
					sidecarTimeoutKind: fallbackContext.transportOutcome?.timeoutKind,
					sidecarErrorMessage: fallbackContext.transportOutcome?.errorMessage,

					replaySuppressedReason: fallbackContext.replaySuppressedReason,
					circuitState: fallbackContext.circuitState,
					sidecarState: sidecarHealth?.state ?? this.sidecarManager.getState().healthState,
					sidecarLastErrorStage: sidecarHealth?.lastError?.stage,
					sidecarLastErrorTarget: sidecarHealth?.lastError?.target,
					sidecarLastErrorCount: sidecarHealth?.lastError?.count,
				},
			),
		];
	}

	async prepareRetry(context: AgentRetryContext): Promise<NetworkRetryDecision | undefined> {
		const requestContext =
			this.findContextFromDiagnostics(context.message) ??
			({
				requestId: randomUUID(),
				traceId: randomUUID(),
				requestClass: "model_pre_first_byte",
				attempt: context.attempt,
				host: "unknown",
				method: "POST",
				path: this.lastKnownPath,
				routeMode: this.settings.mode,
				firstByteReceived: false,
				poolRebuilt: false,
				fallbackUsed: false,
				sidecarRequired: this.settings.mode === "proxy",
				sidecarAvailable: this.dispatcher.getSidecarAvailable(),
				sidecarProxyMode: this.settings.mode === "proxy" ? "required" : undefined,
				circuitState: this.dispatcher.getCircuitState(this.lastKnownPath),
				startedAt: Date.now(),
			} satisfies NetworkRequestContext);

		const suppressedReason = this.getReplaySuppressedReason(
			requestContext,
			this.findTransportErrorCode(context.message),
		);
		const allowedAttempts = this.maxAttemptsForClass(requestContext.requestClass);
		if (suppressedReason || context.attempt > allowedAttempts) {
			return {
				shouldRetry: false,
				delayMs: 0,
				attempt: context.attempt,
				maxAttempts: allowedAttempts,
				errorMessage: context.message.errorMessage ?? "Unknown error",
				context: {
					...requestContext,
					replaySuppressedReason: suppressedReason,
				},
				replaySuppressedReason: suppressedReason,
			};
		}

		const alternatePath = requestContext.path === "direct" && !requestContext.sidecarRequired ? "sidecar" : undefined;
		const canFallback = alternatePath === "sidecar" ? await this.ensureSidecarAvailable() : false;
		if (alternatePath && canFallback) {
			await this.dispatcher.rebuild(requestContext.path);
			requestContext.path = alternatePath;
			this.lastKnownPath = alternatePath;
			requestContext.fallbackUsed = true;
			requestContext.fallbackReason = "retry_route_failover";
			requestContext.sidecarBaseUrl = this.sidecarManager.getState().baseUrl;
			this.pendingRetryPaths.set(
				this.retryRouteKey(requestContext.host, requestContext.requestClass),
				alternatePath,
			);
		}
		requestContext.attempt = context.attempt + 1;
		requestContext.poolRebuilt = true;
		requestContext.circuitState = this.dispatcher.getCircuitState(requestContext.path);
		const delayMs = this.dispatcher.getRetryDelayMs(context.attempt);

		return {
			shouldRetry: true,
			delayMs,
			attempt: context.attempt,
			maxAttempts: allowedAttempts,
			errorMessage: context.message.errorMessage ?? "Unknown error",
			context: { ...requestContext },
		};
	}

	async refreshSidecar(): Promise<void> {
		if (!this.settings.sidecar.enabled) {
			this.dispatcher.setSidecarAvailable(false);
			await this.sidecarManager.stop();
			return;
		}
		try {
			const health = await this.sidecarManager.refreshHealth();
			if (!health) {
				await this.sidecarManager.ensureStarted();
			}
			const current = this.sidecarManager.getState();
			this.dispatcher.setSidecarAvailable(current.ready && current.healthState !== "down");
		} catch {
			this.dispatcher.setSidecarAvailable(false);
		}
	}

	async refreshSidecarIfPreferred(): Promise<void> {
		if (!this.shouldPrestartSidecar()) {
			this.dispatcher.setSidecarAvailable(false);
			return;
		}
		await this.refreshSidecar();
	}

	private mergeSettings(settings?: NetworkSettings): EffectiveNetworkSettings {
		return {
			mode: settings?.mode ?? DEFAULT_NETWORK_SETTINGS.mode,
			proxy: { ...DEFAULT_NETWORK_SETTINGS.proxy, ...(settings?.proxy ?? {}) },
			sidecar: { ...DEFAULT_NETWORK_SETTINGS.sidecar, ...(settings?.sidecar ?? {}) },
			bypass: { ...DEFAULT_NETWORK_SETTINGS.bypass, ...(settings?.bypass ?? {}) },
			routeRules: settings?.routeRules ?? DEFAULT_NETWORK_SETTINGS.routeRules,
			timeouts: { ...DEFAULT_NETWORK_SETTINGS.timeouts, ...(settings?.timeouts ?? {}) },
			retry: { ...DEFAULT_NETWORK_SETTINGS.retry, ...(settings?.retry ?? {}) },
			circuitBreaker: { ...DEFAULT_NETWORK_SETTINGS.circuitBreaker, ...(settings?.circuitBreaker ?? {}) },
		};
	}

	private resolveFallbackPaths(requestClass: NetworkRequestClass): NetworkRoutePath[] | undefined {
		if (this.settings.mode === "proxy") {
			return ["sidecar"];
		}
		if (this.settings.mode === "direct") {
			return ["direct"];
		}
		return requestClass === "never_replay" ? ["direct"] : undefined;
	}

	private shouldPrestartSidecar(): boolean {
		if (!this.settings.sidecar.enabled) {
			return false;
		}
		if (this.settings.mode === "proxy") {
			return true;
		}
		return this.settings.routeRules.some((rule) => rule.policy === "proxy" || rule.policy === "proxy-preferred");
	}

	private findContextFromDiagnostics(message: AssistantMessage): NetworkRequestContext | undefined {
		for (const diagnostic of message.diagnostics ?? []) {
			const requestId = diagnostic.details?.requestId;
			if (typeof requestId !== "string") continue;
			const record = this.activeRequests.get(requestId);
			if (record) {
				return record.context;
			}
			const details = diagnostic.details ?? {};
			if (typeof details.targetHost === "string" && typeof details.selectedPath === "string") {
				return {
					requestId,
					traceId: typeof details.traceId === "string" ? details.traceId : requestId,
					requestClass: (details.requestClass as NetworkRequestClass | undefined) ?? "model_pre_first_byte",
					attempt: typeof details.attemptCount === "number" ? details.attemptCount : 1,
					host: details.targetHost,
					method: typeof details.method === "string" ? details.method : "POST",
					path: (details.selectedPath as NetworkRoutePath | undefined) ?? "direct",
					routeMode: (details.routeMode as EffectiveNetworkSettings["mode"] | undefined) ?? this.settings.mode,
					firstByteReceived: details.firstByteReceived === true || details.sidecarStreamStarted === true,
					poolRebuilt: details.poolRebuilt === true,
					fallbackUsed: details.fallbackUsed === true,
					fallbackReason:
						typeof details.fallbackReason === "string"
							? (details.fallbackReason as NetworkRequestContext["fallbackReason"])
							: undefined,
					matchedRoutePolicy:
						typeof details.matchedRoutePolicy === "string"
							? (details.matchedRoutePolicy as NetworkRequestContext["matchedRoutePolicy"])
							: undefined,
					sidecarRequired: details.sidecarRequired === true,
					sidecarAvailable: details.sidecarAvailable === true,
					sidecarProxyMode:
						details.sidecarProxyMode === "required" || details.sidecarProxyMode === "preferred"
							? details.sidecarProxyMode
							: undefined,
					sidecarBaseUrl: typeof details.sidecarBaseUrl === "string" ? details.sidecarBaseUrl : undefined,
					transportOutcome:
						typeof details.sidecarAttemptCount === "number" ||
						typeof details.sidecarFinalStatus === "string" ||
						typeof details.sidecarStreamStarted === "boolean"
							? {
									owner: "sidecar",
									requestId,
									traceId: typeof details.traceId === "string" ? details.traceId : requestId,
									responseStatus:
										typeof details.sidecarResponseStatus === "number"
											? details.sidecarResponseStatus
											: undefined,
									attemptCount:
										typeof details.sidecarAttemptCount === "number" ? details.sidecarAttemptCount : 0,
									retryCount: typeof details.sidecarRetryCount === "number" ? details.sidecarRetryCount : 0,
									streamingResponse: details.sidecarStreamingResponse === true,
									streamStarted: details.sidecarStreamStarted === true,
									finalStatus:
										details.sidecarFinalStatus === "success" ||
										details.sidecarFinalStatus === "transport_error" ||
										details.sidecarFinalStatus === "stream_error"
											? details.sidecarFinalStatus
											: "success",
									failureStage:
										typeof details.sidecarFailureStage === "string"
											? (details.sidecarFailureStage as SidecarTransportOutcome["failureStage"])
											: undefined,
									timeoutKind:
										typeof details.sidecarTimeoutKind === "string"
											? (details.sidecarTimeoutKind as SidecarTransportOutcome["timeoutKind"])
											: undefined,
									errorMessage:
										typeof details.sidecarErrorMessage === "string" ? details.sidecarErrorMessage : undefined,
								}
							: undefined,
					circuitState: (details.circuitState as NetworkRequestContext["circuitState"] | undefined) ?? "closed",
					startedAt: Date.now() - (typeof details.durationMs === "number" ? details.durationMs : 0),
					replaySuppressedReason:
						typeof details.replaySuppressedReason === "string" ? details.replaySuppressedReason : undefined,
				};
			}
		}
		return undefined;
	}

	private findTransportErrorCode(message: AssistantMessage): unknown {
		for (const diagnostic of message.diagnostics ?? []) {
			if (typeof diagnostic.details?.transportErrorCode === "string") {
				return diagnostic.details.transportErrorCode;
			}
		}
		return undefined;
	}

	private getReplaySuppressedReason(context: NetworkRequestContext, transportErrorCode: unknown): string | undefined {
		if (context.requestClass === "never_replay") {
			return "request_class_never_replay";
		}
		if (context.firstByteReceived || context.transportOutcome?.streamStarted) {
			return "after_first_byte";
		}
		if (typeof transportErrorCode === "string" && transportErrorCode === "client_error") {
			return "non_retryable_transport_error";
		}
		return undefined;
	}

	private maxAttemptsForClass(requestClass: NetworkRequestClass): number {
		const configuredMaxAttempts = Math.max(0, this.settings.retry.maxAttempts);
		switch (requestClass) {
			case "safe":
			case "model_pre_first_byte":
				return configuredMaxAttempts;
			case "never_replay":
				return 0;
		}
	}

	private async ensureSidecarAvailable(): Promise<boolean> {
		if (!this.settings.sidecar.enabled) {
			this.dispatcher.setSidecarAvailable(false);
			return false;
		}
		await this.refreshSidecar();
		const state = this.sidecarManager.getState();
		const available = state.ready && state.healthState !== "down";
		this.dispatcher.setSidecarAvailable(available);
		return available;
	}

	private consumePendingRetryPath(url: URL, requestClass: NetworkRequestClass): NetworkRoutePath | undefined {
		const key = this.retryRouteKey(url.hostname, requestClass);
		const path = this.pendingRetryPaths.get(key);
		if (path) {
			this.pendingRetryPaths.delete(key);
		}
		return path;
	}

	private retryRouteKey(host: string, requestClass: NetworkRequestClass): string {
		return `${host.toLowerCase()}:${requestClass}`;
	}

	private createStrictProxyUnavailableError(url: URL, requestId: string, traceId: string): Error {
		const message = "Network proxy sidecar is required but unavailable";
		const error = new Error(message);
		const sidecarHealth = this.sidecarManager.getState().health;
		const context: NetworkRequestContext = {
			requestId,
			traceId,
			requestClass: "model_pre_first_byte",
			attempt: 1,
			host: url.hostname,
			method: "POST",
			path: "sidecar",
			routeMode: this.settings.mode,
			firstByteReceived: false,
			poolRebuilt: false,
			fallbackUsed: false,
			sidecarRequired: true,
			sidecarAvailable: false,
			sidecarProxyMode: "required",
			sidecarBaseUrl: this.sidecarManager.getState().baseUrl,
			circuitState: this.dispatcher.getCircuitState("sidecar"),
			startedAt: Date.now(),
		};
		Object.assign(error, {
			code: "strict_proxy_unavailable",
			networkContext: context,
			networkSummary: {
				targetHost: url.hostname,
				routeMode: this.settings.mode,
				selectedPath: "sidecar",
				fallbackUsed: false,
				durationMs: 0,
				poolRebuilt: false,
				sidecarBaseUrl: context.sidecarBaseUrl,
				failures: [
					{
						path: "sidecar",
						errorCode: "strict_proxy_unavailable",
						errorMessage: sidecarHealth?.lastError?.message ?? message,
					},
				],
			},
		});
		return error;
	}
}
