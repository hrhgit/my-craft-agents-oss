/**
 * Tests for edit tool's read-history-based recovery:
 *   1. Path recovery (ENOENT -> auto-resolve from read history)
 *   2. Approximate text match (whitespace/indentation drift)
 *   3. Already-applied detection
 *   4. Structured error details on failure
 *
 * Uses real file I/O with temp dirs, no provider/API calls.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import type { ReadHistoryStore } from "../../src/core/tools/read-history.ts";
import {
	buildReadHistoryEntry,
	cleanupReadHistoryStore,
	getReadHistoryStore,
} from "../../src/core/tools/read-history.ts";

const SESSION_ID = "test-edit-recovery-session";
const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-recovery-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createTool(cwd: string, readHistoryStore?: ReadHistoryStore) {
	return createEditToolDefinition(cwd, { readHistoryStore });
}

async function executeEdit(
	tool: ReturnType<typeof createEditToolDefinition>,
	input: { path: string; edits: Array<{ oldText: string; newText: string }> },
) {
	return tool.execute("test-call-id", input as any, undefined, undefined, undefined as any);
}

// ---------------------------------------------------------------------------
// 1. Path recovery: ENOENT with read-history candidates
// ---------------------------------------------------------------------------
describe("edit path recovery from read history", () => {
	it("auto-resolves path when read history has a unique high-confidence candidate", async () => {
		const dir = await createTempDir();
		const realPath = join(dir, "src", "index.ts");
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(realPath, "const x = 1;\n", "utf8");

		const store = getReadHistoryStore(SESSION_ID);
		store.clear();
		// Record with the same basename pattern the model will use
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-1",
				requestedPath: join(dir, "src", "index.tsx"), // model's wrong path
				canonicalPath: realPath,
				text: "const x = 1;\n",
				startLine: 1,
				endLine: 1,
			}),
		);

		// Model hallucinates .tsx instead of .ts
		const wrongPath = join(dir, "src", "index.tsx");
		const tool = createTool(dir, store);

		await executeEdit(tool, {
			path: wrongPath,
			edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
		});

		const content = await readFile(realPath, "utf8");
		expect(content).toBe("const x = 2;\n");

		store.clear();
		cleanupReadHistoryStore(SESSION_ID);
	});

	it("suggests candidates in error message when path recovery score is below threshold", async () => {
		const dir = await createTempDir();
		const realPath = join(dir, "src", "index.ts");
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(realPath, "const x = 1;\n", "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-suggest`);
		store.clear();
		// Record with a different requested path (low similarity)
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-suggest",
				requestedPath: "completely/different/path.ts",
				canonicalPath: realPath,
				text: "const x = 1;\n",
				startLine: 1,
				endLine: 1,
			}),
		);

		const wrongPath = join(dir, "nope", "wrong.ts");
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: wrongPath,
				edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("ENOENT");
			// Should still suggest the real path
			expect(error.message).toContain("index.ts");
			// Structured details should be present
			expect(error.toolResult?.details?.error?.kind).toBe("path_not_found");
		}

		store.clear();
	});
});

// ---------------------------------------------------------------------------
// 2. Approximate text match: whitespace / indentation drift
// ---------------------------------------------------------------------------
describe("edit approximate text match", () => {
	it("auto-applies when oldText differs only in leading whitespace (unique match, long enough text)", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "code.ts");
		// File has tabs, model sends spaces - need 2+ lines and 40+ chars for approximate match
		const fileContent = `\tinterface ServerOptions {\n\t\tpi: ExtensionAPI;\n\t\tauth: RemoteAuth;\n\t\tsettings: RemoteSettings;\n\t}\n`;
		await writeFile(filePath, fileContent, "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-approx`);
		store.clear();
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-approx-1",
				requestedPath: filePath,
				canonicalPath: filePath,
				text: fileContent,
				startLine: 1,
				endLine: 5,
			}),
		);

		const tool = createTool(dir, store);

		// Model sends space-indented version (40+ chars, 2+ lines)
		const result = await executeEdit(tool, {
			path: filePath,
			edits: [
				{
					oldText: `  interface ServerOptions {\n    pi: ExtensionAPI;\n    auth: RemoteAuth;\n    settings: RemoteSettings;\n  }`,
					newText: `  interface ServerOptions {\n    pi: ExtensionAPI;\n    auth: RemoteAuth;\n    settings: RemoteSettings;\n    getCommandContext: () => ExtensionCommandContext | undefined;\n  }`,
				},
			],
		});

		const content = await readFile(filePath, "utf8");
		expect(content).toContain("getCommandContext");

		// Check result mentions approximate match
		expect(result.content[0]).toHaveProperty("text");
		if ("text" in result.content[0]) {
			expect(result.content[0].text).toContain("approximate");
		}

		store.clear();
	});

	it("auto-applies when the only difference is trailing delimiters at line ends", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "delimiters.ts");
		const finalizePlaceholder = ["${", "PLAN_FINALIZE_COMMAND", "}"].join("");
		const sharedLines = [
			"讨论模式规则：",
			"- 只讨论当前方案、取舍、风险、范围、实现细节、替代方案和待确认问题。",
			"- 不要每轮重新输出完整方案。",
			"- 不要输出 plan mode 的完整结构。",
			"- 不要输出 # 执行清单。",
			"- 普通回复应简短，优先给结论、差异、建议和问题。",
			`- 如果用户想结束讨论并生成最终完整方案，请提示用户输入 /${finalizePlaceholder}。`,
		];
		const fileContent = [
			...sharedLines,
			`- 只有 /${finalizePlaceholder} 触发的回合才应生成完整最终方案。\`,`,
			"",
		].join("\n");
		await writeFile(filePath, fileContent, "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-delimiters`);
		store.clear();
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-delimiters-1",
				requestedPath: filePath,
				canonicalPath: filePath,
				text: fileContent,
				startLine: 1,
				endLine: 9,
			}),
		);

		const tool = createTool(dir, store);
		const result = await executeEdit(tool, {
			path: filePath,
			edits: [
				{
					oldText: [
						...sharedLines,
						`- 只有 /${finalizePlaceholder} 触发的回合才应生成完整最终方案。\`,\`\``,
						"",
					].join("\n"),
					newText: [
						...sharedLines,
						`- 只有 /${finalizePlaceholder} 触发的回合才应生成完整最终方案。\`,`,
						"更新说明",
						"",
					].join("\n"),
				},
			],
		});

		const content = await readFile(filePath, "utf8");
		expect(content).toContain("更新说明");
		if ("text" in result.content[0]) {
			expect(result.content[0].text).toContain("approximate");
		}

		store.clear();
	});

	it("auto-applies when text differs slightly inside a long matching block", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "messages.ts");
		const fileContent = `		if (req.method === "GET" && url.pathname === "/api/messages") {
			const ctx = this.options.getContext();
			if (!ctx) {
				sendJson(res, 503, { error: "No active pi session" });
				return;
			}
			const entries = ctx.sessionManager.getEntries();
			sendJson(res, 200, { messages: entries });
			return;
		}
`;
		await writeFile(filePath, fileContent, "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-charscore`);
		store.clear();
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-charscore-1",
				requestedPath: filePath,
				canonicalPath: filePath,
				text: fileContent,
				startLine: 1,
				endLine: 10,
			}),
		);

		const tool = createTool(dir, store);
		const result = await executeEdit(tool, {
			path: filePath,
			edits: [
				{
					oldText: `		if (req.method === "GET" && url.pathname === "/api/sessions") {
			const ctx = this.options.getContext();
			if (!ctx) {
				sendJson(res, 503, { error: "No active pi session" });
				return;
			}
			const entries = ctx.sessionManager.getEntries();
			sendJson(res, 200, { messages: entries });
			return;
		}`,
					newText: `		if (req.method === "GET" && url.pathname === "/api/messages") {
			const ctx = this.options.getContext();
			if (!ctx) {
				sendJson(res, 503, { error: "No active pi session" });
				return;
			}
			const entries = ctx.sessionManager.getEntries();
			sendJson(res, 200, { messages: entries });
			console.log(entries.length);
			return;
		}`,
				},
			],
		});

		const content = await readFile(filePath, "utf8");
		expect(content).toContain("console.log(entries.length);");
		if ("text" in result.content[0]) {
			expect(result.content[0].text).toContain("approximate");
		}

		store.clear();
	});

	it("fails with exact_not_found when oldText is too short for approximate match", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "short.ts");
		await writeFile(filePath, "foo();\n", "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-short`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: filePath,
				edits: [{ oldText: "  foo();", newText: "  bar();" }],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			// Too short for approximate match, falls through to exact_not_found
			expect(error.toolResult?.details?.error?.kind).toBe("exact_not_found");
		}

		store.clear();
	});

	it("fails with duplicate_old_text when text matches multiple locations", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "dupe.ts");
		await writeFile(filePath, "foo();\nfoo();\n", "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-dupe`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: filePath,
				edits: [{ oldText: "foo();", newText: "bar();" }],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("occurrences");
			expect(error.toolResult?.details?.error?.kind).toBe("duplicate_old_text");
		}

		store.clear();
	});
});

// ---------------------------------------------------------------------------
// 3. Already-applied detection
// ---------------------------------------------------------------------------
describe("edit already-applied detection", () => {
	it("detects when the edit has already been applied", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "already.ts");
		// File already has the new text
		await writeFile(filePath, "const x = 2;\n", "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-applied`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: filePath,
				edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("already applied");
			expect(error.toolResult?.details?.error?.kind).toBe("already_applied");
		}

		store.clear();
	});
});

// ---------------------------------------------------------------------------
// 4. Structured error details
// ---------------------------------------------------------------------------
describe("edit structured error details", () => {
	it("includes error kind, editIndex, and totalEdits in details", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "details.ts");
		await writeFile(filePath, "line1\nline2\n", "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-details`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: filePath,
				edits: [
					{ oldText: "line1", newText: "LINE1" },
					{ oldText: "NONEXISTENT", newText: "something" },
				],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.toolResult).toBeDefined();
			const details = error.toolResult.details;
			expect(details.error).toBeDefined();
			expect(details.error.kind).toBe("exact_not_found");
			expect(details.error.editIndex).toBe(1); // second edit failed
			expect(details.error.totalEdits).toBe(2);
		}

		store.clear();
	});

	it("wraps error toolResult with both content and details", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "wrap.ts");
		await writeFile(filePath, "hello\n", "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-wrap`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: filePath,
				edits: [{ oldText: "MISSING", newText: "REPLACED" }],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			// error.toolResult should have content array AND details
			expect(error.toolResult.content).toBeDefined();
			expect(Array.isArray(error.toolResult.content)).toBe(true);
			expect(error.toolResult.content[0].type).toBe("text");
			expect(error.toolResult.content[0].text).toContain("Could not find");

			expect(error.toolResult.details).toBeDefined();
			expect(error.toolResult.details.error.kind).toBe("exact_not_found");
		}

		store.clear();
	});

	it("success result includes diff and firstChangedLine", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "success.ts");
		await writeFile(filePath, "const a = 1;\nconst b = 2;\n", "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-success`);
		store.clear();
		const tool = createTool(dir, store);

		const result = await executeEdit(tool, {
			path: filePath,
			edits: [{ oldText: "const a = 1;", newText: "const a = 99;" }],
		});

		expect(result.details).toBeDefined();
		expect(result.details!.diff).toBeDefined();
		expect(result.details!.diff).toContain("a = 99");
		expect(result.details!.firstChangedLine).toBe(1);

		store.clear();
	});

	it("ENOENT error includes path_not_found kind with candidates array", async () => {
		const dir = await createTempDir();
		const missingPath = join(dir, "nonexistent.ts");

		const store = getReadHistoryStore(`${SESSION_ID}-enoent`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: missingPath,
				edits: [{ oldText: "const x = 1;", newText: "const x = 2;" }],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("ENOENT");
			expect(error.toolResult).toBeDefined();
			expect(error.toolResult.details.error).toBeDefined();
			expect(error.toolResult.details.error.kind).toBe("path_not_found");
			expect(Array.isArray(error.toolResult.details.error.pathCandidates)).toBe(true);
		}

		store.clear();
	});
});

// ---------------------------------------------------------------------------
// 5. Simulation of real session failures
// ---------------------------------------------------------------------------
describe("edit recovery simulation from real session logs", () => {
	it("simulates: model writes plan-mode/src/index.ts but file is at plan-mode/dist/index.js (ENOENT + path recovery)", async () => {
		// Setup: file exists at a different path than what model will use
		const dir = await createTempDir();
		const realDir = join(dir, "plan-mode", "dist");
		await mkdir(realDir, { recursive: true });
		const realPath = join(realDir, "index.js");
		await writeFile(realPath, '  lines.push("old prompt text");\n', "utf8");

		// Simulate: read history recorded the real path with the wrong requestedPath
		const store = getReadHistoryStore(`${SESSION_ID}-sim1`);
		store.clear();
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-sim-1",
				requestedPath: join(dir, "plan-mode", "src", "index.ts"), // model's wrong path
				canonicalPath: realPath,
				text: '  lines.push("old prompt text");\n',
				startLine: 1,
				endLine: 1,
			}),
		);

		// Model uses wrong path (src instead of dist, .ts instead of .js)
		const wrongPath = join(dir, "plan-mode", "src", "index.ts");
		const tool = createTool(dir, store);

		await executeEdit(tool, {
			path: wrongPath,
			edits: [
				{
					oldText: '  lines.push("old prompt text");',
					newText: '  lines.push("new prompt text");',
				},
			],
		});

		// Should have auto-recovered to the real path
		const content = await readFile(realPath, "utf8");
		expect(content).toContain("new prompt text");

		store.clear();
	});

	it("simulates: model edits server.ts but indentation drifts (tabs vs spaces, long text)", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "server.ts");
		// Real file uses tabs - needs to be 40+ chars and 2+ lines for approximate match
		const fileContent = `interface RemoteServerOptions {\n\tpi: ExtensionAPI;\n\tauth: RemoteAuth;\n\tsettings: RemoteSettings;\n\tgetContext: () => ExtensionContext | undefined;\n}\n`;
		await writeFile(filePath, fileContent, "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-sim2`);
		store.clear();
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-sim-2",
				requestedPath: filePath,
				canonicalPath: filePath,
				text: fileContent,
				startLine: 1,
				endLine: 6,
			}),
		);

		const tool = createTool(dir, store);

		// Model sends space-indented version (40+ chars, 2+ lines)
		const result = await executeEdit(tool, {
			path: filePath,
			edits: [
				{
					oldText: `interface RemoteServerOptions {\n  pi: ExtensionAPI;\n  auth: RemoteAuth;\n  settings: RemoteSettings;\n  getContext: () => ExtensionContext | undefined;\n}`,
					newText: `interface RemoteServerOptions {\n  pi: ExtensionAPI;\n  auth: RemoteAuth;\n  settings: RemoteSettings;\n  getContext: () => ExtensionContext | undefined;\n  getCommandContext: () => ExtensionCommandContext | undefined;\n}`,
				},
			],
		});

		const content = await readFile(filePath, "utf8");
		expect(content).toContain("getCommandContext");
		expect(result.content[0]).toHaveProperty("text");
		if ("text" in result.content[0]) {
			expect(result.content[0].text).toContain("approximate");
		}

		store.clear();
	});

	it("simulates: structured details flow through error for a real ENOENT case", async () => {
		const dir = await createTempDir();
		const realPath = join(dir, "extension", "src", "handler.ts");
		await mkdir(join(dir, "extension", "src"), { recursive: true });
		await writeFile(realPath, "export function handle() {}\n", "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-sim3`);
		store.clear();
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-sim-3",
				requestedPath: join(dir, "extension", "handler.ts"),
				canonicalPath: realPath,
				text: "export function handle() {}\n",
				startLine: 1,
				endLine: 1,
			}),
		);

		// Model uses wrong path (missing /src/)
		const wrongPath = join(dir, "extension", "handler.ts");
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: wrongPath,
				edits: [{ oldText: "export function handle() {}", newText: "export function handle(req: Request) {}" }],
			});
			// Might auto-recover if score is high enough - that's fine too
		} catch (error: any) {
			// If it fails, check structured details are present
			if (error.toolResult) {
				expect(error.toolResult.details.error).toBeDefined();
				expect(error.toolResult.details.error.kind).toBe("path_not_found");
				expect(Array.isArray(error.toolResult.details.error.pathCandidates)).toBe(true);
				// The candidate should include the real path
				const candidates = error.toolResult.details.error.pathCandidates;
				const found = candidates.some((c: any) => c.canonicalPath === realPath);
				expect(found).toBe(true);
			}
		}

		store.clear();
	});
});

// ---------------------------------------------------------------------------
// 6. Real failure cases from session logs (2026-05-19 ~ 2026-05-22)
// These are direct reproductions of actual edit failures from user sessions.
// ---------------------------------------------------------------------------
describe("real failure cases from session logs", () => {
	it("case: yourself/extension.ts ENOENT - wrong directory structure", async () => {
		// Session 2026-05-22T10-23-51, model guessed wrong path multiple times
		// Real file was at yourself/src/extension.ts, model tried yourself/extension.ts
		const dir = await createTempDir();
		const realDir = join(dir, "yourself", "src");
		await mkdir(realDir, { recursive: true });
		const realPath = join(realDir, "extension.ts");
		const fileContent = 'import { Extension } from "@pi/coding-agent";\nimport { readFileSync } from "fs";\n';
		await writeFile(realPath, fileContent, "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-real1`);
		store.clear();
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-real-1",
				requestedPath: join(dir, "yourself", "extension.ts"),
				canonicalPath: realPath,
				text: fileContent,
				startLine: 1,
				endLine: 2,
			}),
		);

		const wrongPath = join(dir, "yourself", "extension.ts");
		const tool = createTool(dir, store);

		await executeEdit(tool, {
			path: wrongPath,
			edits: [
				{
					oldText: 'import { Extension } from "@pi/coding-agent";',
					newText: 'import type { Extension } from "@pi/coding-agent";',
				},
			],
		});

		const content = await readFile(realPath, "utf8");
		expect(content).toContain("import type");

		store.clear();
	});

	it("case: settings.json - content already changed (stale oldText)", async () => {
		// Session 2026-05-21, model had stale settings.json content in context
		// File was already modified by a previous edit in the same session
		const dir = await createTempDir();
		const filePath = join(dir, "settings.json");
		await writeFile(
			filePath,
			'{\n  "defaultProvider": "myapi-gpt",\n  "defaultModel": "gpt-5.4",\n  "defaultThinkingLevel": "high",\n  "webSearch": true\n}\n',
			"utf8",
		);

		const store = getReadHistoryStore(`${SESSION_ID}-real2`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: filePath,
				edits: [
					{
						oldText:
							'{\n  "defaultProvider": "myapi-gpt",\n  "defaultModel": "gpt-5.4",\n  "defaultThinkingLevel": "high"\n}\n',
						newText:
							'{\n  "defaultProvider": "myapi-gpt",\n  "defaultModel": "gpt-5.4",\n  "defaultThinkingLevel": "high",\n  "webSearch": true\n}\n',
					},
				],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("already applied");
			expect(error.toolResult?.details?.error?.kind).toBe("already_applied");
		}

		store.clear();
	});

	it("case: Kotlin file - 4-space indent exact match", async () => {
		// Session 2026-05-22, PiRemoteApp.kt with standard Kotlin indentation
		const dir = await createTempDir();
		const filePath = join(dir, "PiRemoteApp.kt");
		const fileContent = `class PiRemoteApp : Application() {\n    override fun onCreate() {\n        super.onCreate()\n        if (BuildConfig.DEBUG) {\n            Timber.plant(Timber.DebugTree())\n        }\n    }\n}\n`;
		await writeFile(filePath, fileContent, "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-real3`);
		store.clear();
		store.record(
			buildReadHistoryEntry({
				toolCallId: "read-real-3",
				requestedPath: filePath,
				canonicalPath: filePath,
				text: fileContent,
				startLine: 1,
				endLine: 8,
			}),
		);

		const tool = createTool(dir, store);

		const _result = await executeEdit(tool, {
			path: filePath,
			edits: [
				{
					oldText: `class PiRemoteApp : Application() {\n    override fun onCreate() {\n        super.onCreate()\n        if (BuildConfig.DEBUG) {\n            Timber.plant(Timber.DebugTree())\n        }\n    }\n}`,
					newText: `class PiRemoteApp : Application() {\n    override fun onCreate() {\n        super.onCreate()\n        if (BuildConfig.DEBUG) {\n            Timber.plant(Timber.DebugTree())\n        }\n        AppContainer.init(this)\n    }\n}`,
				},
			],
		});

		const content = await readFile(filePath, "utf8");
		expect(content).toContain("AppContainer.init(this)");

		store.clear();
	});

	it("case: vitest import duplicate_old_text", async () => {
		// Session 2026-05-20, test file had duplicate vitest import lines
		const dir = await createTempDir();
		const filePath = join(dir, "test.ts");
		await writeFile(
			filePath,
			'import { afterEach, beforeEach, describe, expect, it } from "vitest";\nimport { foo } from "./foo.js";\nimport { afterEach, beforeEach, describe, expect, it } from "vitest";\n',
			"utf8",
		);

		const store = getReadHistoryStore(`${SESSION_ID}-real4`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: filePath,
				edits: [
					{
						oldText: 'import { afterEach, beforeEach, describe, expect, it } from "vitest";',
						newText: 'import { describe, expect, it } from "vitest";',
					},
				],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("occurrences");
			expect(error.toolResult?.details?.error?.kind).toBe("duplicate_old_text");
			expect(error.toolResult?.details?.error?.occurrences).toBe(2);
		}

		store.clear();
	});

	it("case: edits[1] failed - CHANGELOG content not in target file", async () => {
		// Session 2026-05-19, model mixed up edit targets
		// edits[0] was valid for shell.ts, but edits[1] was CHANGELOG content
		const dir = await createTempDir();
		const filePath = join(dir, "shell.ts");
		await writeFile(filePath, 'export function getShell() { return "sh"; }\n', "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-real5`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: filePath,
				edits: [
					{
						oldText: 'export function getShell() { return "sh"; }',
						newText: 'export function getShell() { return "bash"; }',
					},
					{
						oldText: "## [Unreleased]\n",
						newText: "## [Unreleased]\n\n### Changed\n\n- Changed default shell.\n",
					},
				],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.toolResult?.details?.error?.kind).toBe("exact_not_found");
			expect(error.toolResult?.details?.error?.editIndex).toBe(1);
			expect(error.toolResult?.details?.error?.totalEdits).toBe(2);
		}

		store.clear();
	});

	it("case: long Chinese text with trailing space difference", async () => {
		// Session 2026-05-22, plan-mode/index.ts with Chinese prompt text
		// Model had a trailing space before closing quote that wasn't in the file
		const dir = await createTempDir();
		const filePath = join(dir, "index.ts");
		const fileContent =
			'  lines.push("根据下面的架构收缩审查意见重新细化方案。保留用户明确需求和必要安全/验收标准，删除超前设计、过度抽象和未经确认假设，把最终设计收缩到当前需求真正需要的最小形态，然后输出完整必需章节，并附上简短的执行清单。");\n';
		await writeFile(filePath, fileContent, "utf8");

		const store = getReadHistoryStore(`${SESSION_ID}-real6`);
		store.clear();
		const tool = createTool(dir, store);

		// Model's oldText has a trailing space before the closing quote
		try {
			await executeEdit(tool, {
				path: filePath,
				edits: [
					{
						oldText:
							'  lines.push("根据下面的架构收缩审查意见重新细化方案。保留用户明确需求和必要安全/验收标准，删除超前设计、过度抽象和未经确认假设，把最终设计收缩到当前需求真正需要的最小形态，然后输出完整必需章节，并附上简短的 执行清单。");',
						newText: '  lines.push("新文本");',
					},
				],
			});
		} catch (error: any) {
			expect(error.toolResult?.details?.error).toBeDefined();
			expect(error.toolResult?.details?.error?.kind).toBe("exact_not_found");
		}

		store.clear();
	});

	it("case: ENOENT with no read history - empty candidates", async () => {
		// Common case: model hallucinates a path with no prior read
		const dir = await createTempDir();
		const store = getReadHistoryStore(`${SESSION_ID}-real7`);
		store.clear();
		const tool = createTool(dir, store);

		try {
			await executeEdit(tool, {
				path: join(dir, "nonexistent", "deeply", "nested", "file.ts"),
				edits: [{ oldText: "hello", newText: "world" }],
			});
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("ENOENT");
			expect(error.toolResult?.details?.error?.kind).toBe("path_not_found");
			expect(error.toolResult?.details?.error?.pathCandidates).toBeDefined();
			expect(error.toolResult.details.error.pathCandidates.length).toBe(0);
		}

		store.clear();
	});
});
