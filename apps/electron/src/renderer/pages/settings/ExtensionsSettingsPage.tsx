import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RotateCw } from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingsCard, SettingsCardContent, SettingsSection } from '@/components/settings'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { PiExtensionCatalogEntry, PiExtensionCatalogError, PiExtensionReloadActiveSession, PiExtensionSettingScalar } from '@mortise/shared/config'
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
  const [reloadPending, setReloadPending] = useState(false)
  const [reloadConfirmation, setReloadConfirmation] = useState<PiExtensionReloadActiveSession[] | null>(null)
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
        if (result.reload?.status === 'confirmation_required') {
          setReloadConfirmation(result.reload.activeSessions)
        }
        const confirmedValue = isSettingScalar(result.config[key]) ? result.config[key] : undefined
        confirmedConfig.current.set(fieldId, confirmedValue === undefined ? { present: false } : { present: true, value: confirmedValue })
        if (configPatchVersions.current.get(fieldId) === version) {
          setExtensionCatalog((entries) => patchCatalogField(entries, extensionId, key, confirmedValue === undefined ? { present: false } : { present: true, value: confirmedValue }))
        }
      } catch (error) {
        let fallback = confirmedConfig.current.get(fieldId) ?? { present: false }
        try {
          // Saving may have succeeded before a required runtime reload failed. Re-read
          // persisted state so the UI does not falsely roll back a durable change.
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
      const reload = await window.electronAPI.setPiExtensionEnabled(id, enabled)
      if (reload.status === 'confirmation_required') {
        setReloadConfirmation(reload.activeSessions)
      }
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

  const handleReload = useCallback(async (interruptRunning: boolean) => {
    setReloadPending(true)
    if (interruptRunning) setReloadConfirmation(null)
    try {
      const result = await window.electronAPI.reloadPiExtensions(interruptRunning)
      if (result.status === 'confirmation_required') {
        setReloadConfirmation(result.activeSessions)
        return
      }
      setReloadConfirmation(null)
      await loadCatalog()
      if (result.deferredSessionCount > 0) {
        toast.warning(t('settings.extensions.reloadDeferred', { count: result.deferredSessionCount }))
      } else {
        toast.success(t('settings.extensions.reloadSuccess'))
      }
    } catch (error) {
      console.error('Failed to reload Pi extensions:', error)
      toast.error(t('settings.extensions.reloadFailed'))
    } finally {
      setReloadPending(false)
    }
  }, [loadCatalog, t])

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
              <SettingsSection
                title={t('settings.extensions.runtimeTitle')}
                description={t('settings.extensions.runtimeDescription')}
              >
                <SettingsCard>
                  <SettingsCardContent className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{t('settings.extensions.reload')}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.extensions.reloadDescription')}</div>
                    </div>
                    <Button variant="outline" size="sm" disabled={reloadPending} onClick={() => void handleReload(false)}>
                      <RotateCw className={reloadPending ? 'animate-spin' : undefined} />
                      {t('settings.extensions.reload')}
                    </Button>
                  </SettingsCardContent>
                </SettingsCard>
              </SettingsSection>
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
      <Dialog open={reloadConfirmation !== null} onOpenChange={(open) => { if (!open && !reloadPending) setReloadConfirmation(null) }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t('settings.extensions.reloadConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.extensions.reloadConfirmDescription', { count: reloadConfirmation?.length ?? 0 })}
            </DialogDescription>
          </DialogHeader>
          {reloadConfirmation && reloadConfirmation.length > 0 && (
            <div className="max-h-48 overflow-y-auto rounded-md border border-border/70">
              {reloadConfirmation.map((session) => (
                <div key={session.sessionId} className="border-b border-border/50 px-3 py-2 last:border-b-0">
                  <div className="truncate text-sm font-medium">{session.title || t('settings.extensions.untitledSession')}</div>
                  <div className="truncate text-xs text-muted-foreground">{session.workspaceName}</div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={reloadPending} onClick={() => setReloadConfirmation(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={reloadPending} onClick={() => void handleReload(true)}>
              <RotateCw className={reloadPending ? 'animate-spin' : undefined} />
              {t('settings.extensions.interruptAndReload')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
