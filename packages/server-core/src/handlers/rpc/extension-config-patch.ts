import type {
  PiExtensionCatalogEntry,
  PiExtensionConfigPatch,
  PiExtensionConfigPatchResult,
} from '@mortise/shared/config'

type PatchExtensionConfig = (
  entry: PiExtensionCatalogEntry,
  patch: PiExtensionConfigPatch,
) => Promise<Omit<PiExtensionConfigPatchResult, 'takesEffect'>>

export async function applyExtensionConfigPatch(
  entry: PiExtensionCatalogEntry,
  patch: PiExtensionConfigPatch,
  patchExtensionConfig: PatchExtensionConfig,
): Promise<PiExtensionConfigPatchResult> {
  const result = await patchExtensionConfig(entry, patch)
  return {
    ...result,
    takesEffect: result.requiresReload ? 'next-backend-load' : 'immediate',
  }
}
