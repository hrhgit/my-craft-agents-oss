import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model, Tool } from "../src/types.ts";

interface CapturedRequest {
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function createModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "test-anthropic",
		baseUrl: "https://api.anthropic.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true, ...compat },
	};
}

const tool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

function createContext(tools: Tool[] = [tool]): Context {
	return {
		messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
		...(tools.length > 0 ? { tools } : {}),
	};
}

async function captureAnthropicRequest(
	compat: Model<"anthropic-messages">["compat"],
	context: Context,
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;
	const httpFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		capturedRequest = {
			headers: Object.fromEntries(request.headers.entries()),
			body: (await request.json()) as Record<string, unknown>,
		};
		return new Response("", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};

	const stream = streamAnthropic(createModel(compat), context, {
		apiKey: "test-key",
		cacheRetention: "none",
		httpFetch: httpFetch as typeof fetch,
	});

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	if (!capturedRequest) {
		throw new Error("Anthropic request was not captured");
	}
	return capturedRequest;
}

function getFirstTool(body: Record<string, unknown>): Record<string, unknown> {
	const tools = body.tools;
	if (!Array.isArray(tools) || typeof tools[0] !== "object" || tools[0] === null) {
		throw new Error("Expected first tool in request body");
	}
	return tools[0] as Record<string, unknown>;
}

describe("Anthropic eager tool input streaming compatibility", () => {
	it("sends per-tool eager_input_streaming by default", async () => {
		const request = await captureAnthropicRequest(undefined, createContext());

		expect(getFirstTool(request.body).eager_input_streaming).toBe(true);
		expect(request.headers["anthropic-beta"]).toBeUndefined();
	});

	it("uses the legacy fine-grained tool streaming beta when eager tool input streaming is disabled", async () => {
		const request = await captureAnthropicRequest({ supportsEagerToolInputStreaming: false }, createContext());

		expect(getFirstTool(request.body).eager_input_streaming).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toBe("fine-grained-tool-streaming-2025-05-14");
	});

	it("does not send the legacy fine-grained tool streaming beta when there are no tools", async () => {
		const request = await captureAnthropicRequest({ supportsEagerToolInputStreaming: false }, createContext([]));

		expect(request.body.tools).toBeUndefined();
		expect(request.headers["anthropic-beta"]).toBeUndefined();
	});
});
