import { isIP } from "node:net";
import type {
	CircuitState,
	EffectiveNetworkSettings,
	NetworkRequestContext,
	NetworkRequestOptions,
	NetworkRetrySettings,
	NetworkRoutePath,
	NetworkRoutePolicy,
	RouteDispatcherDecision,
	SidecarProxyMode,
} from "./network-types.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

interface ManagedDispatcherState {
	circuitState: CircuitState;
	failures: number;
	cooldownUntil: number;
	lastRebuiltAt: number;
}

export interface NetworkDispatcherController {
	applySettings(settings: EffectiveNetworkSettings): void;
	select(url: URL, options: NetworkRequestOptions): RouteDispatcherDecision | undefined;
	noteSuccess(context: NetworkRequestContext): void;
	noteFailure(context: NetworkRequestContext): void;
	rebuild(path: NetworkRoutePath): Promise<boolean>;
	reset(): void;
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

function parseIpv4Address(value: string): number | undefined {
	const octets = value.split(".");
	if (octets.length !== 4) return undefined;

	let result = 0;
	for (const octet of octets) {
		if (!/^\d+$/.test(octet)) return undefined;
		const parsed = Number.parseInt(octet, 10);
		if (parsed < 0 || parsed > 255) return undefined;
		result = (result << 8) | parsed;
	}
	return result >>> 0;
}

function parseIpv4Cidr(cidr: string): { network: number; mask: number } | undefined {
	const [addressText, prefixText] = cidr.trim().split("/");
	if (!addressText || prefixText === undefined || prefixText.trim() === "") {
		return undefined;
	}

	const prefix = Number.parseInt(prefixText, 10);
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
		return undefined;
	}

	const address = parseIpv4Address(addressText);
	if (address === undefined) {
		return undefined;
	}

	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return { network: address & mask, mask };
}

function matchesCidr(host: string, cidr: string): boolean {
	if (isIP(host) !== 4) {
		return false;
	}

	const address = parseIpv4Address(host);
	const parsedCidr = parseIpv4Cidr(cidr);
	if (address === undefined || !parsedCidr) {
		return false;
	}

	return (address & parsedCidr.mask) === parsedCidr.network;
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

	select(url: URL, options: NetworkRequestOptions): RouteDispatcherDecision | undefined {
		const route = this.resolvePreferredRoute(url, options);
		for (const path of route.paths) {
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
					requestClass: options.requestClass,
					attempt: 0,
					host: url.hostname,
					method: (options.method ?? "GET").toUpperCase(),
					path,
					routeMode: this.settings.mode,
					firstByteReceived: false,
					poolRebuilt: false,
					fallbackUsed: path !== route.paths[0],
					matchedRoutePolicy: route.matchedRoutePolicy,
					sidecarRequired: route.sidecarRequired,
					sidecarAvailable: this.sidecarAvailable,
					sidecarProxyMode: path === "sidecar" ? route.sidecarProxyMode : undefined,
					circuitState: state.circuitState,
					startedAt: now(),
				},
			};
		}

		return undefined;
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

	reset(): void {
		this.states.direct = this.createState("direct");
		this.states.sidecar = this.createState("sidecar");
		this.sidecarAvailable = false;
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

	private resolvePreferredRoute(
		url: URL,
		options: NetworkRequestOptions,
	): {
		paths: NetworkRoutePath[];
		matchedRoutePolicy?: NetworkRoutePolicy;
		sidecarRequired: boolean;
		sidecarProxyMode?: SidecarProxyMode;
	} {
		const host = normalizeHost(url.hostname);
		const explicit = this.resolveExplicitRule(host);
		if (explicit) {
			return this.routeForPolicy(explicit);
		}

		if (this.settings.mode === "direct") {
			return { paths: ["direct"], sidecarRequired: false };
		}
		if (this.settings.mode === "proxy") {
			return {
				paths: this.sidecarAvailable ? ["sidecar"] : [],
				sidecarRequired: true,
				sidecarProxyMode: "required",
			};
		}
		if (this.isBypassedHost(host)) {
			return { paths: ["direct"], sidecarRequired: false };
		}
		if (options.fallbackPaths && options.fallbackPaths.length > 0) {
			return {
				paths: options.fallbackPaths,
				sidecarRequired: false,
				sidecarProxyMode: options.fallbackPaths[0] === "sidecar" ? "preferred" : undefined,
			};
		}
		return {
			paths: this.sidecarAvailable ? ["sidecar", "direct"] : ["direct"],
			sidecarRequired: false,
			sidecarProxyMode: this.sidecarAvailable ? "preferred" : undefined,
		};
	}

	private isBypassedHost(host: string): boolean {
		if (this.isBypassedSpecialHost(host)) {
			return true;
		}
		return (
			this.settings.bypass.hosts.some((entry) => matchesRule(host, entry)) ||
			this.settings.bypass.cidrs.some((entry) => matchesCidr(host, entry))
		);
	}

	private resolveExplicitRule(host: string): NetworkRoutePolicy | undefined {
		for (const rule of this.settings.routeRules) {
			if (matchesRule(host, rule.match)) {
				return rule.policy;
			}
		}
		return undefined;
	}

	private routeForPolicy(policy: NetworkRoutePolicy): {
		paths: NetworkRoutePath[];
		matchedRoutePolicy: NetworkRoutePolicy;
		sidecarRequired: boolean;
		sidecarProxyMode?: SidecarProxyMode;
	} {
		switch (policy) {
			case "direct":
				return { paths: ["direct"], matchedRoutePolicy: policy, sidecarRequired: false };
			case "proxy":
				return {
					paths: this.sidecarAvailable ? ["sidecar"] : [],
					matchedRoutePolicy: policy,
					sidecarRequired: true,
					sidecarProxyMode: "required",
				};
			case "proxy-preferred":
				return {
					paths: this.sidecarAvailable ? ["sidecar", "direct"] : ["direct"],
					matchedRoutePolicy: policy,
					sidecarRequired: false,
					sidecarProxyMode: this.sidecarAvailable ? "preferred" : undefined,
				};
			case "direct-preferred":
				return {
					paths: this.sidecarAvailable ? ["direct", "sidecar"] : ["direct"],
					matchedRoutePolicy: policy,
					sidecarRequired: false,
					sidecarProxyMode: this.sidecarAvailable ? "preferred" : undefined,
				};
		}
	}

	private isBypassedSpecialHost(host: string): boolean {
		const normalized = normalizeHost(host);
		return LOOPBACK_HOSTS.has(normalized) || normalized.endsWith(".local");
	}
}
