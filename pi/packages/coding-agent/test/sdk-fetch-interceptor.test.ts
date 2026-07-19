import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mortise/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { loadHostHooks } from "../src/main.ts";

describe("createAgentSession fetchInterceptor", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-fetch-interceptor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("loads createFetchInterceptor host-hook factories", async () => {
		const hookPath = join(tempDir, "host-hooks.mjs");
		writeFileSync(
			hookPath,
			`
export function createFetchInterceptor() {
	return () => async () => new Response("factory");
}
`,
		);

		const hooks = await loadHostHooks(hookPath, tempDir);
		expect(hooks.fetchInterceptor).toBeDefined();
		const baseFetch: typeof fetch = async () => new Response("base");
		const wrappedFetch = hooks.fetchInterceptor!(baseFetch);
		const response = await wrappedFetch("https://example.invalid");

		await expect(response.text()).resolves.toBe("factory");
	});

	it("routes provider model traffic through the interceptor-wrapped fetch", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		// Disable client-side retries so the synthetic 401 fails fast.
		settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } });
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const interceptedUrls: string[] = [];
		let interceptorInstalls = 0;

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			authStorage,
			modelRegistry,
			resourceLoader,
			fetchInterceptor: (baseFetch) => {
				interceptorInstalls++;
				return async (input, init) => {
					const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
					interceptedUrls.push(url);
					// Short-circuit with a synthetic auth error — proves the provider
					// used OUR fetch without touching the network. baseFetch is
					// intentionally unused (never hit the wire in tests).
					void baseFetch;
					void init;
					return new Response(
						JSON.stringify({ type: "error", error: { type: "authentication_error", message: "synthetic" } }),
						{ status: 401, headers: { "content-type": "application/json" } },
					);
				};
			},
		});

		// Collect the terminal event so we know the turn finished.
		let sawError = false;
		const unsub = session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				const msg = event.message as { stopReason?: string };
				if (msg.stopReason === "error") sawError = true;
			}
		});

		await session.prompt("hello").catch(() => {});
		// Wait for the agent loop to drain (error path emits agent_end quickly).
		await session.agent.waitForIdle();

		expect(interceptorInstalls).toBeGreaterThanOrEqual(1);
		expect(interceptedUrls.length).toBeGreaterThanOrEqual(1);
		expect(interceptedUrls.some((u) => u.includes("anthropic.com"))).toBe(true);
		expect(sawError).toBe(true);

		unsub();
		session.dispose();
	}, 30_000);
});
