import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mortise/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("web search settings", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-web-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options?: { webSearch?: boolean; modelProvider?: "openai" | "mistral" }) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		if (options?.webSearch !== undefined) {
			settingsManager.setWebSearch(options.webSearch);
			await settingsManager.flush();
		}

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const model =
			options?.modelProvider === "mistral"
				? getModel("mistral", "mistral-medium-latest")!
				: getModel("openai", "gpt-5.2")!;

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
		});

		return { session, settingsManager };
	}

	it("defaults webSearch to enabled and persists explicit changes", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		expect(settingsManager.getWebSearch()).toBe(true);

		settingsManager.setWebSearch(false);
		await settingsManager.flush();

		const reloaded = SettingsManager.create(tempDir, agentDir);
		expect(reloaded.getWebSearch()).toBe(false);
	});

	it("adds supported builtin web_search guidance when enabled", async () => {
		const { session } = await createSession({ webSearch: true });

		expect(session.systemPrompt).toContain("built-in web_search capability");
		expect(session.systemPrompt).not.toContain("web search is unavailable");
		expect(session.getActiveToolNames()).toContain("web_fetch");

		session.dispose();
	});

	it("adds unsupported guidance when enabled on an unsupported provider", async () => {
		const { session } = await createSession({ webSearch: true, modelProvider: "mistral" });

		expect(session.systemPrompt).toContain("Built-in web search is unavailable");

		session.dispose();
	});

	it("lets session option override persisted setting", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setWebSearch(true);
		await settingsManager.flush();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("openai", "gpt-5.2")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			webSearch: false,
		});

		expect(session.systemPrompt).not.toContain("built-in web_search capability");

		session.dispose();
	});
});
