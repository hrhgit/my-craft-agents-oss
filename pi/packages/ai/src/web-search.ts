import type { Api, Model, Provider, WebSearchErrorKind } from "./types.ts";

export type WebSearchMode = "auto" | "native" | "extension" | "disabled";

export type WebSearchCapability = {
	mode: "native" | "unsupported" | "unknown";
	provider: Provider;
	api: Api;
	endpointClass: "official" | "compatible" | "unknown";
	model: string;
	reason?: string;
};

const BUILTIN_WEB_SEARCH_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
]);

export function supportsBuiltinWebSearchApi(api: Api): boolean {
	return BUILTIN_WEB_SEARCH_APIS.has(api);
}

export function supportsBuiltinWebSearch(model: Model<Api>): boolean {
	return resolveWebSearchCapability(model).mode === "native";
}

function endpointClass(model: Model<Api>): WebSearchCapability["endpointClass"] {
	const baseUrl = model.baseUrl?.toLowerCase() ?? "";
	if (!baseUrl) return "unknown";
	if (
		(model.api === "openai-responses" && /api\.openai\.com/.test(baseUrl)) ||
		(model.api === "azure-openai-responses" && /\.openai\.azure\.com/.test(baseUrl)) ||
		(model.api === "openai-codex-responses" && /chatgpt\.com|openai\.com/.test(baseUrl)) ||
		(model.api === "anthropic-messages" && /api\.anthropic\.com/.test(baseUrl)) ||
		(model.api === "google-generative-ai" && /generativelanguage\.googleapis\.com/.test(baseUrl)) ||
		(model.api === "google-vertex" && /aiplatform\.googleapis\.com/.test(baseUrl))
	) {
		return "official";
	}
	return "compatible";
}

export function resolveWebSearchCapability(model: Model<Api>): WebSearchCapability {
	const endpoint = endpointClass(model);
	if (supportsBuiltinWebSearchApi(model.api) && endpoint === "official") {
		return {
			mode: "native",
			provider: model.provider,
			api: model.api,
			endpointClass: endpoint,
			model: model.id,
		};
	}
	if (supportsBuiltinWebSearchApi(model.api)) {
		return {
			mode: "unknown",
			provider: model.provider,
			api: model.api,
			endpointClass: endpoint,
			model: model.id,
			reason: "搜索能力仅对官方端点默认开启",
		};
	}
	return {
		mode: "unsupported",
		provider: model.provider,
		api: model.api,
		endpointClass: endpoint,
		model: model.id,
		reason: `API ${model.api} 未声明原生网页搜索能力`,
	};
}

export function resolveWebSearchMode(
	mode: WebSearchMode,
	model: Model<Api> | undefined,
): { native: boolean; extension: boolean; capability?: WebSearchCapability; reason?: string } {
	if (mode === "disabled") return { native: false, extension: false };
	if (mode === "extension") return { native: false, extension: true };
	const capability = model ? resolveWebSearchCapability(model) : undefined;
	if (mode === "native") {
		return capability?.mode === "native"
			? { native: true, extension: false, capability }
			: { native: false, extension: false, capability, reason: capability?.reason ?? "当前模型未提供原生网页搜索" };
	}
	if (capability?.mode === "native") return { native: true, extension: false, capability };
	if (capability?.mode === "unsupported") return { native: false, extension: true, capability };
	return { native: false, extension: false, capability, reason: capability?.reason ?? "搜索能力未知" };
}

export function classifyWebSearchError(error: unknown): WebSearchErrorKind {
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (/cancel(?:led|ed)|abort(?:ed)?|user.?cancel/i.test(message)) return "cancelled";
	if (
		/web[_ -]?search|web search/i.test(message) &&
		/unsupported|not supported|unknown tool|invalid tool|not available/i.test(message)
	) {
		return "unsupported";
	}
	if (
		/configuration|config(?:uration)? error|model not found|no model|missing (?:api|provider)|not configured/i.test(
			message,
		)
	) {
		return "configuration";
	}
	if (/401|403|unauthori[sz]ed|invalid api key|authentication/i.test(message)) return "authentication";
	if (/429|rate.?limit|too many requests/i.test(message)) return "rate_limit";
	if (/timeout|timed out/i.test(message)) return "timeout";
	if (/network|fetch failed|econnreset|enotfound|socket/i.test(message)) return "network";
	return "provider";
}
