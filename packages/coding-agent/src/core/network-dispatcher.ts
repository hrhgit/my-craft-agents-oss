import { isIP } from "node:net";
import type {
	CircuitState,
	EffectiveNetworkSettings,
	NetworkRequestContext,
	NetworkRequestOptions,
	NetworkRetrySettings,
	NetworkRoutePath,
	RouteDispatcherDecision,
} from "./network-types.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PRIVATE_CIDR_PATTERNS = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[0-1])\./];

interface ManagedDispatcherState {
	circuitState: CircuitState;
	failures: number;
	cooldownUntil: number;
	lastRebuiltAt: number;
}

export interface NetworkDispatcherController {
	applySettings(settings: EffectiveNetworkSettings): void;
	select(url: URL, options: NetworkRequestOptions): RouteDispatcherDecision;
	noteSuccess(context: NetworkRequestContext): void;
	noteFailure(context: NetworkRequestContext): void;
	rebuild(path: NetworkRoutePath): Promise<boolean>;
	destroy(): Promise<void>;
	getCircuitState(path: NetworkRoutePath): CircuitState;
	getSidecarAvailable(): boolean;
}

function now(): number {
	return Date.now();
}

function normalizeHost(host: string): string {
	return host.trim().toLowerCase();
}

function isPrivateHost(host: string): boolean {
	const normalized = normalizeHost(host);
	if (LOOPBACK_HOSTS.has(normalized) || normalized.endsWith(".local")) {
		return true;
	}
	if (isIP(normalized) === 4) {
		return PRIVATE_CIDR_PATTERNS.some((pattern) => pattern.test(normalized));
	}
	return false;
}

function matchesRule(host: string, match: string): boolean {
	const normalizedHost = normalizeHost(host);
	const normalizedMatch = normalizeHost(match);
	if (normalizedMatch.startsWith("*.")) {
		const suffix = normalizedMatch.slice(1);
		return normalizedHost.endsWith(suffix);
	}
	return normalizedHost === normalizedMatch;
}

function jitterDelay(baseDelayMs: number, retrySettings: Required<NetworkRetrySettings>, attempt: number): number {
	const rawDelay = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), retrySettings.maxDelayMs);
	if (!retrySettings.jitter) {
		return rawDelay;
	}
	const min = Math.floor(rawDelay * 0.8);
	const max = Math.ceil(rawDelay * 1.2);
	return Math.floor(Math.random() * Math.max(1, max - min + 1)) + min;
}

export class NetworkRouteDispatcher implements NetworkDispatcherController {
	private settings: EffectiveNetworkSettings;
	private readonly states: Record<NetworkRoutePath, ManagedDispatcherState>;
	private sidecarAvailable = false;

	constructor(settings: EffectiveNetworkSettings) {
		this.settings = settings;
		this.states = {
			direct: this.createState("direct"),
			sidecar: this.createState("sidecar"),
		};
	}

	applySettings(settings: EffectiveNetworkSettings): void {
		this.settings = settings;
	}

	getSidecarAvailable(): boolean {
		return this.sidecarAvailable;
	}

	setSidecarAvailable(available: boolean): void {
		this.sidecarAvailable = available;
	}

	getCircuitState(path: NetworkRoutePath): CircuitState {
		this.maybeTransitionHalfOpen(path);
		return this.states[path].circuitState;
	}

	select(url: URL, options: NetworkRequestOptions): RouteDispatcherDecision {
		const preferredPaths = this.resolvePreferredPaths(url, options);
		for (const path of preferredPaths) {
			const state = this.states[path];
			this.maybeTransitionHalfOpen(path);
			if (state.circuitState === "open") {
				continue;
			}
			return {
				path,
				context: {
					requestId: options.requestId ?? crypto.randomUUID(),
					traceId: options.traceId ?? crypto.randomUUID(),
					idempotencyKey: options.idempotencyKey,
					requestClass: options.requestClass,
					attempt: 0,
					host: url.hostname,
					method: (options.method ?? "GET").toUpperCase(),
					path,
					routeMode: this.settings.mode,
					firstByteReceived: false,
					poolRebuilt: false,
					fallbackUsed: path !== preferredPaths[0],
					circuitState: state.circuitState,
					startedAt: now(),
				},
			};
		}

		const fallbackPath = preferredPaths[0] ?? "direct";
		const fallbackState = this.states[fallbackPath];
		return {
			path: fallbackPath,
			context: {
				requestId: options.requestId ?? crypto.randomUUID(),
				traceId: options.traceId ?? crypto.randomUUID(),
				idempotencyKey: options.idempotencyKey,
				requestClass: options.requestClass,
				attempt: 0,
				host: url.hostname,
				method: (options.method ?? "GET").toUpperCase(),
				path: fallbackPath,
				routeMode: this.settings.mode,
				firstByteReceived: false,
				poolRebuilt: false,
				fallbackUsed: false,
				circuitState: fallbackState.circuitState,
				startedAt: now(),
			},
		};
	}

	noteSuccess(context: NetworkRequestContext): void {
		const state = this.states[context.path];
		state.failures = 0;
		state.cooldownUntil = 0;
		state.circuitState = "closed";
	}

	noteFailure(context: NetworkRequestContext): void {
		const state = this.states[context.path];
		state.failures += 1;
		if (state.failures >= this.settings.circuitBreaker.failureThreshold) {
			state.circuitState = "open";
			state.cooldownUntil = now() + this.settings.circuitBreaker.cooldownMs;
		}
	}

	getRetryDelayMs(attempt: number): number {
		return jitterDelay(this.settings.retry.baseDelayMs, this.settings.retry, attempt);
	}

	async rebuild(path: NetworkRoutePath): Promise<boolean> {
		const current = this.states[path];
		const replacement = this.createState(path);
		this.states[path] = replacement;
		replacement.circuitState = current.circuitState;
		replacement.failures = current.failures;
		replacement.cooldownUntil = current.cooldownUntil;
		return true;
	}

	async destroy(): Promise<void> {
		this.sidecarAvailable = false;
	}

	private createState(path: NetworkRoutePath): ManagedDispatcherState {
		void path;
		return {
			circuitState: "closed",
			failures: 0,
			cooldownUntil: 0,
			lastRebuiltAt: now(),
		};
	}

	private maybeTransitionHalfOpen(path: NetworkRoutePath): void {
		const state = this.states[path];
		if (state.circuitState === "open" && state.cooldownUntil > 0 && state.cooldownUntil <= now()) {
			state.circuitState = "half-open";
			state.failures = 0;
		}
	}

	private resolvePreferredPaths(url: URL, options: NetworkRequestOptions): NetworkRoutePath[] {
		const host = normalizeHost(url.hostname);
		if (this.isBypassedHost(host)) {
			return ["direct"];
		}
		const explicit = this.resolveExplicitRule(host);
		if (explicit === "direct") return ["direct"];
		if (explicit === "proxy") return this.sidecarAvailable ? ["sidecar"] : ["direct"];
		if (explicit === "proxy-preferred") return this.sidecarAvailable ? ["sidecar", "direct"] : ["direct"];
		if (explicit === "direct-preferred") return this.sidecarAvailable ? ["direct", "sidecar"] : ["direct"];

		if (this.settings.mode === "direct") {
			return ["direct"];
		}
		if (this.settings.mode === "proxy") {
			return this.sidecarAvailable ? ["sidecar"] : ["direct"];
		}
		if (options.fallbackPaths && options.fallbackPaths.length > 0) {
			return options.fallbackPaths;
		}
		return this.sidecarAvailable ? ["sidecar", "direct"] : ["direct"];
	}

	private isBypassedHost(host: string): boolean {
		if (isPrivateHost(host)) {
			return true;
		}
		return this.settings.bypass.hosts.some((entry) => matchesRule(host, entry));
	}

	private resolveExplicitRule(host: string): "direct" | "proxy" | "direct-preferred" | "proxy-preferred" | undefined {
		for (const rule of this.settings.routeRules) {
			if (matchesRule(host, rule.match)) {
				return rule.policy;
			}
		}
		return undefined;
	}
}
