import { MODELS } from "./models.generated.ts";
import type { Api, KnownProvider, Model, Provider } from "./types.ts";

export { calculateCost, clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual } from "./model-utils.ts";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// Initialize registry from MODELS on module load
for (const [provider, models] of Object.entries(MODELS)) {
	const providerModels = new Map<string, Model<Api>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as Model<Api>);
	}
	modelRegistry.set(provider, providerModels);
}

type ProviderApi<TProvider extends Provider, TModelId extends string> = TProvider extends "amazon-bedrock"
	? "bedrock-converse-stream"
	: TProvider extends "anthropic" | "fireworks" | "vercel-ai-gateway"
		? "anthropic-messages"
		: TProvider extends "github-copilot"
			? TModelId extends `claude-${string}-4${string}`
				? "anthropic-messages"
				: TModelId extends `gpt-5${string}` | `oswe${string}`
					? "openai-responses"
					: "openai-completions"
			: TProvider extends "xiaomi" | `xiaomi-token-plan-${string}`
				? "openai-completions"
				: TProvider extends "google"
					? "google-generative-ai"
					: TProvider extends "google-vertex"
						? "google-vertex"
						: TProvider extends "openai"
							? "openai-responses"
							: TProvider extends "azure-openai-responses"
								? "azure-openai-responses"
								: TProvider extends "openai-codex"
									? "openai-codex-responses"
									: TProvider extends "mistral"
										? "mistral-conversations"
										: TProvider extends KnownProvider
											? "openai-completions"
											: Api;

export function getModel<TProvider extends Provider, TModelId extends string>(
	provider: TProvider,
	modelId: TModelId,
): Model<ProviderApi<TProvider, TModelId>> {
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId) as Model<ProviderApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends Provider>(provider: TProvider): Model<ProviderApi<TProvider, string>>[] {
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ProviderApi<TProvider, string>>[]) : [];
}
