import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.js";
import { convertTools } from "../src/providers/google-shared.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model, Tool } from "../src/types.js";
import { supportsBuiltinWebSearchApi } from "../src/web-search.js";

const stop = new Error("stop");

const functionTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({
		path: Type.String(),
	}),
};

const context: Context = {
	systemPrompt: "You are concise.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	tools: [functionTool],
};

const openAIResponsesModel: Model<"openai-responses"> = {
	id: "gpt-5.2",
	name: "GPT 5.2",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 32000,
};

const azureResponsesModel: Model<"azure-openai-responses"> = {
	id: "gpt-5.2",
	name: "GPT 5.2",
	api: "azure-openai-responses",
	provider: "azure-openai-responses",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 32000,
};

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

async function captureStreamPayload<T>(
	run: (onPayload: (payload: unknown) => never) => AsyncIterable<T>,
): Promise<unknown> {
	let captured: unknown;
	const stream = run((payload) => {
		captured = payload;
		throw stop;
	});

	for await (const _event of stream) {
	}

	return captured;
}

describe("builtin web search", () => {
	it("adds OpenAI Responses web_search when enabled", async () => {
		const payload = await captureStreamPayload((onPayload) =>
			streamOpenAIResponses(openAIResponsesModel, context, {
				apiKey: "test",
				webSearch: true,
				onPayload,
			}),
		);

		expect(payload).toMatchObject({
			tools: expect.arrayContaining([expect.objectContaining({ type: "web_search" })]),
		});
	});

	it("does not add OpenAI Responses web_search when disabled", async () => {
		const payload = await captureStreamPayload((onPayload) =>
			streamOpenAIResponses(openAIResponsesModel, context, {
				apiKey: "test",
				webSearch: false,
				onPayload,
			}),
		);

		expect((payload as { tools?: Array<{ type: string }> }).tools?.some((tool) => tool.type === "web_search")).toBe(
			false,
		);
	});

	it("adds Azure OpenAI Responses web_search when enabled", async () => {
		const payload = await captureStreamPayload((onPayload) =>
			streamAzureOpenAIResponses(azureResponsesModel, context, {
				apiKey: "test",
				webSearch: true,
				onPayload,
			}),
		);

		expect(payload).toMatchObject({
			tools: expect.arrayContaining([expect.objectContaining({ type: "web_search" })]),
		});
	});

	it("adds Anthropic web_search_20250305 when enabled", async () => {
		const payload = await captureStreamPayload((onPayload) =>
			streamAnthropic(anthropicModel, context, {
				apiKey: "test",
				webSearch: true,
				onPayload,
			}),
		);

		expect(payload).toMatchObject({
			tools: expect.arrayContaining([
				expect.objectContaining({
					name: "web_search",
					type: "web_search_20250305",
				}),
			]),
		});
	});

	it("adds Google Search grounding when enabled", () => {
		const tools = convertTools([functionTool], false, true);

		expect(tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					googleSearch: {},
				}),
			]),
		);
	});

	it("reports support only for providers with builtin web search", () => {
		expect(supportsBuiltinWebSearchApi("openai-responses")).toBe(true);
		expect(supportsBuiltinWebSearchApi("anthropic-messages")).toBe(true);
		expect(supportsBuiltinWebSearchApi("google-generative-ai")).toBe(true);
		expect(supportsBuiltinWebSearchApi("openai-completions")).toBe(false);
		expect(supportsBuiltinWebSearchApi("mistral-conversations")).toBe(false);
	});
});
