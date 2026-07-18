import { lookup as dnsLookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import type { Readability as ReadabilityInstance } from "@mozilla/readability";
import type { ConstructorOptions, JSDOM as JSDOMInstance } from "jsdom";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const DEFAULT_MAX_CHARS = 16000;
const HARD_MAX_CHARS = 32000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const require = createRequire(import.meta.url);

const SUPPORTED_HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const UNSUPPORTED_BINARY_PREFIXES = ["image/"];
const UNSUPPORTED_BINARY_TYPES = new Set(["application/pdf"]);

const webFetchSchema = Type.Object({
	url: Type.String({ description: "Public http or https URL to fetch" }),
	mode: Type.Optional(
		Type.Union([Type.Literal("main"), Type.Literal("text"), Type.Literal("raw")], {
			description: "Extraction mode: main article text, plain text, or raw response text",
		}),
	),
	maxChars: Type.Optional(Type.Number({ description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS})` })),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	status: number;
	finalUrl: string;
	contentType: string;
	bytes: number;
	truncated: boolean;
}

type LookupRecord = { address: string; family: number };

type ReadabilityConstructor = new (document: Document) => ReadabilityInstance;

interface ReadabilityModule {
	Readability: ReadabilityConstructor;
}

type JSDOMConstructor = new (html?: string, options?: ConstructorOptions) => JSDOMInstance;

interface JSDOMModule {
	JSDOM: JSDOMConstructor;
}

let readabilityModule: ReadabilityModule | undefined;
let jsdomModule: JSDOMModule | undefined;

function getReadabilityConstructor(): ReadabilityConstructor {
	readabilityModule ??= require("@mozilla/readability") as ReadabilityModule;
	return readabilityModule.Readability;
}

function getJSDOMConstructor(): JSDOMConstructor {
	jsdomModule ??= require("jsdom") as JSDOMModule;
	return jsdomModule.JSDOM;
}

export interface WebFetchOperations {
	fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
	lookup: (hostname: string) => Promise<LookupRecord[]>;
}

const defaultWebFetchOperations: WebFetchOperations = {
	fetch: (input, init) => fetch(input, init),
	lookup: async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
};

export interface WebFetchToolOptions {
	operations?: WebFetchOperations;
}

type WebFetchMode = "main" | "text" | "raw";

function normalizeMode(mode: string | undefined): WebFetchMode {
	return mode === "text" || mode === "raw" ? mode : "main";
}

function clampMaxChars(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return DEFAULT_MAX_CHARS;
	}

	return Math.max(1, Math.min(HARD_MAX_CHARS, Math.floor(value)));
}

function normalizeContentType(contentTypeHeader: string | null): string {
	return contentTypeHeader?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function normalizeText(text: string): string {
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function isTextResponse(contentType: string): boolean {
	return (
		contentType === "application/json" ||
		contentType.endsWith("+json") ||
		contentType.endsWith("+xml") ||
		contentType.startsWith("text/")
	);
}

function isUnsupportedBinary(contentType: string): boolean {
	return (
		UNSUPPORTED_BINARY_TYPES.has(contentType) ||
		UNSUPPORTED_BINARY_PREFIXES.some((prefix) => contentType.startsWith(prefix))
	);
}

function extractHtmlContent(html: string, finalUrl: string, mode: WebFetchMode): { title: string; body: string } {
	const JSDOM = getJSDOMConstructor();

	if (mode === "raw") {
		const dom = new JSDOM(html, { url: finalUrl });
		try {
			return {
				title: normalizeText(dom.window.document.title),
				body: html,
			};
		} finally {
			dom.window.close();
		}
	}

	const dom = new JSDOM(html, { url: finalUrl });
	try {
		const document = dom.window.document;
		const fallbackTitle = normalizeText(document.title);
		const fallbackBody = normalizeText(document.body?.textContent ?? "");

		if (mode === "text") {
			return {
				title: fallbackTitle,
				body: fallbackBody,
			};
		}

		const Readability = getReadabilityConstructor();
		const article = new Readability(document).parse();
		return {
			title: normalizeText(article?.title || fallbackTitle),
			body: normalizeText(article?.textContent || fallbackBody),
		};
	} finally {
		dom.window.close();
	}
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}

	return {
		text: `${text.slice(0, maxChars).trimEnd()}\n\n[Truncated at ${maxChars} characters]`,
		truncated: true,
	};
}

function formatOutput(title: string, finalUrl: string, contentType: string, body: string): string {
	const normalizedTitle = title || "(untitled)";
	const normalizedBody = body || "(no content extracted)";
	return `Title: ${normalizedTitle}\nURL: ${finalUrl}\nContent-Type: ${contentType}\n\n${normalizedBody}`;
}

function createBlockedResult(
	finalUrl: string,
	reason: string,
): { content: { type: "text"; text: string }[]; details: WebFetchToolDetails } {
	return {
		content: [{ type: "text", text: `Blocked URL: ${reason}` }],
		details: {
			status: 0,
			finalUrl,
			contentType: "blocked",
			bytes: 0,
			truncated: false,
		},
	};
}

function parseIpv4(address: string): number[] | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	const octets = parts.map((part) => Number.parseInt(part, 10));
	return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? octets : undefined;
}

function isBlockedIpv4(address: string): boolean {
	const octets = parseIpv4(address);
	if (!octets) return true;

	const [a, b, c, d] = octets;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 0 && c === 0) return true;
	if (a === 192 && b === 0 && c === 2) return true;
	if (a === 192 && b === 88 && c === 99) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a === 198 && b === 51 && c === 100) return true;
	if (a === 203 && b === 0 && c === 113) return true;
	if (a >= 224) return true;
	if (a === 255 && b === 255 && c === 255 && d === 255) return true;
	return false;
}

function isBlockedIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized === "::" || normalized === "::1") return true;
	if (
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	) {
		return true;
	}
	if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")) {
		return true;
	}
	if (normalized.startsWith("2001:db8")) return true;

	const mappedPrefix = "::ffff:";
	if (normalized.startsWith(mappedPrefix)) {
		return isBlockedIpv4(normalized.slice(mappedPrefix.length));
	}

	return false;
}

function isBlockedIpAddress(address: string): boolean {
	switch (isIP(address)) {
		case 4:
			return isBlockedIpv4(address);
		case 6:
			return isBlockedIpv6(address);
		default:
			return true;
	}
}

async function validatePublicUrl(url: URL, operations: WebFetchOperations): Promise<string | undefined> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return `unsupported protocol ${url.protocol}`;
	}

	const hostname = url.hostname.toLowerCase();
	if (!hostname) {
		return "missing hostname";
	}

	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		return "localhost is not allowed";
	}

	if (isIP(hostname)) {
		return isBlockedIpAddress(hostname) ? `blocked IP address ${hostname}` : undefined;
	}

	let records: LookupRecord[];
	try {
		records = await operations.lookup(hostname);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}

	if (records.length === 0) {
		return "hostname did not resolve";
	}

	for (const record of records) {
		if (isBlockedIpAddress(record.address)) {
			return `hostname resolved to blocked address ${record.address}`;
		}
	}

	return undefined;
}

async function readBody(
	response: Response,
	signal: AbortSignal | undefined,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!response.body) {
		return { bytes: new Uint8Array(), truncated: false };
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			if (total + value.length > MAX_BODY_BYTES) {
				const remaining = MAX_BODY_BYTES - total;
				if (remaining > 0) {
					chunks.push(value.subarray(0, remaining));
					total += remaining;
				}
				truncated = true;
				await reader.cancel();
				break;
			}

			chunks.push(value);
			total += value.length;
		}
	} finally {
		reader.releaseLock();
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}

	return { bytes: merged, truncated };
}

function formatWebFetchCall(args: { url?: string; mode?: string } | undefined, theme: Theme): string {
	const url = str(args?.url);
	const invalidArg = invalidArgText(theme);
	const displayUrl =
		url === null ? invalidArg : url ? theme.fg("accent", shortenPath(url)) : theme.fg("toolOutput", "...");
	const mode = normalizeMode(args?.mode);
	return `${theme.fg("toolTitle", theme.bold("web_fetch"))} ${displayUrl}${theme.fg("toolOutput", ` [${mode}]`)}`;
}

function formatWebFetchResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: WebFetchToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";

	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 20;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;

	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}

	if (result.details?.truncated) {
		text += `\n${theme.fg("warning", `[Truncated response body]`)}`;
	}

	return text;
}

export function createWebFetchToolDefinition(
	_cwd: string,
	options?: WebFetchToolOptions,
): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails> {
	const operations = options?.operations ?? defaultWebFetchOperations;

	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a public web page or text resource over HTTP(S) and return extracted text. HTML pages use article extraction by default. Localhost, private networks, PDFs, images, and binary content are blocked.",
		promptSnippet: "Fetch and extract text from public URLs",
		promptGuidelines: [
			"Use web_fetch for specific public URLs when you need the page contents themselves, not search results.",
		],
		parameters: webFetchSchema,
		async execute(_toolCallId, input, signal) {
			const mode = normalizeMode(input.mode);
			const maxChars = clampMaxChars(input.maxChars);

			let initialUrl: URL;
			try {
				initialUrl = new URL(input.url);
			} catch {
				throw new Error(`Invalid URL: ${input.url}`);
			}

			const blockedReason = await validatePublicUrl(initialUrl, operations);
			if (blockedReason) {
				return createBlockedResult(initialUrl.toString(), blockedReason);
			}

			const abortController = new AbortController();
			const timeout = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);
			const onAbort = () => abortController.abort();
			signal?.addEventListener("abort", onAbort, { once: true });

			try {
				let currentUrl = initialUrl;
				let response: Response | undefined;

				for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
					response = await operations.fetch(currentUrl, {
						method: "GET",
						redirect: "manual",
						signal: abortController.signal,
						headers: {
							accept: "text/html, text/plain, application/json;q=0.9, text/*;q=0.8",
						},
					});

					if (response.status >= 300 && response.status < 400) {
						const location = response.headers.get("location");
						if (!location) {
							throw new Error(`Redirect response missing Location header from ${currentUrl.toString()}`);
						}
						if (redirectCount === MAX_REDIRECTS) {
							throw new Error(`Too many redirects while fetching ${input.url}`);
						}

						currentUrl = new URL(location, currentUrl);
						const redirectBlockedReason = await validatePublicUrl(currentUrl, operations);
						if (redirectBlockedReason) {
							return createBlockedResult(currentUrl.toString(), redirectBlockedReason);
						}
						continue;
					}

					break;
				}

				if (!response) {
					throw new Error(`Failed to fetch ${input.url}`);
				}

				const finalUrl = response.url || currentUrl.toString();
				const contentType = normalizeContentType(response.headers.get("content-type"));

				if (
					isUnsupportedBinary(contentType) ||
					(!SUPPORTED_HTML_TYPES.has(contentType) && !isTextResponse(contentType))
				) {
					return {
						content: [{ type: "text", text: `Unsupported content type: ${contentType}` }],
						details: {
							status: response.status,
							finalUrl,
							contentType,
							bytes: Number.parseInt(response.headers.get("content-length") || "0", 10) || 0,
							truncated: false,
						},
					};
				}

				const { bytes, truncated: bodyTruncated } = await readBody(response, signal);
				const rawText = new TextDecoder().decode(bytes);

				let title = "";
				let content = "";
				if (SUPPORTED_HTML_TYPES.has(contentType)) {
					const extracted = extractHtmlContent(rawText, finalUrl, mode);
					title = extracted.title;
					content = extracted.body;
				} else {
					content = mode === "raw" ? rawText : normalizeText(rawText);
				}

				const truncatedContent = truncateText(content, maxChars);
				return {
					content: [
						{
							type: "text",
							text: formatOutput(title, finalUrl, contentType, truncatedContent.text),
						},
					],
					details: {
						status: response.status,
						finalUrl,
						contentType,
						bytes: bytes.byteLength,
						truncated: bodyTruncated || truncatedContent.truncated,
					},
				};
			} catch (error) {
				if (abortController.signal.aborted || signal?.aborted) {
					throw new Error("Operation aborted");
				}

				throw error instanceof Error ? error : new Error(String(error));
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatWebFetchCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatWebFetchResult(
					result as {
						content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
						details?: WebFetchToolDetails;
					},
					options,
					theme,
					context.showImages,
				),
			);
			return text;
		},
	};
}

export function createWebFetchTool(
	cwd: string,
	options?: WebFetchToolOptions,
): AgentTool<typeof webFetchSchema, WebFetchToolDetails> {
	return wrapToolDefinition(createWebFetchToolDefinition(cwd, options));
}
