import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("PromptOptions.systemPrompt host override", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-system-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		return session;
	}

	it("applies the override before the turn and keeps it as base prompt", async () => {
		const session = await createSession();
		const defaultPrompt = session.systemPrompt;
		expect(defaultPrompt).not.toBe("You are Craft Agent.");

		// prompt() will fail without credentials, but the override is applied in
		// preflight before any model validation — the state change is what we assert.
		await session.prompt("hello", { systemPrompt: "You are Craft Agent." }).catch(() => {});

		expect(session.systemPrompt).toBe("You are Craft Agent.");

		session.dispose();
	});

	it("survives refreshSystemPrompt (tool changes / extension reloads)", async () => {
		const session = await createSession();

		await session.prompt("hello", { systemPrompt: "HOST PROMPT" }).catch(() => {});
		expect(session.systemPrompt).toBe("HOST PROMPT");

		// Simulates what happens on tool-set changes and resource reloads.
		session.refreshSystemPrompt();
		expect(session.systemPrompt).toBe("HOST PROMPT");

		session.dispose();
	});

	it("keeps the latest override when called again", async () => {
		const session = await createSession();

		await session.prompt("a", { systemPrompt: "PROMPT V1" }).catch(() => {});
		await session.prompt("b", { systemPrompt: "PROMPT V2" }).catch(() => {});
		expect(session.systemPrompt).toBe("PROMPT V2");

		session.refreshSystemPrompt();
		expect(session.systemPrompt).toBe("PROMPT V2");

		session.dispose();
	});

	it("does not change the prompt when systemPrompt is omitted", async () => {
		const session = await createSession();

		await session.prompt("a", { systemPrompt: "HOST PROMPT" }).catch(() => {});
		expect(session.systemPrompt).toBe("HOST PROMPT");

		// A later prompt without the option must not reset to the loader prompt.
		await session.prompt("b").catch(() => {});
		expect(session.systemPrompt).toBe("HOST PROMPT");

		session.dispose();
	});
});
