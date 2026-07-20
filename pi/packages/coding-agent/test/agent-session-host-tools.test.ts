import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mortise/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession.registerHostTools", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-host-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	function makeHostTool(name: string, onExecute?: (params: unknown) => void) {
		return {
			name,
			label: name,
			description: `Host tool ${name}`,
			promptSnippet: `Use ${name} for testing`,
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId: string, params: { q: string }) => {
				onExecute?.(params);
				return {
					content: [{ type: "text" as const, text: `host:${params.q}` }],
					details: {},
				};
			},
		};
	}

	it("registers tools at runtime, activates them, and lists them in the system prompt", async () => {
		const session = await createSession();
		expect(session.getAllTools().map((t) => t.name)).not.toContain("mcp__linear__list_issues");

		session.registerHostTools([makeHostTool("mcp__linear__list_issues")]);

		expect(session.getAllTools().map((t) => t.name)).toContain("mcp__linear__list_issues");
		expect(session.getActiveToolNames()).toContain("mcp__linear__list_issues");
		expect(session.systemPrompt).toContain("mcp__linear__list_issues");

		session.dispose();
	});

	it("replaces a tool by name on re-registration", async () => {
		const session = await createSession();
		const calls: string[] = [];

		session.registerHostTools([makeHostTool("host_tool", () => calls.push("v1"))]);
		session.registerHostTools([makeHostTool("host_tool", () => calls.push("v2"))]);

		const tool = session.getToolDefinition("host_tool");
		expect(tool).toBeDefined();
		// Execute the replaced definition — only v2 should record.
		await tool!.execute("call-1", { q: "x" } as never, undefined as never, undefined as never, undefined as never);
		expect(calls).toEqual(["v2"]);

		// No duplicates in the registry.
		const names = session.getAllTools().map((t) => t.name);
		expect(names.filter((n) => n === "host_tool")).toHaveLength(1);

		session.dispose();
	});

	it("keeps built-in tools active alongside host tools", async () => {
		const session = await createSession();
		const before = session.getActiveToolNames();

		session.registerHostTools([makeHostTool("host_tool")]);

		const after = session.getActiveToolNames();
		for (const name of before) {
			expect(after).toContain(name);
		}
		expect(after).toContain("host_tool");

		session.dispose();
	});

	it("host tools survive a host system-prompt override refresh", async () => {
		const session = await createSession();
		session.registerHostTools([makeHostTool("host_tool")]);

		await session.prompt("hello", { systemPrompt: "HOST PROMPT" }).catch(() => {});
		expect(session.systemPrompt).toBe("HOST PROMPT");
		// Tool remains registered/active even though the prompt no longer lists it
		// (the host prompt owns tool presentation in shell mode).
		expect(session.getActiveToolNames()).toContain("host_tool");

		session.dispose();
	});

	it("appends and clears host system-prompt context without replacing Pi's prompt", async () => {
		const session = await createSession();
		const nativePrompt = session.systemPrompt;

		await session.prompt("hello", { appendSystemPrompt: "DEVELOPER KIT CONTEXT" }).catch(() => {});
		expect(session.systemPrompt).toBe(`${nativePrompt}\n\nDEVELOPER KIT CONTEXT`);

		session.refreshSystemPrompt();
		expect(session.systemPrompt).toBe(`${nativePrompt}\n\nDEVELOPER KIT CONTEXT`);

		await session.prompt("hello again", { appendSystemPrompt: "" }).catch(() => {});
		expect(session.systemPrompt).toBe(nativePrompt);

		session.dispose();
	});
});
