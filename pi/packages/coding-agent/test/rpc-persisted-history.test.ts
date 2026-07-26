import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@mortise/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

describe("RPC persisted history compatibility", () => {
	const roots: string[] = [];
	const clients: RpcClient[] = [];

	afterEach(async () => {
		await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
		for (const root of roots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it("opens history without usage and reaches the provider before durable settlement", async () => {
		let providerRequests = 0;
		const provider = createServer((request, response) => {
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			providerRequests++;
			request.resume();
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const id = `chatcmpl-${Date.now()}`;
			response.write(
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "model-a", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`,
			);
			response.write(
				`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "model-a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 1 } })}\n\n`,
			);
			response.end("data: [DONE]\n\n");
		});
		provider.listen(0, "127.0.0.1");
		await once(provider, "listening");

		const root = join(tmpdir(), `pi-rpc-history-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "workspace");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		roots.push(root);
		const port = (provider.address() as AddressInfo).port;
		writeFileSync(
			join(root, "models.json"),
			JSON.stringify({
				providers: {
					test: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						apiKey: "test-key",
						models: [{ id: "model-a", contextWindow: 128_000, maxTokens: 4096 }],
					},
				},
			}),
			"utf8",
		);

		const seeded = SessionManager.create(cwd, sessionDir, { id: "persisted-history" });
		seeded.appendMessage({ role: "user", content: "old question", timestamp: 1 });
		seeded.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "old answer" }],
			api: "openai-completions",
			provider: "test",
			model: "model-a",
			stopReason: "stop",
			timestamp: 2,
		} as AssistantMessage);
		await seeded.flush();
		const sessionPath = seeded.getSessionFile();
		expect(sessionPath && existsSync(sessionPath)).toBe(true);

		const client = new RpcClient({
			command: process.execPath,
			runtimePath: join(process.cwd(), "dist", "bun", "headless.js"),
			cwd,
			provider: "test",
			model: "model-a",
			env: { MORTISE_AGENT_DIR: root },
			pipeStderr: false,
		});
		clients.push(client);

		try {
			await client.start();
			const runtime = await client.openRuntime({
				runtimeId: "persisted-runtime",
				cwd,
				extensionTarget: "mortise",
				sessionPath,
			});
			const eventsPromise = runtime.collectEvents(30_000);
			await runtime.prompt("new question", undefined, { clientMutationId: "mutation-history-1" });
			const events = await eventsPromise;

			expect(providerRequests).toBe(1);
			const persistedIndex = events.findIndex((event) => event.type === "pi_user_message_persisted");
			const settledIndex = events.findIndex((event) => event.type === "agent_settled");
			expect(persistedIndex).toBeGreaterThanOrEqual(0);
			expect(settledIndex).toBeGreaterThan(persistedIndex);
			expect(events[persistedIndex]).toMatchObject({ clientMutationId: "mutation-history-1" });
			expect(readFileSync(sessionPath!, "utf8")).toContain('"clientMutationId":"mutation-history-1"');
			await runtime.close();
		} finally {
			provider.close();
			await once(provider, "close");
		}
	}, 60_000);
});
