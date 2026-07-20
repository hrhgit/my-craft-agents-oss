import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, FolderOpen, PackageSearch, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Spinner } from '@mortise/ui'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { SettingsCard, SettingsCardContent, SettingsRow, SettingsSection } from '@/components/settings'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { DeveloperKitStatus } from '../../../shared/types'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'developer',
}

export default function DeveloperSettingsPage() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DeveloperKitStatus | null>(null)
  const [busyAction, setBusyAction] = useState<'load' | 'discover' | 'select' | 'remove' | null>('load')
  const [actionError, setActionError] = useState<string | null>(null)

  const configurePath = useCallback(async (rootPath: string) => {
    setBusyAction('select')
    setActionError(null)
    try {
      const nextStatus = await window.electronAPI.setDeveloperKitPath(rootPath)
      setStatus(nextStatus)
      toast.success(t('settings.developer.configured'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setActionError(message)
      toast.error(t('settings.developer.invalidSelection'))
    } finally {
      setBusyAction(null)
    }
  }, [t])

  const directoryPicker = useDirectoryPicker(
    (path) => void configurePath(path),
    { host: 'client' },
  )

  const discover = useCallback(async (announce = true) => {
    setBusyAction('discover')
    setActionError(null)
    try {
      const nextStatus = await window.electronAPI.discoverDeveloperKit()
      setStatus(nextStatus)
      if (announce) {
        if (nextStatus.state === 'ready') toast.success(t('settings.developer.detected'))
        else toast.info(t('settings.developer.notFound'))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setActionError(message)
      if (announce) toast.error(t('settings.developer.discoveryFailed'))
    } finally {
      setBusyAction(null)
    }
  }, [t])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const current = await window.electronAPI.getDeveloperKitStatus()
        if (cancelled) return
        if (current.state !== 'ready') {
          await discover(false)
          return
        }
        setStatus(current)
      } catch (error) {
        if (!cancelled) setActionError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setBusyAction(null)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [discover])

  const remove = useCallback(async () => {
    setBusyAction('remove')
    setActionError(null)
    try {
      setStatus(await window.electronAPI.setDeveloperKitPath(null))
      toast.success(t('settings.developer.removed'))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyAction(null)
    }
  }, [t])

  const isBusy = busyAction !== null
  const installation = status?.installation
  const isReady = status?.state === 'ready' && installation
  const effectiveError = actionError ?? status?.error

  return (
    <div className="flex h-full flex-col bg-background">
      <PanelHeader
        title={t('settings.developer.title')}
        actions={<HeaderMenu route={routes.view.settings('developer')} />}
      />
      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          <SettingsSection
            title={t('settings.developer.kitTitle')}
            description={t('settings.developer.kitDescription')}
          >
            <SettingsCard>
              <SettingsRow
                label={t('settings.developer.status')}
                description={isReady
                  ? t('settings.developer.readyDescription')
                  : t('settings.developer.missingDescription')}
              >
                {busyAction === 'load' || busyAction === 'discover' ? (
                  <Spinner className="text-muted-foreground" />
                ) : isReady ? (
                  <Badge variant="secondary" className="gap-1.5 text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="size-3.5" />
                    {t('settings.developer.ready')}
                  </Badge>
                ) : status?.state === 'invalid' || effectiveError ? (
                  <Badge variant="secondary" className="gap-1.5 text-destructive">
                    <AlertTriangle className="size-3.5" />
                    {t('settings.developer.invalid')}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1.5">
                    <PackageSearch className="size-3.5" />
                    {t('settings.developer.notConfigured')}
                  </Badge>
                )}
              </SettingsRow>

              {isReady && (
                <>
                  <SettingsRow
                    label={t('settings.developer.version')}
                    description={t('settings.developer.versionDescription', {
                      kit: installation.manifest.version,
                      host: installation.manifest.hostVersion,
                    })}
                  />
                  <SettingsCardContent className="space-y-2 border-t border-border/50">
                    <div className="text-xs font-medium text-foreground/80">{t('settings.developer.cliPath')}</div>
                    <div
                      data-mortise-semantic-id="settings.developer.cliPath"
                      className="break-all rounded-md bg-muted/60 px-3 py-2 font-mono text-xs text-muted-foreground"
                    >
                      {installation.cliPath}
                    </div>
                  </SettingsCardContent>
                </>
              )}

              {effectiveError && !isReady && (
                <SettingsCardContent className="border-t border-border/50">
                  <div className="flex items-start gap-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span className="break-words">{effectiveError}</span>
                  </div>
                </SettingsCardContent>
              )}

              <SettingsCardContent className="flex flex-wrap items-center justify-end gap-2 border-t border-border/50">
                {isReady && (
                  <Button
                    semanticId="settings.developer.remove"
                    variant="ghost"
                    size="sm"
                    disabled={isBusy}
                    onClick={() => void remove()}
                  >
                    <Trash2 />
                    {t('common.remove')}
                  </Button>
                )}
                <Button
                  semanticId="settings.developer.discover"
                  variant="outline"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => void discover(true)}
                >
                  <RefreshCw className={busyAction === 'discover' ? 'animate-spin' : undefined} />
                  {t('settings.developer.detect')}
                </Button>
                <Button
                  semanticId="settings.developer.choose"
                  size="sm"
                  disabled={isBusy}
                  onClick={directoryPicker.pickDirectory}
                >
                  <FolderOpen />
                  {t('settings.developer.chooseFolder')}
                </Button>
              </SettingsCardContent>
            </SettingsCard>
          </SettingsSection>
        </div>
      </ScrollArea>

      <ServerDirectoryBrowser
        open={directoryPicker.showServerBrowser}
        mode={directoryPicker.serverBrowserMode}
        initialPath={status?.configuredPath}
        onSelect={directoryPicker.confirmServerBrowser}
        onCancel={directoryPicker.cancelServerBrowser}
      />
    </div>
  )
}
