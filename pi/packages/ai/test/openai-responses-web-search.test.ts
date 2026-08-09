import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";

describe("OpenAI Responses native web search projection", () => {
	it("preserves the raw item and emits ordered search events with sources", async () => {
		const item = {
			id: "ws_1",
			type: "web_search_call",
			status: "completed",
			action: {
				type: "search",
				query: "Mortise agent",
				queries: ["Mortise agent"],
				sources: [{ type: "url", url: "https://example.com/docs" }],
			},
		} as const;
		async function* events() {
			yield { type: "response.output_item.added", item, output_index: 0, sequence_number: 1 };
			yield { type: "response.web_search_call.searching", item_id: "ws_1", output_index: 0, sequence_number: 2 };
			yield { type: "response.output_item.done", item, output_index: 0, sequence_number: 3 };
		}
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5",
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
		const push = vi.fn();
		const model = {
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
		} satisfies Model<"openai-responses">;

		await processResponsesStream(events() as any, output, { push } as any, model);

		expect(push.mock.calls.map(([event]) => event.type)).toEqual([
			"websearch_start",
			"websearch_update",
			"websearch_update",
			"websearch_end",
		]);
		expect(output.content[0]).toMatchObject({
			type: "webSearch",
			searchId: "ws_1",
			query: "Mortise agent",
			status: "completed",
			sources: [{ url: "https://example.com/docs", domain: "example.com" }],
			raw: item,
		});
	});
});
