import { describe, expect, it, mock } from 'bun:test'
import type { PiExtensionCatalogEntry, PiExtensionConfigPatch } from '@mortise/shared/config'
import { applyExtensionConfigPatch } from './extension-config-patch'

const entry = { id: 'example' } as PiExtensionCatalogEntry
const patch = { schemaVersion: 1, extensionId: 'example', set: { enabled: true } } as PiExtensionConfigPatch

describe('extension config patch load boundary', () => {
  it('defers reload-required fields to the next backend load', async () => {
    const patchConfig = mock(async () => ({ config: { enabled: true }, requiresReload: true }))

    await expect(applyExtensionConfigPatch(entry, patch, patchConfig)).resolves.toEqual({
      config: { enabled: true },
      requiresReload: true,
      takesEffect: 'next-backend-load',
    })
  })

  it('does not touch runtimes for a live-applied field', async () => {
    const patchConfig = mock(async () => ({ config: { enabled: true }, requiresReload: false }))

    await expect(applyExtensionConfigPatch(entry, patch, patchConfig)).resolves.toEqual({
      config: { enabled: true },
      requiresReload: false,
      takesEffect: 'immediate',
    })
  })
})
