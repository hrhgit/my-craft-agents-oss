import type { AssistantMessage, Message, Model } from "@mortise/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_PROMPT, generateSummaryViaAppendPrompt } from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@mortise/pi-ai/stream", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mortise/pi-ai/stream")>();
	return { ...actual, completeSimple: completeSimpleMock };
});

const model: Model<"anthropic-messages"> = {
	id: "test-model",
	name: "Test Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const response: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test-model",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "Earlier work" }], timestamp: 1 }];

describe("compaction prompt override", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(response);
	});

	it("uses the Pi default when no host override is configured", async () => {
		await generateSummaryViaAppendPrompt(messages, model, 4096, "key");
		const context = completeSimpleMock.mock.calls[0][1];
		const prompt = context.messages.at(-1).content[0].text;
		expect(prompt).toContain(DEFAULT_COMPACTION_PROMPT);
	});

	it("replaces the default prompt and preserves previous summary context", async () => {
		await generateSummaryViaAppendPrompt(
			messages,
			model,
			4096,
			"key",
			undefined,
			undefined,
			"Focus on exact decisions.",
			"Previous checkpoint",
			undefined,
			undefined,
			{ compactionPrompt: "CUSTOM COMPACTION INSTRUCTIONS" },
		);
		const context = completeSimpleMock.mock.calls[0][1];
		const prompt = context.messages.at(-1).content[0].text;
		expect(prompt).toContain("CUSTOM COMPACTION INSTRUCTIONS");
		expect(prompt).toContain("<previous-summary>\nPrevious checkpoint\n</previous-summary>");
		expect(prompt).toContain("Additional focus: Focus on exact decisions.");
		expect(prompt).not.toContain(DEFAULT_COMPACTION_PROMPT);
	});
});
