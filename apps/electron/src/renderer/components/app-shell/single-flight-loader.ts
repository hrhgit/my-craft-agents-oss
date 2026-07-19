interface CacheEntry<T> {
  value?: T
  expiresAt: number
  inFlight?: Promise<T>
}

export interface SingleFlightLoader<T> {
  load: (key: string, options?: { force?: boolean }) => Promise<T>
}

/** Shares in-flight work and briefly reuses completed results for one keyed resource. */
export function createSingleFlightLoader<T>(
  fetchValue: (key: string) => Promise<T>,
  options: { cacheTtlMs: number; now?: () => number },
): SingleFlightLoader<T> {
  const entries = new Map<string, CacheEntry<T>>()
  const now = options.now ?? Date.now

  return {
    load(key, loadOptions) {
      const existing = entries.get(key)
      if (existing?.inFlight) return existing.inFlight
      if (!loadOptions?.force && existing?.value !== undefined && existing.expiresAt > now()) {
        return Promise.resolve(existing.value)
      }

      const entry = existing ?? { expiresAt: 0 }
      const inFlight = fetchValue(key).then(
        (value) => {
          if (entry.inFlight === inFlight) {
            entry.value = value
            entry.expiresAt = now() + options.cacheTtlMs
            entry.inFlight = undefined
            entries.set(key, entry)
          }
          return value
        },
        (error: unknown) => {
          if (entry.inFlight === inFlight) {
            entry.inFlight = undefined
            if (entry.value === undefined) entries.delete(key)
          }
          throw error
        },
      )

      entry.inFlight = inFlight
      entries.set(key, entry)
      return inFlight
    },
  }
}
