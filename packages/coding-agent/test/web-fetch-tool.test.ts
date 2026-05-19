import { describe, expect, it } from "vitest";
import { createWebFetchToolDefinition, type WebFetchOperations } from "../src/core/tools/web-fetch.js";

function response(body: string, init?: ResponseInit): Response {
	return new Response(body, init);
}

function operations(routes: Record<string, Response>): WebFetchOperations {
	return {
		fetch: async (input) => {
			const key = input.toString();
			const result = routes[key];
			if (!result) {
				throw new Error(`No route for ${key}`);
			}
			return result;
		},
		lookup: async (hostname) => {
			if (hostname === "localhost") {
				return [{ address: "127.0.0.1", family: 4 }];
			}
			if (hostname === "private.test") {
				return [{ address: "10.0.0.1", family: 4 }];
			}
			return [{ address: "93.184.216.34", family: 4 }];
		},
	};
}

async function execute(
	toolOps: WebFetchOperations,
	input: Parameters<ReturnType<typeof createWebFetchToolDefinition>["execute"]>[1],
) {
	const tool = createWebFetchToolDefinition(process.cwd(), { operations: toolOps });
	return tool.execute("call_1", input, undefined, undefined, undefined as never);
}

function textOutput(result: Awaited<ReturnType<typeof execute>>): string {
	const [content] = result.content;
	expect(content?.type).toBe("text");
	return content.type === "text" ? content.text : "";
}

describe("web_fetch tool", () => {
	it("extracts HTML main content", async () => {
		const result = await execute(
			operations({
				"https://example.com/article": response(
					"<html><head><title>Test Article</title></head><body><article><h1>Hello</h1><p>Main text.</p></article><nav>ignore me</nav></body></html>",
					{ headers: { "content-type": "text/html" } },
				),
			}),
			{ url: "https://example.com/article" },
		);

		expect(textOutput(result)).toContain("Title: Test Article");
		expect(textOutput(result)).toContain("Main text.");
		expect(result.details.contentType).toBe("text/html");
	});

	it("returns plain text responses", async () => {
		const result = await execute(
			operations({
				"https://example.com/readme.txt": response("hello\nworld", {
					headers: { "content-type": "text/plain" },
				}),
			}),
			{ url: "https://example.com/readme.txt" },
		);

		expect(textOutput(result)).toContain("hello\nworld");
	});

	it("follows redirects with target validation", async () => {
		const result = await execute(
			operations({
				"https://example.com/start": response("", {
					status: 302,
					headers: { location: "https://example.org/final" },
				}),
				"https://example.org/final": response("done", {
					headers: { "content-type": "text/plain" },
				}),
			}),
			{ url: "https://example.com/start" },
		);

		expect(result.details.finalUrl).toBe("https://example.org/final");
		expect(textOutput(result)).toContain("done");
	});

	it("blocks localhost and private addresses", async () => {
		const localhost = await execute(operations({}), { url: "http://localhost/test" });
		const privateHost = await execute(operations({}), { url: "https://private.test/test" });

		expect(textOutput(localhost)).toContain("Blocked URL");
		expect(textOutput(privateHost)).toContain("blocked address 10.0.0.1");
	});

	it("truncates oversized output", async () => {
		const result = await execute(
			operations({
				"https://example.com/large": response("x".repeat(100), {
					headers: { "content-type": "text/plain" },
				}),
			}),
			{ url: "https://example.com/large", maxChars: 10 },
		);

		expect(result.details.truncated).toBe(true);
		expect(textOutput(result)).toContain("[Truncated at 10 characters]");
	});

	it("rejects pdf and binary content types as unsupported", async () => {
		const pdf = await execute(
			operations({
				"https://example.com/file.pdf": response("%PDF", {
					headers: { "content-type": "application/pdf", "content-length": "4" },
				}),
			}),
			{ url: "https://example.com/file.pdf" },
		);
		const image = await execute(
			operations({
				"https://example.com/image.png": response("PNG", {
					headers: { "content-type": "image/png", "content-length": "3" },
				}),
			}),
			{ url: "https://example.com/image.png" },
		);

		expect(textOutput(pdf)).toContain("Unsupported content type: application/pdf");
		expect(textOutput(image)).toContain("Unsupported content type: image/png");
	});
});
