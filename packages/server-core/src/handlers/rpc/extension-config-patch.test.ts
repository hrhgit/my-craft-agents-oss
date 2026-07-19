import { describe, expect, it, mock } from 'bun:test'
import type { PiExtensionCatalogEntry, PiExtensionConfigPatch } from '@mortise/shared/config'
import { applyExtensionConfigPatch } from './extension-config-patch'

const entry = { id: 'example' } as PiExtensionCatalogEntry
const patch = { schemaVersion: 1, extensionId: 'example', set: { enabled: true } } as PiExtensionConfigPatch

describe('extension config patch reload boundary', () => {
  it('requests confirmation instead of directly reloading a running session', async () => {
    const patchConfig = mock(async () => ({ config: { enabled: true }, requiresReload: true }))
    const requestReload = mock(async () => ({
      status: 'confirmation_required' as const,
      activeSessions: [{ sessionId: 'active', workspaceName: 'Workspace' }],
    }))

    await expect(applyExtensionConfigPatch(entry, patch, patchConfig, requestReload)).resolves.toMatchObject({
      requiresReload: true,
      reload: { status: 'confirmation_required', activeSessions: [{ sessionId: 'active' }] },
    })
    expect(requestReload).toHaveBeenCalledWith(false)
  })

  it('does not touch runtimes for a live-applied field', async () => {
    const patchConfig = mock(async () => ({ config: { enabled: true }, requiresReload: false }))
    const requestReload = mock(async () => ({
      status: 'reloaded' as const,
      interruptedSessionCount: 0,
      reloadedSessionCount: 0,
      deferredSessionCount: 0,
    }))

    await expect(applyExtensionConfigPatch(entry, patch, patchConfig, requestReload)).resolves.toEqual({
      config: { enabled: true },
      requiresReload: false,
    })
    expect(requestReload).not.toHaveBeenCalled()
  })
})
