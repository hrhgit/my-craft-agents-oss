import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mortise/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel, type Model } from "@mortise/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

type FakeRuntimeControls = {
	toolExecutionHandler: (request: Record<string, unknown>) => Promise<{ action: string; reason?: string }>;
	toolResultHandler: (request: Record<string, unknown>) => Promise<void>;
};

function createFakeRuntime(sessionId: string, siblingFactory?: () => ReturnType<typeof createFakeRuntime>) {
	let controls: FakeRuntimeControls | undefined;
	let rebind: (() => Promise<void>) | undefined;
	let hostTools: Array<{ name: string; execute: (toolCallId: string, input: unknown) => Promise<unknown> }> = [];
	const session = {
		sessionId,
		attemptId: `execution-${sessionId}`,
		sessionFile: undefined,
		isStreaming: false,
		isCompacting: false,
		model: undefined,
		thinkingLevel: "off",
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		sessionName: undefined,
		autoCompactionEnabled: true,
		messages: [],
		pendingMessageCount: 0,
		systemPrompt: "",
		compactionPrompt: undefined,
		resourceLoader: { getExtensions: () => ({ extensions: [] }) },
		agent: { subscribe: () => () => {}, waitForIdle: async () => {} },
		bindExtensions: async (next: FakeRuntimeControls) => {
			controls = next;
		},
		subscribe: () => () => {},
		getLastAssistantText: () => undefined,
		getActiveToolNames: () => [],
		getAllTools: () => [],
		registerHostTools: (tools: typeof hostTools) => {
			hostTools = tools;
		},
	};
	const runtime = {
		cwd: process.cwd(),
		session,
		services: { agentDir: process.cwd() },
		setRebindSession: (handler: () => Promise<void>) => {
			rebind = handler;
		},
		createSibling: async () => siblingFactory?.() ?? createFakeRuntime(`sibling-${Date.now()}`),
		dispose: async () => {},
		get controls() {
			if (!controls) throw new Error(`Runtime ${sessionId} is not bound`);
			return controls;
		},
		get hostTool() {
			const tool = hostTools[0];
			if (!tool) throw new Error(`Runtime ${sessionId} has no host tool`);
			return tool;
		},
		get rebind() {
			return rebind;
		},
	};
	return runtime;
}

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function getCommandResponses(outputLines: string[], id: string, command: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === command,
	);
}

function getStartedAttemptId(outputLines: string[], id: string): string | undefined {
	const response = getPromptResponses(outputLines, id)[0];
	const data = response?.data as { status?: unknown; attemptId?: unknown } | undefined;
	return data?.status === "started" && typeof data.attemptId === "string" ? data.attemptId : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	persistSession?: boolean;
	extensionFactories?: ExtensionFactory[];
	failSettlementOnce?: boolean;
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	getSessionFile: () => string | undefined;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = options.persistSession
		? SessionManager.create(tempDir, join(tempDir, "sessions"))
		: SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	if (options.withAuth) {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	}

	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined),
	});
	if (options.failSettlementOnce) {
		const originalFlush = sessionManager.flush.bind(sessionManager);
		let flushCalls = 0;
		vi.spyOn(sessionManager, "flush").mockImplementation(async () => {
			flushCalls++;
			if (flushCalls === 3) throw new Error("disk temporarily unavailable");
			await originalFlush();
		});
		vi.spyOn(sessionManager, "retryFlush").mockImplementation(originalFlush);
	}

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		getSessionFile: () => sessionManager.getSessionFile(),
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	persistSession?: boolean;
	extensionFactories?: ExtensionFactory[];
	failSettlementOnce?: boolean;
}): Promise<{
	lineHandler: (line: string) => void;
	getSessionFile: () => string | undefined;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, getSessionFile, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, getSessionFile, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("starts a Pi Attempt without a host-issued Attempt identity", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "missing-execution", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "missing-execution")).toEqual([
					expect.objectContaining({ success: true }),
				]);
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one rejected disposition when prompt preflight fails", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: true,
					data: { status: "rejected", reason: "preflight-failed" },
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
					data: { status: "started", attemptId: expect.any(String) },
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("retries a failed durability settlement under the original Attempt identity", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			failSettlementOnce: true,
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "settlement-prompt",
					type: "prompt",
					message: "Hello",
				}),
			);
			let attemptId: string | undefined;
			await vi.waitFor(() => {
				attemptId = getStartedAttemptId(rpcIo.outputLines, "settlement-prompt");
				expect(attemptId).toEqual(expect.any(String));
				const records = parseOutputLines(rpcIo.outputLines);
				expect(records).toContainEqual(
					expect.objectContaining({
						type: "settlement_failed",
						attemptId,
						attempt: 1,
						error: "disk temporarily unavailable",
					}),
				);
				expect(records.some((record) => record.type === "agent_settled")).toBe(false);
			});

			lineHandler(
				JSON.stringify({
					id: "settlement-retry",
					type: "retry_settlement",
					attemptId,
				}),
			);

			await vi.waitFor(() => {
				expect(getCommandResponses(rpcIo.outputLines, "settlement-retry", "retry_settlement")).toEqual([
					expect.objectContaining({ success: true }),
				]);
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						type: "agent_settled",
						attemptId,
					}),
				);
			});
		} finally {
			await cleanup();
		}
	});

	it("isolates pending tool cleanup to the runtime being disabled or closed", async () => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		const siblings: Array<ReturnType<typeof createFakeRuntime>> = [];
		const defaultRuntime = createFakeRuntime("default-session", () => {
			const sibling = createFakeRuntime(`session-${siblings.length + 1}`);
			siblings.push(sibling);
			return sibling;
		});
		void runRpcMode(defaultRuntime as never);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		const lineHandler = rpcIo.lineHandler!;
		const send = (command: Record<string, unknown>) => lineHandler(JSON.stringify(command));

		send({ id: "open-a", type: "open_runtime", runtimeId: "runtime-a", cwd: process.cwd(), inMemory: true });
		send({ id: "open-b", type: "open_runtime", runtimeId: "runtime-b", cwd: process.cwd(), inMemory: true });
		await vi.waitFor(() => expect(siblings).toHaveLength(2));
		const [runtimeA, runtimeB] = siblings;
		if (!runtimeA || !runtimeB) throw new Error("Sibling runtimes were not created");

		for (const runtimeId of ["runtime-a", "runtime-b"]) {
			send({ id: `execution-on-${runtimeId}`, type: "enable_tool_execution_interceptor", runtimeId, enabled: true });
			send({ id: `results-on-${runtimeId}`, type: "enable_tool_results", runtimeId, enabled: true });
			send({
				id: `tools-${runtimeId}`,
				type: "register_tools",
				runtimeId,
				tools: [{ name: "host_tool", description: "Host tool", inputSchema: { type: "object" } }],
			});
		}
		await vi.waitFor(() => {
			expect(runtimeA.hostTool.name).toBe("host_tool");
			expect(runtimeB.hostTool.name).toBe("host_tool");
		});

		let disabledBResolved = false;
		const disabledA = runtimeA.controls.toolExecutionHandler({
			toolName: "write",
			toolCallId: "disabled-a",
			input: {},
			assistantTimestamp: 1,
		});
		const disabledB = runtimeB.controls
			.toolExecutionHandler({
				toolName: "write",
				toolCallId: "disabled-b",
				input: {},
				assistantTimestamp: 1,
			})
			.then((value) => {
				disabledBResolved = true;
				return value;
			});
		send({ id: "disable-a", type: "enable_tool_execution_interceptor", runtimeId: "runtime-a", enabled: false });
		await expect(disabledA).resolves.toMatchObject({ action: "block" });
		await sleep(20);
		expect(disabledBResolved).toBe(false);
		const disabledBRequest = parseOutputLines(rpcIo.outputLines).find(
			(record) => record.type === "tool_execution_request" && record.toolCallId === "disabled-b",
		);
		if (!disabledBRequest) throw new Error("Runtime B interceptor request was not emitted");
		send({
			type: "tool_execution_response",
			id: disabledBRequest.id,
			runtimeId: "runtime-b",
			sessionId: runtimeB.session.sessionId,
			attemptId: runtimeB.session.attemptId,
			action: "allow",
		});
		await expect(disabledB).resolves.toEqual({ action: "allow" });

		send({
			id: "execution-on-a-again",
			type: "enable_tool_execution_interceptor",
			runtimeId: "runtime-a",
			enabled: true,
		});
		const executionA = runtimeA.controls.toolExecutionHandler({
			toolName: "write",
			toolCallId: "close-execution-a",
			input: {},
			assistantTimestamp: 1,
		});
		let executionBResolved = false;
		const executionB = runtimeB.controls
			.toolExecutionHandler({
				toolName: "write",
				toolCallId: "close-execution-b",
				input: {},
				assistantTimestamp: 1,
			})
			.then((value) => {
				executionBResolved = true;
				return value;
			});
		const resultA = runtimeA.controls.toolResultHandler({
			toolName: "write",
			toolCallId: "close-result-a",
			input: {},
			content: [],
			isError: false,
			assistantTimestamp: 1,
		});
		let resultBResolved = false;
		const resultB = runtimeB.controls
			.toolResultHandler({
				toolName: "write",
				toolCallId: "close-result-b",
				input: {},
				content: [],
				isError: false,
				assistantTimestamp: 1,
			})
			.then(() => {
				resultBResolved = true;
			});
		const executeA = runtimeA.hostTool.execute("close-execute-a", {});
		let executeBResolved = false;
		const executeB = runtimeB.hostTool.execute("close-execute-b", {}).then((value) => {
			executeBResolved = true;
			return value;
		});

		send({ id: "close-a", type: "close_runtime", runtimeId: "runtime-a" });
		await expect(executionA).resolves.toMatchObject({ action: "block" });
		await expect(resultA).rejects.toThrow("Runtime closed before the host recorded the tool result");
		await expect(executeA).rejects.toThrow("Runtime closed before the host tool completed");
		await sleep(20);
		expect(executionBResolved).toBe(false);
		expect(resultBResolved).toBe(false);
		expect(executeBResolved).toBe(false);

		const pendingB = parseOutputLines(rpcIo.outputLines).filter((record) => record.runtimeId === "runtime-b");
		const executionRequestB = pendingB.find((record) => record.toolCallId === "close-execution-b");
		const resultRequestB = pendingB.find((record) => record.toolCallId === "close-result-b");
		const executeRequestB = pendingB.find((record) => record.toolCallId === "close-execute-b");
		if (!executionRequestB || !resultRequestB || !executeRequestB)
			throw new Error("Runtime B requests were not emitted");
		send({
			type: "tool_execution_response",
			id: executionRequestB.id,
			runtimeId: "runtime-b",
			sessionId: runtimeB.session.sessionId,
			attemptId: runtimeB.session.attemptId,
			action: "allow",
		});
		send({
			type: "tool_result_response",
			id: resultRequestB.id,
			runtimeId: "runtime-b",
			sessionId: runtimeB.session.sessionId,
			attemptId: runtimeB.session.attemptId,
			status: "acknowledged",
		});
		send({
			type: "tool_execute_response",
			id: executeRequestB.id,
			runtimeId: "runtime-b",
			sessionId: runtimeB.session.sessionId,
			attemptId: runtimeB.session.attemptId,
			content: "ok",
		});
		await expect(executionB).resolves.toMatchObject({ action: "allow" });
		await expect(resultB).resolves.toBeUndefined();
		await expect(executeB).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
	});

	it("rejects malformed host tool responses instead of allowing or acknowledging them", async () => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		const siblings: Array<ReturnType<typeof createFakeRuntime>> = [];
		const defaultRuntime = createFakeRuntime("default-session", () => {
			const sibling = createFakeRuntime("malformed-session");
			siblings.push(sibling);
			return sibling;
		});
		void runRpcMode(defaultRuntime as never);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		const send = (command: Record<string, unknown>) => rpcIo.lineHandler!(JSON.stringify(command));
		send({ id: "open", type: "open_runtime", runtimeId: "runtime-malformed", cwd: process.cwd(), inMemory: true });
		await vi.waitFor(() => expect(siblings).toHaveLength(1));
		const runtime = siblings[0]!;
		send({
			id: "execution-on",
			type: "enable_tool_execution_interceptor",
			runtimeId: "runtime-malformed",
			enabled: true,
		});
		send({ id: "results-on", type: "enable_tool_results", runtimeId: "runtime-malformed", enabled: true });
		send({
			id: "tools",
			type: "register_tools",
			runtimeId: "runtime-malformed",
			tools: [{ name: "host_tool", description: "Host tool", inputSchema: { type: "object" } }],
		});
		await vi.waitFor(() => expect(runtime.hostTool.name).toBe("host_tool"));

		const execution = runtime.controls.toolExecutionHandler({
			toolName: "write",
			toolCallId: "malformed-execution",
			input: {},
			assistantTimestamp: 1,
		});
		const result = runtime.controls.toolResultHandler({
			toolName: "write",
			toolCallId: "malformed-result",
			input: {},
			content: [],
			isError: false,
			assistantTimestamp: 1,
		});
		const execute = runtime.hostTool.execute("malformed-execute", {});
		await vi.waitFor(() => {
			const requests = parseOutputLines(rpcIo.outputLines);
			expect(requests.some((record) => record.toolCallId === "malformed-execution")).toBe(true);
			expect(requests.some((record) => record.toolCallId === "malformed-result")).toBe(true);
			expect(requests.some((record) => record.toolCallId === "malformed-execute")).toBe(true);
		});
		const requests = parseOutputLines(rpcIo.outputLines);
		const route = {
			runtimeId: "runtime-malformed",
			sessionId: runtime.session.sessionId,
			attemptId: runtime.session.attemptId,
		};
		send({
			type: "tool_execution_response",
			id: requests.find((record) => record.toolCallId === "malformed-execution")!.id,
			...route,
			action: "unexpected",
		});
		send({
			type: "tool_result_response",
			id: requests.find((record) => record.toolCallId === "malformed-result")!.id,
			...route,
			status: "unexpected",
		});
		send({
			type: "tool_execute_response",
			id: requests.find((record) => record.toolCallId === "malformed-execute")!.id,
			...route,
			content: [{ type: "unknown" }],
		});

		await expect(execution).rejects.toThrow("invalid tool execution response");
		await expect(result).rejects.toThrow("invalid tool result response");
		await expect(execute).rejects.toThrow("invalid tool execute response");
	});

	it("emits the user persistence event only after canonical JSONL publication", async () => {
		const clientMutationId = "mutation-durable-1";
		const { lineHandler, getSessionFile, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 100,
			persistSession: true,
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "durable-1",
					type: "prompt",
					message: "Hello",
					clientMutationId,
				}),
			);

			let attemptId: string | undefined;
			await vi.waitFor(() => {
				attemptId = getStartedAttemptId(rpcIo.outputLines, "durable-1");
				expect(attemptId).toEqual(expect.any(String));
				const records = parseOutputLines(rpcIo.outputLines);
				expect(
					records.some(
						(record) =>
							record.type === "message_end" &&
							(record.message as { role?: string } | undefined)?.role === "user",
					),
				).toBe(true);
			});
			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				expect(records.some((record) => record.type === "pi_user_message_persisted")).toBe(true);
			});
			expect(existsSync(getSessionFile()!)).toBe(true);

			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				const persistedIndex = records.findIndex((record) => record.type === "pi_user_message_persisted");
				const settledIndex = records.findIndex((record) => record.type === "agent_settled");
				expect(persistedIndex).toBeGreaterThanOrEqual(0);
				expect(settledIndex).toBeGreaterThan(persistedIndex);

				const persistedEvent = records[persistedIndex];
				expect(persistedEvent).toMatchObject({
					type: "pi_user_message_persisted",
					clientMutationId,
					attemptId,
				});

				const sessionFile = getSessionFile();
				expect(sessionFile).toBe(persistedEvent.sessionFile);
				expect(sessionFile && existsSync(sessionFile)).toBe(true);
				const entries = readFileSync(sessionFile!, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Record<string, any>);
				expect(entries).toContainEqual(
					expect.objectContaining({
						type: "message",
						id: persistedEvent.entryId,
						message: expect.objectContaining({ role: "user", clientMutationId }),
					}),
				);
			});
		} finally {
			await cleanup();
		}
	});

	it("persists hidden interruption context immediately before the original user message", async () => {
		const clientMutationId = "mutation-interrupted-attempt";
		const { lineHandler, getSessionFile, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 100,
			persistSession: true,
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "interrupted-attempt",
					type: "prompt",
					message: "actual user text",
					clientMutationId,
					interruptedAttempt: true,
				}),
			);

			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				expect(
					records.some(
						(record) =>
							record.type === "pi_user_message_persisted" && record.clientMutationId === clientMutationId,
					),
				).toBe(true);

				const entries = readFileSync(getSessionFile()!, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Record<string, any>);
				const userIndex = entries.findIndex(
					(entry) => entry.type === "message" && entry.message?.clientMutationId === clientMutationId,
				);
				expect(userIndex).toBeGreaterThan(0);
				expect(entries[userIndex - 1]).toMatchObject({
					type: "custom_message",
					customType: "attempt_interrupted",
					display: false,
				});
				expect(entries[userIndex]).toMatchObject({
					type: "message",
					message: {
						role: "user",
						content: [{ type: "text", text: "actual user text" }],
						clientMutationId,
					},
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits persistence immediately when appending a user message to a published session", async () => {
		const { lineHandler, getSessionFile, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 100,
			persistSession: true,
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "published-1",
					type: "prompt",
					message: "First",
					clientMutationId: "mutation-first",
				}),
			);
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "agent_settled")).toBe(true);
			});

			rpcIo.outputLines = [];
			const clientMutationId = "mutation-existing-session";
			lineHandler(
				JSON.stringify({
					id: "published-2",
					type: "prompt",
					message: "Second",
					clientMutationId,
				}),
			);

			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				const persistedIndex = records.findIndex(
					(record) => record.type === "pi_user_message_persisted" && record.clientMutationId === clientMutationId,
				);
				const assistantStartIndex = records.findIndex(
					(record) =>
						record.type === "message_start" &&
						(record.message as { role?: string } | undefined)?.role === "assistant",
				);
				expect(persistedIndex).toBeGreaterThanOrEqual(0);
				expect(assistantStartIndex === -1 || persistedIndex < assistantStartIndex).toBe(true);

				const entries = readFileSync(getSessionFile()!, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Record<string, any>);
				expect(entries).toContainEqual(
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({ role: "user", clientMutationId }),
					}),
				);
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			let attemptId: string | undefined;
			await vi.waitFor(() => {
				attemptId = getStartedAttemptId(rpcIo.outputLines, "b3-start");
				expect(attemptId).toEqual(expect.any(String));
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
					data: { status: "queued", attemptId },
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("withdraws one Pi-owned queued message by client mutation id", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 150 });

		try {
			lineHandler(JSON.stringify({ id: "withdraw-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(getStartedAttemptId(rpcIo.outputLines, "withdraw-start")).toEqual(expect.any(String)));

			lineHandler(JSON.stringify({
				id: "withdraw-follow-up",
				type: "follow_up",
				message: "Remove only this",
				clientMutationId: "mutation-withdraw-1",
			}));
			await vi.waitFor(() => expect(rpcIo.outputLines.some((line) => line.includes('"id":"withdraw-follow-up"'))).toBe(true));

			lineHandler(JSON.stringify({
				id: "withdraw-command",
				type: "withdraw_queued",
				clientMutationId: "mutation-withdraw-1",
			}));
			await vi.waitFor(() => {
				const response = rpcIo.outputLines.map(line => JSON.parse(line)).find(record => record.id === "withdraw-command");
				expect(response).toMatchObject({ success: true, data: { status: "removed" } });
			});
		} finally {
			await cleanup();
		}
	});

	it("accepts steering into the active Pi Attempt without a host-issued identity", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "active-start", type: "prompt", message: "Start" }));
			let attemptId: string | undefined;
			await vi.waitFor(() => {
				attemptId = getStartedAttemptId(rpcIo.outputLines, "active-start");
				expect(attemptId).toEqual(expect.any(String));
			});

			lineHandler(JSON.stringify({ id: "active-steer", type: "steer", message: "Use this direction" }));

			await vi.waitFor(() => {
				expect(getCommandResponses(rpcIo.outputLines, "active-steer", "steer")).toEqual([
					expect.objectContaining({
						success: true,
						data: { status: "accepted", attemptId },
					}),
				]);
			});
		} finally {
			await cleanup();
		}
	});

	it("settles a handled host prompt without emitting an Agent Loop", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});

		try {
			lineHandler(
				JSON.stringify({
					id: "handled-prompt",
					type: "prompt",
					message: "Handled",
				}),
			);

			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				const attemptId = getStartedAttemptId(rpcIo.outputLines, "handled-prompt");
				expect(attemptId).toEqual(expect.any(String));
				expect(records).toContainEqual(
					expect.objectContaining({ type: "agent_settled", attemptId }),
				);
				expect(records.some((record) => record.type === "agent_start")).toBe(false);
			});
		} finally {
			await cleanup();
		}
	});
});
