import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";

describe("Pi RPC extension UI convenience methods", () => {
	const roots: string[] = [];
	const clients: RpcClient[] = [];

	afterEach(async () => {
		await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
		for (const root of roots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it("maps dialogs and widgets exclusively onto versioned interaction and contribution events", async () => {
		const root = join(tmpdir(), `pi-ui-convenience-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const extensionPath = join(root, "convenience-extension.js");
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
			join(root, "settings.json"),
			JSON.stringify({
				extensions: [{ id: "convenience", path: extensionPath, activation: "startup", targets: ["pi"] }],
			}),
			"utf8",
		);
		writeFileSync(
			extensionPath,
			`export default function(pi) {
	pi.registerCommand("exercise-convenience-ui", {
		handler: async (_args, ctx) => {
			ctx.ui.setWidget("summary", ["First", "Second"], { placement: "belowEditor" });
			const selected = await ctx.ui.select("Pick one", ["Alpha", "Beta"]);
			const confirmed = await ctx.ui.confirm("Proceed?", "Confirm action");
			const input = await ctx.ui.input("Name", "Type a name");
			const edited = await ctx.ui.editor("Notes", "Original");
			ctx.ui.setWidget("summary", undefined);
			if (selected !== "Beta" || confirmed !== true || input !== "Typed" || edited !== "Edited\\nText") {
				throw new Error(JSON.stringify({ selected, confirmed, input, edited }));
			}
		},
	});
}`,
			"utf8",
		);
		roots.push(root);

		const client = new RpcClient({
			command: process.execPath,
			cliPath: join(process.cwd(), "src", "cli.ts"),
			cwd: root,
			provider: "test",
			model: "model-a",
			args: ["--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files"],
			env: {
				PI_CODING_AGENT_DIR: root,
				PI_RPC_UI_CAPABILITIES: JSON.stringify({
					kind: "mortise",
					dialogs: true,
					widgets: true,
					editorControl: false,
					contributions: true,
					interactionSchemas: [1],
				}),
			},
			pipeStderr: false,
		});
		clients.push(client);
		const requests: RpcExtensionUIRequest[] = [];
		client.onClientEvent((event) => {
			if (event.type !== "extension_ui_request") return;
			requests.push(event);
			if (event.method !== "interact") return;
			const field = event.request.fields[0];
			const answer =
				field.kind === "choice"
					? { fieldId: field.id, kind: "choice" as const, selectedOptionIds: ["option-2"] }
					: field.kind === "confirm"
						? { fieldId: field.id, kind: "confirm" as const, value: true }
						: {
								fieldId: field.id,
								kind: "text" as const,
								value: field.multiline ? "Edited\nText" : "Typed",
							};
			client.respondToExtensionUI({
				type: "extension_ui_response",
				id: event.id,
				extensionId: event.extensionId,
				interaction: { schemaVersion: 1, status: "submitted", answers: [answer] },
			});
		});

		await client.start();
		await expect(client.invokeExtensionCommandResult("exercise-convenience-ui")).resolves.toEqual({ invoked: true });

		expect(requests.map((request) => request.method)).toEqual([
			"contribution",
			"interact",
			"interact",
			"interact",
			"interact",
			"contribution",
		]);
		expect(
			requests.some((request) => ["select", "confirm", "input", "editor", "setWidget"].includes(request.method)),
		).toBe(false);
		expect(requests[0]).toMatchObject({
			method: "contribution",
			operation: "upsert",
			contribution: {
				id: "summary",
				schemaVersion: 1,
				surface: "composer.below",
				content: { type: "text", text: "First\nSecond" },
			},
		});
		expect(requests.at(-1)).toMatchObject({
			method: "contribution",
			operation: "remove",
			contributionId: "summary",
		});
	});
});
