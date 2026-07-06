/**
 * useLabels Hook
 *
 * React hook to load and manage workspace labels.
 * Returns the label tree (nested structure with children) from config.
 * Also exposes a flattened version for components that need flat lookups.
 * Auto-refreshes when workspace changes or label config changes.
 */

import { useMemo } from 'react'
import type { LabelConfig } from '@craft-agent/shared/labels'
import { flattenLabels } from '@craft-agent/shared/labels'
import { useWorkspaceEntity } from './useWorkspaceEntity'

export interface UseLabelsResult {
  /** Label tree (root-level nodes with nested children) */
  labels: LabelConfig[]
  /** Flattened label list for lookups and non-hierarchical display */
  flatLabels: LabelConfig[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Load labels for a workspace via IPC.
 * Returns the tree structure (labels with nested children).
 * Auto-refreshes when workspaceId changes.
 * Subscribes to live label config changes via LABELS_CHANGED event.
 */
export function useLabels(workspaceId: string | null): UseLabelsResult {
  const { data, isLoading, error, refresh } = useWorkspaceEntity<LabelConfig[]>({
    workspaceId,
    fetcher: (wid) => window.electronAPI.listLabels(wid!),
    subscribe: (wid, onChange) =>
      window.electronAPI.onLabelsChanged((changedWorkspaceId) => {
        // Only refresh if this is our workspace
        if (changedWorkspaceId === wid) onChange()
      }),
    tag: 'useLabels',
  })

  const labels = data ?? []

  // Memoized flat version of the tree for lookups
  const flatLabels = useMemo(() => flattenLabels(labels), [labels])

  return {
    labels,
    flatLabels,
    isLoading,
    error,
    refresh,
  }
}
