/**
 * Browser-safe provider model types and helpers.
 *
 * Keep this separate from pi-global-config.ts: that module reads Pi's files
 * through the host facade and must never be included in a renderer bundle.
 */

export type PiCustomApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export interface PiGlobalModel {
  id: string;
  name?: string;
  /** User-assigned display tags (e.g. 常用/快速/轻量). Tagged models appear
   * in the session model picker with tag badges and can be surfaced alone via
   * the "仅显示标签模型" mode. */
  tags?: string[];
  /** Another configured model (provider + model id) that acts as the
   * image-reading proxy for this model when it lacks image input capability. */
  visionProxy?: { provider: string; model: string };
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export function piProviderModelTags(
  provider: PiGlobalProvider | null | undefined,
  modelId: string,
): string[] {
  const model = provider?.models?.find(candidate => candidate.id === modelId);
  const tags = model?.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0) : [];
}

export function setPiProviderModelTags(
  provider: PiGlobalProvider,
  modelId: string,
  tags: string[],
): PiGlobalProvider {
  if (!provider.models?.some(model => model.id === modelId)) return provider;
  const normalized = [...new Set(tags.map(tag => tag.trim()).filter(Boolean))];
  return {
    ...provider,
    models: provider.models.map(model => {
      if (model.id !== modelId) return model;
      const next = { ...model };
      if (normalized.length > 0) next.tags = normalized;
      else delete next.tags;
      return next;
    }),
  };
}

export function piProviderModelVisionProxy(
  provider: PiGlobalProvider | null | undefined,
  modelId: string,
): { provider: string; model: string } | undefined {
  const model = provider?.models?.find(candidate => candidate.id === modelId);
  const value = model?.visionProxy;
  if (
    value
    && typeof value === 'object'
    && typeof (value as { provider?: unknown }).provider === 'string'
    && typeof (value as { model?: unknown }).model === 'string'
  ) {
    const { provider: proxyProvider, model: proxyModel } = value as { provider: string; model: string };
    if (proxyProvider.trim() && proxyModel.trim()) return { provider: proxyProvider.trim(), model: proxyModel.trim() };
  }
  return undefined;
}

export function setPiProviderModelVisionProxy(
  provider: PiGlobalProvider,
  modelId: string,
  visionProxy: { provider: string; model: string } | undefined,
): PiGlobalProvider {
  if (!provider.models?.some(model => model.id === modelId)) return provider;
  return {
    ...provider,
    models: provider.models.map(model => {
      if (model.id !== modelId) return model;
      const next = { ...model };
      if (visionProxy && visionProxy.provider.trim() && visionProxy.model.trim()) {
        next.visionProxy = { provider: visionProxy.provider.trim(), model: visionProxy.model.trim() };
      } else {
        delete next.visionProxy;
      }
      return next;
    }),
  };
}

export interface PiGlobalProvider {
  baseUrl?: string;
  api?: PiCustomApi;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: PiGlobalModel[];
  [key: string]: unknown;
}

/** Parse a context window entered as tokens or with a K/M suffix. */
export function parseContextWindowInput(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!match) return undefined;

  const amount = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2] ? 1_000 : 1;
  const result = amount * multiplier;
  return Number.isFinite(result) && result > 0 && Number.isInteger(result) ? result : undefined;
}

export function piProviderModelSupportsImages(
  provider: PiGlobalProvider | null | undefined,
  modelId: string,
): boolean {
  const model = provider?.models?.find(candidate => candidate.id === modelId);
  return Array.isArray(model?.input) && model.input.includes('image');
}

export function piProviderModelSupportsReasoning(
  provider: PiGlobalProvider | null | undefined,
  modelId: string,
): boolean {
  const model = provider?.models?.find(candidate => candidate.id === modelId);
  return model?.reasoning !== false;
}

export function setPiProviderModelSupportsImages(
  provider: PiGlobalProvider,
  modelId: string,
  enabled: boolean,
): PiGlobalProvider {
  if (!provider.models?.some(model => model.id === modelId)) return provider;
  return {
    ...provider,
    models: provider.models.map(model => {
      if (model.id !== modelId) return model;
      const input = new Set<'text' | 'image'>(model.input ?? ['text']);
      if (enabled) input.add('image');
      else input.delete('image');
      if (input.size === 0) input.add('text');
      return {
        ...model,
        input: ['text', 'image'].filter(kind => input.has(kind as 'text' | 'image')) as ('text' | 'image')[],
      };
    }),
  };
}

export function setPiProviderModelSupportsReasoning(
  provider: PiGlobalProvider,
  modelId: string,
  enabled: boolean,
): PiGlobalProvider {
  if (!provider.models?.some(model => model.id === modelId)) return provider;
  return {
    ...provider,
    models: provider.models.map(model => {
      if (model.id !== modelId) return model;
      if (!enabled) return { ...model, reasoning: false };
      const next = { ...model };
      delete next.reasoning;
      return next;
    }),
  };
}
