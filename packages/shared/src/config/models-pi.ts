/**
 * Pi model/provider discovery wrapper.
 *
 * Mortise keeps this module as a stable import seam for existing handlers, but
 * all model/provider catalog semantics now come from Pi's host facade.
 */

import {
  getModelCatalog,
  isDeprecatedClaudeOpus46Model,
  type HostModelCatalogModel,
} from '@mortise/pi-coding-agent/host-facade';
import type { ModelDefinition } from './models.ts';

function piModelToDefinition(model: HostModelCatalogModel): ModelDefinition {
  return {
    id: model.id,
    name: model.name,
    shortName: model.shortName,
    description: `${model.provider} model via Pi`,
    provider: 'pi',
    contextWindow: model.contextWindow,
    supportsThinking: model.reasoning,
    supportsImages: (model.input ?? []).includes('image') || undefined,
  };
}

/**
 * Get Pi models for a specific auth provider from Pi's host facade.
 */
export function getPiModelsForAuthProvider(piAuthProvider: string): ModelDefinition[] {
  const provider = getModelCatalog({ provider: piAuthProvider }).providers[0];
  return provider ? provider.models.map(piModelToDefinition) : [];
}

/**
 * Get all Pi models across all providers from Pi's host facade.
 */
export function getAllPiModels(): ModelDefinition[] {
  return getModelCatalog().providers.flatMap(provider => provider.models.map(piModelToDefinition));
}

/** Info for a Pi provider available in the API key flow. */
export interface PiProviderInfo {
  key: string;
  label: string;
  placeholder: string;
}

/** Raw model metadata from one Pi SDK provider, normalized for host callers. */
export interface PiProviderCatalogModel {
  id: string;
  name: string;
  costInput: number;
  costOutput: number;
  contextWindow: number;
  reasoning: boolean;
}

/**
 * Get all Pi providers available for API key authentication.
 */
export function getPiApiKeyProviders(): PiProviderInfo[] {
  return getModelCatalog().apiKeyProviders;
}

/**
 * Get the base URL for a Pi provider, if Pi's catalog exposes one.
 */
export function getPiProviderBaseUrl(provider: string): string | undefined {
  return getModelCatalog({ provider }).providers[0]?.baseUrl;
}

/**
 * Get normalized model metadata for a specific Pi provider.
 */
export function getPiProviderCatalogModels(provider: string): PiProviderCatalogModel[] {
  return (getModelCatalog({ provider }).providers[0]?.models ?? []).map(model => ({
    id: model.id,
    name: model.name,
    costInput: model.cost?.input ?? 0,
    costOutput: model.cost?.output ?? 0,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
  }));
}

export { isDeprecatedClaudeOpus46Model };
