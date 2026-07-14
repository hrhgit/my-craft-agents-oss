import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeadlessUIContext } from "../src/core/extensions/headless-ui-context.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { parseRpcHostUICapabilities } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIValidationEvent } from "../src/modes/rpc/rpc-types.ts";

type RpcContributionRequest = Extract<RpcExtensionUIRequest, { method: "contribution" }>;

const baseCapabilities = {
	kind: "craft",
	dialogs: true,
	widgets: true,
	editorControl: true,
	contributions: true,
	interactionSchemas: [1],
} as const;

describe("extension UI validation capability", () => {
	const roots: string[] = [];
	const clients: RpcClient[] = [];

	afterEach(async () => {
		await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
		for (const root of roots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it("keeps validation disabled for hosts that do not advertise it", () => {
		expect(parseRpcHostUICapabilities(JSON.stringify(baseCapabilities))).toMatchObject({
			validation: false,
		});
	});

	it("accepts explicit development-host validation support", () => {
		expect(parseRpcHostUICapabilities(JSON.stringify({ ...baseCapabilities, validation: true }))).toEqual({
			...baseCapabilities,
			validation: true,
		});
	});

	it("rejects validation on a host that declares no UI", () => {
		expect(() =>
			parseRpcHostUICapabilities(
				JSON.stringify({
					kind: "none",
					dialogs: false,
					widgets: false,
					editorControl: false,
					contributions: false,
					validation: true,
					interactionSchemas: [],
				}),
			),
		).toThrow('RPC host UI kind "none" cannot declare UI features');
	});

	it("gracefully ignores declarations when the capability is unavailable", () => {
		const send = vi.fn();
		const validation = createHeadlessUIContext({ send }).validation;
		expect(validation.available).toBe(false);
		expect(validation.protocolVersions).toEqual([]);

		validation.upsertDefinition({
			schemaVersion: 1,
			id: "status.contract",
			contributionId: "status",
			verificationLevel: "semantic",
		});
		validation.updateState("status.contract", { signals: [] });
		validation.removeDefinition("status.contract");
		validation.clearDefinitions();

		expect(send).not.toHaveBeenCalled();
	});

	it("emits revisioned validation deltas from a real RPC extension context", async () => {
		const root = join(tmpdir(), `pi-ui-validation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const extensionPath = join(root, "validation-extension.js");
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
				extensions: [{ id: "validation", path: extensionPath, activation: "startup", targets: ["pi"] }],
			}),
			"utf8",
		);
		writeFileSync(
			extensionPath,
			`export default function(pi) {
	pi.registerCommand("publish-validation", {
		handler: async (_args, ctx) => {
			if (!ctx.ui.validation.available || !ctx.ui.validation.protocolVersions.includes(1)) {
				throw new Error("Validation capability was not enabled");
			}
			ctx.ui.validation.upsertDefinition({
				schemaVersion: 1,
				id: "status.contract",
				contributionId: "status",
				verificationLevel: "semantic",
				signals: [{ id: "ready", label: "Ready", status: "pending" }],
				readyWhen: ["ready"],
			});
			ctx.ui.validation.updateState("status.contract", {
				signals: [{ id: "ready", label: "Ready", status: "ready" }],
			});
			ctx.ui.validation.removeDefinition("status.contract");
			ctx.ui.validation.clearDefinitions();
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
				PI_RPC_UI_CAPABILITIES: JSON.stringify({ ...baseCapabilities, validation: true }),
			},
			pipeStderr: false,
		});
		clients.push(client);
		const events: RpcExtensionUIValidationEvent[] = [];
		client.onClientEvent((event) => {
			if (event.type === "extension_ui_validation") events.push(event);
		});

		await client.start();
		await expect(client.invokeExtensionCommandResult("publish-validation")).resolves.toEqual({ invoked: true });
		expect(events.map((event) => event.delta.operation)).toEqual(["upsert", "upsert", "remove", "reset"]);
		expect(events.map((event) => event.delta.revision)).toEqual([1, 2, 3, 4]);
		expect(events[1]).toMatchObject({
			extensionId: expect.any(String),
			runtimeId: "default",
			sessionId: expect.any(String),
			delta: {
				schemaVersion: 1,
				operation: "upsert",
				definition: { id: "status.contract", signals: [{ id: "ready", status: "ready" }] },
			},
		});
	});

	it("publishes both host-rendered and sandbox validation examples through a real RPC runtime", async () => {
		const root = join(tmpdir(), `pi-craft-gui-example-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const extensionPath = resolve(process.cwd(), "examples", "extensions", "craft-gui.ts");
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
				extensions: [{ id: "craft-gui-example", path: extensionPath, activation: "startup", targets: ["craft"] }],
			}),
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
				PI_EXTENSION_TARGET: "craft",
				PI_RPC_UI_CAPABILITIES: JSON.stringify({ ...baseCapabilities, validation: true }),
			},
			pipeStderr: false,
		});
		clients.push(client);
		const contributions: RpcContributionRequest[] = [];
		client.onClientEvent((event) => {
			if (event.type === "extension_ui_request" && event.method === "contribution") contributions.push(event);
		});
		await client.start();
		await client.getState();
		const published = contributions.flatMap((event) =>
			event.operation === "upsert"
				? [event.contribution]
				: event.operation === "snapshot"
					? event.contributions
					: [],
		);
		expect(published.map((item) => item.id)).toContain("craft-gui-example.status");
		expect(published).toContainEqual(
			expect.objectContaining({
				id: "craft-gui-example.sandbox",
				content: expect.objectContaining({
					type: "sandbox-app",
					permissions: ["commands", "resize", "validation"],
				}),
			}),
		);
	});
});
