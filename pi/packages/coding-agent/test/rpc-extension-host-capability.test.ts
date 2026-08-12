import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type {
	RpcExtensionHostCapabilityCancel,
	RpcExtensionHostCapabilityDeclaration,
	RpcExtensionHostCapabilityRequest,
} from "../src/modes/rpc/rpc-types.ts";

describe("Pi RPC extension host capabilities", () => {
	const roots: string[] = [];
	const clients: RpcClient[] = [];

	afterEach(async () => {
		await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
		for (const root of roots.splice(0)) {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it("routes system.notification from a real extension to the embedding host", async () => {
		const root = join(tmpdir(), `pi-host-capability-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const extensionPath = join(root, "notification-extension.js");
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
				extensions: [{ id: "notification-integration", path: extensionPath, activation: "startup" }],
			}),
			"utf8",
		);
		writeFileSync(
			extensionPath,
			`export default function(pi) {
	pi.declareCapabilities([
		{ capability: "system.notification", operations: ["show"] },
		{ capability: "test.long-running", operations: ["wait"] },
	]);
	pi.registerCommand("notify-host", {
		handler: async (_args, ctx) => {
			const progress = [];
			const result = await ctx.capabilities.invoke(
				"system.notification",
				"show",
				{ title: "Capability integration", body: "Shown by the mocked Mortise Host" },
				{ timeoutMs: 5000, onProgress: (value, sequence) => progress.push({ value, sequence }) },
			);
			if (result.status !== "success" || result.output?.shown !== true) {
				throw new Error("Host did not confirm the notification");
			}
			if (progress.length !== 1 || progress[0].sequence !== 1 || progress[0].value?.phase !== "showing") {
				throw new Error("Host capability progress was not delivered");
			}
		},
	});
	pi.registerCommand("cancel-host", {
		handler: async (_args, ctx) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 10);
			const result = await ctx.capabilities.invoke("test.long-running", "wait", {}, { signal: controller.signal });
			if (result.status !== "cancelled") throw new Error("Capability was not cancelled");
		},
	});
		pi.registerCommand("allow-other", {
			handler: async (_args, ctx) => {
				const result = await ctx.ui.interact({
					schemaVersion: 1,
					presentation: { mode: "wizard", allowSkip: true, autoAdvanceSingleChoice: true },
				fields: [{
					id: "choices",
					kind: "choice",
					label: "Choices",
					options: [{ id: "fixed", label: "Fixed" }],
					multiple: true,
					allowOther: true,
					maxSelections: 2,
				}],
			});
			const answer = result.status === "submitted" ? result.answers[0] : undefined;
			if (answer?.kind !== "choice" || answer.selectedOptionIds[0] !== "fixed" || answer.otherText !== "Custom") {
				throw new Error("Other choice was not preserved");
			}
		},
	});
}
`,
			"utf8",
		);
		roots.push(root);

		const client = new RpcClient({
			command: process.execPath,
			runtimePath: join(process.cwd(), "dist", "bun", "headless.js"),
			cwd: root,
			provider: "test",
			model: "model-a",
			env: {
				MORTISE_AGENT_DIR: root,
				PI_RPC_UI_CAPABILITIES: JSON.stringify({
					kind: "mortise",
					dialogs: true,
					contributions: false,
					interactionSchemas: [1],
				}),
			},
			pipeStderr: false,
		});
		clients.push(client);

		let receivedRequest: RpcExtensionHostCapabilityRequest | undefined;
		let receivedDeclaration: RpcExtensionHostCapabilityDeclaration | undefined;
		let receivedCancel: RpcExtensionHostCapabilityCancel | undefined;
		const receivedRouteRejections: Array<{ phase: string; reason: string }> = [];
		let receivedInteractionPresentation: unknown;
		let notificationRequestCount = 0;
		client.onClientEvent((event) => {
			if (event.type === "extension_host_capability_route_rejected") {
				receivedRouteRejections.push(event);
				return;
			}
			if (event.type === "extension_ui_request" && event.method === "interact") {
				receivedInteractionPresentation = event.request.presentation;
				const writable = (client as unknown as { process?: { stdin?: { write(value: string): void } } }).process
					?.stdin;
				writable?.write(
					`${JSON.stringify({
						type: "extension_ui_response",
						id: event.id,
						extensionId: event.extensionId,
						runtimeId: "wrong-runtime",
						sessionId: event.sessionId,
						interaction: { schemaVersion: 1, status: "cancelled", reason: "user" },
					})}\n`,
				);
				setTimeout(() => {
					client.respondToExtensionUI({
						type: "extension_ui_response",
						id: event.id,
						extensionId: event.extensionId,
						interaction: {
							schemaVersion: 1,
							status: "submitted",
							answers: [
								{ fieldId: "choices", kind: "choice", selectedOptionIds: ["fixed"], otherText: "Custom" },
							],
						},
					});
				}, 20);
				return;
			}
			if (event.type === "extension_host_capability_declaration") {
				receivedDeclaration = event;
				return;
			}
			if (event.type === "extension_host_capability_cancel") {
				receivedCancel = event;
				return;
			}
			if (event.type !== "extension_host_capability_request") return;
			if (event.capability === "test.long-running") {
				return;
			}
			receivedRequest = event;
			notificationRequestCount++;
			client.reportExtensionHostCapabilityProgress({
				type: "extension_host_capability_progress",
				version: 1,
				id: event.id,
				sequence: -1,
				progress: { phase: "invalid" },
				runtimeId: event.runtimeId,
				sessionId: event.sessionId,
				clientId: event.clientId,
			});
			client.reportExtensionHostCapabilityProgress({
				type: "extension_host_capability_progress",
				version: 1,
				id: event.id,
				sequence: 1,
				progress: { phase: "showing" },
				runtimeId: event.runtimeId,
				sessionId: event.sessionId,
				clientId: event.clientId,
			});
			// A malformed response must be observable and must not settle another route.
			if (notificationRequestCount === 1) {
				client.respondToExtensionHostCapability({
					type: "extension_host_capability_response",
					version: 1,
					id: event.id,
					status: "unexpected",
					runtimeId: event.runtimeId,
					sessionId: event.sessionId,
					clientId: event.clientId,
				} as never);
				client.respondToExtensionHostCapability({
					type: "extension_host_capability_response",
					version: 1,
					id: event.id,
					status: "success",
					output: { ignored: true },
				});
				return;
			}
			client.respondToExtensionHostCapability({
				type: "extension_host_capability_response",
				version: 1,
				id: event.id,
				status: "success",
				output: { shown: true },
				runtimeId: event.runtimeId,
				sessionId: event.sessionId,
				clientId: event.clientId,
			});
		});

		await client.start();
		await expect(client.invokeExtensionCommandResult("notify-host")).resolves.toEqual({
			invoked: false,
			error: "Host did not confirm the notification",
		});
		await vi.waitFor(() =>
			expect(receivedRouteRejections).toEqual(
				expect.arrayContaining([expect.objectContaining({ phase: "response", reason: "unknown_request" })]),
			),
		);
		await expect(client.invokeExtensionCommandResult("notify-host")).resolves.toEqual({ invoked: true });

		expect(receivedRequest).toMatchObject({
			type: "extension_host_capability_request",
			version: 1,
			capability: "system.notification",
			operation: "show",
			input: { title: "Capability integration", body: "Shown by the mocked Mortise Host" },
			timeoutMs: 5000,
		});
		expect(receivedRequest?.extensionId).toBeTruthy();
		expect(receivedDeclaration).toMatchObject({
			type: "extension_host_capability_declaration",
			version: 1,
			declarations: expect.arrayContaining([{ capability: "system.notification", operations: ["show"] }]),
		});

		await expect(client.invokeExtensionCommandResult("cancel-host")).resolves.toEqual({ invoked: true });
		await vi.waitFor(() =>
			expect(receivedCancel).toMatchObject({
				type: "extension_host_capability_cancel",
				version: 1,
				extensionId: expect.any(String),
			}),
		);
		await expect(client.invokeExtensionCommandResult("allow-other")).resolves.toEqual({ invoked: true });
		expect(receivedInteractionPresentation).toEqual({
			mode: "wizard",
			allowSkip: true,
			autoAdvanceSingleChoice: true,
		});
	}, 30_000);
});
