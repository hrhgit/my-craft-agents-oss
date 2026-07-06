import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string }, timeoutMs?: number) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

type RpcClientInternals = {
	process: { stdin: { destroyed: boolean; writable: boolean; write: (line: string) => void } };
	toolExecutor: (request: unknown) => Promise<unknown>;
	handleLine: (line: string) => void;
};

describe("RpcClient clone", () => {
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
