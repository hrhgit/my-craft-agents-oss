import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsInputRow, SettingsSection, SettingsSelectRow, SettingsTextarea, SettingsToggle, useModelReferenceOptions } from '@/components/settings'
import type { PiExtensionCatalogEntry, PiExtensionSettingField, PiExtensionSettingScalar, PiGlobalDefaultSlot, PiGlobalProviderForDisplay } from '@mortise/shared/config'
import { PI_MODEL_REFERENCE_CURRENT_SESSION } from '@mortise/shared/config/pi-extension-settings'

interface ExtensionDetailPanelProps {
  extension: PiExtensionCatalogEntry
  providers: PiGlobalProviderForDisplay[]
  defaultSlots: PiGlobalDefaultSlot[]
  onPatch: (key: string, value: PiExtensionSettingScalar) => Promise<void>
  onUnset: (key: string) => Promise<void>
  onBack: () => void
}

export function ExtensionDetailPanel({ extension, providers, defaultSlots, onPatch, onUnset, onBack }: ExtensionDetailPanelProps) {
  const modelOptions = useMemo(() => providers.flatMap((entry) => (entry.provider.models ?? []).map((model) => ({
    value: model.id,
    label: model.name ?? model.id,
    description: entry.key,
  }))), [providers])
  const modelReferenceOptions = useModelReferenceOptions(providers, defaultSlots)
  const values = extension.config ?? {}
  const fields = extension.ui?.settings?.fields ?? []
  const effectiveValues = Object.assign(Object.fromEntries(fields.filter((field) => field.default !== undefined).map((field) => [field.key, field.default])), values)
  const sections = buildExtensionSettingSections(extension)

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 size-3.5" />
        Back to extensions
      </Button>
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
    </div>
  )
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
  const schema = extension.ui?.settings
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
