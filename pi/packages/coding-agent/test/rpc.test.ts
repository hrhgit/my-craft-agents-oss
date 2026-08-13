import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * RPC mode tests.
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN)("RPC mode", () => {
	let client: RpcClient;
	let sessionDir: string;
	const promptAndWait = (message: string) => client.promptAndWait(message);

	beforeEach(() => {
		sessionDir = join(tmpdir(), `pi-rpc-test-${Date.now()}`);
		client = new RpcClient({
			runtimePath: join(__dirname, "..", "dist", "bun", "headless.js"),
			cwd: join(__dirname, ".."),
			env: { MORTISE_AGENT_DIR: sessionDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	afterEach(async () => {
		await client.stop();
		if (sessionDir && existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true });
		}
	});

	test("should get state", async () => {
		await client.start();
		const state = await client.getState();

		expect(state.model).toBeDefined();
		expect(state.model?.provider).toBe("anthropic");
		expect(state.model?.id).toBe("claude-sonnet-4-5");
		expect(state.isStreaming).toBe(false);
		expect(state.messageCount).toBe(0);
	}, 30000);

	test("should save messages to session file", async () => {
		await client.start();

		// Send prompt and wait for completion
		const events = await promptAndWait("Reply with just the word 'hello'");

		// Should have message events
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThanOrEqual(2); // user + assistant

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify session file
		const sessionsPath = join(sessionDir, "sessions");
		expect(existsSync(sessionsPath)).toBe(true);

		const sessionDirs = readdirSync(sessionsPath);
		expect(sessionDirs.length).toBeGreaterThan(0);

		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		expect(sessionFiles.length).toBe(1);

		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		// First entry should be session header
		expect(entries[0].type).toBe("session");

		// Should have user and assistant messages
		const messages = entries.filter((e: { type: string }) => e.type === "message");
		expect(messages.length).toBeGreaterThanOrEqual(2);

		const roles = messages.map((m: { message: { role: string } }) => m.message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	}, 90000);

	test("should handle manual compaction", async () => {
		await client.start();

		// First send a prompt to have messages to compact
		await promptAndWait("Say hello");

		// Compact
		const result = await client.compact();
		expect(result.summary).toBeDefined();
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify compaction in session file
		const sessionsPath = join(sessionDir, "sessions");
		const sessionDirs = readdirSync(sessionsPath);
		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const compactionEntries = entries.filter((e: { type: string }) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);
		expect(compactionEntries[0].summary).toBeDefined();
	}, 120000);

	test("should set and get thinking level", async () => {
		await client.start();

		// Set thinking level
		await client.setThinkingLevel("high");

		// Verify via state
		const state = await client.getState();
		expect(state.thinkingLevel).toBe("high");
	}, 30000);

	test("should cycle thinking level", async () => {
		await client.start();

		// Get initial level
		const initialState = await client.getState();
		const initialLevel = initialState.thinkingLevel;

		// Cycle
		const result = await client.cycleThinkingLevel();
		expect(result).toBeDefined();
		expect(result!.level).not.toBe(initialLevel);

		// Verify via state
		const newState = await client.getState();
		expect(newState.thinkingLevel).toBe(result!.level);
	}, 30000);

	test("should get available models", async () => {
		await client.start();

		const models = await client.getAvailableModels();
		expect(models.length).toBeGreaterThan(0);

		// All models should have required fields
		for (const model of models) {
			expect(model.provider).toBeDefined();
			expect(model.id).toBeDefined();
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(typeof model.reasoning).toBe("boolean");
		}
	}, 30000);

	test("should get session stats", async () => {
		await client.start();

		// Send a prompt first
		await promptAndWait("Hello");

		const stats = await client.getSessionStats();
		expect(stats.sessionFile).toBeDefined();
		expect(stats.sessionId).toBeDefined();
		expect(stats.userMessages).toBeGreaterThanOrEqual(1);
		expect(stats.assistantMessages).toBeGreaterThanOrEqual(1);
	}, 90000);

	test("should get last assistant text", async () => {
		await client.start();

		// Initially null
		let text = await client.getLastAssistantText();
		expect(text).toBeUndefined();

		// Send prompt
		await promptAndWait("Reply with just: test123");

		// Should have text now
		text = await client.getLastAssistantText();
		expect(text).toContain("test123");
	}, 90000);

	test("should set and get session name", async () => {
		await client.start();

		// Initially undefined
		let state = await client.getState();
		expect(state.sessionName).toBeUndefined();

		// Send a prompt first so the first durable user message creates the Session file.
		await promptAndWait("Reply with just 'ok'");

		// Set name
		await client.setSessionName("my-test-session");

		// Verify via state
		state = await client.getState();
		expect(state.sessionName).toBe("my-test-session");

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify session_info entry in session file
		const sessionsPath = join(sessionDir, "sessions");
		const sessionDirs = readdirSync(sessionsPath);
		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const sessionInfoEntries = entries.filter((e: { type: string }) => e.type === "session_info");
		expect(sessionInfoEntries.length).toBe(1);
		expect(sessionInfoEntries[0].name).toBe("my-test-session");
	}, 60000);
});
