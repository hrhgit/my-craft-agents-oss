import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetworkManager } from "../src/core/network-manager.ts";
import type { SidecarState } from "../src/core/network-sidecar.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface TestSidecarManager {
	getState(): SidecarState;
	createFetch(options?: { timeoutMs?: number; maxAttempts?: number }): typeof fetch;
	stop(): Promise<void>;
}

interface TestRouteDispatcher {
	setSidecarAvailable(available: boolean): void;
}

interface TestNetworkManagerInternals {
	sidecarManager: TestSidecarManager;
	dispatcher: TestRouteDispatcher;
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
		expect(network?.timeouts?.firstByteMs).toBe(80_000);
		expect(network?.timeouts?.connectMs).toBe(5_000);
		expect(network?.retry?.maxAttempts).toBe(4);
		expect(network?.retry?.baseDelayMs).toBe(250);
		expect(network?.retry?.maxDelayMs).toBe(4_000);
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

	it("creates a sidecar-backed fetch when the sidecar route is selected", async () => {
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const manager = new NetworkManager(settingsManager);
		const calls: Array<{ url: string; method: string }> = [];
		let receivedOptions: { timeoutMs?: number; maxAttempts?: number } | undefined;
		const fakeSidecar: TestSidecarManager = {
			getState: () => ({
				enabled: true,
				ready: true,
				baseUrl: "http://127.0.0.1:45678",
				healthState: "ready",
			}),
			createFetch: (options) => {
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
		expect(context.sidecarBaseUrl).toBe("http://127.0.0.1:45678");
		expect(httpFetch).toBeDefined();
		const response = await httpFetch!("https://api.example.com/v1/test", { method: "POST", body: "{}" });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(receivedOptions).toEqual({ timeoutMs: 1234, maxAttempts: 4 });
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
});
