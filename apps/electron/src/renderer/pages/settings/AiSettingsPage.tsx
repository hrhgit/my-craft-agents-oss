import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingsCard, SettingsMenuSelectRow, SettingsSection } from '@/components/settings'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { MidStreamBehavior } from '@craft-agent/shared/config/midstream-behavior'
import { DEFAULT_THINKING_LEVEL, THINKING_LEVELS, type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { PiProvidersSection } from './PiProvidersSection'
import { usePiGlobalConfig } from '@/hooks/usePiGlobalConfig'
import { getModelShortName } from '@config/models'
import type { Workspace, WorkspaceSettings } from '../../../shared/types'

interface WorkspaceOverrideCardProps {
  workspace: Workspace
  providers: ReturnType<typeof usePiGlobalConfig>['providers']
  globalProvider?: string
}

function WorkspaceOverrideCard({ workspace, providers, globalProvider }: WorkspaceOverrideCardProps) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.getWorkspaceSettings(workspace.id)
      .then(value => { if (!cancelled) setSettings(value ?? {}) })
      .catch(error => console.error('Failed to load workspace settings:', error))
    return () => { cancelled = true }
  }, [workspace.id])

  const updateSetting = useCallback(async <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => {
    const previous = settings?.[key]
    setSettings(current => ({ ...(current ?? {}), [key]: value }))
    try {
      await window.electronAPI.updateWorkspaceSetting(workspace.id, key, value)
    } catch (error) {
      setSettings(current => ({ ...(current ?? {}), [key]: previous }))
      toast.error(t('toast.failedToSaveSetting', { setting: String(key) }))
    }
  }, [settings, t, workspace.id])

  const effectiveProviderKey = settings?.provider ?? globalProvider
  const effectiveProvider = providers.find(entry => entry.key === effectiveProviderKey)
  const summary = [
    settings?.provider,
    settings?.model ? getModelShortName(settings.model) : undefined,
    settings?.thinkingLevel
      ? t(THINKING_LEVELS.find(level => level.id === settings.thinkingLevel)?.nameKey ?? settings.thinkingLevel)
      : undefined,
  ].filter(Boolean).join(' · ') || t('settings.ai.usingDefaults')

  return (
    <SettingsCard>
      <div className="px-4 py-3 border-b border-border/50">
        <div className="text-sm font-medium">{workspace.name}</div>
        <div className="text-xs text-muted-foreground">{summary}</div>
      </div>
      <SettingsMenuSelectRow
        label={t('settings.piProviders.provider')}
        description={t('settings.piProviders.providerDesc')}
        value={settings?.provider ?? 'global'}
        onValueChange={value => updateSetting('provider', value === 'global' ? undefined : value)}
        options={[
          { value: 'global', label: t('settings.ai.useDefault'), description: t('settings.ai.inheritFromApp') },
          ...providers.map(entry => ({ value: entry.key, label: entry.key, description: entry.provider.baseUrl })),
        ]}
      />
      <SettingsMenuSelectRow
        label={t('settings.ai.model')}
        description={t('settings.ai.modelDesc')}
        value={settings?.model ?? 'global'}
        onValueChange={value => updateSetting('model', value === 'global' ? undefined : value)}
        options={[
          { value: 'global', label: t('settings.ai.useDefault'), description: t('settings.ai.inheritFromApp') },
          ...(effectiveProvider?.provider.models ?? []).map(model => ({
            value: model.id,
            label: model.name ?? getModelShortName(model.id),
          })),
        ]}
      />
      <SettingsMenuSelectRow
        label={t('settings.ai.thinking')}
        description={t('settings.ai.thinkingDesc')}
        value={settings?.thinkingLevel ?? 'global'}
        onValueChange={value => updateSetting('thinkingLevel', value === 'global' ? undefined : value as ThinkingLevel)}
        options={[
          { value: 'global', label: t('settings.ai.useDefault'), description: t('settings.ai.inheritFromApp') },
          ...THINKING_LEVELS.map(level => ({
            value: level.id,
            label: t(level.nameKey),
            description: t(level.descriptionKey),
          })),
        ]}
      />
    </SettingsCard>
  )
}

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'ai',
}

export function AiSettingsPage() {
  const { t } = useTranslation()
  const [midStreamBehavior, setMidStreamBehaviorState] = useState<MidStreamBehavior>('steer')
  const [isLoadingBehavior, setIsLoadingBehavior] = useState(true)
  const [defaultThinking, setDefaultThinking] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const { providers, settings: piSettings } = usePiGlobalConfig()

  useEffect(() => {
    let cancelled = false
    window.electronAPI.getMidStreamBehavior()
      .then((value) => {
        if (!cancelled) setMidStreamBehaviorState(value)
      })
      .catch((error) => {
        console.error('Failed to load mid-stream behavior:', error)
      })
      .finally(() => {
        if (!cancelled) setIsLoadingBehavior(false)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    window.electronAPI.getWorkspaces()
      .then(setWorkspaces)
      .catch(error => console.error('Failed to load workspaces:', error))
  }, [])

  useEffect(() => {
    window.electronAPI.getDefaultThinkingLevel()
      .then(setDefaultThinking)
      .catch(error => console.error('Failed to load default thinking level:', error))
  }, [])

  const handleDefaultThinkingChange = useCallback(async (value: string) => {
    const next = value as ThinkingLevel
    const previous = defaultThinking
    setDefaultThinking(next)
    try {
      const result = await window.electronAPI.setDefaultThinkingLevel(next)
      if (!result.success) setDefaultThinking(previous)
    } catch (error) {
      setDefaultThinking(previous)
      console.error('Failed to update default thinking level:', error)
    }
  }, [defaultThinking])

  const handleMidStreamBehaviorChange = useCallback(async (value: string) => {
    const next = value as MidStreamBehavior
    const previous = midStreamBehavior
    setMidStreamBehaviorState(next)
    try {
      const result = await window.electronAPI.setMidStreamBehavior(next)
      if (!result.success) {
        setMidStreamBehaviorState(previous)
        toast.error(t('settings.ai.midStream.updateFailed'), { description: result.error })
      }
    } catch (error) {
      setMidStreamBehaviorState(previous)
      console.error('Failed to update mid-stream behavior:', error)
      toast.error(t('settings.ai.midStream.updateFailed'))
    }
  }, [midStreamBehavior, t])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t('settings.ai.title')} actions={<HeaderMenu route={routes.view.settings('ai')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <PiProvidersSection />

              <SettingsSection title={t('settings.ai.defaultSection')} description={t('settings.ai.defaultSectionDesc')}>
                <SettingsCard>
                  <SettingsMenuSelectRow
                    label={t('settings.ai.thinking')}
                    description={t('settings.ai.thinkingDesc')}
                    value={defaultThinking}
                    onValueChange={handleDefaultThinkingChange}
                    options={THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => ({
                      value: id,
                      label: t(nameKey),
                      description: t(descriptionKey),
                    }))}
                  />
                </SettingsCard>
              </SettingsSection>

              {workspaces.length > 0 && providers.length > 0 && (
                <SettingsSection
                  title={t('settings.ai.workspaceOverrides')}
                  description={t('settings.ai.workspaceOverridesDesc')}
                >
                  <div className="space-y-2">
                    {workspaces.map(workspace => (
                      <WorkspaceOverrideCard
                        key={workspace.id}
                        workspace={workspace}
                        providers={providers}
                        globalProvider={piSettings.defaultProvider}
                      />
                    ))}
                  </div>
                </SettingsSection>
              )}

              <SettingsSection
                title={t('settings.ai.midStream.title')}
              >
                <SettingsCard>
                  <SettingsMenuSelectRow
                    label={t('settings.ai.midStream.title')}
                    value={midStreamBehavior}
                    onValueChange={handleMidStreamBehaviorChange}
                    disabled={isLoadingBehavior}
                    options={[
                      { value: 'steer', label: t('settings.ai.midStream.steer') },
                      { value: 'queue', label: t('settings.ai.midStream.queue') },
                    ]}
                  />
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

export default AiSettingsPage
