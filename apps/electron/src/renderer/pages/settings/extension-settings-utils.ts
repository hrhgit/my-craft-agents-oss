import type { PiExtensionCatalogEntry, PiExtensionSettingScalar } from '@craft-agent/shared/config'

export function patchCatalogField(
  entries: PiExtensionCatalogEntry[],
  extensionId: string,
  key: string,
  field: { present: boolean; value?: PiExtensionSettingScalar },
): PiExtensionCatalogEntry[] {
  return entries.map((entry) => {
    if (entry.id !== extensionId) return entry
    const config = { ...(entry.config ?? {}) }
    if (field.present) config[key] = field.value
    else delete config[key]
    return { ...entry, config }
  })
}
