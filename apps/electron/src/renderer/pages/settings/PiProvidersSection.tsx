/**
 * PiProvidersSection
 *
 * Embedded section for AiSettingsPage. Manages Pi CLI global providers
 * (~/.mortise/agent/models.json) and the default provider/model
 * (~/.mortise/agent/settings.json). Lets the user:
 *   - See all configured providers (key, host, model count, default badge)
 *   - Switch the default provider+model (writes settings.json)
 *   - Add / edit / delete providers (writes models.json; credentials go to auth.json)
 *
 * Reads ~/.mortise/agent/ directly via the pi:* RPC channel; does NOT touch
 * ~/.mortise/config.json. Live updates arrive via the GLOBAL_CHANGED
 * broadcast (usePiGlobalConfig subscribes automatically).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronRight, List, Loader2, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
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
import { useAppShellContext } from '@/context/AppShellContext'
import { usePiGlobalConfig } from '@/hooks/usePiGlobalConfig'
import { piProviderModelTags } from '@mortise/shared/config/pi-provider-models'
import { PiProviderFormDialog } from './PiProviderFormDialog'
import { ModelEditDialog } from './ModelEditDialog'
import type { PiCustomApi, PiGlobalModel, PiGlobalProvider, PiGlobalProviderForDisplay, PiGlobalSettings } from '../../../shared/types'
import type { PiGlobalDefaultSlot } from '@mortise/shared/config'
import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@mortise/shared/agent/thinking-levels'

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
  const { showTaggedModelsOnly, setShowTaggedModelsOnly } = useAppShellContext()
  const {
    providers: loadedProviders,
    settings: loadedSettings,
    isLoading,
    error,
    refresh,
  } = usePiGlobalConfig({ subscribe: false })
  const [providers, setProviders] = React.useState<PiGlobalProviderForDisplay[]>([])
  const [settings, setSettings] = React.useState<PiGlobalSettings>({})
  const addProviderLabel = cleanAddLabel(t('settings.piProviders.addProvider'))

  // This page applies its own confirmed changes so opening a select or saving a
  // field never replaces the entire settings surface with a loading state.
  React.useEffect(() => {
    setProviders(loadedProviders)
  }, [loadedProviders])
  React.useEffect(() => {
    setSettings(loadedSettings)
  }, [loadedSettings])

  // Dialog state
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingKey, setEditingKey] = React.useState<string | null>(null)
  const [editingProvider, setEditingProvider] = React.useState<PiGlobalProvider | undefined>(undefined)
  const [expandedSlot, setExpandedSlot] = React.useState<number | null>(1)
  // Per-provider models popover + per-model edit dialog
  const [modelsMenuProvider, setModelsMenuProvider] = React.useState<string | null>(null)
  const [editingModel, setEditingModel] = React.useState<{ providerKey: string; provider: PiGlobalProvider; model: PiGlobalModel } | null>(null)

  const defaultProvider = settings.defaultProvider
  const defaultSlots = settings.defaultSlots ?? []

  const modelOptionsForProvider = React.useCallback((providerKey: string | undefined) => {
    const entry = providers.find(p => p.key === providerKey)
    const models = entry?.provider.models ?? []
    return models.map(m => ({
      value: m.id,
      label: m.name ?? m.id,
      description: m.id,
    }))
  }, [providers])

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

  // Persist a provider (add or edit) via RPC.
  const handleSaveProvider = React.useCallback(async (key: string, provider: PiGlobalProvider, apiKey?: string) => {
    const result = await window.electronAPI.savePiGlobalProvider({ key, provider, apiKey })
    if (!result.success) {
      throw new Error(result.error || 'savePiGlobalProvider failed')
    }
    setProviders(current => {
      const existing = current.find(entry => entry.key === key)
      const nextEntry: PiGlobalProviderForDisplay = {
        key,
        provider,
        apiKeyMasked: existing?.apiKeyMasked ?? '',
        modelCount: provider.models?.length ?? 0,
      }
      return existing
        ? current.map(entry => entry.key === key ? nextEntry : entry)
        : [...current, nextEntry]
    })
    toast.success(t('settings.piProviders.saved'))
  }, [t])

  // Persist a model edit (tags/name/capabilities) via RPC; keeps the page's
  // local provider list in sync without a full reload.
  const handleSaveModel = React.useCallback(async (providerKey: string, provider: PiGlobalProvider) => {
    const result = await window.electronAPI.savePiGlobalProvider({ key: providerKey, provider })
    if (!result.success) {
      toast.error(result.error || t('settings.piProviders.saveFailed'))
      return
    }
    setProviders(current => current.map(entry =>
      entry.key === providerKey
        ? { ...entry, provider, modelCount: provider.models?.length ?? 0 }
        : entry,
    ))
    toast.success(t('settings.piProviders.saved'))
  }, [t])

  // Delete a provider via RPC.
  const handleDelete = React.useCallback(async (key: string) => {
    const result = await window.electronAPI.deletePiGlobalProvider(key)
    if (result.success) {
      setProviders(current => current.filter(entry => entry.key !== key))
      toast.success(t('settings.piProviders.deleted'))
    } else {
      toast.error(t('settings.piProviders.deleteFailed'), { description: result.error })
    }
  }, [t])

  // Switch default provider (keeps current model if it exists in the new provider, else first model).
  const saveDefaultSlot = React.useCallback(async (slot: number, next: Pick<PiGlobalDefaultSlot, 'provider' | 'model' | 'thinkingLevel'>): Promise<boolean> => {
    const result = await window.electronAPI.setPiGlobalDefault({ slot, ...next })
    if (!result.success) {
      toast.error(result.error || t('settings.piProviders.switchFailed'))
      return false
    }
    setSettings(current => {
      const defaultSlot = { slot, ...next }
      const defaultSlots = [
        ...(current.defaultSlots ?? []).filter(entry => entry.slot !== slot),
        defaultSlot,
      ].sort((a, b) => a.slot - b.slot)
      return slot === 1
        ? {
            ...current,
            defaultProvider: next.provider,
            defaultModel: next.model,
            defaultThinkingLevel: next.thinkingLevel,
            defaultSlots,
          }
        : { ...current, defaultSlots }
    })
    return true
  }, [t])

  const handleDefaultProviderChange = React.useCallback(async (slot: PiGlobalDefaultSlot, nextProvider: string) => {
    const entry = providers.find(p => p.key === nextProvider)
    const firstModel = entry?.provider.models?.[0]?.id ?? ''
    const nextModel = entry?.provider.models?.some(m => m.id === slot.model) ? slot.model : firstModel
    if (!nextModel) return
    await saveDefaultSlot(slot.slot, {
      provider: nextProvider,
      model: nextModel,
      thinkingLevel: slot.thinkingLevel,
    })
  }, [providers, saveDefaultSlot])

  const handleDefaultModelChange = React.useCallback(async (slot: PiGlobalDefaultSlot, nextModel: string) => {
    await saveDefaultSlot(slot.slot, {
      provider: slot.provider,
      model: nextModel,
      thinkingLevel: slot.thinkingLevel,
    })
  }, [saveDefaultSlot])

  const handleDefaultThinkingChange = React.useCallback(async (slot: PiGlobalDefaultSlot, thinkingLevel: ThinkingLevel) => {
    await saveDefaultSlot(slot.slot, {
      provider: slot.provider,
      model: slot.model,
      thinkingLevel,
    })
  }, [saveDefaultSlot])

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
          <SettingsCard divided={false}>
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
                  // Only the primary default (slot 1) remains; the
                  // "add multiple defaults" feature has been removed in
                  // favor of model tags.
                  defaultSlots.filter(slot => slot.slot === 1).map((slot, index) => {
                    const modelOptions = modelOptionsForProvider(slot.provider)
                    const open = expandedSlot === slot.slot
                    return (
                      <Collapsible
                        key={slot.slot}
                        open={open}
                        onOpenChange={(nextOpen) => setExpandedSlot(nextOpen ? slot.slot : null)}
                        className={index > 0 ? 'border-t border-border/50' : undefined}
                      >
                        <CollapsibleTrigger asChild>
                          <button
                            type="button"
                            data-mortise-semantic-id={`settings.ai.default.${slot.slot}.toggle`}
                            className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-foreground/[0.025]"
                          >
                            <ChevronRight className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium">
                                {t('settings.ai.defaultSlotLabel', { slot: slot.slot })}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {slot.provider}/{slot.model} · {t(`thinking.${slot.thinkingLevel}`)}
                              </span>
                            </span>
                          </button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <div className="border-t border-border/40 bg-muted/15 pb-2 pl-8">
                            <SettingsMenuSelectRow
                              label={t('settings.piProviders.provider')}
                              description={t('settings.piProviders.providerDesc')}
                              value={slot.provider}
                              onValueChange={(value) => void handleDefaultProviderChange(slot, value)}
                              options={providers.map(p => ({
                                value: p.key,
                                label: p.key,
                                description: hostOf(p.provider.baseUrl),
                              }))}
                            />
                            <SettingsMenuSelectRow
                              label={t('settings.piProviders.model')}
                              description={t('settings.piProviders.modelDesc')}
                              value={slot.model}
                              onValueChange={(value) => void handleDefaultModelChange(slot, value)}
                              options={modelOptions}
                              disabled={modelOptions.length === 0}
                            />
                            <SettingsMenuSelectRow
                              label={t('settings.ai.thinking')}
                              description={t('settings.ai.thinkingDesc')}
                              value={slot.thinkingLevel}
                              onValueChange={(value) => void handleDefaultThinkingChange(slot, value as ThinkingLevel)}
                              options={THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => ({
                                value: id,
                                label: t(nameKey),
                                description: t(descriptionKey),
                              }))}
                            />
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    )
                  })
                )}
              </>
            )}
          </SettingsCard>
        </SettingsSection>

        {/* Tagged-models-only picker preference */}
        <SettingsSection
          title={t('settings.ai.taggedSection')}
          description={t('settings.ai.taggedSectionDesc')}
        >
          <SettingsCard divided={false}>
            <SettingsRow
              label={t('settings.ai.showTaggedModelsOnly')}
              description={t('settings.ai.showTaggedModelsOnlyDesc')}
            >
              <Switch
                checked={showTaggedModelsOnly}
                onCheckedChange={(value) => {
                  void setShowTaggedModelsOnly(value).catch(() => {
                    toast.error(t('settings.ai.showTaggedModelsOnlyFailed'))
                  })
                }}
                semanticId="settings.ai.showTaggedModelsOnly.toggle"
              />
            </SettingsRow>
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
                    <Popover
                      open={modelsMenuProvider === entry.key}
                      onOpenChange={(next) => setModelsMenuProvider(next ? entry.key : null)}
                    >
                      <PopoverTrigger asChild>
                        <button
                          className="p-1.5 rounded-md hover:bg-foreground/[0.05] transition-colors"
                          aria-label={t('settings.piProviders.viewModels')}
                          title={t('settings.piProviders.viewModels')}
                        >
                          <List className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-80 max-h-80 p-0 overflow-hidden flex flex-col">
                        <div className="px-3 pt-2.5 pb-1.5 text-xs font-medium text-foreground/60 uppercase tracking-wide border-b border-border/40">
                          {t('settings.piProviders.models')} · {entry.modelCount}
                        </div>
                        <div className="flex-1 min-h-0 overflow-y-auto py-1">
                          {(entry.provider.models ?? []).length === 0 ? (
                            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                              {t('settings.piProviders.modelsEmpty')}
                            </div>
                          ) : (
                            (entry.provider.models ?? []).map(model => {
                              const tags = piProviderModelTags(entry.provider, model.id)
                              const displayName = model.name && model.name !== model.id ? model.name : model.id
                              return (
                                <div
                                  key={model.id}
                                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg mx-1 hover:bg-foreground/[0.04] transition-colors"
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">{displayName}</div>
                                    {model.name && model.name !== model.id && (
                                      <div className="text-xs text-muted-foreground truncate">{model.id}</div>
                                    )}
                                    {tags.length > 0 && (
                                      <div className="flex flex-wrap gap-1 pt-0.5">
                                        {tags.map(tag => (
                                          <span
                                            key={tag}
                                            className="inline-flex items-center h-4.5 px-1.5 text-[10px] font-medium rounded-[3px] bg-foreground/10 text-foreground/70"
                                          >
                                            {tag}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                  <button
                                    type="button"
                                    className="p-1.5 rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors shrink-0"
                                    aria-label={t('settings.piProviders.editModel', { model: displayName })}
                                    title={t('settings.piProviders.editModel', { model: displayName })}
                                    onClick={() => setEditingModel({ providerKey: entry.key, provider: entry.provider, model })}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              )
                            })
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <button className="p-1.5 rounded-md hover:bg-foreground/[0.05] transition-colors">
                          <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <StyledDropdownMenuContent align="end">
                        {entry.key !== defaultProvider && (
                          <StyledDropdownMenuItem onClick={() => {
                            const primary = defaultSlots[0]
                            if (primary) void handleDefaultProviderChange(primary, entry.key)
                          }}>
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

      {editingModel && (
        <ModelEditDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingModel(null)
          }}
          providerKey={editingModel.providerKey}
          provider={editingModel.provider}
          model={editingModel.model}
          allProviders={providers.map(entry => ({ key: entry.key, provider: entry.provider }))}
          onSave={handleSaveModel}
        />
      )}
    </>
  )
}
