import type {
  PiExtensionCatalogEntry,
  PiExtensionConfigPatch,
  PiExtensionConfigPatchResult,
  PiExtensionReloadResult,
} from '@mortise/shared/config'

type PatchExtensionConfig = (
  entry: PiExtensionCatalogEntry,
  patch: PiExtensionConfigPatch,
) => Promise<Omit<PiExtensionConfigPatchResult, 'reload'>>

export async function applyExtensionConfigPatch(
  entry: PiExtensionCatalogEntry,
  patch: PiExtensionConfigPatch,
  patchExtensionConfig: PatchExtensionConfig,
  requestExtensionReload: (interruptRunning: boolean) => Promise<PiExtensionReloadResult>,
): Promise<PiExtensionConfigPatchResult> {
  const result = await patchExtensionConfig(entry, patch)
  if (!result.requiresReload) return result
  const reload = await requestExtensionReload(false)
  return { ...result, reload }
}
