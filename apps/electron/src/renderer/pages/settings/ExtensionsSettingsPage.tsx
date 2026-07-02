import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { LlmConnectionWithStatus, PiExtensionSettings, StoredPiExtensionSettings } from '../../../shared/types'
import { mergePiExtensionSettings } from '@craft-agent/shared/config/pi-extension-settings'
import { ExtensionListPanel } from './PiExtensionsSettingsPanel'
import { ExtensionDetailPanel } from './ExtensionDetailPanel'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'extensions',
}

export default function ExtensionsSettingsPage() {
  const { t } = useTranslation()
  const [piExtensionSettings, setPiExtensionSettings] = useState<PiExtensionSettings | null>(null)
  const [llmConnections, setLlmConnections] = useState<LlmConnectionWithStatus[]>([])
  const [extensionStates, setExtensionStates] = useState<Record<string, boolean>>({})
  const [selectedExtensionId, setSelectedExtensionId] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false

    async function load() {
      try {
        const [settings, connections, states] = await Promise.all([
          window.electronAPI.getPiExtensionSettings(),
          window.electronAPI.listLlmConnectionsWithStatus(),
          window.electronAPI.getPiExtensionStates(),
        ])
        if (disposed) return
        setPiExtensionSettings(settings)
        setLlmConnections(connections)
        setExtensionStates(states)
      } catch (error) {
        console.error('Failed to load extension settings:', error)
        toast.error('Failed to load extension settings')
      }
    }

    load()
    return () => { disposed = true }
  }, [])

  const handlePatch = useCallback(async (patch: StoredPiExtensionSettings) => {
    const previous = piExtensionSettings
    if (previous) {
      setPiExtensionSettings(mergePiExtensionSettings(previous, patch))
    }
    try {
      const next = await window.electronAPI.updatePiExtensionSettings(patch)
      setPiExtensionSettings(next)
    } catch (error) {
      if (previous) setPiExtensionSettings(previous)
      console.error('Failed to update extension settings:', error)
      toast.error('Failed to save extension settings')
    }
  }, [piExtensionSettings])

  const handleToggleExtension = useCallback(async (id: string, enabled: boolean) => {
    const previous = extensionStates
    setExtensionStates(prev => ({ ...prev, [id]: enabled }))
    try {
      await window.electronAPI.setPiExtensionEnabled(id, enabled)
    } catch (error) {
      setExtensionStates(previous)
      console.error('Failed to toggle extension:', error)
      toast.error('Failed to save extension state')
    }
  }, [extensionStates])

  const handleBack = useCallback(() => {
    setSelectedExtensionId(null)
  }, [])

  const isDetailView = selectedExtensionId !== null && piExtensionSettings !== null

  return (
    <div className="flex flex-col h-full bg-background">
      <PanelHeader
        title={isDetailView ? selectedExtensionId! : t('settings.extensions.title')}
        actions={<HeaderMenu route={routes.view.settings('extensions')} />}
      />
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {isDetailView ? (
            <ExtensionDetailPanel
              extensionId={selectedExtensionId!}
              settings={piExtensionSettings!}
              llmConnections={llmConnections}
              onPatch={handlePatch}
              onBack={handleBack}
            />
          ) : (
            <ExtensionListPanel
              extensionStates={extensionStates}
              onToggleExtension={handleToggleExtension}
              onSelectExtension={setSelectedExtensionId}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
