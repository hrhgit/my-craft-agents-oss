import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { PiExtensionCatalogEntry, PiExtensionCatalogError, PiExtensionSettingScalar } from '@mortise/shared/config'
import { ExtensionListPanel } from './PiExtensionsSettingsPanel'
import { ExtensionDetailPanel } from './ExtensionDetailPanel'
import { usePiGlobalConfig } from '@/hooks/usePiGlobalConfig'
import { patchCatalogField } from './extension-settings-utils'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'extensions',
}

function configFieldId(extensionId: string, key: string): string {
  return JSON.stringify([extensionId, key])
}

function isSettingScalar(value: unknown): value is PiExtensionSettingScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

export default function ExtensionsSettingsPage() {
  const { t } = useTranslation()
  const { providers, settings: piSettings } = usePiGlobalConfig()
  const [extensionCatalog, setExtensionCatalog] = useState<PiExtensionCatalogEntry[]>([])
  const [extensionErrors, setExtensionErrors] = useState<PiExtensionCatalogError[]>([])
  const [extensionStates, setExtensionStates] = useState<Record<string, boolean>>({})
  const [selectedExtensionId, setSelectedExtensionId] = useState<string | null>(null)
  const configPatchQueues = useRef(new Map<string, Promise<void>>())
  const configPatchVersions = useRef(new Map<string, number>())
  const confirmedConfig = useRef(new Map<string, { present: boolean; value?: PiExtensionSettingScalar }>())
  const toggleVersions = useRef(new Map<string, number>())

  const loadCatalog = useCallback(async () => {
    const catalog = await window.electronAPI.getPiExtensionCatalog()
    setExtensionCatalog(catalog.extensions)
    setExtensionErrors(catalog.errors)
    setExtensionStates(Object.fromEntries(catalog.extensions.map((extension) => [extension.id, extension.enabled])))
    confirmedConfig.current.clear()
    for (const extension of catalog.extensions) {
      for (const [key, value] of Object.entries(extension.config ?? {})) {
        if (isSettingScalar(value)) confirmedConfig.current.set(configFieldId(extension.id, key), { present: true, value })
      }
    }
  }, [])

  useEffect(() => {
    void loadCatalog().catch((error) => {
      console.error('Failed to load extension settings:', error)
      toast.error(t('settings.extensions.loadFailed'))
    })
  }, [loadCatalog, t])

  const handleConfigPatch = useCallback(async (key: string, value?: PiExtensionSettingScalar) => {
    if (!selectedExtensionId) return
    const extensionId = selectedExtensionId
    const fieldId = configFieldId(extensionId, key)
    const version = (configPatchVersions.current.get(fieldId) ?? 0) + 1
    configPatchVersions.current.set(fieldId, version)
    setExtensionCatalog((entries) => entries.map((entry) => entry.id === extensionId
      ? { ...entry, config: value === undefined
        ? Object.fromEntries(Object.entries(entry.config ?? {}).filter(([entryKey]) => entryKey !== key))
        : { ...(entry.config ?? {}), [key]: value } }
      : entry))

    // The backend persists an extension config with read-modify-write semantics,
    // so all fields for one extension must share a queue.
    const previousRequest = configPatchQueues.current.get(extensionId) ?? Promise.resolve()
    const request = previousRequest.then(async () => {
      try {
        const result = await window.electronAPI.patchPiExtensionConfig({
          schemaVersion: 1,
          extensionId,
          ...(value === undefined ? { unset: [key] } : { set: { [key]: value } }),
        })
        const confirmedValue = isSettingScalar(result.config[key]) ? result.config[key] : undefined
        confirmedConfig.current.set(fieldId, confirmedValue === undefined ? { present: false } : { present: true, value: confirmedValue })
        if (configPatchVersions.current.get(fieldId) === version) {
          setExtensionCatalog((entries) => patchCatalogField(entries, extensionId, key, confirmedValue === undefined ? { present: false } : { present: true, value: confirmedValue }))
        }
      } catch (error) {
        let fallback = confirmedConfig.current.get(fieldId) ?? { present: false }
        try {
          // Saving may have succeeded before the response failed. Re-read persisted
          // state so the UI does not falsely roll back a durable change.
          const catalog = await window.electronAPI.getPiExtensionCatalog()
          const persistedConfig = catalog.extensions.find((entry) => entry.id === extensionId)?.config ?? {}
          fallback = Object.prototype.hasOwnProperty.call(persistedConfig, key) && isSettingScalar(persistedConfig[key])
            ? { present: true, value: persistedConfig[key] }
            : { present: false }
          confirmedConfig.current.set(fieldId, fallback)
        } catch {
          // Keep the last confirmed field value when the recovery read also fails.
        }
        if (configPatchVersions.current.get(fieldId) === version) {
          setExtensionCatalog((entries) => patchCatalogField(entries, extensionId, key, fallback))
        }
        console.error('Failed to update extension settings:', error)
        toast.error('Failed to save extension settings')
      } finally {
        if (configPatchQueues.current.get(extensionId) === request) configPatchQueues.current.delete(extensionId)
      }
    })
    configPatchQueues.current.set(extensionId, request)
    await request
  }, [selectedExtensionId])

  const handleToggleExtension = useCallback(async (id: string, enabled: boolean) => {
    const version = (toggleVersions.current.get(id) ?? 0) + 1
    toggleVersions.current.set(id, version)
    setExtensionStates(prev => ({ ...prev, [id]: enabled }))
    try {
      await window.electronAPI.setPiExtensionEnabled(id, enabled)
    } catch (error) {
      if (toggleVersions.current.get(id) === version) {
        try {
          await loadCatalog()
        } catch {
          setExtensionStates(prev => ({ ...prev, [id]: !enabled }))
        }
      }
      console.error('Failed to toggle extension:', error)
      toast.error('Failed to save extension state')
    }
  }, [loadCatalog])

  const handleBack = useCallback(() => {
    setSelectedExtensionId(null)
  }, [])

  const selectedExtension = extensionCatalog.find((entry) => entry.id === selectedExtensionId)
  const isDetailView = selectedExtension !== undefined

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
              extension={selectedExtension!}
              providers={providers}
              defaultSlots={piSettings.defaultSlots ?? []}
              onPatch={handleConfigPatch}
              onUnset={(key) => handleConfigPatch(key)}
              onBack={handleBack}
            />
          ) : (
            <div className="space-y-6">
              <ExtensionListPanel
                extensions={extensionCatalog}
                errors={extensionErrors}
                extensionStates={extensionStates}
                onToggleExtension={handleToggleExtension}
                onSelectExtension={setSelectedExtensionId}
              />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
