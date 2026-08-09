import type {
  PiExtensionCatalogEntry,
  PiExtensionRuntimeState,
} from '@mortise/shared/config'

export function selectConfiguredExtensions(
  extensions: PiExtensionCatalogEntry[],
): PiExtensionCatalogEntry[] {
  return extensions.filter(extension => extension.enabled)
}

export function selectRuntimeExtensions(
  extensions: PiExtensionCatalogEntry[],
  runtimeState: PiExtensionRuntimeState,
): PiExtensionCatalogEntry[] {
  if (!runtimeState.loaded) return selectConfiguredExtensions(extensions)
  const loadedIds = new Set(runtimeState.extensionIds)
  return extensions.filter(extension => loadedIds.has(extension.id))
}

export async function refreshRuntimeExtensions(options: {
  loadCatalog: () => Promise<PiExtensionCatalogEntry[]>
  loadRuntimeState: () => Promise<PiExtensionRuntimeState>
  apply: (extensions: PiExtensionCatalogEntry[]) => void
  applyConfigured?: boolean
}): Promise<PiExtensionRuntimeState> {
  const extensions = await options.loadCatalog()

  // Keep extension frontends usable while the applied runtime snapshot is
  // unavailable or slow. A successful snapshot refines this provisional set.
  if (options.applyConfigured !== false) {
    options.apply(selectConfiguredExtensions(extensions))
  }

  const runtimeState = await options.loadRuntimeState()
  options.apply(selectRuntimeExtensions(extensions, runtimeState))
  return runtimeState
}

export function isExtensionInRuntime(
  extension: PiExtensionCatalogEntry,
  runtimeState: PiExtensionRuntimeState,
): boolean {
  return runtimeState.loaded
    ? runtimeState.extensionIds.includes(extension.id)
    : extension.enabled
}
