/**
 * usePiGlobalConfig Hook
 *
 * Loads Pi CLI global config from ~/.pi/agent/ (models.json + settings.json)
 * via the dedicated RPC channel. Subscribes to GLOBAL_CHANGED broadcasts so
 * external edits (e.g. via the `pi` CLI or cc-switch) refresh the UI live.
 *
 * This is the single source of truth for "pure Pi + custom provider" mode —
 * the desktop reads ~/.pi/agent/ directly instead of ~/.craft-agent/config.json.
 */

import { useState, useEffect, useCallback } from 'react'
import type {
  PiGlobalProviderForDisplay,
  PiGlobalSettings,
} from '../../shared/types'

export interface UsePiGlobalConfigResult {
  providers: PiGlobalProviderForDisplay[]
  settings: PiGlobalSettings
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function usePiGlobalConfig(): UsePiGlobalConfigResult {
  const [providers, setProviders] = useState<PiGlobalProviderForDisplay[]>([])
  const [settings, setSettings] = useState<PiGlobalSettings>({})
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      setIsLoading(true)
      const [list, s] = await Promise.all([
        window.electronAPI.getPiGlobalProviders(),
        window.electronAPI.getPiGlobalSettings(),
      ])
      setProviders(list)
      setSettings(s)
      setError(null)
    } catch (err) {
      console.error('[usePiGlobalConfig] Failed to load:', err)
      setError(err instanceof Error ? err.message : 'Failed to load Pi global config')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!window.electronAPI) return
    const cleanup = window.electronAPI.onPiGlobalChanged(() => {
      refresh()
    })
    return cleanup
  }, [refresh])

  return { providers, settings, isLoading, error, refresh }
}
