import type { AssistantMessageEvent, Context, Model } from "@mortise/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createContext(): Context {
	return {
		systemPrompt: "",
		messages: [],
		tools: [],
	};
}

function usage() {
	return {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function encodeChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

function delayedStream(chunks: string[], delayMs = 10): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			for (const chunk of chunks) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

function mockFetchResponse(body: ReadableStream<Uint8Array> | null, status = 200): void {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(body, {
			status,
			statusText: status === 200 ? "OK" : "Error",
		}),
	);
}

async function collectEvents(chunks: string[], options?: { signal?: AbortSignal }): Promise<AssistantMessageEvent[]> {
	mockFetchResponse(encodeChunks(chunks));
	const stream = streamProxy(createModel(), createContext(), {
		authToken: "test-token",
		proxyUrl: "https://proxy.example",
		signal: options?.signal,
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("streamProxy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses SSE events split across chunks", async () => {
		const done = JSON.stringify({ type: "done", reason: "stop", usage: usage() });
		const events = await collectEvents([
			'data: {"type":"start"}\n\n',
			'data: {"type":"text_start","contentIndex":0}\n\n',
			'data: {"type":"text_delta","contentIndex":0,"delta":"hel',
			'lo"}\n\n',
			'data: {"type":"text_end","contentIndex":0}\n\n',
			`data: ${done}\n\n`,
		]);

		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		const doneEvent = events.at(-1);
		expect(doneEvent?.type).toBe("done");
		if (doneEvent?.type !== "done") throw new Error("Expected done event");
		expect(doneEvent.message.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("handles CRLF, event metadata, comments, and a final event without trailing newline", async () => {
		const events = await collectEvents([
			": keepalive\r\n",
			"id: event-1\r\n",
			"event: proxy\r\n",
			'data: {"type":"start"}\r\n\r\n',
			": keepalive\r\n",
			"id: event-2\r\n",
			"event: proxy\r\n",
			`data: ${JSON.stringify({ type: "done", reason: "stop", usage: usage() })}`,
		]);

		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
	});

	it("parses a JSON event assembled from multiple SSE data lines", async () => {
		const events = await collectEvents([
			"data: {\n",
			'data: "type":"done",\n',
			'data: "reason":"stop",\n',
			`data: "usage":${JSON.stringify(usage())}\n`,
			"data: }\n\n",
		]);

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("done");
	});

	it("ignores empty data events and [DONE] sentinels", async () => {
		const events = await collectEvents([
			"data:\n\n",
			"data: [DONE]\n\n",
			`data: ${JSON.stringify({ type: "done", reason: "stop", usage: usage() })}\n\n`,
		]);

		expect(events.map((event) => event.type)).toEqual(["done"]);
	});

	it("turns malformed JSON into an error event", async () => {
		const events = await collectEvents(['data: {"type":"start"}\n\n', "data: not-json\n\n"]);

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		const errorEvent = events.at(-1);
		expect(errorEvent?.type).toBe("error");
		if (errorEvent?.type !== "error") throw new Error("Expected error event");
		expect(errorEvent.reason).toBe("error");
		expect(errorEvent.error.errorMessage).toContain("Unexpected token");
	});

	it("reports a missing response body as an error event", async () => {
		mockFetchResponse(null);
		const stream = streamProxy(createModel(), createContext(), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example",
		});

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		if (events[0].type !== "error") throw new Error("Expected error event");
		expect(events[0].error.errorMessage).toBe("Proxy stream response body is missing");
	});

	it("reports premature stream endings before a terminal event", async () => {
		const events = await collectEvents(['data: {"type":"start"}\n\n']);

		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		const errorEvent = events.at(-1);
		expect(errorEvent?.type).toBe("error");
		if (errorEvent?.type !== "error") throw new Error("Expected error event");
		expect(errorEvent.error.errorMessage).toBe("Proxy stream ended before terminal event");
	});

	it("turns aborts into aborted error events", async () => {
		const controller = new AbortController();
		mockFetchResponse(delayedStream(['data: {"type":"start"}\n\n'], 20));
		const stream = streamProxy(createModel(), createContext(), {
			authToken: "test-token",
			proxyUrl: "https://proxy.example",
			signal: controller.signal,
		});
		controller.abort("stop");

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		if (events[0].type !== "error") throw new Error("Expected error event");
		expect(events[0].reason).toBe("aborted");
	});
});
