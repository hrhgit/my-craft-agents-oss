import { describe, expect, it, vi } from "vitest";
import {
	classifyTransportError,
	formatTransportError,
	getTransportErrorCauseChain,
	getTransportSpecificCause,
	isRetryableTransportError,
	TransportError,
} from "../src/transport/errors.ts";
import { fetchWithHeaderTimeout } from "../src/transport/http.ts";
import { capRetryDelayMs, getRetryDelayMs, parseRetryAfterMs } from "../src/transport/retry.ts";
import { iterateSseMessages } from "../src/transport/sse.ts";
import {
	connectWebSocket,
	extractWebSocketCloseError,
	iterateWebSocketJsonMessages,
	type WebSocketListener,
} from "../src/transport/websocket.ts";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
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

describe("transport retry helpers", () => {
	it("parses retry-after-ms, retry-after seconds, and retry-after HTTP dates", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-13T00:00:00Z"));

		expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
		expect(parseRetryAfterMs(new Headers({ "retry-after": "60" }))).toBe(60_000);
		expect(parseRetryAfterMs(new Headers({ "retry-after": "Wed, 13 May 2026 00:00:45 GMT" }))).toBe(45_000);

		vi.useRealTimers();
	});

	it("caps retry delays with default, zero, and explicit maxRetryDelayMs", () => {
		expect(capRetryDelayMs(90_000)).toBe(60_000);
		expect(capRetryDelayMs(90_000, 0)).toBe(90_000);
		expect(capRetryDelayMs(90_000, 2_000)).toBe(2_000);
		expect(
			getRetryDelayMs({
				attempt: 0,
				status: 429,
				headers: new Headers({ "retry-after-ms": "5000" }),
				maxRetryDelayMs: 1000,
			}),
		).toBe(1000);
	});
});

describe("transport SSE parser", () => {
	it("supports multi-line data, comments, and half-frame buffering", async () => {
		const events = [];
		for await (const event of iterateSseMessages(
			sseStream([": keepalive\r\n", "event: update\r\ndata: one\r\ndata: two\r\n\r", "\n", "data: trailing"]),
		)) {
			events.push(event);
		}

		expect(events).toEqual([
			{ event: "update", data: "one\ntwo", raw: [": keepalive", "event: update", "data: one", "data: two"] },
			{ event: null, data: "trailing", raw: ["data: trailing"] },
		]);
	});
});

describe("transport fetch helpers", () => {
	it("uses the injected fetch implementation for header-timeout requests", async () => {
		const calls: string[] = [];
		const injectedFetch: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			calls.push(`${request.method} ${request.url}`);
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithHeaderTimeout(
			"https://api.example.test/v1/messages",
			{ method: "POST", body: "{}" },
			{ fetch: injectedFetch },
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toEqual(["POST https://api.example.test/v1/messages"]);
	});
});

describe("transport websocket helpers", () => {
	it("classifies close codes including message-too-big", () => {
		const error = extractWebSocketCloseError({ code: 1009, wasClean: false });
		const transportError = classifyTransportError(error);

		expect(error.message).toBe("WebSocket closed 1009 message too big");
		expect(transportError.code).toBe("websocket_closed");
		expect(isRetryableTransportError(transportError)).toBe(true);
	});

	it("classifies connect timeout", async () => {
		vi.useFakeTimers();
		class MockWebSocket {
			addEventListener(): void {}
			removeEventListener(): void {}
			send(): void {}
			close(): void {}
		}

		const assertion = expect(
			connectWebSocket({
				url: "wss://example.test",
				connectTimeoutMs: 50,
				getConstructor: () => MockWebSocket,
			}),
		).rejects.toMatchObject({
			code: "timeout",
			phase: "websocket_connect",
			message: "WebSocket connect timeout after 50ms",
		});
		await vi.advanceTimersByTimeAsync(50);

		await assertion;
		vi.useRealTimers();
	});

	it("classifies websocket idle timeout", async () => {
		vi.useFakeTimers();
		class MockWebSocket {
			private listeners = new Map<string, Set<WebSocketListener>>();

			addEventListener(type: string, listener: WebSocketListener): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: WebSocketListener): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(): void {}
			close(): void {}
		}

		const socket = new MockWebSocket();
		const iterator = iterateWebSocketJsonMessages(socket, {
			idleTimeoutMs: 25,
			isTerminalEvent: () => false,
		});
		const assertion = expect(iterator.next()).rejects.toMatchObject({
			code: "idle_timeout",
			phase: "websocket_stream",
			message: "WebSocket idle timeout after 25ms",
		});
		await vi.advanceTimersByTimeAsync(25);

		await assertion;
		vi.useRealTimers();
	});

	it("maps aborts to non-retryable aborted errors", () => {
		const error = classifyTransportError(new DOMException("The operation was aborted.", "AbortError"));
		const explicit = new TransportError({ code: "aborted", message: "Request was aborted" });

		expect(error.code).toBe("aborted");
		expect(error.retryable).toBe(false);
		expect(isRetryableTransportError(explicit)).toBe(false);
	});

	it("surfaces specific cause details for generic connection errors", () => {
		const rootCause = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), {
			code: "ENOTFOUND",
			errno: "ENOTFOUND",
			syscall: "getaddrinfo",
			hostname: "api.example.test",
		});
		const wrapped = Object.assign(new Error("Connection error."), { cause: rootCause });

		const error = classifyTransportError(wrapped, { phase: "sdk" });
		const specificCause = getTransportSpecificCause(wrapped);
		const causeChain = getTransportErrorCauseChain(wrapped);

		expect(error.code).toBe("network_error");
		expect(error.message).toContain("Connection error.");
		expect(error.message).toContain("ENOTFOUND");
		expect(error.message).toContain("api.example.test");
		expect(formatTransportError(wrapped, "OpenAI API error")).toContain("OpenAI API error:");
		expect(specificCause).toMatchObject({
			code: "ENOTFOUND",
			hostname: "api.example.test",
			syscall: "getaddrinfo",
		});
		expect(causeChain).toHaveLength(2);
		expect(causeChain[1]).toMatchObject({
			code: "ENOTFOUND",
			hostname: "api.example.test",
		});
	});

	it("extracts HTTP status text from response-like causes", () => {
		const responseLike = {
			status: 503,
			statusText: "Service Unavailable",
		};
		const wrapped = Object.assign(new Error("Connection error."), { cause: responseLike });
		const error = classifyTransportError(wrapped, { phase: "sdk" });

		expect(error.code).toBe("server_error");
		expect(error.status).toBe(503);
		expect(error.message).toContain("503 Service Unavailable");
	});
});
