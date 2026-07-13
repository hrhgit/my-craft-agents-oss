import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { setPiProviderModelSupportsImages } from '@craft-agent/shared/config/pi-provider-models'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

export type ToggleModelVision = (
  providerKey: string,
  modelId: string,
  enabled: boolean,
) => Promise<void>

/**
 * Toggle per-model image support on a Pi provider.
 */
export function useModelVisionToggle(): ToggleModelVision {
  const { t } = useTranslation()
  const appShellCtx = useOptionalAppShellContext()
  const providers = appShellCtx?.piProviders ?? []
  const refresh = appShellCtx?.refreshPiGlobalConfig

  return React.useCallback(async (providerKey, modelId, enabled) => {
    if (!window.electronAPI) return
    const entry = providers.find(candidate => candidate.key === providerKey)
    if (!entry) return
    try {
      const updated = setPiProviderModelSupportsImages(entry.provider, modelId, enabled)
      const result = await window.electronAPI.savePiGlobalProvider({ key: providerKey, provider: updated })
      if (!result.success) {
        console.error('Failed to toggle model vision:', result.error)
        toast.error(t('chat.modelPicker.toggleVisionFailed'))
        return
      }
      await refresh?.()
    } catch (error) {
      console.error('Failed to toggle model vision:', error)
      toast.error(t('chat.modelPicker.toggleVisionFailed'))
    }
  }, [providers, refresh, t])
}
