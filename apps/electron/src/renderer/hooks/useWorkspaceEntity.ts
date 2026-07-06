/**
 * useWorkspaceEntity
 *
 * Generic hook for loading workspace-scoped entities (labels, statuses, views,
 * global config, etc). Encapsulates the isLoading / error / refresh / subscribe
 * pattern duplicated across useLabels, useStatuses, useViews, usePiGlobalConfig.
 *
 * Workspace ID semantics:
 * - `string`  → workspace-scoped fetch (fetcher receives the id)
 * - `null`    → no workspace selected: skip fetch, clear data, stop loading
 * - `undefined` → global entity (not workspace-scoped): fetcher is still called
 *   (receives undefined) so global config hooks can reuse this machinery.
 *
 * The fetcher/subscribe callbacks are held in refs so that `refresh` only
 * depends on `workspaceId`. This mirrors the original hooks (whose refresh
 * depended solely on workspaceId) and allows callers to pass inline arrow
 * functions without triggering a refetch on every render.
 */

import { useState, useEffect, useCallback, useRef } from 'react'

export interface UseWorkspaceEntityOptions<T> {
  /** Workspace ID to scope the fetch. null = skip, undefined = global, string = scoped. */
  workspaceId: string | null | undefined
  /** Fetcher: receives the workspaceId (string | undefined) and returns entity or null. */
  fetcher: (workspaceId: string | undefined) => Promise<T | null>
  /** Optional: subscribe to live change events. Called when workspaceId changes. */
  subscribe?: (workspaceId: string | undefined, onChange: () => void) => () => void
  /** Tag for error logging (e.g. 'useLabels'). */
  tag: string
}

export interface UseWorkspaceEntityResult<T> {
  data: T | null
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useWorkspaceEntity<T>(
  options: UseWorkspaceEntityOptions<T>,
): UseWorkspaceEntityResult<T> {
  const { workspaceId, subscribe, tag } = options

  // Hold the latest fetcher/subscribe in refs so `refresh` stays stable across
  // renders (only re-created when workspaceId/tag changes). Inline arrow
  // functions passed by callers therefore don't cause refetch loops.
  const fetcherRef = useRef(options.fetcher)
  fetcherRef.current = options.fetcher
  const subscribeRef = useRef(subscribe)
  subscribeRef.current = subscribe

  const [data, setData] = useState<T | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Track the latest workspaceId so stale closures (old `refresh` instances
  // captured before workspaceId changed) can skip their setData/isLoading calls
  // instead of overwriting the new workspace's data (last-write-wins race).
  const workspaceIdRef = useRef(workspaceId)
  workspaceIdRef.current = workspaceId

  const refresh = useCallback(async () => {
    // null = no workspace selected: clear data and stop loading.
    // undefined = global entity: fall through and fetch.
    if (workspaceId === null) {
      setData(null)
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const result = await fetcherRef.current(workspaceId)
      // Stale closure: workspaceId changed while this fetch was in-flight.
      // Drop the result — the newer refresh's setData must win.
      if (workspaceIdRef.current !== workspaceId) return
      setData(result)
      setError(null)
    } catch (err) {
      if (workspaceIdRef.current !== workspaceId) return
      console.error(`[${tag}] Failed to load:`, err)
      setError(err instanceof Error ? err.message : `Failed to load ${tag}`)
    } finally {
      if (workspaceIdRef.current === workspaceId) setIsLoading(false)
    }
  }, [workspaceId, tag])

  // Load (or clear) whenever refresh changes — i.e. whenever workspaceId changes.
  // Staleness protection lives inside refresh via workspaceIdRef, so this
  // effect is a simple fire-and-forget.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Subscribe to live changes. Skipped for `null` (no workspace).
  useEffect(() => {
    if (workspaceId === null) return
    const sub = subscribeRef.current
    if (!sub) return
    const unsubscribe = sub(workspaceId, () => void refresh())
    return unsubscribe
  }, [workspaceId, refresh])

  return { data, isLoading, error, refresh }
}
