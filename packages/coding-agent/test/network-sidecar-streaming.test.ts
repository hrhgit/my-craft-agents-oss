import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { TransportError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getPackageDir } from "../src/config.ts";
import { SidecarManager } from "../src/core/network-sidecar.ts";
import type { EffectiveNetworkSettings, NetworkRequestContext } from "../src/core/network-types.ts";

function createTestSettings(): EffectiveNetworkSettings {
	return {
		mode: "proxy",
		proxy: {
			enabled: true,
			candidates: ["http://127.0.0.1:7890"],
			probeTimeoutMs: 500,
			statusCacheMs: 15_000,
		},
		sidecar: {
			enabled: true,
			binaryPath: "",
			restartBackoffMs: 2_000,
			healthCheckIntervalMs: 15_000,
		},
		bypass: {
			hosts: ["localhost", "127.0.0.1", "::1", "*.local"],
			cidrs: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
		},
		routeRules: [],
		timeouts: {
			connectMs: 15_000,
			tlsMs: 15_000,
			responseHeaderTimeoutMs: 60_000,
			idleStreamMs: 90_000,
			totalMs: 300_000,
		},
		retry: {
			maxAttempts: 2,
			baseDelayMs: 500,
			maxDelayMs: 3_000,
			jitter: true,
		},
		circuitBreaker: {
			failureThreshold: 3,
			cooldownMs: 60_000,
		},
	};
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	server.close();
	await once(server, "close");
}

function createRequestContext(): NetworkRequestContext {
	return {
		requestId: "req-1",
		traceId: "trace-1",
		requestClass: "model_pre_first_byte",
		attempt: 1,
		host: "127.0.0.1",
		method: "GET",
		path: "sidecar",
		routeMode: "proxy",
		firstByteReceived: false,
		poolRebuilt: false,
		fallbackUsed: false,
		sidecarRequired: true,
		sidecarAvailable: true,
		sidecarProxyMode: "required",
		circuitState: "closed",
		startedAt: Date.now(),
	};
}

describe("SidecarManager streaming fetch", () => {
	const cleanup: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanup.length > 0) {
			await cleanup.pop()?.();
		}
	});

	it("streams SSE chunks through /v1/fetch before the upstream response ends", async () => {
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			if (req.url !== "/sse") {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write("event: message\ndata: one\n\n");
			setTimeout(() => {
				res.write("event: message\ndata: two\n\n");
				res.end();
			}, 1_000);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanup.push(() => closeServer(server));
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Expected TCP server address");
		}

		const sidecar = new SidecarManager(createTestSettings());
		cleanup.push(async () => {
			await sidecar.stop();
		});
		await sidecar.ensureStarted();
		const requestContext = createRequestContext();
		const sidecarFetch = sidecar.createFetch(requestContext, { totalTimeoutMs: 5_000, maxAttempts: 1 });

		const startedAt = performance.now();
		const response = await sidecarFetch(`http://127.0.0.1:${address.port}/sse`, {
			method: "GET",
			headers: { accept: "text/event-stream" },
		});
		const resolvedAtMs = performance.now() - startedAt;
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Expected readable response body");
		}
		const decoder = new TextDecoder();
		const first = await reader.read();
		const firstElapsedMs = performance.now() - startedAt;
		const firstText = decoder.decode(first.value ?? new Uint8Array(), { stream: true });
		const second = await reader.read();
		const secondElapsedMs = performance.now() - startedAt;
		const secondText = decoder.decode(second.value ?? new Uint8Array(), { stream: true });
		const done = await reader.read();

		expect(response.status).toBe(200);
		expect(resolvedAtMs).toBeLessThan(300);
		expect(first.done).toBe(false);
		expect(firstText).toContain("data: one");
		expect(firstText).not.toContain("data: two");
		expect(firstElapsedMs).toBeLessThan(300);
		expect(second.done).toBe(false);
		expect(secondText).toContain("data: two");
		expect(secondElapsedMs).toBeGreaterThanOrEqual(900);
		expect(done.done).toBe(true);
		expect(requestContext.transportOutcome).toMatchObject({
			owner: "sidecar",
			requestId: "req-1",
			traceId: "trace-1",
			responseStatus: 200,
			attemptCount: 1,
			retryCount: 0,
			streamingResponse: true,
			streamStarted: true,
			finalStatus: "success",
		});
	});

	it("records a structured idle-stream timeout outcome when streaming stalls", async () => {
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			if (req.url !== "/stall") {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write("event: message\ndata: one\n\n");
			setTimeout(() => {
				res.end();
			}, 10_000);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanup.push(() => closeServer(server));
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Expected TCP server address");
		}

		const sidecar = new SidecarManager(createTestSettings());
		cleanup.push(async () => {
			await sidecar.stop();
		});
		await sidecar.ensureStarted();
		const requestContext = createRequestContext();
		const sidecarFetch = sidecar.createFetch(requestContext, {
			totalTimeoutMs: 1_000,
			idleStreamTimeoutMs: 50,
			maxAttempts: 1,
		});
		const response = await sidecarFetch(`http://127.0.0.1:${address.port}/stall`, {
			method: "GET",
			headers: { accept: "text/event-stream" },
		});
		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("Expected readable response body");
		}

		const first = await reader.read();
		expect(first.done).toBe(false);
		const secondResult = await Promise.race([
			reader.read().then(
				(value) => ({ kind: "resolved" as const, value }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			),
			new Promise<{ kind: "timeout" }>((resolve) => {
				setTimeout(() => resolve({ kind: "timeout" }), 500);
			}),
		]);
		expect(secondResult.kind).toBe("rejected");
		if (secondResult.kind === "rejected") {
			expect(String(secondResult.error)).toMatch(/terminated|idle timeout/i);
		}
		expect(requestContext.transportOutcome).toMatchObject({
			owner: "sidecar",
			finalStatus: "stream_error",
			streamStarted: true,
			failureStage: "stream",
		});
	});

	it("returns a structured transport error outcome when the upstream connect fails", async () => {
		const sidecar = new SidecarManager(createTestSettings());
		cleanup.push(async () => {
			await sidecar.stop();
		});
		await sidecar.ensureStarted();
		const requestContext = createRequestContext();
		const sidecarFetch = sidecar.createFetch(requestContext, { totalTimeoutMs: 1_000, maxAttempts: 1 });

		const targetUrl = "http://127.0.0.1:1/unreachable";
		let thrown: unknown;
		try {
			await sidecarFetch(targetUrl, { method: "GET" });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TransportError);
		expect((thrown as TransportError).code).toBe("network_error");
		expect(requestContext.transportOutcome).toMatchObject({
			owner: "sidecar",
			requestId: "req-1",
			traceId: "trace-1",
			attemptCount: 1,
			retryCount: 0,
			streamingResponse: false,
			streamStarted: false,
			finalStatus: "transport_error",
			failureStage: "connect",
		});
	});

	it("fails required proxy requests before applying bypass rules", async () => {
		let directRequests = 0;
		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			directRequests += 1;
			if (req.url !== "/proxy-required") {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("should-not-direct");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		cleanup.push(() => closeServer(server));
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Expected TCP server address");
		}

		const settings = createTestSettings();
		settings.proxy = {
			enabled: true,
			candidates: [],
			probeTimeoutMs: 500,
			statusCacheMs: 15_000,
		};
		const sidecar = new SidecarManager(settings);
		cleanup.push(async () => {
			await sidecar.stop();
		});
		await sidecar.ensureStarted();
		const requestContext = createRequestContext();
		const sidecarFetch = sidecar.createFetch(requestContext, {
			totalTimeoutMs: 1_000,
			maxAttempts: 1,
			proxyMode: "required",
		});

		let thrown: unknown;
		try {
			await sidecarFetch(`http://127.0.0.1:${address.port}/proxy-required`, { method: "GET" });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TransportError);
		expect(String((thrown as TransportError).message)).toContain(
			"required proxy route has no configured proxy candidates",
		);
		expect(directRequests).toBe(0);
		expect(requestContext.transportOutcome).toMatchObject({
			owner: "sidecar",
			finalStatus: "transport_error",
			streamStarted: false,
		});
	});

	it("resolves bundled sidecar binary paths with packaged platform names", () => {
		const sidecar = new SidecarManager(createTestSettings());
		const expected = join(getPackageDir(), "sidecar", "bin", "windows-x64", "pi-network-sidecar.exe");
		const originalPlatform = process.platform;
		const originalArch = process.arch;

		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		Object.defineProperty(process, "arch", { configurable: true, value: "x64" });

		try {
			const getBundledBinaryCandidates = Reflect.get(sidecar as object, "getBundledBinaryCandidates") as
				| (() => string[])
				| undefined;
			expect(getBundledBinaryCandidates?.call(sidecar)).toEqual([expected]);
		} finally {
			Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			Object.defineProperty(process, "arch", { configurable: true, value: originalArch });
		}
	});
});
