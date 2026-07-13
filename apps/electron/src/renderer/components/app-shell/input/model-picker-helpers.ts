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
