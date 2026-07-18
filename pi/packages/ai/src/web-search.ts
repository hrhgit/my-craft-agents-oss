import type { Api, Model } from "./types.ts";

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
	return supportsBuiltinWebSearchApi(model.api);
}
