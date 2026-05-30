import type { AssistantMessage, AssistantMessageDiagnostic } from "@earendil-works/pi-ai";

export type NetworkMode = "auto" | "proxy" | "direct";
export type NetworkRequestClass = "safe" | "model_pre_first_byte" | "requires_idempotency_key" | "never_replay";
export type NetworkRoutePath = "direct" | "sidecar";
export type CircuitState = "closed" | "open" | "half-open";
export type SidecarHealthState = "ready" | "degraded" | "down";
export type SidecarFailureStage = "dns" | "connect" | "tls" | "upstream" | "stream" | "unknown";

export interface NetworkProxySettings {
	enabled?: boolean;
	candidates?: string[];
	probeTimeoutMs?: number;
	statusCacheMs?: number;
}

export interface NetworkSidecarSettings {
	enabled?: boolean;
	binaryPath?: string;
	restartBackoffMs?: number;
	healthCheckIntervalMs?: number;
}

export interface NetworkBypassSettings {
	hosts?: string[];
	cidrs?: string[];
}

export interface NetworkRouteRule {
	match: string;
	policy: "direct" | "proxy" | "direct-preferred" | "proxy-preferred";
}

export interface NetworkTimeoutSettings {
	connectMs?: number;
	tlsMs?: number;
	firstByteMs?: number;
	idleStreamMs?: number;
	totalMs?: number;
}

export interface NetworkRetrySettings {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitter?: boolean;
}

export interface NetworkCircuitBreakerSettings {
	failureThreshold?: number;
	cooldownMs?: number;
}

export interface NetworkSettings {
	mode?: NetworkMode;
	proxy?: NetworkProxySettings;
	sidecar?: NetworkSidecarSettings;
	bypass?: NetworkBypassSettings;
	routeRules?: NetworkRouteRule[];
	timeouts?: NetworkTimeoutSettings;
	retry?: NetworkRetrySettings;
	circuitBreaker?: NetworkCircuitBreakerSettings;
}

export interface SidecarFailureSummary {
	stage: SidecarFailureStage;
	target?: string;
	message: string;
	count: number;
	lastFailureAt?: number;
}

export interface SidecarHealthSnapshot {
	ready: boolean;
	state: SidecarHealthState;
	listenAddress?: string;
	port?: number;
	lastHealthAt?: number;
	lastSuccessAt?: number;
	lastFailureAt?: number;
	recentFailures: Record<SidecarFailureStage, number>;
	lastError?: SidecarFailureSummary;
}

export interface EffectiveNetworkSettings {
	mode: NetworkMode;
	proxy: Required<NetworkProxySettings>;
	sidecar: Required<NetworkSidecarSettings>;
	bypass: Required<NetworkBypassSettings>;
	routeRules: NetworkRouteRule[];
	timeouts: Required<NetworkTimeoutSettings>;
	retry: Required<NetworkRetrySettings>;
	circuitBreaker: Required<NetworkCircuitBreakerSettings>;
}

export interface NetworkRequestOptions extends RequestInit {
	requestClass: NetworkRequestClass;
	requestId?: string;
	traceId?: string;
	idempotencyKey?: string;
	allowReplay?: boolean;
	fallbackPaths?: NetworkRoutePath[];
	sessionId?: string;
}

export interface NetworkAttemptRecord {
	requestId: string;
	traceId: string;
	idempotencyKey?: string;
	requestClass: NetworkRequestClass;
	attempt: number;
	path: NetworkRoutePath;
	host: string;
	startedAt: number;
	firstByteReceived: boolean;
	replayed: boolean;
}

export interface NetworkRequestContext {
	requestId: string;
	traceId: string;
	idempotencyKey?: string;
	requestClass: NetworkRequestClass;
	attempt: number;
	host: string;
	method: string;
	path: NetworkRoutePath;
	routeMode: NetworkMode;
	firstByteReceived: boolean;
	poolRebuilt: boolean;
	fallbackUsed: boolean;
	replaySuppressedReason?: string;
	sidecarBaseUrl?: string;
	circuitState: CircuitState;
	startedAt: number;
}

export interface NetworkRetryDecision {
	shouldRetry: boolean;
	delayMs: number;
	attempt: number;
	maxAttempts: number;
	errorMessage: string;
	context?: NetworkRequestContext;
	replaySuppressedReason?: string;
}

export interface PathFailureSummary {
	path: NetworkRoutePath;
	errorCode?: string;
	errorMessage: string;
}

export interface NetworkFailureSummary {
	targetHost: string;
	routeMode: NetworkMode;
	selectedPath: NetworkRoutePath;
	fallbackUsed: boolean;
	durationMs: number;
	poolRebuilt: boolean;
	sidecarBaseUrl?: string;
	replaySuppressedReason?: string;
	failures: PathFailureSummary[];
}

export interface NetworkFailure extends Error {
	code?: string;
	networkContext?: NetworkRequestContext;
	networkSummary?: NetworkFailureSummary;
}

export interface RouteDispatcherDecision {
	path: NetworkRoutePath;
	context: NetworkRequestContext;
}

export interface NetworkPreparedRetry {
	delayMs: number;
	context?: NetworkRequestContext;
	replaySuppressedReason?: string;
}

export interface NetworkDiagnosticsDetails {
	requestId: string;
	traceId: string;
	targetHost: string;
	routeMode: NetworkMode;
	selectedPath: NetworkRoutePath;
	attemptCount: number;
	durationMs: number;
	poolRebuilt: boolean;
	fallbackUsed: boolean;
	circuitState: CircuitState;
	sidecarBaseUrl?: string;
	replaySuppressedReason?: string;
	sidecarState?: SidecarHealthState;
	sidecarLastErrorStage?: SidecarFailureStage;
	sidecarLastErrorTarget?: string;
	sidecarLastErrorCount?: number;
}

export interface AssistantNetworkDiagnostic extends AssistantMessageDiagnostic {
	details?: Record<string, unknown> & Partial<NetworkDiagnosticsDetails>;
}

export interface AgentRetryContext {
	message: AssistantMessage;
	attempt: number;
}
