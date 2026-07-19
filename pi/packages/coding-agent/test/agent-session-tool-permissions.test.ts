import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mortise/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolPermissionRequest, ToolResultRequest } from "../src/core/agent-session.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("AgentSession tool permission handler", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-permission-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSessionWithEchoTool(options?: {
		extensionFactories?: ExtensionFactory[];
		onRuntimeDiagnostics?: (diagnostics: Array<{ type: "info" | "warning" | "error"; message: string }>) => void;
	}) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: options?.extensionFactories,
		});
		await resourceLoader.reload();

		const executedInputs: Record<string, unknown>[] = [];
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			onRuntimeDiagnostics: options?.onRuntimeDiagnostics,
			customTools: [
				{
					name: "echo_tool",
					label: "Echo Tool",
					description: "Echoes its input",
					parameters: Type.Object({ text: Type.String() }),
					execute: async (_toolCallId: string, params: { text: string }) => {
						executedInputs.push({ ...params });
						return {
							content: [{ type: "text" as const, text: params.text }],
							details: {},
						};
					},
				},
			],
		});

		return { session, executedInputs };
	}

	/** Drive the agent's beforeToolCall hook directly (no LLM round-trip). */
	async function invokeBeforeToolCall(
		session: Awaited<ReturnType<typeof createSessionWithEchoTool>>["session"],
		args: Record<string, unknown>,
	) {
		return session.agent.beforeToolCall!(
			{
				assistantMessage: {
					role: "assistant",
					content: [],
					responseId: "response-1",
					timestamp: 1234,
				} as never,
				toolCall: { type: "toolCall", id: "call-1", name: "echo_tool", arguments: args } as never,
				args,
				context: { messages: [] } as never,
			},
			undefined,
		);
	}

	/** Drive the agent's afterToolCall hook directly (no LLM round-trip). */
	async function invokeAfterToolCall(
		session: Awaited<ReturnType<typeof createSessionWithEchoTool>>["session"],
		args: Record<string, unknown>,
		isError: boolean,
	) {
		return session.agent.afterToolCall!(
			{
				assistantMessage: {
					role: "assistant",
					content: [],
					responseId: "response-1",
					timestamp: 1234,
				} as never,
				toolCall: { type: "toolCall", id: "call-1", name: "echo_tool", arguments: args } as never,
				args,
				result: {
					content: [{ type: "text", text: isError ? "failed" : "ok" }],
					details: { original: true },
				},
				isError,
				context: { messages: [] } as never,
			},
			undefined,
		);
	}

	it("allows tool execution when handler returns allow", async () => {
		const { session } = await createSessionWithEchoTool();
		const seen: ToolPermissionRequest[] = [];

		await session.bindExtensions({
			toolPermissionHandler: async (request) => {
				seen.push(request);
				return { action: "allow" };
			},
		});

		const result = await invokeBeforeToolCall(session, { text: "hi" });
		expect(result?.block).toBeFalsy();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			toolName: "echo_tool",
			toolCallId: "call-1",
			input: { text: "hi" },
			assistantResponseId: "response-1",
			assistantTimestamp: 1234,
		});

		session.dispose();
	});

	it("blocks tool execution when handler returns block", async () => {
		const { session } = await createSessionWithEchoTool();

		await session.bindExtensions({
			toolPermissionHandler: async () => ({ action: "block", reason: "denied by host" }),
		});

		const result = await invokeBeforeToolCall(session, { text: "hi" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("denied by host");

		session.dispose();
	});

	it("modifies tool input in place when handler returns modify", async () => {
		const { session } = await createSessionWithEchoTool();

		await session.bindExtensions({
			toolPermissionHandler: async (request) => ({
				action: "modify",
				input: { text: `${(request.input as { text: string }).text}-modified` },
			}),
		});

		const args: Record<string, unknown> = { text: "hi", stale: "drop-me" };
		const result = await invokeBeforeToolCall(session, args);
		expect(result?.block).toBeFalsy();
		// Mutated in place: same object the agent will execute with.
		expect(args).toEqual({ text: "hi-modified" });

		session.dispose();
	});

	it("runs the host gate after extension tool_call handlers (sees mutated input)", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event) => {
						(event.input as Record<string, unknown>).text = "extension-mutated";
						return undefined;
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			customTools: [
				{
					name: "echo_tool",
					label: "Echo Tool",
					description: "Echoes its input",
					parameters: Type.Object({ text: Type.String() }),
					execute: async (_toolCallId: string, params: { text: string }) => ({
						content: [{ type: "text" as const, text: params.text }],
						details: {},
					}),
				},
			],
		});

		const hostSawInput: Record<string, unknown>[] = [];
		await session.bindExtensions({
			toolPermissionHandler: async (request) => {
				hostSawInput.push({ ...request.input });
				return { action: "allow" };
			},
		});

		const args: Record<string, unknown> = { text: "original" };
		await session.agent.beforeToolCall!(
			{
				assistantMessage: { role: "assistant", content: [] } as never,
				toolCall: { type: "toolCall", id: "call-1", name: "echo_tool", arguments: args } as never,
				args,
				context: { messages: [] } as never,
			},
			undefined,
		);

		expect(hostSawInput).toHaveLength(1);
		expect(hostSawInput[0]).toEqual({ text: "extension-mutated" });

		session.dispose();
	});

	it("does not invoke the handler when extension already blocked", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => ({ block: true, reason: "extension says no" }));
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			customTools: [
				{
					name: "echo_tool",
					label: "Echo Tool",
					description: "Echoes its input",
					parameters: Type.Object({ text: Type.String() }),
					execute: async (_toolCallId: string, params: { text: string }) => ({
						content: [{ type: "text" as const, text: params.text }],
						details: {},
					}),
				},
			],
		});

		let handlerCalled = false;
		await session.bindExtensions({
			toolPermissionHandler: async () => {
				handlerCalled = true;
				return { action: "allow" };
			},
		});

		const args: Record<string, unknown> = { text: "hi" };
		const result = await session.agent.beforeToolCall!(
			{
				assistantMessage: { role: "assistant", content: [] } as never,
				toolCall: { type: "toolCall", id: "call-1", name: "echo_tool", arguments: args } as never,
				args,
				context: { messages: [] } as never,
			},
			undefined,
		);

		expect(result?.block).toBe(true);
		expect(result?.reason).toBe("extension says no");
		expect(handlerCalled).toBe(false);

		session.dispose();
	});

	it("awaits the host result handler for successful and failed tool results", async () => {
		const { session } = await createSessionWithEchoTool();
		const seen: ToolResultRequest[] = [];
		let releaseHandler!: () => void;
		let notifyStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		let completed = false;

		await session.bindExtensions({
			toolResultHandler: async (request) => {
				seen.push(request);
				if (seen.length === 1) {
					notifyStarted();
					await new Promise<void>((resolve) => {
						releaseHandler = resolve;
					});
				}
			},
		});

		const successCall = invokeAfterToolCall(session, { text: "hi" }, false).then((result) => {
			completed = true;
			return result;
		});
		await started;
		expect(completed).toBe(false);
		releaseHandler();
		await successCall;

		await invokeAfterToolCall(session, { text: "bad" }, true);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatchObject({
			toolName: "echo_tool",
			toolCallId: "call-1",
			input: { text: "hi" },
			content: [{ type: "text", text: "ok" }],
			details: { original: true },
			isError: false,
			assistantResponseId: "response-1",
			assistantTimestamp: 1234,
		});
		expect(seen[1]).toMatchObject({ isError: true, content: [{ type: "text", text: "failed" }] });

		session.dispose();
	});

	it("sends extension-finalized results to the host and keeps host failures non-fatal", async () => {
		const diagnostics: Array<{ type: "info" | "warning" | "error"; message: string }> = [];
		const seen: ToolResultRequest[] = [];
		const { session } = await createSessionWithEchoTool({
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async () => ({
						content: [{ type: "text", text: "extension-final" }],
						details: { extension: true },
						isError: false,
					}));
				},
			],
			onRuntimeDiagnostics: (next) => diagnostics.push(...next),
		});

		await session.bindExtensions({
			toolResultHandler: async (request) => {
				seen.push(request);
				throw new Error("ledger unavailable");
			},
		});

		const result = await invokeAfterToolCall(session, { text: "bad" }, true);
		expect(seen[0]).toMatchObject({
			content: [{ type: "text", text: "extension-final" }],
			details: { extension: true },
			isError: false,
		});
		expect(result).toMatchObject({
			content: [{ type: "text", text: "extension-final" }],
			details: { extension: true },
			isError: false,
		});
		expect(diagnostics).toEqual([
			expect.objectContaining({ type: "warning", message: expect.stringContaining("ledger unavailable") }),
		]);

		session.dispose();
	});
});
