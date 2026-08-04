/**
 * usePiGlobalConfig Hook
 *
 * Loads Mortise-owned Pi runtime config from ~/.mortise/agent/ (models.json + settings.json)
 * via the dedicated RPC channel. Subscribes to GLOBAL_CHANGED broadcasts so
 * external edits (e.g. via the `pi` CLI or cc-switch) refresh the UI live.
 *
 * This is the single source of truth for "pure Pi + custom provider" mode —
 * the desktop reads ~/.mortise/agent/ directly instead of ~/.mortise/config.json.
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

export interface UsePiGlobalConfigOptions {
  /** Disable live reloads when a caller applies its own local mutation state. */
  subscribe?: boolean
}

const EMPTY_PROVIDERS: PiGlobalProviderForDisplay[] = []
const EMPTY_SETTINGS: PiGlobalSettings = {}

export function usePiGlobalConfig({ subscribe = true }: UsePiGlobalConfigOptions = {}): UsePiGlobalConfigResult {
  // No workspaceId: global config. `undefined` tells useWorkspaceEntity to fetch
  // without workspace scoping. Callers can opt out of global change broadcasts
  // when they update the current view locally after a successful mutation.
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
    subscribe: subscribe ? (_wid, onChange) => {
      if (!window.electronAPI) return () => {}
      return window.electronAPI.onPiGlobalChanged(onChange)
    } : undefined,
    tag: 'usePiGlobalConfig',
  })

  return {
    providers: data?.providers ?? EMPTY_PROVIDERS,
    settings: data?.settings ?? EMPTY_SETTINGS,
    isLoading,
    error,
    refresh,
  }
}
