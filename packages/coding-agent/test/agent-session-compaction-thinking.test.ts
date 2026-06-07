import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type * as CompactionModule from "../src/core/compaction/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const { compactMock } = vi.hoisted(() => ({
	compactMock: vi.fn(),
}));

vi.mock("../src/core/compaction/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof CompactionModule>();
	return {
		...actual,
		compact: compactMock,
		prepareCompaction: () => ({
			firstKeptEntryId: "entry-1",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		}),
	};
});

describe("AgentSession compaction thinking level", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compaction-thinking-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		compactMock.mockReset();
		compactMock.mockResolvedValue({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 100,
			details: {},
			summaryStats: {
				durationMs: 1234,
				usage: {
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					totalTokens: 100,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				},
				calls: [
					{
						purpose: "history",
						durationMs: 1234,
						usage: {
							input: 10,
							output: 20,
							cacheRead: 30,
							cacheWrite: 40,
							totalTokens: 100,
							cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
						},
					},
				],
			},
		});

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("uses medium thinking for manual compaction regardless of the current session level", async () => {
		session.setThinkingLevel("high");

		await session.compact();

		expect(compactMock).toHaveBeenCalledTimes(1);
		expect(compactMock.mock.calls[0][6]).toBe("medium");
	});

	it("persists compaction summary usage and duration in the session log", async () => {
		await session.compact();

		const compactionEntry = session.sessionManager.getEntries().find((entry) => entry.type === "compaction");

		expect(compactionEntry).toBeDefined();
		expect(compactionEntry?.type).toBe("compaction");
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.summaryStats).toEqual({
				durationMs: 1234,
				usage: {
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					totalTokens: 100,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				},
				calls: [
					{
						purpose: "history",
						durationMs: 1234,
						usage: {
							input: 10,
							output: 20,
							cacheRead: 30,
							cacheWrite: 40,
							totalTokens: 100,
							cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
						},
					},
				],
			});
		}
	});
});
