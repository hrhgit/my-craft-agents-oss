import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("OpenAI Responses reasoning summary", () => {
	it("keeps raw thinking and provider summary separate on thinking_end and in AssistantMessage", async () => {
		const summaryPart = { type: "reasoning_summary_text", text: "" };
		const doneItem = {
			type: "reasoning",
			id: "rs_1",
			summary: [{ type: "reasoning_summary_text", text: "Summary" }],
			content: [{ type: "reasoning_text", text: "Raw reasoning" }],
		};
		async function* events() {
			yield {
				type: "response.output_item.added",
				item: { type: "reasoning", id: "rs_1", summary: [], content: [] },
				output_index: 0,
				sequence_number: 1,
			} as any;
			yield {
				type: "response.reasoning_summary_part.added",
				item_id: "rs_1",
				output_index: 0,
				sequence_number: 2,
				part: summaryPart,
			} as any;
			yield {
				type: "response.reasoning_summary_text.delta",
				item_id: "rs_1",
				output_index: 0,
				sequence_number: 3,
				delta: "Summary",
			} as any;
			yield {
				type: "response.reasoning_text.delta",
				item_id: "rs_1",
				output_index: 0,
				sequence_number: 4,
				delta: "Raw reasoning",
			} as any;
			yield {
				type: "response.output_item.done",
				item: doneItem,
				output_index: 0,
				sequence_number: 5,
			} as any;
		}

		const model = createModel();
		const output = createOutput(model);
		const push = vi.fn();
		await processResponsesStream(events(), output, { push } as any, model);

		const emitted = push.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const thinkingDeltas = emitted.filter((event) => event.type === "thinking_delta");
		expect(thinkingDeltas).toEqual([expect.objectContaining({ delta: "Raw reasoning" })]);

		const thinkingEnd = emitted.find((event) => event.type === "thinking_end");
		expect(thinkingEnd).toMatchObject({ content: "Raw reasoning", summary: "Summary" });

		const thinking = output.content[0] as any;
		expect(thinking).toMatchObject({
			type: "thinking",
			thinking: "Raw reasoning",
			thinkingSummary: "Summary",
		});
		expect(JSON.parse(thinking.thinkingSignature)).toMatchObject({ type: "reasoning", id: "rs_1" });
	});

	it("does not treat raw reasoning content as a summary", async () => {
		const doneItem = {
			type: "reasoning",
			id: "rs_2",
			content: [{ type: "reasoning_text", text: "Raw only" }],
		};
		async function* events() {
			yield {
				type: "response.output_item.added",
				item: { type: "reasoning", id: "rs_2", content: [] },
				output_index: 0,
				sequence_number: 1,
			} as any;
			yield {
				type: "response.reasoning_text.delta",
				item_id: "rs_2",
				output_index: 0,
				sequence_number: 2,
				delta: "Raw only",
			} as any;
			yield {
				type: "response.output_item.done",
				item: doneItem,
				output_index: 0,
				sequence_number: 3,
			} as any;
		}

		const model = createModel();
		const output = createOutput(model);
		const push = vi.fn();
		await processResponsesStream(events(), output, { push } as any, model);

		const emitted = push.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const thinkingEnd = emitted.find((event) => event.type === "thinking_end");
		expect(thinkingEnd).toMatchObject({ content: "Raw only" });
		expect((thinkingEnd as any).summary).toBeUndefined();

		const thinking = output.content[0] as any;
		expect(thinking.thinking).toBe("Raw only");
		expect(thinking.thinkingSummary).toBeUndefined();
	});
});
