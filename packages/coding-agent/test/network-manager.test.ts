import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetworkManager } from "../src/core/network-manager.ts";
import type { SidecarState } from "../src/core/network-sidecar.ts";
import type { NetworkRequestContext } from "../src/core/network-types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface TestSidecarManager {
	getState(): SidecarState;
	createFetch(
		requestContext?: NetworkRequestContext,
		options?: {
			totalTimeoutMs?: number;
			connectTimeoutMs?: number;
			tlsTimeoutMs?: number;
			responseHeaderTimeoutMs?: number;
			idleStreamTimeoutMs?: number;
			maxAttempts?: number;
			retryBaseDelayMs?: number;
			retryMaxDelayMs?: number;
			proxyMode?: "preferred" | "required";
		},
	): typeof fetch;
	refreshHealth?(): Promise<unknown>;
	ensureStarted?(): Promise<SidecarState>;
	stop(): Promise<void>;
}

interface TestRouteDispatcher {
	setSidecarAvailable(available: boolean): void;
}

interface TestNetworkManagerInternals {
	sidecarManager: TestSidecarManager;
	dispatcher: TestRouteDispatcher;
}

function createAssistantErrorMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("NetworkManager", () => {
	let tempDir = "";

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-network-manager-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("derives network settings from legacy timeout and retry config", () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			httpIdleTimeoutMs: 120_000,
			retry: {
				enabled: true,
				maxRetries: 4,
				baseDelayMs: 250,
				provider: { timeoutMs: 80_000, maxRetryDelayMs: 4_000 },
			},
			websocketConnectTimeoutMs: 5_000,
		});

		const network = settingsManager.getNetworkSettings();

		expect(network?.timeouts?.idleStreamMs).toBe(120_000);
		expect(network?.timeouts?.responseHeaderTimeoutMs).toBe(80_000);
		expect(network?.timeouts?.connectMs).toBe(5_000);
		expect(network?.retry?.maxAttempts).toBe(4);
		expect(network?.retry?.baseDelayMs).toBe(250);
		expect(network?.retry?.maxDelayMs).toBe(4_000);
	});

	it("uses configured bypass cidrs for direct routing", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			network: {
				bypass: {
					cidrs: ["203.0.113.0/24"],
				},
			},
		});
		const manager = new NetworkManager(settingsManager);
		const internals = manager as unknown as TestNetworkManagerInternals;
		internals.dispatcher.setSidecarAvailable(true);

		const bypassed = manager.beginRequest("https://203.0.113.9/v1/test", {
			requestClass: "safe",
			method: "GET",
		});
		const proxied = manager.beginRequest("https://198.51.100.9/v1/test", {
			requestClass: "safe",
			method: "GET",
		});

		expect(bypassed.path).toBe("direct");
		expect(proxied.path).toBe("sidecar");

		await manager.dispose();
	});

	it("lets explicit proxy rules override configured bypass cidrs", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			network: {
				bypass: {
					cidrs: ["203.0.113.0/24"],
				},
				routeRules: [{ match: "203.0.113.9", policy: "proxy" }],
			},
		});
		const manager = new NetworkManager(settingsManager);
		const internals = manager as unknown as TestNetworkManagerInternals;
		internals.dispatcher.setSidecarAvailable(true);

		const context = manager.beginRequest("https://203.0.113.9/v1/test", {
			requestClass: "safe",
			method: "GET",
		});

		expect(context.path).toBe("sidecar");
		expect(context.matchedRoutePolicy).toBe("proxy");
		expect(context.sidecarRequired).toBe(true);
		expect(context.sidecarProxyMode).toBe("required");

		await manager.dispose();
	});

	it("fails closed when global proxy mode requires an unavailable sidecar", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ network: { mode: "proxy" } });
		const manager = new NetworkManager(settingsManager);

		expect(() =>
			manager.beginRequest("https://api.example.com/v1/test", {
				requestClass: "safe",
				method: "GET",
			}),
		).toThrow("Network proxy sidecar is required but unavailable");

		await manager.dispose();
	});

	it("fails closed when an explicit proxy route requires an unavailable sidecar", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			network: {
				routeRules: [{ match: "api.example.com", policy: "proxy" }],
			},
		});
		const manager = new NetworkManager(settingsManager);

		expect(() =>
			manager.beginRequest("https://api.example.com/v1/test", {
				requestClass: "safe",
				method: "GET",
			}),
		).toThrow("Network proxy sidecar is required but unavailable");

		await manager.dispose();
	});

	it("keeps proxy-preferred routes fail-open when sidecar is unavailable", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			network: {
				routeRules: [{ match: "api.example.com", policy: "proxy-preferred" }],
			},
		});
		const manager = new NetworkManager(settingsManager);

		const context = manager.beginRequest("https://api.example.com/v1/test", {
			requestClass: "safe",
			method: "GET",
		});

		expect(context.path).toBe("direct");
		expect(context.matchedRoutePolicy).toBe("proxy-preferred");
		expect(context.sidecarRequired).toBe(false);

		await manager.dispose();
	});

	it("uses direct path for localhost and internal addresses", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const manager = new NetworkManager(settingsManager);

		const localhost = manager.beginRequest("https://localhost/v1/test", {
			requestClass: "safe",
			method: "GET",
		});
		const privateHost = manager.beginRequest("https://192.168.1.9/v1/test", {
			requestClass: "safe",
			method: "GET",
		});

		expect(localhost.path).toBe("direct");
		expect(privateHost.path).toBe("direct");

		await manager.dispose();
	});

	it("does not prestart sidecar for default auto mode", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const manager = new NetworkManager(settingsManager);
		let ensureStartedCalls = 0;
		const fakeSidecar: TestSidecarManager = {
			getState: () => ({
				enabled: true,
				ready: false,
			}),
			createFetch: () => async () => new Response("ok", { status: 200 }),
			refreshHealth: async () => undefined,
			ensureStarted: async () => {
				ensureStartedCalls++;
				return {
					enabled: true,
					ready: true,
					baseUrl: "http://127.0.0.1:45678",
					healthState: "ready",
				};
			},
			stop: async () => {},
		};
		const internals = manager as unknown as TestNetworkManagerInternals;
		internals.sidecarManager = fakeSidecar;

		await manager.initialize();

		expect(ensureStartedCalls).toBe(0);

		await manager.dispose();
	});

	it("prefers sidecar route in auto mode when sidecar is available", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const manager = new NetworkManager(settingsManager);
		const internals = manager as unknown as TestNetworkManagerInternals;
		internals.dispatcher.setSidecarAvailable(true);

		const context = manager.beginRequest("https://api.example.com/v1/test", {
			requestClass: "safe",
			method: "POST",
		});

		expect(context.path).toBe("sidecar");
		expect(context.fallbackUsed).toBe(false);
		expect(manager.createHttpFetch(context)).toBeDefined();

		await manager.dispose();
	});

	it("creates a sidecar-backed fetch when the sidecar route is selected", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ network: { mode: "proxy" } });
		const manager = new NetworkManager(settingsManager);
		const calls: Array<{ url: string; method: string }> = [];
		let receivedOptions:
			| {
					totalTimeoutMs?: number;
					connectTimeoutMs?: number;
					tlsTimeoutMs?: number;
					responseHeaderTimeoutMs?: number;
					idleStreamTimeoutMs?: number;
					maxAttempts?: number;
					retryBaseDelayMs?: number;
					retryMaxDelayMs?: number;
			  }
			| undefined;
		const fakeSidecar: TestSidecarManager = {
			getState: () => ({
				enabled: true,
				ready: true,
				baseUrl: "http://127.0.0.1:45678",
				healthState: "ready",
			}),
			createFetch: (_requestContext, options) => {
				receivedOptions = options;
				return async (input, init) => {
					const request = new Request(input, init);
					calls.push({ url: request.url, method: request.method });
					return new Response("ok", { status: 200 });
				};
			},
			stop: async () => {},
		};
		const internals = manager as unknown as TestNetworkManagerInternals;
		internals.sidecarManager = fakeSidecar;
		internals.dispatcher.setSidecarAvailable(true);

		const context = manager.beginRequest("https://api.example.com/v1/test", {
			requestClass: "safe",
			method: "POST",
		});
		const httpFetch = manager.createHttpFetch(context, { timeoutMs: 1234, maxAttempts: 4 });

		expect(context.path).toBe("sidecar");
		expect(context.fallbackReason).toBeUndefined();
		expect(context.sidecarBaseUrl).toBe("http://127.0.0.1:45678");
		expect(httpFetch).toBeDefined();
		const response = await httpFetch!("https://api.example.com/v1/test", { method: "POST", body: "{}" });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(receivedOptions).toEqual({
			totalTimeoutMs: 1234,
			connectTimeoutMs: 15_000,
			tlsTimeoutMs: 15_000,
			responseHeaderTimeoutMs: 300_000,
			idleStreamTimeoutMs: 300_000,
			maxAttempts: 4,
			retryBaseDelayMs: 2_000,
			retryMaxDelayMs: 60_000,
			proxyMode: "required",
		});
		expect(calls).toEqual([{ url: "https://api.example.com/v1/test", method: "POST" }]);

		await manager.dispose();
	});

	it("preserves structured network settings for sidecar health polling", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			network: {
				sidecar: {
					enabled: true,
					healthCheckIntervalMs: 2000,
					restartBackoffMs: 1500,
				},
			},
		});
		const manager = new NetworkManager(settingsManager);
		const effective = manager.getEffectiveSettings();

		expect(effective.sidecar.enabled).toBe(true);
		expect(effective.sidecar.healthCheckIntervalMs).toBe(2000);
		expect(effective.sidecar.restartBackoffMs).toBe(1500);

		await manager.dispose();
	});

	it("allows model_pre_first_byte retries up to configured maxAttempts", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			network: {
				retry: {
					maxAttempts: 3,
					baseDelayMs: 1,
					maxDelayMs: 10,
					jitter: false,
				},
			},
		});
		const manager = new NetworkManager(settingsManager);
		const message = createAssistantErrorMessage({
			errorMessage:
				"OpenAI API error: Connection error. Cause: Client network socket disconnected before secure TLS connection was established (code=ECONNRESET, port=443)",
			diagnostics: [
				{
					type: "provider_transport_failure",
					timestamp: Date.now(),
					details: {
						transportErrorCode: "network_error",
						requestId: "req-1",
						traceId: "trace-1",
						targetHost: "api.openai.com",
						selectedPath: "direct",
						routeMode: "auto",
						attemptCount: 1,
						requestClass: "model_pre_first_byte",
						method: "POST",
						firstByteReceived: false,
					},
				},
			],
		});

		const first = await manager.prepareRetry({ message, attempt: 1 });
		const second = await manager.prepareRetry({ message, attempt: 2 });
		const third = await manager.prepareRetry({ message, attempt: 3 });
		const fourth = await manager.prepareRetry({ message, attempt: 4 });

		expect(first?.shouldRetry).toBe(true);
		expect(first?.maxAttempts).toBe(3);
		expect(second?.shouldRetry).toBe(true);
		expect(second?.maxAttempts).toBe(3);
		expect(third?.shouldRetry).toBe(true);
		expect(third?.maxAttempts).toBe(3);
		expect(fourth?.shouldRetry).toBe(false);
		expect(fourth?.maxAttempts).toBe(3);

		await manager.dispose();
	});

	it("keeps retries on the sidecar path instead of failing over to direct", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			network: {
				retry: {
					maxAttempts: 2,
					baseDelayMs: 1,
					maxDelayMs: 10,
					jitter: false,
				},
			},
		});
		const manager = new NetworkManager(settingsManager);
		const message = createAssistantErrorMessage({
			errorMessage: "Connection reset before headers",
			diagnostics: [
				{
					type: "provider_transport_failure",
					timestamp: Date.now(),
					details: {
						transportErrorCode: "network_error",
						requestId: "req-sidecar",
						traceId: "trace-sidecar",
						targetHost: "api.openai.com",
						selectedPath: "sidecar",
						routeMode: "auto",
						attemptCount: 1,
						requestClass: "model_pre_first_byte",
						method: "POST",
						firstByteReceived: false,
						sidecarFinalStatus: "transport_error",
						sidecarAttemptCount: 2,
						sidecarRetryCount: 1,
						sidecarStreamingResponse: false,
						sidecarStreamStarted: false,
						sidecarFailureStage: "connect",
					},
				},
			],
		});

		const decision = await manager.prepareRetry({ message, attempt: 1 });

		expect(decision?.shouldRetry).toBe(true);
		expect(decision?.context?.path).toBe("sidecar");
		expect(decision?.context?.fallbackReason).toBeUndefined();

		await manager.dispose();
	});

	it("suppresses replay when the sidecar outcome shows the stream already started", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({
			network: {
				retry: {
					maxAttempts: 2,
					baseDelayMs: 1,
					maxDelayMs: 10,
					jitter: false,
				},
			},
		});
		const manager = new NetworkManager(settingsManager);
		const message = createAssistantErrorMessage({
			errorMessage: "stream ended before message_stop",
			diagnostics: [
				{
					type: "provider_transport_failure",
					timestamp: Date.now(),
					details: {
						transportErrorCode: "network_error",
						requestId: "req-stream",
						traceId: "trace-stream",
						targetHost: "api.openai.com",
						selectedPath: "sidecar",
						routeMode: "auto",
						attemptCount: 1,
						requestClass: "model_pre_first_byte",
						method: "POST",
						firstByteReceived: false,
						sidecarFinalStatus: "stream_error",
						sidecarAttemptCount: 1,
						sidecarRetryCount: 0,
						sidecarStreamingResponse: true,
						sidecarStreamStarted: true,
						sidecarFailureStage: "stream",
					},
				},
			],
		});

		const decision = await manager.prepareRetry({ message, attempt: 1 });

		expect(decision?.shouldRetry).toBe(false);
		expect(decision?.replaySuppressedReason).toBe("after_first_byte");

		await manager.dispose();
	});
});
