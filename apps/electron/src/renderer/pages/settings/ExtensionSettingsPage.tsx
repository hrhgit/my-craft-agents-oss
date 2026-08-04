import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { SettingsCard } from '@/components/settings'
import { routes } from '@/lib/navigate'
import { createExtensionSettingsSubpage } from '../../../shared/settings-registry'
import type { PiExtensionCatalogEntry, PiExtensionCatalogError, PiExtensionSettingScalar } from '@mortise/shared/config'
import { ExtensionDetailPanel } from './ExtensionDetailPanel'
import { usePiGlobalConfig } from '@/hooks/usePiGlobalConfig'

export function ExtensionSettingsPage({ extensionId, pageId }: { extensionId: string; pageId: string }) {
  const { providers, settings } = usePiGlobalConfig()
  const [extension, setExtension] = useState<PiExtensionCatalogEntry | null>(null)
  const [error, setError] = useState<PiExtensionCatalogError | null>(null)
  const pageRoute = createExtensionSettingsSubpage(extensionId, pageId)

  const load = useCallback(async () => {
    try {
      const catalog = await window.electronAPI.getPiExtensionCatalog()
      const next = catalog.extensions.find((entry) => entry.enabled && entry.id === extensionId && entry.ui?.settings?.page?.id === pageId)
      setExtension(next ?? null)
      setError(next ? null : catalog.errors[0] ?? { path: extensionId, error: 'Extension settings page is unavailable.' })
    } catch (cause) {
      setError({ path: extensionId, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }, [extensionId, pageId])

  useEffect(() => { void load() }, [load])

  const patchField = useCallback(async (key: string, value?: PiExtensionSettingScalar) => {
    if (!extension) return
    const result = await window.electronAPI.patchPiExtensionConfig({
      schemaVersion: 1,
      extensionId: extension.id,
      ...(value === undefined ? { unset: [key] } : { set: { [key]: value } }),
    })
    setExtension((current) => current ? { ...current, config: result.config } : current)
  }, [extension])

  const page = extension?.ui?.settings?.page
  const title = page?.title ?? extension?.title ?? 'Extension settings'
  const description = page?.description ?? extension?.description
  const settingsContent = useMemo(() => {
    if (extension) {
      return (
        <ExtensionDetailPanel
          extension={extension}
          providers={providers}
          defaultSlots={settings.defaultSlots ?? []}
          onPatch={(key, value) => patchField(key, value)}
          onUnset={(key) => patchField(key)}
          showMetadata={false}
          className="space-y-8"
        />
      )
    }
    if (error) return <SettingsCard className="p-4 text-sm text-destructive">{error.error}</SettingsCard>
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  }, [error, extension, patchField, providers, settings.defaultSlots])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={title} actions={<HeaderMenu route={routes.view.settings(pageRoute)} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            {description && <p className="mb-6 text-sm text-muted-foreground">{description}</p>}
            {settingsContent}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

export default ExtensionSettingsPage
