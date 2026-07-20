import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type {
  PiExtensionModelReference,
  PiGlobalDefaultSlot,
  PiGlobalProviderForDisplay,
} from '@mortise/shared/config'
import { PI_MODEL_REFERENCE_CURRENT_SESSION } from '@mortise/shared/config/pi-extension-settings'
import { SettingsSelectRow, type SettingsSelectOption } from './SettingsSelect'

export function useModelReferenceOptions(
  providers: PiGlobalProviderForDisplay[],
  defaultSlots: PiGlobalDefaultSlot[],
): SettingsSelectOption[] {
  const { t } = useTranslation()

  return React.useMemo(() => [
    {
      value: PI_MODEL_REFERENCE_CURRENT_SESSION,
      label: t('settings.extensions.modelReference.currentSession'),
      description: t('settings.extensions.modelReference.currentSessionDesc'),
    },
    ...[...defaultSlots]
      .sort((a, b) => a.slot - b.slot)
      .map((slot) => ({
        value: `default:${slot.slot}`,
        label: t('settings.extensions.modelReference.defaultLabel', { slot: slot.slot }),
        description: `${slot.provider}/${slot.model} · ${t(`thinking.${slot.thinkingLevel}`)}`,
      })),
    ...providers.flatMap((entry) => (entry.provider.models ?? []).map((model) => ({
      value: `model:${entry.key}/${model.id}`,
      label: model.name ?? model.id,
      description: t('settings.extensions.modelReference.specificDesc', { model: `${entry.key}/${model.id}` }),
    }))),
  ], [defaultSlots, providers, t])
}

export interface ModelReferenceSelectRowProps {
  label: React.ReactNode
  description?: React.ReactNode
  value?: string
  providers: PiGlobalProviderForDisplay[]
  defaultSlots: PiGlobalDefaultSlot[]
  onValueChange: (value: PiExtensionModelReference) => void
}

export function ModelReferenceSelectRow({
  label,
  description,
  value,
  providers,
  defaultSlots,
  onValueChange,
}: ModelReferenceSelectRowProps) {
  const options = useModelReferenceOptions(providers, defaultSlots)

  return (
    <SettingsSelectRow
      label={label}
      description={description}
      value={value || PI_MODEL_REFERENCE_CURRENT_SESSION}
      options={options}
      onValueChange={(next) => onValueChange(next as PiExtensionModelReference)}
    />
  )
}
