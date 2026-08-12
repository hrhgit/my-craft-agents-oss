/**
 * Format token count for display (e.g., 1500 -> "1.5k", 200000 -> "200k").
 * Shared by the desktop model dropdown and the compact (drawer) model picker.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  }
  return tokens.toString()
}

/**
 * Strip the "pi/" prefix from model IDs/display names so the user sees a
 * provider-agnostic label in the picker (e.g., "pi/claude-opus" → "claude-opus").
 */
export function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

export function groupProviders<T>(providers: readonly T[]): Array<[string, T[]]> {
  return providers.length > 0 ? [['Providers', [...providers]]] : []
}

export function resolveEffectiveProvider<T extends { key: string }>(
  sessionProvider: string | undefined,
  defaultProvider: string | undefined,
  providers: readonly T[],
): string | undefined {
  if (sessionProvider && providers.some(entry => entry.key === sessionProvider)) return sessionProvider
  if (defaultProvider && providers.some(entry => entry.key === defaultProvider)) return defaultProvider
  return providers[0]?.key
}

export interface TaggedModelEntry {
  providerKey: string
  modelId: string
  modelName: string
  tags: string[]
}

/**
 * Collect every tagged model across providers for the single-level tagged
 * model list ("仅显示标签模型" mode). Models without tags are excluded.
 */
export function collectTaggedModels<T extends { key: string; provider: { models?: Array<{ id: string; name?: string; tags?: unknown }> } }>(
  providers: readonly T[],
): TaggedModelEntry[] {
  const entries: TaggedModelEntry[] = []
  for (const entry of providers) {
    for (const model of entry.provider.models ?? []) {
      const tags = Array.isArray(model.tags)
        ? model.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        : []
      if (tags.length === 0) continue
      entries.push({
        providerKey: entry.key,
        modelId: model.id,
        modelName: model.name ?? model.id,
        tags,
      })
    }
  }
  return entries
}
