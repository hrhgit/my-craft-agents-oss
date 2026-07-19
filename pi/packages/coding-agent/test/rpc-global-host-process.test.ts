import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPiGlobalHostState } from "../src/core/global-host-state.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

describe("Pi RPC GlobalHost process", () => {
	const roots: string[] = [];
	const clients: RpcClient[] = [];
	const hostPids: number[] = [];

	afterEach(async () => {
		await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
		for (const pid of hostPids.splice(0)) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
			let alive = true;
			for (let attempt = 0; attempt < 20; attempt++) {
				try {
					process.kill(pid, 0);
					await new Promise((resolve) => setTimeout(resolve, 50));
				} catch {
					alive = false;
					break;
				}
			}
			if (alive) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		for (const root of roots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it("connects a second client to the first host while isolating runtime ownership", async () => {
		const root = join(tmpdir(), `pi-global-host-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = process.cwd();
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "models.json"),
			JSON.stringify({
				providers: {
					test: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [{ id: "model-a" }],
					},
				},
			}),
			"utf8",
		);
		roots.push(root);
		const options = {
			command: process.execPath,
			cliPath: join(process.cwd(), "dist", "cli.js"),
			cwd,
			provider: "test",
			model: "model-a",
			args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"],
			env: { PI_CODING_AGENT_DIR: root },
			globalHost: { enabled: true, agentDir: root },
			pipeStderr: false,
		};

		const first = new RpcClient(options);
		clients.push(first);
		await first.start();
		await expect(first.getCapabilities()).resolves.toMatchObject({ protocolVersion: 3 });
		const hostState = readPiGlobalHostState(root);
		expect(hostState?.pid).toBeDefined();
		if (hostState) hostPids.push(hostState.pid);

		const second = new RpcClient(options);
		clients.push(second);
		await second.start();
		await expect(second.listRuntimes()).resolves.toEqual([]);
		const firstRuntime = await first.openRuntime({
			runtimeId: "runtime-a",
			cwd,
			sessionId: "session-a",
			extensionTarget: "pi",
		});
		const secondRuntime = await second.openRuntime({
			runtimeId: "runtime-b",
			cwd,
			sessionId: "session-b",
			extensionTarget: "pi",
		});

		const runtimes = await second.listRuntimes();
		expect(runtimes.map((runtime) => runtime.runtimeId)).toEqual(["runtime-b"]);
		expect((await first.listRuntimes()).map((runtime) => runtime.runtimeId)).toEqual(["runtime-a"]);
		expect(readPiGlobalHostState(root)?.pid).toBe(hostState?.pid);
		expect((second as unknown as { process: unknown }).process).toBeNull();

		const performanceHandles = [];
		const durations: number[] = [];
		for (let index = 0; index < 20; index++) {
			const startedAt = performance.now();
			performanceHandles.push(
				await second.openRuntime({
					runtimeId: `perf-${index}`,
					cwd,
					sessionId: `perf-session-${index}`,
					extensionTarget: "pi",
				}),
			);
			durations.push(performance.now() - startedAt);
		}
		const sortedDurations = [...durations].sort((left, right) => left - right);
		const p95 = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
		expect(p95).toBeLessThanOrEqual(750);

		await firstRuntime.close();
		await secondRuntime.close();
		await Promise.all(performanceHandles.map((handle) => handle.close()));

		if (!hostState) throw new Error("GlobalHost state was not written");
		process.kill(hostState.pid, "SIGTERM");
		for (let attempt = 0; attempt < 40; attempt++) {
			const currentState = readPiGlobalHostState(root);
			if (!currentState || currentState.pid !== hostState.pid) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		const restarted = new RpcClient(options);
		clients.push(restarted);
		await restarted.start();
		await expect(restarted.listRuntimes()).resolves.toEqual([]);
		const restartedState = readPiGlobalHostState(root);
		expect(restartedState?.pid).toBeDefined();
		expect(restartedState?.pid).not.toBe(hostState.pid);
		if (restartedState) hostPids.push(restartedState.pid);
	});

	it("isolates host generations that share one agent directory", async () => {
		const root = join(tmpdir(), `pi-global-host-generation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = process.cwd();
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "models.json"),
			JSON.stringify({
				providers: {
					test: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [{ id: "model-a" }],
					},
				},
			}),
			"utf8",
		);
		roots.push(root);

		const commonOptions = {
			command: process.execPath,
			cliPath: join(process.cwd(), "dist", "cli.js"),
			cwd,
			provider: "test",
			model: "model-a",
			args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"],
			env: { PI_CODING_AGENT_DIR: root },
			pipeStderr: false,
		};
		const firstInstanceId = "config-generation-a";
		const secondInstanceId = "config-generation-b";
		const first = new RpcClient({
			...commonOptions,
			globalHost: { enabled: true, agentDir: root, instanceId: firstInstanceId },
		});
		clients.push(first);
		await first.start();
		await expect(first.getCapabilities()).resolves.toMatchObject({ protocolVersion: 3 });
		const firstState = readPiGlobalHostState(root, firstInstanceId);
		expect(firstState?.instanceId).toBe(firstInstanceId);
		if (firstState) hostPids.push(firstState.pid);
		const firstRuntime = await first.openRuntime({
			runtimeId: "runtime-a",
			cwd,
			sessionId: "session-a",
			extensionTarget: "pi",
		});

		const second = new RpcClient({
			...commonOptions,
			globalHost: { enabled: true, agentDir: root, instanceId: secondInstanceId },
		});
		clients.push(second);
		await second.start();
		await expect(second.getCapabilities()).resolves.toMatchObject({ protocolVersion: 3 });
		const secondState = readPiGlobalHostState(root, secondInstanceId);
		expect(secondState?.instanceId).toBe(secondInstanceId);
		expect(secondState?.pid).not.toBe(firstState?.pid);
		if (secondState) hostPids.push(secondState.pid);
		expect(await first.listRuntimes()).toEqual([
			expect.objectContaining({ runtimeId: "runtime-a", sessionId: "session-a" }),
		]);
		await expect(second.listRuntimes()).resolves.toEqual([]);

		await firstRuntime.close();
	});

	it("loads runtime-scoped extensionPaths in the shared host", async () => {
		const root = join(tmpdir(), `pi-global-host-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const extensionPath = join(root, "runtime-extension.js");
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "models.json"),
			JSON.stringify({
				providers: {
					test: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [{ id: "model-a" }],
					},
				},
			}),
			"utf8",
		);
		writeFileSync(
			extensionPath,
			`export default function(pi) {
	pi.registerCommand("runtime-extension-loaded", { handler: async () => {} });
}`,
			"utf8",
		);
		roots.push(root);

		const client = new RpcClient({
			command: process.execPath,
			cliPath: join(process.cwd(), "dist", "cli.js"),
			cwd: process.cwd(),
			provider: "test",
			model: "model-a",
			args: ["--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files"],
			env: { PI_CODING_AGENT_DIR: root },
			globalHost: { enabled: true, agentDir: root },
			pipeStderr: false,
		});
		clients.push(client);
		await client.start();
		const state = readPiGlobalHostState(root);
		if (state) hostPids.push(state.pid);
		const runtime = await client.openRuntime({
			runtimeId: "extension-runtime",
			cwd: root,
			sessionId: "extension-session",
			extensionTarget: "mortise",
			extensionPaths: [extensionPath],
		});
		await expect(runtime.invokeExtensionCommandResult("runtime-extension-loaded")).resolves.toEqual({
			invoked: true,
		});
		await runtime.close();
	});
});
