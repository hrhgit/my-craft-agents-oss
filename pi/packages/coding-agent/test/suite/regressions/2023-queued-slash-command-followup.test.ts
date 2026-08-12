import type { AgentTool } from "@mortise/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@mortise/pi-ai";
import type { ExtensionAPI } from "@mortise/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

describe("issue #2023 queued slash-command follow-up", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("dispatches extension-origin slash commands from the Pi Session follow-up queue", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const commandRuns: string[] = [];
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test to release execution",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("first turn complete"),
			fauxAssistantMessage("queued follow-up handled by model"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("/testcmd queued", { deliverAs: "followUp" });
		releaseToolExecution?.();
		await promptPromise;

		expect(commandRuns).toEqual(["queued"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(getAssistantTexts(harness)).toContain("first turn complete");
		expect(getAssistantTexts(harness)).not.toContain("queued follow-up handled by model");
	});
});
