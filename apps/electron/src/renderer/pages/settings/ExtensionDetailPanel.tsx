import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, ChevronDown, ExternalLink, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleTrigger, AnimatedCollapsibleContent } from '@/components/ui/collapsible'
import { SettingsCard, SettingsInputRow, SettingsSection, SettingsSelectRow, SettingsTextarea, SettingsToggle, useModelReferenceOptions } from '@/components/settings'
import type { PiExtensionCatalogEntry, PiExtensionSettingField, PiExtensionSettingScalar, PiGlobalDefaultSlot, PiGlobalProviderForDisplay } from '@mortise/shared/config'
import { PI_MODEL_REFERENCE_CURRENT_SESSION } from '@mortise/shared/config/pi-extension-settings'

interface ExtensionDetailPanelProps {
  extension: PiExtensionCatalogEntry
  providers: PiGlobalProviderForDisplay[]
  defaultSlots: PiGlobalDefaultSlot[]
  onPatch: (key: string, value: PiExtensionSettingScalar) => Promise<void>
  onUnset: (key: string) => Promise<void>
  onBack?: () => void
  onUninstall?: () => void
  showMetadata?: boolean
  className?: string
}

export function ExtensionDetailPanel({ extension, providers, defaultSlots, onPatch, onUnset, onBack, onUninstall, showMetadata = true, className }: ExtensionDetailPanelProps) {
  const { t } = useTranslation()
  const modelOptions = useMemo(() => providers.flatMap((entry) => (entry.provider.models ?? []).map((model) => ({
    value: model.id,
    label: model.name ?? model.id,
    description: entry.key,
  }))), [providers])
  const modelReferenceOptions = useModelReferenceOptions(providers, defaultSlots)
  const values = extension.config ?? {}
  const fields = extension.ui?.schemaVersion === 1 ? extension.ui.settings?.fields ?? [] : []
  const effectiveValues = Object.assign(Object.fromEntries(fields.filter((field) => field.default !== undefined).map((field) => [field.key, field.default])), values)
  const sections = buildExtensionSettingSections(extension)

  return (
    <div className={className ?? 'space-y-4'}>
      {onBack && <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 size-3.5" />
          {t('settings.extensions.backToList')}
        </Button>
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t('common.close')} title={t('common.close')}>
          <X className="size-4" />
        </Button>
      </div>}
      {showMetadata && <ExtensionOverview extension={extension} t={t} />}
      {showMetadata && <ExtensionDependencyInfo extension={extension} t={t} />}
      {showMetadata && <ExtensionCapabilityInfo extension={extension} />}
      {sections.map((section) => section.fields.length > 0 && (
        <SettingsSection key={section.id} title={section.title} description={section.description}>
          <SettingsCard>
            {section.fields.map((field) => isVisible(field, effectiveValues) && (
              <ExtensionSettingControl
                key={field.key}
                field={field}
                value={effectiveValues[field.key] as PiExtensionSettingScalar | undefined}
                modelOptions={modelOptions}
                onChange={(value) => onPatch(field.key, value)}
                onUnset={() => onUnset(field.key)}
                modelReferenceOptions={modelReferenceOptions}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      ))}
      {showMetadata && <ExtensionMoreInfo extension={extension} t={t} />}
      {onUninstall && (
        <SettingsSection title={t('settings.extensions.dangerZone')}>
          <SettingsCard>
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t('settings.extensions.uninstall')}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.extensions.uninstallFromDetailDescription')}</div>
              </div>
              <Button variant="destructive" size="sm" onClick={onUninstall}>
                <Trash2 />
                {t('settings.extensions.uninstall')}
              </Button>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}
    </div>
  )
}

function ExtensionCapabilityInfo({ extension }: { extension: PiExtensionCatalogEntry }) {
  const provides = Object.entries(extension.manifest?.provides ?? {})
  const bindings = extension.capabilityBindings ?? []
  if (provides.length === 0 && bindings.length === 0) return null
  return (
    <SettingsSection title="扩展能力">
      <SettingsCard>
        <div className="divide-y divide-border/60">
          {provides.length > 0 && <div className="px-4 py-3.5">
            <div className="text-xs font-medium text-muted-foreground">提供</div>
            <div className="mt-2 space-y-2">
              {provides.map(([id, declaration]) => <div key={id} className="flex flex-wrap items-center gap-2 text-sm">
                <span>{id}</span><Badge variant="secondary">{declaration.version}</Badge><Badge variant="outline">{declaration.scope}</Badge>
                {declaration.service && <Badge variant="outline">服务</Badge>}{declaration.ui && <Badge variant="outline">界面</Badge>}
              </div>)}
            </div>
          </div>}
          {bindings.length > 0 && <div className="px-4 py-3.5">
            <div className="text-xs font-medium text-muted-foreground">消费与绑定</div>
            <div className="mt-2 space-y-2">
              {bindings.map(binding => <div key={binding.alias} className="text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span>{binding.alias}</span><span className="text-muted-foreground">{binding.capability} {binding.version}</span>
                  <Badge variant={binding.status === 'bound' ? 'secondary' : binding.required ? 'destructive' : 'outline'}>{binding.status}</Badge>
                </div>
                {binding.providerExtensionId && <div className="mt-0.5 text-xs text-muted-foreground">提供者：{binding.providerExtensionId} {binding.providerVersion ?? ''}</div>}
                {binding.candidateProviderIds && binding.candidateProviderIds.length > 1 && <div className="mt-0.5 text-xs text-muted-foreground">候选：{binding.candidateProviderIds.join(', ')}</div>}
              </div>)}
            </div>
          </div>}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

function ExtensionOverview({ extension, t }: { extension: PiExtensionCatalogEntry; t: (key: string) => string }) {
  const manifest = extension.manifest
  return (
    <SettingsCard>
      <div className="space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{extension.title || extension.id}</h2>
            {extension.description && <p className="mt-1 text-sm text-muted-foreground">{extension.description}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {manifest?.version && <span>{t('settings.extensions.version')}: {manifest.version}</span>}
          {manifest?.author?.name && <span>{t('settings.extensions.author')}: {manifest.author.name}</span>}
          {extension.category && <span>{t('settings.extensions.categoryLabel')}: {t(`settings.extensions.category.${extension.category}`)}</span>}
        </div>
      </div>
    </SettingsCard>
  )
}

function ExtensionDependencyInfo({ extension, t }: { extension: PiExtensionCatalogEntry; t: (key: string) => string }) {
  const manifest = extension.manifest
  const dependencyGroups = [
    [t('settings.extensions.requiredDependencies'), manifest?.dependencies],
    [t('settings.extensions.optionalDependencies'), manifest?.optionalDependencies],
    [t('settings.extensions.conflicts'), manifest?.conflicts],
  ] as const
  const hasDependencies = dependencyGroups.some(([, values]) => values && Object.keys(values).length > 0)
  const hasDiagnostics = extension.manifestDiagnostics.length > 0
  if (!hasDependencies && !hasDiagnostics) return null
  return (
    <SettingsSection title={hasDependencies ? t('settings.extensions.dependencies') : t('settings.extensions.diagnostics')}>
      <SettingsCard>
        <div className="divide-y divide-border/60">
          {hasDependencies && (
            <div className="px-4 py-3.5">
              <div className="text-xs font-medium text-muted-foreground">{t('settings.extensions.dependencies')}</div>
              <div className="mt-2 space-y-2">
                {dependencyGroups.map(([label, values]) => values && Object.keys(values).length > 0 && (
                  <div key={label} className="text-sm">
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {Object.entries(values).map(([id, range]) => <Badge key={id} variant="secondary">{id} {range}</Badge>)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {hasDiagnostics && (
            <div className="px-4 py-3.5">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <AlertTriangle className="size-3.5" />
                {t('settings.extensions.diagnostics')}
              </div>
              <div className="mt-2 space-y-1.5">
                {extension.manifestDiagnostics.map((diagnostic, index) => (
                  <div key={`${diagnostic.code}:${index}`} className={diagnostic.severity === 'error' ? 'text-sm text-destructive' : 'text-sm text-amber-700'}>
                    {diagnostic.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

function ExtensionMoreInfo({ extension, t }: { extension: PiExtensionCatalogEntry; t: (key: string) => string }) {
  const [open, setOpen] = useState(false)
  const manifest = extension.manifest
  const links = [
    [t('settings.extensions.homepage'), manifest?.homepage],
    [t('settings.extensions.repository'), manifest?.repository],
    [t('settings.extensions.authorHomepage'), manifest?.author?.url],
  ] as const
  const hasMore = links.some(([, value]) => Boolean(value)) || Boolean(manifest?.license)
  if (!hasMore) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SettingsCard>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center justify-between px-4 py-3.5 text-left">
            <span className="text-sm font-medium">{t('settings.extensions.moreInfo')}</span>
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        </CollapsibleTrigger>
        <AnimatedCollapsibleContent isOpen={open}>
          <div className="space-y-2 border-t border-border/60 px-4 py-3.5 text-sm">
            {links.map(([label, value]) => value && <ExternalInfoLink key={label} label={label} value={value} />)}
            {manifest?.license && <InfoRow label={t('settings.extensions.license')} value={manifest.license} />}
          </div>
        </AnimatedCollapsibleContent>
      </SettingsCard>
    </Collapsible>
  )
}

function ExternalInfoLink({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <a className="flex min-w-0 items-center gap-1 text-right text-foreground underline-offset-4 hover:underline" href={value} target="_blank" rel="noreferrer">
        <span className="truncate">{value}</span>
        <ExternalLink className="size-3.5 shrink-0" />
      </a>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 px-4 py-3.5 text-sm"><span className="text-muted-foreground">{label}</span><span className="text-right">{value}</span></div>
}

function isVisible(field: PiExtensionSettingField, values: Record<string, unknown>): boolean {
  if (!field.visibleWhen) return true
  return values[field.visibleWhen.key] === field.visibleWhen.equals
}

export function buildExtensionSettingSections(extension: PiExtensionCatalogEntry): Array<{
  id: string
  title: string
  description?: string
  fields: PiExtensionSettingField[]
}> {
  const schema = extension.ui?.schemaVersion === 1 ? extension.ui.settings : undefined
  const groups = schema?.groups ?? []
  const fields = schema?.fields ?? []
  if (groups.length === 0) {
    return [{
      id: 'settings',
      title: extension.ui?.title ?? extension.title,
      description: extension.ui?.description ?? extension.description,
      fields,
    }]
  }

  const groupIds = new Set(groups.map((group) => group.id))
  const ungroupedFields = fields.filter((field) => !field.group || !groupIds.has(field.group))
  const sections = groups.map((group) => ({
    ...group,
    fields: fields.filter((field) => field.group === group.id),
  }))
  if (ungroupedFields.length > 0) {
    sections.push({
      id: 'settings',
      title: extension.ui?.title ?? extension.title,
      description: extension.ui?.description ?? extension.description,
      fields: ungroupedFields,
    })
  }
  return sections
}

function ExtensionSettingControl({ field, value, modelOptions, onChange, onUnset, modelReferenceOptions }: {
  field: PiExtensionSettingField
  value: PiExtensionSettingScalar | undefined
  modelOptions: Array<{ value: string; label: string; description?: string }>
  onChange: (value: PiExtensionSettingScalar) => void
  onUnset: () => void
  modelReferenceOptions: Array<{ value: string; label: string; description?: string }>
}) {
  if (field.type === 'boolean') {
    return <SettingsToggle label={field.label} description={field.description} checked={value === true} onCheckedChange={onChange} />
  }
  if (field.type === 'select' || field.type === 'model') {
    const options = field.type === 'select' ? field.options : modelOptions
    return <SettingsSelectRow label={field.label} description={field.description} value={typeof value === 'string' ? value : ''} options={options} onValueChange={onChange} />
  }
  if (field.type === 'model-reference') {
    const selected = typeof value === 'string' && value ? value : PI_MODEL_REFERENCE_CURRENT_SESSION
    return <SettingsSelectRow label={field.label} description={field.description} value={selected} options={modelReferenceOptions} onValueChange={(next) => {
      if (next === PI_MODEL_REFERENCE_CURRENT_SESSION && (!field.default || field.default === PI_MODEL_REFERENCE_CURRENT_SESSION)) onUnset()
      else onChange(next)
    }} />
  }
  if (field.type === 'textarea') {
    return <SettingsTextarea inCard label={field.label} description={field.description} value={typeof value === 'string' ? value : ''} maxLength={field.maxLength} onChange={onChange} />
  }
  if (field.type === 'number') {
    return <NumberExtensionSettingControl field={field} value={typeof value === 'number' ? value : undefined} onChange={onChange} />
  }
  return (
    <SettingsInputRow
      label={field.label}
      description={field.description}
      value={value === undefined ? '' : String(value)}
      onChange={onChange}
    />
  )
}

export function parseExtensionNumberDraft(
  draft: string,
  field: Extract<PiExtensionSettingField, { type: 'number' }>,
): number | null {
  if (draft.trim() === '') return null
  const parsed = Number(draft)
  if (!Number.isFinite(parsed)) return null
  if (field.min !== undefined && parsed < field.min) return null
  if (field.max !== undefined && parsed > field.max) return null
  if (field.step !== undefined && field.step > 0) {
    const steps = (parsed - (field.min ?? 0)) / field.step
    const tolerance = 1e-9 * Math.max(1, Math.abs(steps))
    if (Math.abs(steps - Math.round(steps)) > tolerance) return null
  }
  return parsed
}

function NumberExtensionSettingControl({ field, value, onChange }: {
  field: Extract<PiExtensionSettingField, { type: 'number' }>
  value: number | undefined
  onChange: (value: PiExtensionSettingScalar) => void
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setDraft(value === undefined ? '' : String(value))
    setInvalid(false)
  }, [value])

  const commit = () => {
    const parsed = parseExtensionNumberDraft(draft, field)
    if (parsed === null) {
      setInvalid(draft.trim() !== '')
      if (draft.trim() === '') setDraft(value === undefined ? '' : String(value))
      return
    }
    setInvalid(false)
    setDraft(String(parsed))
    if (parsed !== value) onChange(parsed)
  }

  return (
    <SettingsInputRow
      label={field.label}
      description={field.description}
      type="number"
      min={field.min}
      max={field.max}
      step={field.step}
      value={draft}
      error={invalid ? 'Enter a valid value within the allowed range.' : undefined}
      onChange={(next) => {
        setDraft(next)
        setInvalid(false)
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(value === undefined ? '' : String(value))
          setInvalid(false)
        }
      }}
    />
  )
}

export default ExtensionDetailPanel
