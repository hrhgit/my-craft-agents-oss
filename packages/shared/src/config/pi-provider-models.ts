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
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface PiGlobalProvider {
  baseUrl?: string;
  api?: PiCustomApi;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: PiGlobalModel[];
  [key: string]: unknown;
}

export function piProviderModelSupportsImages(
  provider: PiGlobalProvider | null | undefined,
  modelId: string,
): boolean {
  const model = provider?.models?.find(candidate => candidate.id === modelId);
  return Array.isArray(model?.input) && model.input.includes('image');
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
