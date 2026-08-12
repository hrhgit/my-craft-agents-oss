/**
 * ModelEditDialog
 *
 * Per-model basic edit dialog, opened from the provider models dropdown in
 * PiProvidersSection. Edits are applied to the provider's models array and
 * persisted via savePiGlobalProvider (models.json).
 *
 * Fields:
 *   - 显示名称 (display name)
 *   - 标签 (tags: preset chips 常用/快速/轻量 + custom input) — tagged models
 *     show badges in the session model picker and can be surfaced alone via
 *     the "仅显示标签模型" mode
 *   - 支持图片输入 / 支持思考模式
 *   - 上下文窗口 / 最大输出 Tokens
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Tag, X } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import type { PiGlobalProvider, PiGlobalModel } from '../../../shared/types'
import { parseContextWindowInput } from '@mortise/shared/config/pi-provider-models'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** Preset tag suggestions shown as clickable chips. Stored verbatim as user data. */
const TAG_PRESETS = ['常用', '快速', '轻量']

/** Select value sentinel meaning "no vision proxy configured". */
const VISION_PROXY_NONE = '__vision_proxy_none__'

interface ModelEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerKey: string
  provider: PiGlobalProvider
  model: PiGlobalModel
  /** All configured providers (with their models) used as vision proxy candidates. */
  allProviders: Array<{ key: string; provider: PiGlobalProvider }>
  onSave: (providerKey: string, provider: PiGlobalProvider) => Promise<void>
}

function modelSupportsImage(model: PiGlobalModel): boolean {
  return (model.input ?? ['text']).includes('image')
}

export function ModelEditDialog({
  open,
  onOpenChange,
  providerKey,
  provider,
  model,
  allProviders,
  onSave,
}: ModelEditDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = React.useState('')
  const [tags, setTags] = React.useState<string[]>([])
  const [tagDraft, setTagDraft] = React.useState('')
  const [reasoning, setReasoning] = React.useState(true)
  const [imageInput, setImageInput] = React.useState(false)
  const [visionProxy, setVisionProxy] = React.useState<{ provider: string; model: string } | undefined>(undefined)
  const [contextWindowDraft, setContextWindowDraft] = React.useState('')
  const [contextWindow, setContextWindow] = React.useState<number | undefined>(undefined)
  const [maxTokens, setMaxTokens] = React.useState<number | undefined>(undefined)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setName(model.name ?? '')
    setTags((model.tags ?? []).filter(tag => typeof tag === 'string' && tag.trim().length > 0))
    setTagDraft('')
    setReasoning(model.reasoning !== false)
    setImageInput(modelSupportsImage(model))
    setVisionProxy(
      model.visionProxy && typeof model.visionProxy.provider === 'string' && typeof model.visionProxy.model === 'string'
        ? { provider: model.visionProxy.provider, model: model.visionProxy.model }
        : undefined,
    )
    setContextWindowDraft(model.contextWindow != null ? String(model.contextWindow) : '')
    setContextWindow(model.contextWindow)
    setMaxTokens(model.maxTokens)
    setSaving(false)
  }, [open, model])

  // Vision proxy candidates: all models of all providers, excluding this model itself.
  const visionProxyCandidates = React.useMemo(() => {
    const candidates: Array<{ provider: string; model: PiGlobalModel; label: string }> = []
    for (const entry of allProviders) {
      for (const candidate of entry.provider.models ?? []) {
        if (entry.key === providerKey && candidate.id === model.id) continue
        candidates.push({
          provider: entry.key,
          model: candidate,
          label: `${entry.key} · ${candidate.name ?? candidate.id}`,
        })
      }
    }
    return candidates
  }, [allProviders, providerKey, model.id])

  const visionProxyValue = visionProxy ? `${visionProxy.provider}\u0001${visionProxy.model}` : VISION_PROXY_NONE

  const addTag = React.useCallback((raw: string) => {
    const tag = raw.trim()
    if (!tag) return
    setTags(prev => (prev.includes(tag) ? prev : [...prev, tag]))
    setTagDraft('')
  }, [])

  const removeTag = React.useCallback((tag: string) => {
    setTags(prev => prev.filter(candidate => candidate !== tag))
  }, [])

  const handleContextWindowChange = React.useCallback((value: string) => {
    setContextWindowDraft(value)
    const parsed = value.trim() ? parseContextWindowInput(value) : undefined
    if (!value.trim() || parsed !== undefined) {
      setContextWindow(parsed)
    }
  }, [])

  const handleSave = React.useCallback(async () => {
    if (!provider.models?.some(candidate => candidate.id === model.id)) {
      onOpenChange(false)
      return
    }
    const nextModel: PiGlobalModel = { ...model }
    const trimmedName = name.trim()
    if (trimmedName) nextModel.name = trimmedName
    else delete nextModel.name
    if (tags.length > 0) nextModel.tags = tags
    else delete nextModel.tags
    if (!reasoning) nextModel.reasoning = false
    else delete nextModel.reasoning
    const input = new Set<'text' | 'image'>(model.input ?? ['text'])
    input.add('text')
    if (imageInput) input.add('image')
    else input.delete('image')
    nextModel.input = ['text', 'image'].filter(kind => input.has(kind as 'text' | 'image')) as ('text' | 'image')[]
    if (contextWindow != null) nextModel.contextWindow = contextWindow
    else delete nextModel.contextWindow
    if (maxTokens != null) nextModel.maxTokens = maxTokens
    else delete nextModel.maxTokens

    nextModel.visionProxy = visionProxy
    if (!visionProxy) delete nextModel.visionProxy

    const nextProvider: PiGlobalProvider = {
      ...provider,
      models: provider.models.map(candidate =>
        candidate.id === model.id ? nextModel : candidate,
      ),
    }
    setSaving(true)
    try {
      await onSave(providerKey, nextProvider)
      onOpenChange(false)
    } catch (error) {
      console.error('Failed to save model edits:', error)
    } finally {
      setSaving(false)
    }
  }, [name, tags, reasoning, imageInput, visionProxy, contextWindow, maxTokens, model, provider, providerKey, onSave, onOpenChange])

  const presetChips = TAG_PRESETS.filter(preset => !tags.includes(preset))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('settings.piProviders.editModelTitle')}</DialogTitle>
          <DialogDescription>
            {providerKey}/{model.id}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Display name */}
          <div className="space-y-2">
            <Label htmlFor="pi-model-edit-name">
              {t('settings.piProviders.displayName')}
            </Label>
            <Input
              id="pi-model-edit-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={model.id}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.piProviders.displayNameHint')}
            </p>
          </div>

          {/* Tags */}
          <div className="space-y-2">
            <Label>{t('settings.piProviders.tags')}</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 h-6 px-2 text-xs font-medium rounded-[4px] bg-foreground/10 text-foreground/80"
                >
                  <Tag className="h-3 w-3 opacity-60" />
                  {tag}
                  <button
                    type="button"
                    className="p-0.5 rounded-sm hover:bg-foreground/10"
                    onClick={() => removeTag(tag)}
                    aria-label={t('settings.piProviders.removeTag', { tag })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {tags.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  {t('settings.piProviders.tagsEmpty')}
                </span>
              )}
            </div>
            <div className="flex gap-1.5">
              <Input
                value={tagDraft}
                onChange={e => setTagDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addTag(tagDraft)
                  }
                }}
                placeholder={t('settings.piProviders.tagPlaceholder')}
                className="flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0"
                onClick={() => addTag(tagDraft)}
              >
                {t('settings.piProviders.addTag')}
              </Button>
            </div>
            {presetChips.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {presetChips.map(preset => (
                  <button
                    key={preset}
                    type="button"
                    className="h-6 px-2 text-xs rounded-[4px] border border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
                    onClick={() => addTag(preset)}
                  >
                    + {preset}
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t('settings.piProviders.tagsHint')}
            </p>
          </div>

          {/* Vision proxy model */}
          <div className="space-y-2">
            <Label htmlFor="pi-model-edit-vision-proxy">
              {t('settings.piProviders.visionProxy')}
            </Label>
            <Select
              value={visionProxyValue}
              onValueChange={value => {
                if (value === VISION_PROXY_NONE) {
                  setVisionProxy(undefined)
                  return
                }
                const separator = value.indexOf('\u0001')
                if (separator < 0) return
                setVisionProxy({
                  provider: value.slice(0, separator),
                  model: value.slice(separator + 1),
                })
              }}
            >
              <SelectTrigger semanticId="pi-model-edit-vision-proxy">
                <SelectValue placeholder={t('settings.piProviders.visionProxyNone')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={VISION_PROXY_NONE}>{t('settings.piProviders.visionProxyNone')}</SelectItem>
                {visionProxyCandidates.map(candidate => (
                  <SelectItem
                    key={`${candidate.provider}\u0001${candidate.model.id}`}
                    value={`${candidate.provider}\u0001${candidate.model.id}`}
                  >
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('settings.piProviders.visionProxyHint')}
            </p>
          </div>

          {/* Capabilities */}
          <div className={cn('grid gap-2.5 sm:grid-cols-2')}>
            <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5">
              <Label htmlFor="pi-model-edit-image" className="text-xs">
                {t('settings.piProviders.imageSupport')}
              </Label>
              <Switch
                id="pi-model-edit-image"
                checked={imageInput}
                onCheckedChange={setImageInput}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2.5">
              <Label htmlFor="pi-model-edit-reasoning" className="text-xs">
                {t('settings.piProviders.reasoning')}
              </Label>
              <Switch
                id="pi-model-edit-reasoning"
                checked={reasoning}
                onCheckedChange={setReasoning}
              />
            </div>
          </div>

          {/* Context / tokens */}
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">{t('settings.piProviders.contextWindow')}</Label>
              <Input
                type="text"
                inputMode="decimal"
                value={contextWindowDraft}
                onChange={e => handleContextWindowChange(e.target.value)}
                placeholder="200K"
                aria-label={`${t('settings.piProviders.contextWindow')} (tokens, K/M)`}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('settings.piProviders.maxTokens')}</Label>
              <Input
                type="number"
                value={maxTokens ?? ''}
                onChange={e => setMaxTokens(e.target.value ? Number(e.target.value) : undefined)}
                placeholder="8192"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
