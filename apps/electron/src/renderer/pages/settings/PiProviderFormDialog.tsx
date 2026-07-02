/**
 * PiProviderFormDialog
 *
 * Add/Edit dialog for a single Pi global provider (~/.pi/agent/models.json).
 * Core fields (per "核心字段先跑通" scope, excluding thinkingLevelMap 3-state
 * and cost):
 *   - key (only when adding; lowercase slug)
 *   - baseUrl, apiKey, api (4 built-in protocols), authHeader
 *   - defaultModel (free text + fetch-from-endpoint picker)
 *   - models list (id + name + collapsible advanced: reasoning / image /
 *     contextWindow / maxTokens)
 *
 * Writes go through savePiGlobalProvider RPC, which broadcasts GLOBAL_CHANGED
 * so usePiGlobalConfig (and the list page) refresh automatically.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Download, Loader2, Plus, Trash2 } from 'lucide-react'
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

const PI_API_OPTIONS: Array<{ value: PiCustomApi; label: string }> = [
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
]

interface PiProviderFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When editing, the existing provider key. When null, "add" mode. */
  editingKey: string | null
  /** When editing, the existing provider data. When null, defaults are used. */
  initialProvider?: PiGlobalProvider
  /** Existing keys — used to prevent duplicates in "add" mode. */
  existingKeys: string[]
  /** Called with the new key + provider payload when the user saves. */
  onSave: (key: string, provider: PiGlobalProvider) => Promise<void>
}

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
    apiKey: initial?.apiKey ?? '',
    api: (initial?.api as PiCustomApi) ?? 'openai-completions',
    authHeader: initial?.authHeader ?? true,
    defaultModel: (initial?.models?.[0]?.id) ?? '',
    models: initial?.models ?? [],
  }
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
  const [keyError, setKeyError] = React.useState<string | null>(null)
  const [expandedModels, setExpandedModels] = React.useState<Record<number, boolean>>({})

  // Reset form state when the dialog opens (so switching between rows doesn't keep stale state)
  React.useEffect(() => {
    if (open) {
      setState(buildInitialState(editingKey, initialProvider))
      setFetchedModels([])
      setKeyError(null)
    }
  }, [open, editingKey, initialProvider])

  const update = React.useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState(prev => ({ ...prev, [key]: value }))
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

  const handleFetchModels = React.useCallback(async () => {
    if (!state.baseUrl || !state.apiKey) {
      toast.error(t('settings.piProviders.fetchNeedBoth'))
      return
    }
    setFetching(true)
    try {
      const result = await window.electronAPI.fetchModelsForEndpoint({
        baseUrl: state.baseUrl,
        apiKey: state.apiKey,
      })
      if (!result.success) {
        toast.error(t('settings.piProviders.fetchFailed'), { description: result.error })
        return
      }
      setFetchedModels(result.models)
      if (result.models.length === 0) {
        toast.info(t('settings.piProviders.fetchEmpty'))
      } else {
        toast.success(t('settings.piProviders.fetchSuccess', { count: result.models.length }))
      }
    } finally {
      setFetching(false)
    }
  }, [state.baseUrl, state.apiKey, t])

  const handleAddModel = React.useCallback(() => {
    update('models', [...state.models, { id: '', name: '' }])
  }, [state.models, update])

  const handleAddFetchedModel = React.useCallback((modelId: string) => {
    if (state.models.some(m => m.id === modelId)) return
    const next = [...state.models, { id: modelId, name: modelId }]
    update('models', next)
    if (!state.defaultModel) update('defaultModel', modelId)
  }, [state.models, state.defaultModel, update])

  const handleModelChange = React.useCallback((index: number, field: keyof PiGlobalModel, value: unknown) => {
    const next = [...state.models]
    next[index] = { ...next[index], [field]: value }
    update('models', next)
  }, [state.models, update])

  const handleRemoveModel = React.useCallback((index: number) => {
    const next = [...state.models]
    next.splice(index, 1)
    update('models', next)
  }, [state.models, update])

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
    (model.input ?? ['text', 'image']).includes('image')

  const handleSave = React.useCallback(async () => {
    const trimmedKey = state.key.trim()
    const keyErr = validateKey(trimmedKey)
    if (keyErr) {
      setKeyError(keyErr)
      return
    }
    if (!state.baseUrl.trim()) {
      toast.error(t('settings.piProviders.baseUrlRequired'))
      return
    }

    // Ensure defaultModel is part of the models list; if not, prepend it as an entry
    const defaultModel = state.defaultModel.trim()
    let models = state.models.filter(m => m.id.trim())
    if (defaultModel && !models.some(m => m.id === defaultModel)) {
      models = [{ id: defaultModel, name: defaultModel }, ...models]
    }

    const provider: PiGlobalProvider = {
      baseUrl: state.baseUrl.trim(),
      apiKey: state.apiKey.trim() || undefined,
      api: state.api,
      authHeader: state.authHeader,
      models,
    }

    setSaving(true)
    try {
      await onSave(trimmedKey, provider)
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
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isAdd ? t('settings.piProviders.addProvider') : t('settings.piProviders.editProvider')}
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
              placeholder="https://api.example.com/v1"
            />
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="pi-provider-apikey">
              {t('settings.piProviders.apiKey')}
            </Label>
            <Input
              id="pi-provider-apikey"
              type="password"
              value={state.apiKey}
              onChange={e => update('apiKey', e.target.value)}
              placeholder="sk-..."
            />
          </div>

          {/* API type */}
          <div className="space-y-2">
            <Label htmlFor="pi-provider-api">
              {t('settings.piProviders.apiType')}
            </Label>
            <Select value={state.api} onValueChange={v => update('api', v as PiCustomApi)}>
              <SelectTrigger id="pi-provider-api">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PI_API_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Auth header toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5">
            <div className="space-y-0.5 pr-3">
              <Label htmlFor="pi-provider-auth-header" className="text-sm">
                {t('settings.piProviders.authHeader')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('settings.piProviders.authHeaderHint')}
              </p>
            </div>
            <Switch
              id="pi-provider-auth-header"
              checked={state.authHeader}
              onCheckedChange={v => update('authHeader', v)}
            />
          </div>

          {/* Default model + fetch button */}
          <div className="space-y-2">
            <Label htmlFor="pi-provider-default-model">
              {t('settings.piProviders.defaultModel')}
            </Label>
            <div className="flex gap-1.5">
              <Input
                id="pi-provider-default-model"
                value={state.defaultModel}
                onChange={e => update('defaultModel', e.target.value)}
                placeholder="gpt-4o-mini"
                className="flex-1"
              />
              {fetchedModels.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="shrink-0">
                      <Download className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto z-[200]">
                    {groupedFetched.map(([vendor, items], idx) => (
                      <div key={vendor}>
                        {idx > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel>{vendor}</DropdownMenuLabel>
                        {items.map(item => (
                          <DropdownMenuItem
                            key={item.id}
                            onSelect={() => update('defaultModel', item.id)}
                          >
                            {item.id}
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
              >
                {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* Models list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('settings.piProviders.models')}</Label>
              <div className="flex gap-1">
                {fetchedModels.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 gap-1">
                        <Download className="h-3.5 w-3.5" />
                        {t('settings.piProviders.pickFetched')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto z-[200]">
                      {groupedFetched.map(([vendor, items], idx) => (
                        <div key={vendor}>
                          {idx > 0 && <DropdownMenuSeparator />}
                          <DropdownMenuLabel>{vendor}</DropdownMenuLabel>
                          {items.map(item => (
                            <DropdownMenuItem
                              key={item.id}
                              onSelect={() => handleAddFetchedModel(item.id)}
                            >
                              {item.id}
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
                    <div className="flex items-center gap-2">
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
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => handleRemoveModel(index)}
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
                        <div className="grid gap-2 grid-cols-2">
                          <div className="space-y-1">
                            <Label className="text-xs">{t('settings.piProviders.contextWindow')}</Label>
                            <Input
                              type="number"
                              value={model.contextWindow ?? ''}
                              onChange={e => handleModelChange(index, 'contextWindow', e.target.value ? Number(e.target.value) : undefined)}
                              placeholder="200000"
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
