import { IMAGE_MODELS } from "./image-models.generated.ts";
import type { ImagesApi, ImagesModel, ImagesProvider, KnownImagesProvider } from "./types.ts";

const imageModelRegistry: Map<string, Map<string, ImagesModel<ImagesApi>>> = new Map();

for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	const providerModels = new Map<string, ImagesModel<ImagesApi>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as ImagesModel<ImagesApi>);
	}
	imageModelRegistry.set(provider, providerModels);
}

export function getImageModel<TApi extends ImagesApi = ImagesApi>(
	provider: ImagesProvider,
	modelId: string,
): ImagesModel<TApi> {
	const providerModels = imageModelRegistry.get(provider);
	return providerModels?.get(modelId) as ImagesModel<TApi>;
}

export function getImageProviders(): KnownImagesProvider[] {
	return Array.from(imageModelRegistry.keys()) as KnownImagesProvider[];
}

export function getImageModels<TApi extends ImagesApi = ImagesApi>(provider: ImagesProvider): ImagesModel<TApi>[] {
	const models = imageModelRegistry.get(provider);
	return models ? (Array.from(models.values()) as ImagesModel<TApi>[]) : [];
}
