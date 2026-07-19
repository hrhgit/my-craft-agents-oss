/**
 * usePiGlobalConfig Hook
 *
 * Loads Pi CLI global config from ~/.pi/agent/ (models.json + settings.json)
 * via the dedicated RPC channel. Subscribes to GLOBAL_CHANGED broadcasts so
 * external edits (e.g. via the `pi` CLI or cc-switch) refresh the UI live.
 *
 * This is the single source of truth for "pure Pi + custom provider" mode —
 * the desktop reads ~/.pi/agent/ directly instead of ~/.mortise/config.json.
 */

import type {
  PiGlobalProviderForDisplay,
  PiGlobalSettings,
} from '../../shared/types'
import { useWorkspaceEntity } from './useWorkspaceEntity'

interface PiGlobalConfigData {
  providers: PiGlobalProviderForDisplay[]
  settings: PiGlobalSettings
}

export interface UsePiGlobalConfigResult {
  providers: PiGlobalProviderForDisplay[]
  settings: PiGlobalSettings
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function usePiGlobalConfig(): UsePiGlobalConfigResult {
  // No workspaceId: global config. `undefined` tells useWorkspaceEntity to fetch
  // without workspace scoping (and still subscribe to global change events).
  const { data, isLoading, error, refresh } = useWorkspaceEntity<PiGlobalConfigData>({
    workspaceId: undefined,
    fetcher: async () => {
      if (!window.electronAPI) return null
      const [list, s] = await Promise.all([
        window.electronAPI.getPiGlobalProviders(),
        window.electronAPI.getPiGlobalSettings(),
      ])
      return { providers: list, settings: s }
    },
    subscribe: (_wid, onChange) => {
      if (!window.electronAPI) return () => {}
      return window.electronAPI.onPiGlobalChanged(onChange)
    },
    tag: 'usePiGlobalConfig',
  })

  return {
    providers: data?.providers ?? [],
    settings: data?.settings ?? {},
    isLoading,
    error,
    refresh,
  }
}
