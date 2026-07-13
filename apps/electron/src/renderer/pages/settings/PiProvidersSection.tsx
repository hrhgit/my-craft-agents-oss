/**
 * PiProvidersSection
 *
 * Embedded section for AiSettingsPage. Manages Pi CLI global providers
 * (~/.pi/agent/models.json) and the default provider/model
 * (~/.pi/agent/settings.json). Lets the user:
 *   - See all configured providers (key, host, model count, default badge)
 *   - Switch the default provider+model (writes settings.json)
 *   - Add / edit / delete providers (writes models.json; credentials go to auth.json)
 *
 * Reads ~/.pi/agent/ directly via the pi:* RPC channel; does NOT touch
 * ~/.craft-agent/config.json. Live updates arrive via the GLOBAL_CHANGED
 * broadcast (usePiGlobalConfig subscribes automatically).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, MoreHorizontal, Pencil, Plus, Star, Trash2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsMenuSelectRow,
} from '@/components/settings'
import { usePiGlobalConfig } from '@/hooks/usePiGlobalConfig'
import { PiProviderFormDialog } from './PiProviderFormDialog'
import type { PiCustomApi, PiGlobalProvider, PiGlobalProviderForDisplay } from '../../../shared/types'
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@craft-agent/shared/agent/thinking-levels'

const PI_API_LABELS: Record<PiCustomApi, string> = {
  'openai-completions': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic',
  'google-generative-ai': 'Google AI',
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function cleanAddLabel(label: string): string {
  return label.replace(/^\+\s*/, '')
}

export function PiProvidersSection() {
  const { t } = useTranslation()
  const { providers, settings, isLoading, error, refresh } = usePiGlobalConfig()
  const addProviderLabel = cleanAddLabel(t('settings.piProviders.addProvider'))

  // Dialog state
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingKey, setEditingKey] = React.useState<string | null>(null)
  const [editingProvider, setEditingProvider] = React.useState<PiGlobalProvider | undefined>(undefined)
  const [defaultThinking, setDefaultThinking] = React.useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL)

  const defaultProvider = settings.defaultProvider
  const defaultModel = settings.defaultModel

  React.useEffect(() => {
    window.electronAPI.getDefaultThinkingLevel()
      .then(setDefaultThinking)
      .catch(error => console.error('Failed to load default thinking level:', error))
  }, [])

  // Models available under the current default provider (for the model switcher)
  const defaultProviderEntry = React.useMemo(
    () => providers.find(p => p.key === defaultProvider) ?? null,
    [providers, defaultProvider],
  )
  const modelOptions = React.useMemo(() => {
    if (!defaultProviderEntry) return []
    const models = defaultProviderEntry.provider.models ?? []
    return models.map(m => ({
      value: m.id,
      label: m.name ?? m.id,
      description: m.id,
    }))
  }, [defaultProviderEntry])

  // Open the form dialog in "add" mode
  const handleAdd = React.useCallback(() => {
    setEditingKey(null)
    setEditingProvider(undefined)
    setDialogOpen(true)
  }, [])

  // Open the form dialog in "edit" mode
  const handleEdit = React.useCallback((entry: PiGlobalProviderForDisplay) => {
    setEditingKey(entry.key)
    setEditingProvider(entry.provider)
    setDialogOpen(true)
  }, [])

  // Persist a provider (add or edit) via RPC
  const handleSaveProvider = React.useCallback(async (key: string, provider: PiGlobalProvider, apiKey?: string) => {
    const result = await window.electronAPI.savePiGlobalProvider({ key, provider, apiKey })
    if (!result.success) {
      throw new Error(result.error || 'savePiGlobalProvider failed')
    }
    toast.success(t('settings.piProviders.saved'))
    await refresh()
  }, [refresh, t])

  // Delete a provider via RPC
  const handleDelete = React.useCallback(async (key: string) => {
    const result = await window.electronAPI.deletePiGlobalProvider(key)
    if (result.success) {
      toast.success(t('settings.piProviders.deleted'))
      await refresh()
    } else {
      toast.error(t('settings.piProviders.deleteFailed'), { description: result.error })
    }
  }, [refresh, t])

  // Switch default provider (keeps current model if it exists in the new provider, else first model)
  const handleDefaultProviderChange = React.useCallback(async (nextProvider: string) => {
    const entry = providers.find(p => p.key === nextProvider)
    const firstModel = entry?.provider.models?.[0]?.id ?? ''
    const nextModel = entry?.provider.models?.some(m => m.id === defaultModel) ? (defaultModel ?? firstModel) : firstModel
    const result = await window.electronAPI.setPiGlobalDefault({
      provider: nextProvider,
      model: nextModel,
    })
    if (result.success) {
      await refresh()
    } else {
      toast.error(result.error || t('settings.piProviders.switchFailed'))
    }
  }, [providers, defaultModel, refresh, t])

  // Switch default model (within the current default provider)
  const handleDefaultModelChange = React.useCallback(async (nextModel: string) => {
    if (!defaultProvider) return
    const result = await window.electronAPI.setPiGlobalDefault({
      provider: defaultProvider,
      model: nextModel,
    })
    if (result.success) {
      await refresh()
    } else {
      toast.error(result.error || t('settings.piProviders.switchFailed'))
    }
  }, [defaultProvider, refresh, t])

  const handleDefaultThinkingChange = React.useCallback(async (value: string) => {
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

  const existingKeys = React.useMemo(() => providers.map(p => p.key), [providers])

  return (
    <>
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 mb-6 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium text-destructive">
              {t('settings.piProviders.loadError')}
            </h4>
            <p className="mt-1 text-sm text-destructive/80">{error}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refresh()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : null}

      <div className="space-y-8">
        {/* Global defaults for new chats */}
        <SettingsSection
          title={t('settings.ai.defaultSection')}
          description={t('settings.ai.defaultSectionDesc')}
        >
          <SettingsCard>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {providers.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('settings.piProviders.noProviders')}
                  </div>
                ) : (
                  <>
                    <SettingsMenuSelectRow
                      label={t('settings.piProviders.provider')}
                      description={t('settings.piProviders.providerDesc')}
                      value={defaultProvider ?? ''}
                      onValueChange={handleDefaultProviderChange}
                      options={providers.map(p => ({
                        value: p.key,
                        label: p.key,
                        description: hostOf(p.provider.baseUrl),
                      }))}
                    />
                    <SettingsMenuSelectRow
                      label={t('settings.piProviders.model')}
                      description={t('settings.piProviders.modelDesc')}
                      value={defaultModel ?? ''}
                      onValueChange={handleDefaultModelChange}
                      options={modelOptions}
                      disabled={modelOptions.length === 0}
                    />
                  </>
                )}
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
              </>
            )}
          </SettingsCard>
        </SettingsSection>

        {/* Providers list */}
        <SettingsSection
          title={t('settings.piProviders.providers')}
          description={t('settings.piProviders.providersDesc')}
        >
          <SettingsCard>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : providers.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t('settings.piProviders.noProvidersDesc')}
              </div>
            ) : (
              providers.map((entry, idx) => (
                <React.Fragment key={entry.key}>
                  {idx > 0 && <div className="border-t border-border/40" />}
                  <SettingsRow
                    label={
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium truncate">{entry.key}</span>
                          {entry.key === defaultProvider && (
                            <span className="inline-flex items-center h-5 px-2 text-[11px] font-medium rounded-[4px] bg-background shadow-minimal text-foreground/60">
                              {t('common.default')}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground truncate">
                          {hostOf(entry.provider.baseUrl) || t('settings.piProviders.noBaseUrl')}
                          {' · '}
                          {entry.provider.api ? PI_API_LABELS[entry.provider.api] : 'OpenAI Chat'}
                          {' · '}
                          {t('settings.piProviders.modelCount', { count: entry.modelCount })}
                          {entry.apiKeyMasked ? ` · ${entry.apiKeyMasked}` : ''}
                        </span>
                      </div>
                    }
                  >
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button className="p-1.5 rounded-md hover:bg-foreground/[0.05] transition-colors">
                          <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <StyledDropdownMenuContent align="end">
                        {entry.key !== defaultProvider && (
                          <StyledDropdownMenuItem onClick={() => handleDefaultProviderChange(entry.key)}>
                            <Star className="h-3.5 w-3.5" />
                            <span>{t('settings.piProviders.setAsDefault')}</span>
                          </StyledDropdownMenuItem>
                        )}
                        <StyledDropdownMenuItem onClick={() => handleEdit(entry)}>
                          <Pencil className="h-3.5 w-3.5" />
                          <span>{t('common.edit')}</span>
                        </StyledDropdownMenuItem>
                        <StyledDropdownMenuSeparator />
                        <StyledDropdownMenuItem
                          onClick={() => handleDelete(entry.key)}
                          variant="destructive"
                          disabled={providers.length <= 1}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>{t('common.delete')}</span>
                        </StyledDropdownMenuItem>
                      </StyledDropdownMenuContent>
                    </DropdownMenu>
                  </SettingsRow>
                </React.Fragment>
              ))
            )}
          </SettingsCard>
          <div className="pt-0">
            <button
              onClick={handleAdd}
              className="inline-flex items-center h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              {addProviderLabel}
            </button>
          </div>
        </SettingsSection>
      </div>

      <PiProviderFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingKey={editingKey}
        initialProvider={editingProvider}
        existingKeys={existingKeys}
        onSave={handleSaveProvider}
      />
    </>
  )
}
