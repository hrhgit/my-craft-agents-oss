/**
 * useShowTaggedModelsOnly Hook
 *
 * Loads and persists the "仅显示标签模型" model-picker preference
 * (shellGui.mortise.showTaggedModelsOnly in ~/.mortise/agent/settings.json).
 * The value is owned by AppShell state so the settings page toggle and the
 * session model picker stay in sync within the same renderer process.
 */

import * as React from 'react'

export interface ShowTaggedModelsOnlyResult {
  showTaggedModelsOnly: boolean
  setShowTaggedModelsOnly: (enabled: boolean) => Promise<void>
}

export function useShowTaggedModelsOnly(): ShowTaggedModelsOnlyResult {
  const [showTaggedModelsOnly, setValue] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    window.electronAPI
      ?.getShowTaggedModelsOnly()
      .then(value => {
        if (!cancelled) setValue(value)
      })
      .catch(error => {
        console.error('Failed to load showTaggedModelsOnly:', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setShowTaggedModelsOnly = React.useCallback(async (enabled: boolean) => {
    if (!window.electronAPI) return
    setValue(enabled)
    try {
      await window.electronAPI.setShowTaggedModelsOnly(enabled)
    } catch (error) {
      console.error('Failed to persist showTaggedModelsOnly:', error)
      setValue(!enabled)
      throw error
    }
  }, [])

  return { showTaggedModelsOnly, setShowTaggedModelsOnly }
}
