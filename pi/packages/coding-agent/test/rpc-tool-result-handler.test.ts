import { describe, expect, it, vi } from "vitest";
import { RpcClient, type RpcToolResultHandler } from "../src/modes/rpc/rpc-client.ts";
import type { RpcResponse, RpcToolResultRequest, RpcToolResultResponse } from "../src/modes/rpc/rpc-types.ts";

type RpcClientInternals = {
	toolResultHandler: RpcToolResultHandler | null;
	runtimeToolResultHandlers: Map<string, RpcToolResultHandler>;
	handleLine(line: string): void;
	getWritableInput(): { destroyed: boolean; writable: boolean; write(chunk: string): void };
	send(command: unknown): Promise<RpcResponse>;
};

function request(runtimeId: string, id: string): RpcToolResultRequest {
	return {
		type: "tool_result_request",
		id,
		clientId: "client-1",
		runtimeId,
		sessionId: `session-${runtimeId}`,
		toolName: "write",
		toolCallId: `call-${runtimeId}`,
		input: { path: `${runtimeId}.txt` },
		content: [{ type: "text", text: "ok" }],
		details: { changed: true },
		isError: false,
		assistantResponseId: `response-${runtimeId}`,
		assistantTimestamp: 1234,
	};
}

describe("RpcClient finalized tool result routing", () => {
	it("isolates runtime handlers and removes the closed runtime handler", async () => {
		const client = new RpcClient();
		const internals = client as unknown as RpcClientInternals;
		const responses: RpcToolResultResponse[] = [];
		const calls: string[] = [];
		internals.toolResultHandler = async (event) => {
			calls.push(`global:${event.toolCallId}`);
		};
		internals.getWritableInput = () => ({
			destroyed: false,
			writable: true,
			write: (chunk) => responses.push(JSON.parse(chunk) as RpcToolResultResponse),
		});
		internals.runtimeToolResultHandlers.set("runtime-a", async (event) => {
			calls.push(`a:${event.toolCallId}`);
		});
		internals.runtimeToolResultHandlers.set("runtime-b", async (event) => {
			calls.push(`b:${event.toolCallId}`);
			throw new Error("runtime-b ledger failed");
		});

		internals.handleLine(JSON.stringify(request("runtime-a", "result-a")));
		await vi.waitFor(() => expect(responses).toHaveLength(1));
		expect(calls).toEqual(["a:call-runtime-a"]);
		expect(responses[0]).toMatchObject({
			id: "result-a",
			status: "acknowledged",
			clientId: "client-1",
			runtimeId: "runtime-a",
			sessionId: "session-runtime-a",
		});

		internals.handleLine(JSON.stringify(request("runtime-b", "result-b")));
		await vi.waitFor(() => expect(responses).toHaveLength(2));
		expect(calls).toEqual(["a:call-runtime-a", "b:call-runtime-b"]);
		expect(responses[1]).toMatchObject({
			id: "result-b",
			status: "failed",
			runtimeId: "runtime-b",
			error: expect.stringContaining("runtime-b ledger failed"),
		});

		internals.send = async () =>
			({
				type: "response",
				command: "close_runtime",
				success: true,
				data: { closed: true },
			}) as RpcResponse;
		await client.closeRuntime("runtime-a");
		expect(internals.runtimeToolResultHandlers.has("runtime-a")).toBe(false);
		expect(internals.runtimeToolResultHandlers.has("runtime-b")).toBe(true);

		internals.handleLine(JSON.stringify(request("runtime-a", "result-a-after-close")));
		await vi.waitFor(() => expect(responses).toHaveLength(3));
		expect(calls).toEqual(["a:call-runtime-a", "b:call-runtime-b"]);
		expect(responses[2]).toMatchObject({ id: "result-a-after-close", status: "acknowledged" });
	});
});
