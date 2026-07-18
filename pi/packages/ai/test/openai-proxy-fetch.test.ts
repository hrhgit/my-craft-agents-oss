import { describe, expect, it } from "vitest";
import { createOpenAICompatibleFetch, createOpenAIProxyAwareFetch } from "../src/providers/openai-proxy-fetch.ts";

describe("openai proxy fetch", () => {
	it("strips OpenAI SDK fingerprint headers for non-OpenAI hosts", async () => {
		const captured: Request[] = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			captured.push(request);
			return new Response("ok", { status: 200 });
		};

		const fetch = createOpenAIProxyAwareFetch(fetchImpl as typeof globalThis.fetch);
		await fetch("https://proxy.example.com/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: "Bearer token",
				"Content-Type": "application/json",
				"User-Agent": "OpenAI/JS 6.26.0",
				"x-stainless-lang": "js",
			},
			body: JSON.stringify({}),
		});

		const headers = captured[0]?.headers;
		expect(headers?.get("user-agent")).toBeNull();
		expect(headers?.get("x-stainless-lang")).toBeNull();
		expect(headers?.get("authorization")).toBe("Bearer token");
	});

	it("keeps fingerprint headers for api.openai.com", async () => {
		const captured: Request[] = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			captured.push(request);
			return new Response("ok", { status: 200 });
		};

		const fetch = createOpenAIProxyAwareFetch(fetchImpl as typeof globalThis.fetch);
		await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: "Bearer token",
				"Content-Type": "application/json",
				"User-Agent": "OpenAI/JS 6.26.0",
				"x-stainless-lang": "js",
			},
			body: JSON.stringify({}),
		});

		const headers = captured[0]?.headers;
		expect(headers?.get("user-agent")).toContain("OpenAI/JS");
		expect(headers?.get("x-stainless-lang")).toBe("js");
	});

	it("strips fingerprint headers when a custom fetch is provided for a compatible host", async () => {
		const captured: Request[] = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			const request = new Request(input, init);
			captured.push(request);
			return new Response("ok", { status: 200 });
		};

		const fetch = createOpenAICompatibleFetch("https://proxy.example.com/v1", fetchImpl as typeof globalThis.fetch);
		await fetch?.("https://proxy.example.com/v1/responses", {
			method: "POST",
			headers: {
				Authorization: "Bearer token",
				"Content-Type": "application/json",
				"User-Agent": "OpenAI/JS 6.26.0",
				"x-stainless-runtime": "node",
			},
			body: JSON.stringify({}),
		});

		const headers = captured[0]?.headers;
		expect(headers?.get("user-agent")).toBeNull();
		expect(headers?.get("x-stainless-runtime")).toBeNull();
		expect(headers?.get("authorization")).toBe("Bearer token");
	});

	it("keeps a custom fetch unchanged for api.openai.com", async () => {
		const fetchImpl = async () => new Response("ok", { status: 200 });

		const fetch = createOpenAICompatibleFetch("https://api.openai.com/v1", fetchImpl as typeof globalThis.fetch);

		expect(fetch).toBe(fetchImpl);
	});
});
