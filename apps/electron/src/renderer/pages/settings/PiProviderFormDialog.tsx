/**
 * PiProviderFormDialog
 *
 * Add/Edit dialog for a single Pi global provider (~/.pi/agent/models.json).
 * Core fields (per "核心字段先跑通" scope, excluding thinkingLevelMap 3-state
 * and cost):
 *   - key (only when adding; lowercase slug)
 *   - baseUrl, api (4 built-in protocols), authHeader
 *   - defaultModel (free text + fetch-from-endpoint picker)
 *   - models list (id + name + collapsible advanced: reasoning / image /
 *     contextWindow / maxTokens)
 *
 * Provider metadata is saved to models.json; the API key is submitted
 * separately and saved to auth.json by the RPC handler.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Download, Eye, EyeOff, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { PiGlobalProvider, PiGlobalModel, PiCustomApi, FetchedEndpointModel } from '../../../shared/types'
import { parseContextWindowInput } from '@craft-agent/shared/config/pi-provider-models'

const FLOATING_MENU_CLASS = 'z-floating-menu'

interface PiProviderFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When editing, the existing provider key. When null, "add" mode. */
  editingKey: string | null
  /** When editing, the existing provider data. When null, defaults are used. */
  initialProvider?: PiGlobalProvider
  /** Existing keys — used to prevent duplicates in "add" mode. */
  existingKeys: string[]
  /** Called with the new key + provider payload + optional credential when the user saves. */
  onSave: (key: string, provider: PiGlobalProvider, apiKey?: string) => Promise<void>
}

interface ApiOption {
  value: PiCustomApi
  labelKey: string
  hintKey: string
  baseUrlPlaceholder: string
  modelPlaceholder: string
}

const PI_API_OPTIONS: ApiOption[] = [
  {
    value: 'openai-completions',
    labelKey: 'settings.piProviders.api.openaiCompletions',
    hintKey: 'settings.piProviders.apiHint.openaiCompletions',
    baseUrlPlaceholder: 'https://api.example.com/v1',
    modelPlaceholder: 'gpt-4o-mini',
  },
  {
    value: 'openai-responses',
    labelKey: 'settings.piProviders.api.openaiResponses',
    hintKey: 'settings.piProviders.apiHint.openaiResponses',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
    modelPlaceholder: 'gpt-5-mini',
  },
  {
    value: 'anthropic-messages',
    labelKey: 'settings.piProviders.api.anthropicMessages',
    hintKey: 'settings.piProviders.apiHint.anthropicMessages',
    baseUrlPlaceholder: 'https://api.anthropic.com',
    modelPlaceholder: 'claude-sonnet-4-6',
  },
  {
    value: 'google-generative-ai',
    labelKey: 'settings.piProviders.api.googleGenerativeAi',
    hintKey: 'settings.piProviders.apiHint.googleGenerativeAi',
    baseUrlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
    modelPlaceholder: 'gemini-2.5-flash',
  },
]

interface FormState {
  key: string
  baseUrl: string
  apiKey: string
  api: PiCustomApi
  authHeader: boolean
  defaultModel: string
  models: PiGlobalModel[]
}

function buildInitialState(editingKey: string | null, initial?: PiGlobalProvider): FormState {
  return {
    key: editingKey ?? '',
    baseUrl: initial?.baseUrl ?? '',
    apiKey: '',
    api: (initial?.api as PiCustomApi) ?? 'openai-completions',
    authHeader: initial?.authHeader ?? true,
    defaultModel: (initial?.models?.[0]?.id) ?? '',
    models: initial?.models ?? [],
  }
}

function getApiOption(api: PiCustomApi): ApiOption {
  return PI_API_OPTIONS.find(option => option.value === api) ?? PI_API_OPTIONS[0]!
}

function isOpenAiCompatibleApi(api: PiCustomApi): boolean {
  return api === 'openai-completions' || api === 'openai-responses'
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function cleanAddLabel(label: string): string {
  return label.replace(/^\+\s*/, '')
}

function fetchRequiresApiKey(api: PiCustomApi, authHeader: boolean): boolean {
  return api === 'anthropic-messages' || api === 'google-generative-ai' || authHeader
}

function fetchedToGlobalModel(model: FetchedEndpointModel): PiGlobalModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
  }
}

function mergeFetchedModels(
  current: PiGlobalModel[],
  fetched: FetchedEndpointModel[],
): PiGlobalModel[] {
  const seen = new Set(current.map(model => model.id.trim()).filter(Boolean))
  const next = [...current]
  for (const model of fetched) {
    if (!model.id.trim() || seen.has(model.id)) continue
    next.push(fetchedToGlobalModel(model))
    seen.add(model.id)
  }
  return next
}

function normalizeModelForSave(model: PiGlobalModel): PiGlobalModel | null {
  const id = model.id.trim()
  if (!id) return null
  const name = typeof model.name === 'string' ? model.name.trim() : ''
  const next: PiGlobalModel = {
    ...model,
    id,
  }
  if (name) {
    next.name = name
  } else {
    delete next.name
  }
  return next
}

function normalizeModelsForSave(models: PiGlobalModel[], preferredModelId: string): PiGlobalModel[] {
  const seen = new Set<string>()
  const normalized: PiGlobalModel[] = []
  for (const model of models) {
    const next = normalizeModelForSave(model)
    if (!next || seen.has(next.id)) continue
    seen.add(next.id)
    normalized.push(next)
  }

  const preferred = preferredModelId.trim()
  if (!preferred) return normalized

  const existingIndex = normalized.findIndex(model => model.id === preferred)
  if (existingIndex === -1) {
    return [{ id: preferred, name: preferred }, ...normalized]
  }

  if (existingIndex === 0) return normalized
  const existing = normalized.splice(existingIndex, 1)[0]
  if (!existing) return normalized
  return [existing, ...normalized]
}

function FetchedModelMenuLabel({ item }: { item: FetchedEndpointModel }) {
  const displayName = item.name && item.name !== item.id ? item.name : item.id
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{displayName}</span>
      {displayName !== item.id ? (
        <span className="truncate text-xs text-muted-foreground">{item.id}</span>
      ) : null}
    </span>
  )
}

export function PiProviderFormDialog({
  open,
  onOpenChange,
  editingKey,
  initialProvider,
  existingKeys,
  onSave,
}: PiProviderFormDialogProps) {
  const { t } = useTranslation()
  const isAdd = editingKey === null
  const [state, setState] = React.useState<FormState>(() => buildInitialState(editingKey, initialProvider))
  const [saving, setSaving] = React.useState(false)
  const [fetching, setFetching] = React.useState(false)
  const [fetchedModels, setFetchedModels] = React.useState<FetchedEndpointModel[]>([])
  const [fetchError, setFetchError] = React.useState<string | null>(null)
  const [keyError, setKeyError] = React.useState<string | null>(null)
  const [expandedModels, setExpandedModels] = React.useState<Record<number, boolean>>({})
  const [apiKeyVisible, setApiKeyVisible] = React.useState(false)
  const [apiKeyLoading, setApiKeyLoading] = React.useState(false)
  const [contextWindowDrafts, setContextWindowDrafts] = React.useState<Record<number, string>>({})
  const addProviderLabel = cleanAddLabel(t('settings.piProviders.addProvider'))
  const currentApiOption = getApiOption(state.api)

  // Reset form state when the dialog opens (so switching between rows doesn't keep stale state)
  React.useEffect(() => {
    if (open) {
      setState(buildInitialState(editingKey, initialProvider))
      setFetchedModels([])
      setFetchError(null)
      setKeyError(null)
      setExpandedModels({})
      setApiKeyVisible(false)
      setApiKeyLoading(false)
      setContextWindowDrafts({})
    }
  }, [open, editingKey, initialProvider])

  const update = React.useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState(prev => ({ ...prev, [key]: value }))
    if (key === 'baseUrl' || key === 'apiKey' || key === 'api' || key === 'authHeader') {
      setFetchedModels([])
      setFetchError(null)
    }
  }, [])

  const handleApiChange = React.useCallback((value: PiCustomApi) => {
    setState(prev => ({
      ...prev,
      api: value,
      authHeader: isOpenAiCompatibleApi(value) ? prev.authHeader : true,
    }))
    setFetchedModels([])
    setFetchError(null)
  }, [])

  const validateKey = React.useCallback((key: string): string | null => {
    const trimmed = key.trim()
    if (!trimmed) return t('settings.piProviders.keyRequired')
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed)) {
      return t('settings.piProviders.keyFormat')
    }
    if (isAdd && existingKeys.includes(trimmed)) {
      return t('settings.piProviders.keyDuplicate')
    }
    return null
  }, [isAdd, existingKeys, t])

  const handleKeyBlur = React.useCallback(() => {
    setKeyError(validateKey(state.key))
  }, [state.key, validateKey])

  const readExistingApiKey = React.useCallback(async (): Promise<string> => {
    if (isAdd || !editingKey) return ''
    setApiKeyLoading(true)
    try {
      const existing = await window.electronAPI.getPiGlobalProviderApiKey(editingKey)
      return existing ?? ''
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.piProviders.fetchFailed'), { description: message })
      return ''
    } finally {
      setApiKeyLoading(false)
    }
  }, [editingKey, isAdd, t])

  const handleToggleApiKeyVisible = React.useCallback(async () => {
    if (apiKeyVisible) {
      setApiKeyVisible(false)
      return
    }

    if (!state.apiKey.trim()) {
      const existing = await readExistingApiKey()
      if (existing) {
        update('apiKey', existing)
      }
    }
    setApiKeyVisible(true)
  }, [apiKeyVisible, readExistingApiKey, state.apiKey, update])

  const formatFetchError = React.useCallback((error: string | undefined): string => {
    const message = error ?? ''
    if (message.includes('returned HTML instead of JSON')) {
      return t('settings.piProviders.fetchReturnedHtml')
    }
    if (message.includes('returned invalid JSON')) {
      return t('settings.piProviders.fetchInvalidJson')
    }
    if (message.includes('returned an empty response')) {
      return t('settings.piProviders.fetchEmptyResponse')
    }
    return message || t('settings.piProviders.fetchFailed')
  }, [t])

  const handleFetchModels = React.useCallback(async () => {
    const baseUrl = state.baseUrl.trim()
    let apiKey = state.apiKey.trim()
    if (!apiKey && fetchRequiresApiKey(state.api, state.authHeader)) {
      apiKey = await readExistingApiKey()
      if (apiKey) update('apiKey', apiKey)
    }

    if (!baseUrl) {
      toast.error(t('settings.piProviders.baseUrlRequired'))
      return
    }
    if (fetchRequiresApiKey(state.api, state.authHeader) && !apiKey) {
      toast.error(t('settings.piProviders.fetchNeedApiKey'))
      return
    }
    if (!isValidHttpUrl(baseUrl)) {
      toast.error(t('settings.piProviders.baseUrlInvalid'))
      return
    }
    setFetching(true)
    setFetchError(null)
    try {
      const result = await window.electronAPI.fetchModelsForEndpoint({
        baseUrl,
        apiKey,
        api: state.api,
        authHeader: state.authHeader,
      })
      if (!result.success) {
        const message = formatFetchError(result.error)
        setFetchError(message)
        toast.error(t('settings.piProviders.fetchFailed'), { description: message })
        return
      }
      setFetchedModels(result.models)
      if (result.models.length === 0) {
        toast.info(t('settings.piProviders.fetchEmpty'))
      } else {
        setState(prev => ({
          ...prev,
          baseUrl: result.resolvedBaseUrl ?? prev.baseUrl,
          models: mergeFetchedModels(prev.models, result.models),
          defaultModel: prev.defaultModel || result.models[0]?.id || prev.defaultModel,
        }))
        toast.success(t('settings.piProviders.fetchSuccess', { count: result.models.length }))
      }
    } catch (error) {
      const message = formatFetchError(error instanceof Error ? error.message : String(error))
      setFetchError(message)
      toast.error(t('settings.piProviders.fetchFailed'), { description: message })
    } finally {
      setFetching(false)
    }
  }, [formatFetchError, readExistingApiKey, state.api, state.apiKey, state.authHeader, state.baseUrl, t, update])

  const handleAddModel = React.useCallback(() => {
    update('models', [...state.models, { id: '', name: '' }])
  }, [state.models, update])

  const handleAddFetchedModel = React.useCallback((modelId: string) => {
    if (state.models.some(m => m.id === modelId)) return
    const fetched = fetchedModels.find(model => model.id === modelId)
    const next = [...state.models, fetched ? fetchedToGlobalModel(fetched) : { id: modelId, name: modelId }]
    update('models', next)
    if (!state.defaultModel) update('defaultModel', modelId)
  }, [fetchedModels, state.models, state.defaultModel, update])

  const handleModelChange = React.useCallback((index: number, field: keyof PiGlobalModel, value: unknown) => {
    const next = [...state.models]
    next[index] = { ...next[index], [field]: value }
    update('models', next)
  }, [state.models, update])

  const handleContextWindowChange = React.useCallback((index: number, value: string) => {
    setContextWindowDrafts(prev => ({ ...prev, [index]: value }))
    const parsed = value.trim() ? parseContextWindowInput(value) : undefined
    if (!value.trim() || parsed !== undefined) {
      handleModelChange(index, 'contextWindow', parsed)
    }
  }, [handleModelChange])

  const handleRemoveModel = React.useCallback((index: number) => {
    const next = [...state.models]
    const [removed] = next.splice(index, 1)
    update('models', next)
    if (removed?.id && removed.id === state.defaultModel) {
      update('defaultModel', next[0]?.id ?? '')
    }
  }, [state.defaultModel, state.models, update])

  const toggleModelAdvanced = React.useCallback((index: number) => {
    setExpandedModels(prev => ({ ...prev, [index]: !prev[index] }))
  }, [])

  const handleImageSupportChange = React.useCallback((index: number, checked: boolean) => {
    const next = [...state.models]
    const currentInput = new Set(next[index].input ?? ['text'])
    currentInput.add('text')
    if (checked) {
      currentInput.add('image')
    } else {
      currentInput.delete('image')
    }
    next[index] = { ...next[index], input: Array.from(currentInput) as ('text' | 'image')[] }
    update('models', next)
  }, [state.models, update])

  const modelSupportsImage = (model: PiGlobalModel): boolean =>
    (model.input ?? ['text']).includes('image')

  const handleSave = React.useCallback(async () => {
    const trimmedKey = state.key.trim()
    const keyErr = validateKey(trimmedKey)
    if (keyErr) {
      setKeyError(keyErr)
      return
    }
    const baseUrl = state.baseUrl.trim()
    if (!baseUrl) {
      toast.error(t('settings.piProviders.baseUrlRequired'))
      return
    }
    if (!isValidHttpUrl(baseUrl)) {
      toast.error(t('settings.piProviders.baseUrlInvalid'))
      return
    }

    const models = normalizeModelsForSave(state.models, state.defaultModel)
    if (models.length === 0) {
      toast.error(t('settings.piProviders.modelsRequired'))
      return
    }

    const provider: PiGlobalProvider = {
      baseUrl,
      api: state.api,
      authHeader: isOpenAiCompatibleApi(state.api) ? state.authHeader : true,
      models,
    }

    setSaving(true)
    try {
      await onSave(trimmedKey, provider, state.apiKey.trim() || undefined)
      onOpenChange(false)
    } catch (err) {
      toast.error(t('settings.piProviders.saveFailed'), {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }, [state, validateKey, onSave, onOpenChange, t])

  // Group fetched models by ownedBy for the picker
  const groupedFetched = React.useMemo(() => {
    const groups: Record<string, FetchedEndpointModel[]> = {}
    for (const m of fetchedModels) {
      const k = m.ownedBy || 'Other'
      ;(groups[k] ??= []).push(m)
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
  }, [fetchedModels])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isAdd ? addProviderLabel : t('settings.piProviders.editProvider')}
          </DialogTitle>
          <DialogDescription>
            {t('settings.piProviders.formDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Provider key */}
          <div className="space-y-2">
            <Label htmlFor="pi-provider-key">
              {t('settings.piProviders.providerKey')}
            </Label>
            <Input
              id="pi-provider-key"
              value={state.key}
              onChange={e => update('key', e.target.value)}
              onBlur={handleKeyBlur}
              placeholder="myapi-gpt"
              disabled={!isAdd}
              className={cn(keyError && 'ring-1 ring-destructive')}
            />
            {keyError ? (
              <p className="text-xs text-destructive">{keyError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('settings.piProviders.providerKeyHint')}
              </p>
            )}
          </div>

          {/* Base URL */}
          <div className="space-y-2">
            <Label htmlFor="pi-provider-baseurl">
              {t('settings.piProviders.baseUrl')}
            </Label>
            <Input
              id="pi-provider-baseurl"
              value={state.baseUrl}
              onChange={e => update('baseUrl', e.target.value)}
              placeholder={currentApiOption.baseUrlPlaceholder}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.piProviders.baseUrlHint', { example: currentApiOption.baseUrlPlaceholder })}
            </p>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="pi-provider-apikey">
              {t('settings.piProviders.apiKey')}
            </Label>
            <div className="relative">
              <Input
                id="pi-provider-apikey"
                type={apiKeyVisible ? 'text' : 'password'}
                value={state.apiKey}
                onChange={e => update('apiKey', e.target.value)}
                placeholder={isAdd
                  ? t('settings.piProviders.apiKeyPlaceholderAdd')
                  : t('settings.piProviders.apiKeyPlaceholderEdit')}
                className="pr-11 font-mono"
                autoComplete="off"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1 h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={handleToggleApiKeyVisible}
                disabled={apiKeyLoading}
                title={apiKeyVisible ? t('settings.piProviders.hideApiKey') : t('settings.piProviders.showApiKey')}
                aria-label={apiKeyVisible ? t('settings.piProviders.hideApiKey') : t('settings.piProviders.showApiKey')}
              >
                {apiKeyLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : apiKeyVisible ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {isAdd ? t('settings.piProviders.apiKeyHintAdd') : t('settings.piProviders.apiKeyHintEdit')}
            </p>
          </div>

          {/* API type */}
          <div className="space-y-2">
            <Label htmlFor="pi-provider-api">
              {t('settings.piProviders.apiType')}
            </Label>
            <Select value={state.api} onValueChange={v => handleApiChange(v as PiCustomApi)}>
              <SelectTrigger id="pi-provider-api">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={FLOATING_MENU_CLASS}>
                {PI_API_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(currentApiOption.hintKey)}
            </p>
          </div>

          {/* Auth header toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5">
            <div className="space-y-0.5 pr-3">
              <Label htmlFor="pi-provider-auth-header" className="text-sm">
                {isOpenAiCompatibleApi(state.api)
                  ? t('settings.piProviders.authHeader')
                  : t('settings.piProviders.authMode')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {isOpenAiCompatibleApi(state.api)
                  ? t('settings.piProviders.authHeaderHint')
                  : t(`settings.piProviders.apiAuthHint.${state.api}`)}
              </p>
            </div>
            {isOpenAiCompatibleApi(state.api) ? (
              <Switch
                id="pi-provider-auth-header"
                checked={state.authHeader}
                onCheckedChange={v => update('authHeader', v)}
              />
            ) : (
              <span className="shrink-0 rounded-[4px] bg-foreground/5 px-2 py-1 text-xs text-muted-foreground">
                {t('settings.piProviders.managedAuth')}
              </span>
            )}
          </div>

          {/* Default model + fetch button */}
          <div className="space-y-2">
            <Label htmlFor="pi-provider-default-model">
              {t('settings.piProviders.providerDefaultModel')}
            </Label>
            <div className="flex gap-1.5">
              <Input
                id="pi-provider-default-model"
                value={state.defaultModel}
                onChange={e => update('defaultModel', e.target.value)}
                placeholder={currentApiOption.modelPlaceholder}
                className="flex-1"
              />
              {fetchedModels.length > 0 && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      title={t('settings.piProviders.pickFetched')}
                      aria-label={t('settings.piProviders.pickFetched')}
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className={cn('max-h-64 w-80 overflow-y-auto', FLOATING_MENU_CLASS)}>
                    {groupedFetched.map(([vendor, items], idx) => (
                      <div key={vendor}>
                        {idx > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel>{vendor}</DropdownMenuLabel>
                        {items.map(item => (
                          <DropdownMenuItem
                            key={item.id}
                            onSelect={() => update('defaultModel', item.id)}
                          >
                            <FetchedModelMenuLabel item={item} />
                          </DropdownMenuItem>
                        ))}
                      </div>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                type="button"
                onClick={handleFetchModels}
                disabled={fetching}
                title={t('settings.piProviders.fetchModels')}
                aria-label={t('settings.piProviders.fetchModels')}
              >
                {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('settings.piProviders.providerDefaultModelHint')}
            </p>
            {fetchError ? (
              <p className="text-xs text-destructive">{fetchError}</p>
            ) : null}
          </div>

          {/* Models list */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>{t('settings.piProviders.models')}</Label>
              <div className="flex flex-wrap gap-1">
                {fetchedModels.length > 0 && (
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 gap-1">
                        <Download className="h-3.5 w-3.5" />
                        {t('settings.piProviders.pickFetched')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className={cn('max-h-64 w-80 overflow-y-auto', FLOATING_MENU_CLASS)}>
                      {groupedFetched.map(([vendor, items], idx) => (
                        <div key={vendor}>
                          {idx > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuLabel>{vendor}</DropdownMenuLabel>
                          {items.map(item => (
                            <DropdownMenuItem
                              key={item.id}
                              onSelect={() => handleAddFetchedModel(item.id)}
                            >
                              <FetchedModelMenuLabel item={item} />
                            </DropdownMenuItem>
                          ))}
                        </div>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button variant="outline" size="sm" className="h-7 gap-1" type="button" onClick={handleAddModel}>
                  <Plus className="h-3.5 w-3.5" />
                  {t('settings.piProviders.addModel')}
                </Button>
              </div>
            </div>
            {state.models.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                {t('settings.piProviders.modelsEmpty')}
              </div>
            ) : (
              <div className="space-y-2">
                {state.models.map((model, index) => (
                  <div key={index} className="rounded-lg border border-border/50 p-3 space-y-2">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <Input
                        value={model.id}
                        onChange={e => handleModelChange(index, 'id', e.target.value)}
                        placeholder="model-id"
                        className="flex-1"
                      />
                      <Input
                        value={model.name ?? ''}
                        onChange={e => handleModelChange(index, 'name', e.target.value)}
                        placeholder={t('settings.piProviders.displayName')}
                        className="flex-1"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        type="button"
                        className="justify-self-end text-muted-foreground hover:text-destructive sm:justify-self-auto"
                        onClick={() => handleRemoveModel(index)}
                        title={t('settings.piProviders.removeModel')}
                        aria-label={t('settings.piProviders.removeModel')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <Collapsible open={expandedModels[index] ?? false} onOpenChange={() => toggleModelAdvanced(index)}>
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="sm" type="button" className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground">
                          {expandedModels[index] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          {t('settings.piProviders.advancedOptions')}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-2.5 pt-1.5">
                        <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
                          <Label htmlFor={`pi-model-reasoning-${index}`} className="text-xs">
                            {t('settings.piProviders.reasoning')}
                          </Label>
                          <Switch
                            id={`pi-model-reasoning-${index}`}
                            checked={model.reasoning === true}
                            onCheckedChange={v => handleModelChange(index, 'reasoning', v)}
                          />
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
                          <Label htmlFor={`pi-model-image-${index}`} className="text-xs">
                            {t('settings.piProviders.imageSupport')}
                          </Label>
                          <Switch
                            id={`pi-model-image-${index}`}
                            checked={modelSupportsImage(model)}
                            onCheckedChange={v => handleImageSupportChange(index, v)}
                          />
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label className="text-xs">{t('settings.piProviders.contextWindow')}</Label>
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={contextWindowDrafts[index] ?? (model.contextWindow ?? '')}
                              onChange={e => handleContextWindowChange(index, e.target.value)}
                              placeholder="200K"
                              aria-label={`${t('settings.piProviders.contextWindow')} (tokens, K/M)`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">{t('settings.piProviders.maxTokens')}</Label>
                            <Input
                              type="number"
                              value={model.maxTokens ?? ''}
                              onChange={e => handleModelChange(index, 'maxTokens', e.target.value ? Number(e.target.value) : undefined)}
                              placeholder="8192"
                            />
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving || fetching}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            {isAdd ? t('common.add') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
