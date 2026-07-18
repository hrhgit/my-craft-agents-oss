import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidecarManager } from "../src/core/network-sidecar.ts";
import type { EffectiveNetworkSettings, NetworkRequestContext } from "../src/core/network-types.ts";

const childProcessMock = vi.hoisted(() => {
	class SimpleEmitter {
		private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

		on(event: string, listener: (...args: unknown[]) => void): this {
			let listeners = this.listeners.get(event);
			if (!listeners) {
				listeners = new Set();
				this.listeners.set(event, listeners);
			}
			listeners.add(listener);
			return this;
		}

		once(event: string, listener: (...args: unknown[]) => void): this {
			const wrapper = (...args: unknown[]) => {
				this.removeListener(event, wrapper);
				listener(...args);
			};
			this.on(event, wrapper);
			return this;
		}

		emit(event: string, ...args: unknown[]): boolean {
			const listeners = this.listeners.get(event);
			if (!listeners || listeners.size === 0) {
				return false;
			}
			for (const listener of [...listeners]) {
				listener(...args);
			}
			return true;
		}

		removeListener(event: string, listener: (...args: unknown[]) => void): this {
			this.listeners.get(event)?.delete(listener);
			return this;
		}
	}

	class MockReadable extends SimpleEmitter {
		write(text: string): void {
			for (const line of text.split("\n")) {
				if (line.length > 0) {
					this.emit("line", line);
				}
			}
			this.emit("data", text);
		}

		close(): void {}

		destroy(): void {}
	}

	class MockChildProcess extends SimpleEmitter {
		stdout = new MockReadable();
		stderr = new MockReadable();
		exitCode: number | null = null;
		killed = false;

		kill(): boolean {
			this.killed = true;
			this.exitCode = 0;
			setTimeout(() => this.emit("exit", 0, null), 0);
			return true;
		}

		ready(port: number): void {
			this.stdout.write(`${JSON.stringify({ type: "ready", port })}\n`);
		}

		exitBeforeReady(): void {
			this.exitCode = 1;
			this.emit("exit", 1, null);
		}
	}

	const spawnedChildren: MockChildProcess[] = [];
	const spawnMock = vi.fn(() => {
		const child = new MockChildProcess();
		spawnedChildren.push(child);
		return child;
	});
	const createInterfaceMock = vi.fn((options: { input: MockReadable }) => options.input);
	return { createInterfaceMock, spawnMock, spawnedChildren };
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: childProcessMock.spawnMock,
	};
});

vi.mock("node:readline", () => ({
	createInterface: childProcessMock.createInterfaceMock,
}));

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
			binaryPath: "mock-sidecar",
			restartBackoffMs: 10,
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

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("SidecarManager lifecycle", () => {
	beforeEach(() => {
		childProcessMock.spawnMock.mockClear();
		childProcessMock.spawnedChildren.length = 0;
		vi.restoreAllMocks();
	});

	afterEach(() => {
		for (const child of childProcessMock.spawnedChildren) {
			child.stdout.destroy();
			child.stderr.destroy();
		}
		childProcessMock.spawnedChildren.length = 0;
	});

	it("shares one startup across concurrent ensureStarted calls", async () => {
		const sidecar = new SidecarManager(createTestSettings());
		const first = sidecar.ensureStarted();
		const second = sidecar.ensureStarted();

		await flushMicrotasks();
		expect(childProcessMock.spawnMock).toHaveBeenCalledTimes(1);
		childProcessMock.spawnedChildren[0].ready(45001);

		const [firstState, secondState] = await Promise.all([first, second]);

		expect(firstState).toMatchObject({ ready: true, port: 45001 });
		expect(secondState).toMatchObject({ ready: true, port: 45001 });
		await sidecar.stop();
	});

	it("shares one startup across concurrent createFetch calls", async () => {
		const sidecar = new SidecarManager(createTestSettings());
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		try {
			const sidecarFetch = sidecar.createFetch(createRequestContext(), { totalTimeoutMs: 1_000 });
			const first = sidecarFetch("https://api.example.com/test", { method: "POST", body: "{}" });
			const second = sidecarFetch("https://api.example.com/test", { method: "POST", body: "{}" });

			await flushMicrotasks();
			expect(childProcessMock.spawnMock).toHaveBeenCalledTimes(1);
			childProcessMock.spawnedChildren[0].ready(45002);

			const responses = await Promise.all([first, second]);

			expect(responses.map((response) => response.status)).toEqual([200, 200]);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.stubGlobal("fetch", originalFetch);
			await sidecar.stop();
		}
	});

	it("can start again after the child exits before ready", async () => {
		const sidecar = new SidecarManager(createTestSettings());
		const first = sidecar.ensureStarted();

		await flushMicrotasks();
		childProcessMock.spawnedChildren[0].exitBeforeReady();
		await expect(first).rejects.toThrow(/exited before ready/);

		const second = sidecar.ensureStarted();
		await flushMicrotasks();
		expect(childProcessMock.spawnMock).toHaveBeenCalledTimes(2);
		childProcessMock.spawnedChildren[1].ready(45003);

		await expect(second).resolves.toMatchObject({ ready: true, port: 45003 });
		await sidecar.stop();
	});

	it("does not let a stopped startup mark the sidecar ready", async () => {
		const sidecar = new SidecarManager(createTestSettings());
		const startup = sidecar.ensureStarted();
		const startupExpectation = expect(startup).rejects.toThrow(/superseded|exited before ready/);

		await flushMicrotasks();
		const child = childProcessMock.spawnedChildren[0];
		await sidecar.stop();
		child.ready(45004);

		await startupExpectation;
		expect(sidecar.getState().ready).toBe(false);
	});

	it("ignores old child exit events after a newer sidecar is ready", async () => {
		const sidecar = new SidecarManager(createTestSettings());
		const first = sidecar.ensureStarted();
		const firstExpectation = expect(first).rejects.toThrow(/superseded|exited before ready/);

		await flushMicrotasks();
		const oldChild = childProcessMock.spawnedChildren[0];
		await sidecar.stop();
		await firstExpectation;

		const second = sidecar.ensureStarted();
		await flushMicrotasks();
		childProcessMock.spawnedChildren[1].ready(45005);
		await expect(second).resolves.toMatchObject({ ready: true, port: 45005 });

		oldChild.emit("exit", 1, null);

		expect(sidecar.getState()).toMatchObject({ ready: true, port: 45005 });
		expect(childProcessMock.spawnMock).toHaveBeenCalledTimes(2);
		await sidecar.stop();
	});

	it("schedules a restart when the active ready child exits", async () => {
		vi.useFakeTimers();
		const sidecar = new SidecarManager(createTestSettings());
		try {
			const first = sidecar.ensureStarted();
			await flushMicrotasks();
			childProcessMock.spawnedChildren[0].ready(45006);
			await expect(first).resolves.toMatchObject({ ready: true, port: 45006 });

			childProcessMock.spawnedChildren[0].exitBeforeReady();
			expect(sidecar.getState()).toMatchObject({ ready: false, healthState: "down" });

			await vi.advanceTimersByTimeAsync(10);
			expect(childProcessMock.spawnMock).toHaveBeenCalledTimes(2);
			childProcessMock.spawnedChildren[1].ready(45007);
			await flushMicrotasks();

			expect(sidecar.getState()).toMatchObject({ ready: true, port: 45007 });
		} finally {
			vi.useRealTimers();
			await sidecar.stop();
		}
	});
});
