import { describe, expect, it, vi } from "vitest";
import { PiRuntimeHandle, RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }, timeoutMs?: number) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

type RpcClientInternals = {
	process: { stdin: { destroyed: boolean; writable: boolean; write: (line: string) => void } };
	toolExecutor: (request: unknown) => Promise<unknown>;
	handleLine: (line: string) => void;
};

function emitAgentEnd(internals: RpcClientInternals, runtimeId?: string): void {
	internals.handleLine(
		JSON.stringify({
			type: "agent_end",
			messages: [],
			willRetry: true,
			...(runtimeId ? { runtimeId } : {}),
		}),
	);
}

function emitAgentSettled(internals: RpcClientInternals, runtimeId?: string): void {
	internals.handleLine(JSON.stringify({ type: "agent_settled", ...(runtimeId ? { runtimeId } : {}) }));
}

describe("RpcClient clone", () => {
	it("forwards clientMutationId in prompt metadata", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({ type: "response", command: "prompt", success: true }));
		privateClient.send = send;

		await client.prompt("hello", undefined, {
			systemPrompt: "host prompt",
			clearSystemPrompt: false,
			clientMutationId: "mutation-1",
			attachments: [{ id: "att-1", name: "photo.png", mediaType: "image/png", size: 42 }],
		});

		expect(send).toHaveBeenCalledWith({
			type: "prompt",
			message: "hello",
			images: undefined,
			systemPrompt: "host prompt",
			clearSystemPrompt: false,
			clientMutationId: "mutation-1",
			attachments: [{ id: "att-1", name: "photo.png", mediaType: "image/png", size: 42 }],
		});

		await client.steer("mid-stream", undefined, { clientMutationId: "mutation-2" });
		expect(send).toHaveBeenLastCalledWith({
			type: "steer",
			message: "mid-stream",
			images: undefined,
			clientMutationId: "mutation-2",
		});
	});

	it("sends the clone RPC command", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "clone",
			success: true,
			data: { cancelled: false },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return (response as { data: T }).data;
		};

		const result = await client.clone();

		expect(send).toHaveBeenCalledWith({ type: "clone" });
		expect(result).toEqual({ cancelled: false });
	});
});

describe("RpcClient logical settlement", () => {
	it("waitForIdle ignores retrying agent_end and resolves on agent_settled", async () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		let settled = false;
		const waiting = client.waitForIdle().then(() => {
			settled = true;
		});

		emitAgentEnd(internals);
		await Promise.resolve();
		expect(settled).toBe(false);

		emitAgentSettled(internals);
		await waiting;
		expect(settled).toBe(true);
	});

	it("collectEvents retains intermediate agent_end events through agent_settled", async () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		const collecting = client.collectEvents();

		emitAgentEnd(internals);
		emitAgentSettled(internals);

		await expect(collecting).resolves.toEqual([
			expect.objectContaining({ type: "agent_end", willRetry: true }),
			expect.objectContaining({ type: "agent_settled" }),
		]);
	});
});

describe("RpcClient Pi shell API methods", () => {
	function mockClient(response: unknown): { client: RpcClient; send: ReturnType<typeof vi.fn> } {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => response);
		privateClient.send = send;
		privateClient.getData = <T>(rpcResponse: unknown): T => {
			return (rpcResponse as { data: T }).data;
		};
		return { client, send };
	}

	it("sends get_capabilities and returns protocol capabilities", async () => {
		const { client, send } = mockClient({
			type: "response",
			command: "get_capabilities",
			success: true,
			data: {
				protocolVersion: 2,
				packageVersion: "0.0.0-test",
				commands: ["get_capabilities", "query_llm"],
				features: {
					hostHooksModule: true,
					legacyFetchInterceptorModule: true,
					toolExecutionMetadata: true,
					hostToolResults: "content",
					extensionCommandResult: true,
					secondaryLlmQuery: true,
					childSessionListing: true,
				},
				hostHooks: {
					moduleEnv: "PI_HOST_HOOKS_MODULE",
					legacyModuleEnv: "PI_FETCH_INTERCEPTOR_MODULE",
					exports: ["fetchInterceptor"],
				},
			},
		});

		await expect(client.getCapabilities()).resolves.toMatchObject({
			protocolVersion: 2,
			commands: ["get_capabilities", "query_llm"],
		});
		expect(send).toHaveBeenCalledWith({ type: "get_capabilities" });
	});

	it("sends run_mini_completion with secondary LLM timeout", async () => {
		const { client, send } = mockClient({
			type: "response",
			command: "run_mini_completion",
			success: true,
			data: { text: "title" },
		});

		await expect(client.runMiniCompletion("summarize")).resolves.toBe("title");
		expect(send).toHaveBeenCalledWith({ type: "run_mini_completion", prompt: "summarize" }, 120000);
	});

	it("sends query_llm with secondary LLM timeout", async () => {
		const { client, send } = mockClient({
			type: "response",
			command: "query_llm",
			success: true,
			data: { text: "answer", model: "gpt-test" },
		});

		await expect(client.queryLlm({ prompt: "hi", maxTokens: 64 })).resolves.toEqual({
			text: "answer",
			model: "gpt-test",
		});
		expect(send).toHaveBeenCalledWith({ type: "query_llm", request: { prompt: "hi", maxTokens: 64 } }, 120000);
	});

	it("sends list_child_sessions and returns sessions", async () => {
		const { client, send } = mockClient({
			type: "response",
			command: "list_child_sessions",
			success: true,
			data: { sessions: [{ id: "child", path: "child.jsonl", cwd: "E:/project", spawnedFrom: "parent" }] },
		});

		await expect(client.listChildSessions("parent")).resolves.toEqual([
			{ id: "child", path: "child.jsonl", cwd: "E:/project", spawnedFrom: "parent" },
		]);
		expect(send).toHaveBeenCalledWith({ type: "list_child_sessions", parentSessionId: "parent" });
	});

	it("sends invoke_extension_command and returns ack", async () => {
		const { client, send } = mockClient({
			type: "response",
			command: "invoke_extension_command",
			success: true,
			data: { invoked: true },
		});

		await expect(client.invokeExtensionCommand("prompt-automation", "[{}]")).resolves.toBe(true);
		await expect(client.invokeExtensionCommandResult("prompt-automation", "[{}]")).resolves.toEqual({
			invoked: true,
		});
		expect(send).toHaveBeenCalledWith({
			type: "invoke_extension_command",
			commandId: "prompt-automation",
			args: "[{}]",
		});
	});

	it("routes contribution actions with an expected extension owner", async () => {
		const { client, send } = mockClient({
			type: "response",
			command: "invoke_extension_command",
			success: true,
			data: { invoked: true },
		});

		await expect(client.invokeExtensionCommandResult("status-open", undefined, "status-extension")).resolves.toEqual({
			invoked: true,
		});
		expect(send).toHaveBeenCalledWith({
			type: "invoke_extension_command",
			commandId: "status-open",
			args: undefined,
			ownerExtensionId: "status-extension",
		});
	});

	it("forwards structured host tool results to the RPC subprocess", async () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		const write = vi.fn();
		internals.process = {
			stdin: {
				destroyed: false,
				writable: true,
				write,
			},
		};
		internals.toolExecutor = vi.fn(async () => ({
			content: [{ type: "text", text: "done" }],
			details: { diff: "+done" },
			isError: false,
			terminate: true,
		}));

		internals.handleLine(
			JSON.stringify({
				type: "tool_execute_request",
				id: "exec-1",
				toolName: "mcp__session__example",
				toolCallId: "tool-1",
				input: { value: 1 },
			}),
		);

		await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
		expect(JSON.parse(write.mock.calls[0][0])).toEqual({
			type: "tool_execute_response",
			id: "exec-1",
			content: [{ type: "text", text: "done" }],
			details: { diff: "+done" },
			isError: false,
			terminate: true,
		});
	});
});

describe("PiRuntimeHandle", () => {
	it("waitForIdle ignores retrying agent_end and resolves on runtime agent_settled", async () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		const handle = new PiRuntimeHandle(client, {
			runtimeId: "runtime-a",
			cwd: "E:/project",
			sessionId: "session-a",
			isStreaming: true,
		});
		let settled = false;
		const waiting = handle.waitForIdle().then(() => {
			settled = true;
		});

		emitAgentEnd(internals, "runtime-a");
		emitAgentSettled(internals, "runtime-b");
		await Promise.resolve();
		expect(settled).toBe(false);

		emitAgentSettled(internals, "runtime-a");
		await waiting;
		expect(settled).toBe(true);
	});

	it("collectEvents retains intermediate runtime agent_end through agent_settled", async () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		const handle = new PiRuntimeHandle(client, {
			runtimeId: "runtime-a",
			cwd: "E:/project",
			sessionId: "session-a",
			isStreaming: true,
		});
		const collecting = handle.collectEvents();

		emitAgentEnd(internals, "runtime-a");
		emitAgentSettled(internals, "runtime-a");

		await expect(collecting).resolves.toEqual([
			expect.objectContaining({ type: "agent_end", willRetry: true, runtimeId: "runtime-a" }),
			expect.objectContaining({ type: "agent_settled", runtimeId: "runtime-a" }),
		]);
	});

	it("sends structured interaction responses through the runtime envelope", () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		const write = vi.fn();
		internals.process = { stdin: { destroyed: false, writable: true, write } };
		const handle = new PiRuntimeHandle(client, {
			runtimeId: "runtime-a",
			cwd: "E:/project",
			sessionId: "session-a",
			isStreaming: false,
		});

		handle.respondToExtensionUI({
			type: "extension_ui_response",
			id: "interaction-1",
			extensionId: "ask-user",
			interaction: {
				schemaVersion: 1,
				status: "submitted",
				answers: [{ fieldId: "topic", kind: "text", value: "RPC" }],
			},
		});

		expect(JSON.parse(write.mock.calls[0][0])).toEqual({
			type: "extension_ui_response",
			id: "interaction-1",
			extensionId: "ask-user",
			interaction: {
				schemaVersion: 1,
				status: "submitted",
				answers: [{ fieldId: "topic", kind: "text", value: "RPC" }],
			},
			runtimeId: "runtime-a",
			sessionId: "session-a",
		});
	});

	it("routes interaction cancellation as a client event", () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		const listener = vi.fn();
		client.onClientEvent(listener);

		internals.handleLine(
			JSON.stringify({
				type: "extension_ui_cancel",
				id: "interaction-1",
				extensionId: "ask-user",
				schemaVersion: 1,
				reason: "runtime-disposed",
				runtimeId: "runtime-a",
			}),
		);

		expect(listener).toHaveBeenCalledWith({
			type: "extension_ui_cancel",
			id: "interaction-1",
			extensionId: "ask-user",
			schemaVersion: 1,
			reason: "runtime-disposed",
			runtimeId: "runtime-a",
		});
	});

	it("sends host capability responses through the runtime envelope", () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		const write = vi.fn();
		internals.process = { stdin: { destroyed: false, writable: true, write } };
		const handle = new PiRuntimeHandle(client, {
			runtimeId: "runtime-a",
			cwd: "E:/project",
			sessionId: "session-a",
			isStreaming: false,
		});

		handle.respondToExtensionHostCapability({
			type: "extension_host_capability_response",
			version: 1,
			id: "cap-1",
			status: "success",
			output: { shown: true },
		});

		expect(JSON.parse(write.mock.calls[0][0])).toEqual({
			type: "extension_host_capability_response",
			version: 1,
			id: "cap-1",
			status: "success",
			output: { shown: true },
			runtimeId: "runtime-a",
			sessionId: "session-a",
		});
	});

	it("scopes commands to its runtime without owning another process", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async (command: { type: string; runtimeId?: string }) => ({
			type: "response",
			command: command.type,
			success: true,
			data:
				command.type === "open_runtime"
					? { runtimeId: command.runtimeId, cwd: "E:/project", sessionId: "session-a", isStreaming: false }
					: { sessionId: "session-a", thinkingLevel: "off" },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => (response as { data: T }).data;

		const handle = await client.openRuntime({ runtimeId: "runtime-a", cwd: "E:/project", extensionTarget: "pi", inMemory: true });
		await handle.getState();

		expect(handle.runtimeId).toBe("runtime-a");
		expect(send).toHaveBeenNthCalledWith(1, {
			type: "open_runtime",
			runtimeId: "runtime-a",
			cwd: "E:/project",
			extensionTarget: "pi",
			inMemory: true,
		});
		expect(send).toHaveBeenNthCalledWith(2, { type: "get_state", runtimeId: "runtime-a" }, undefined);
	});

	it("filters shared transport events by runtimeId", () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		const first = new PiRuntimeHandle(client, {
			runtimeId: "runtime-a",
			cwd: "E:/project",
			sessionId: "session-a",
			isStreaming: false,
		});
		const second = new PiRuntimeHandle(client, {
			runtimeId: "runtime-b",
			cwd: "E:/project",
			sessionId: "session-b",
			isStreaming: false,
		});
		const firstEvents = vi.fn();
		const secondEvents = vi.fn();
		first.onEvent(firstEvents);
		second.onEvent(secondEvents);

		internals.handleLine(JSON.stringify({ type: "agent_start", runtimeId: "runtime-a" }));
		internals.handleLine(JSON.stringify({ type: "agent_start", runtimeId: "runtime-b" }));

		expect(firstEvents).toHaveBeenCalledTimes(1);
		expect(firstEvents).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "runtime-a" }));
		expect(secondEvents).toHaveBeenCalledTimes(1);
		expect(secondEvents).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "runtime-b" }));
	});
});
