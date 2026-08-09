import type { Message, ToolResultMessage } from "@mortise/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@mortise/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const INTERRUPTION_CONTEXT =
	"The previous attempt was interrupted. Some tools or commands may still be running or may have partially executed. Check the current state before retrying.";

function userMessage(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details: { original: true },
		isError: false,
		timestamp: Date.now(),
	};
}

function seedHistory(harness: Harness, messages: Message[]): void {
	for (const message of messages) harness.sessionManager.appendMessage(message);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession continueFromHistory", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("preserves completed parallel tool results and closes only missing results", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const completed = toolResult("tool-complete", "complete", "original result");
		seedHistory(harness, [
			userMessage("start"),
			fauxAssistantMessage(
				[
					fauxToolCall("complete", {}, { id: "tool-complete" }),
					fauxToolCall("unknown", {}, { id: "tool-unknown" }),
				],
				{ stopReason: "toolUse" },
			),
			completed,
		]);
		let providerContext: Message[] = [];
		harness.setResponses([
			(context) => {
				providerContext = structuredClone(context.messages);
				return fauxAssistantMessage("resumed");
			},
		]);

		await harness.session.continueFromHistory();

		const toolResults = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(toolResults).toHaveLength(2);
		expect(toolResults.find((message) => message.toolCallId === "tool-complete")).toEqual(completed);
		expect(toolResults.find((message) => message.toolCallId === "tool-unknown")).toMatchObject({
			toolName: "unknown",
			isError: true,
			details: { status: "outcome-unknown" },
		});
		expect(providerContext.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(providerContext.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: INTERRUPTION_CONTEXT }],
		});
		expect(INTERRUPTION_CONTEXT).not.toMatch(/intentionally|on purpose|by the user/i);
	});

	it("does not add tool status when every tool already has a complete result", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const first = toolResult("tool-first", "first", "first result");
		const second = toolResult("tool-second", "second", "second result");
		seedHistory(harness, [
			userMessage("start"),
			fauxAssistantMessage(
				[fauxToolCall("first", {}, { id: "tool-first" }), fauxToolCall("second", {}, { id: "tool-second" })],
				{ stopReason: "toolUse" },
			),
			first,
			second,
		]);
		harness.setResponses([fauxAssistantMessage("resumed")]);

		await harness.session.continueFromHistory();

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toEqual([first, second]);
		expect(harness.session.messages.filter((message) => message.role === "custom")).toMatchObject([
			{ customType: "attempt_interrupted", content: INTERRUPTION_CONTEXT, display: false },
		]);
	});

	it("places hidden interruption context before a new user message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedHistory(harness, [userMessage("previous turn"), fauxAssistantMessage("previous answer")]);
		let providerContext: Message[] = [];
		harness.setResponses([
			(context) => {
				providerContext = structuredClone(context.messages);
				return fauxAssistantMessage("next answer");
			},
		]);

		await harness.session.prompt("actual user text", { interruptedAttempt: true });

		const branch = harness.sessionManager.getBranch();
		const customIndex = branch.findIndex(
			(entry) => entry.type === "custom_message" && entry.customType === "attempt_interrupted",
		);
		const userIndex = branch.findIndex(
			(entry, index) => index > customIndex && entry.type === "message" && entry.message.role === "user",
		);
		expect(customIndex).toBeGreaterThan(-1);
		expect(userIndex).toBe(customIndex + 1);
		expect(branch[customIndex]).toMatchObject({
			type: "custom_message",
			customType: "attempt_interrupted",
			content: INTERRUPTION_CONTEXT,
			display: false,
		});
		expect(providerContext.at(-2)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: INTERRUPTION_CONTEXT }],
		});
		expect(providerContext.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "actual user text" }],
		});
	});

	it("rejects a steer after the streaming turn has already ended", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await expect(harness.session.steer("late steer")).rejects.toThrow("not streaming");
	});

	it.each(["aborted", "error"] as const)(
		"drops an incomplete %s assistant branch before resuming",
		async (stopReason) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const incomplete = fauxAssistantMessage("partial response", {
				stopReason,
				errorMessage: stopReason === "error" ? "stream failed" : undefined,
			});
			seedHistory(harness, [userMessage("start"), incomplete]);
			let providerContext: Message[] = [];
			harness.setResponses([
				(context) => {
					providerContext = structuredClone(context.messages);
					return fauxAssistantMessage("resumed");
				},
			]);

			await harness.session.continueFromHistory();

			expect(providerContext.some((message) => message.role === "assistant")).toBe(false);
			expect(providerContext.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "text", text: INTERRUPTION_CONTEXT }],
			});
			expect(
				harness.sessionManager
					.getBranch()
					.some((entry) => entry.type === "message" && entry.message === incomplete),
			).toBe(false);
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "message" && entry.message === incomplete),
			).toBe(true);
		},
	);
});
