/**
 * useStatuses Hook
 *
 * React hook to load and manage workspace statuses.
 * Auto-refreshes when workspace changes.
 */

import type { StatusConfig } from '@craft-agent/shared/statuses'
import { clearIconCache } from '@/config/session-status-config'
import { useWorkspaceEntity } from './useWorkspaceEntity'

export interface UseStatusesResult {
  statuses: StatusConfig[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Load statuses for a workspace via IPC
 * Auto-refreshes when workspaceId changes
 *
 * To detect agent edits to status config files, you could:
 * - Poll periodically (simple)
 * - Use file watcher in main process (more complex but real-time)
 */
export function useStatuses(workspaceId: string | null): UseStatusesResult {
  const { data, isLoading, error, refresh } = useWorkspaceEntity<StatusConfig[]>({
    workspaceId,
    fetcher: (wid) => window.electronAPI.listStatuses(wid!),
    subscribe: (wid, onChange) =>
      window.electronAPI.onStatusesChanged((changedWorkspaceId) => {
        // Only refresh if this is our workspace
        if (changedWorkspaceId === wid) {
          clearIconCache() // Clear cached icon files before refreshing
          onChange()
        }
      }),
    tag: 'useStatuses',
  })

  return {
    statuses: data ?? [],
    isLoading,
    error,
    refresh,
  }
}
