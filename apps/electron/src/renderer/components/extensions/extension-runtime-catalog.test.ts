import { describe, expect, it } from 'bun:test'
import type { PiExtensionCatalogEntry } from '@mortise/shared/config'
import {
  refreshRuntimeExtensions,
  selectConfiguredExtensions,
  selectRuntimeExtensions,
} from './extension-runtime-catalog'

function extension(id: string, enabled: boolean): PiExtensionCatalogEntry {
  return {
    id,
    enabled,
    loaded: false,
    title: id,
    description: '',
    category: 'other',
    configurable: false,
    manifestStatus: 'compatible',
    manifestDiagnostics: [],
    loadable: true,
    path: `${id}.ts`,
    resolvedPath: `C:/${id}.ts`,
    commands: [],
    tools: [],
  }
}

describe('extension runtime catalog', () => {
  it('uses enabled extensions as the provisional frontend set', () => {
    const catalog = [extension('disabled', false), extension('enabled', true)]

    expect(selectConfiguredExtensions(catalog).map(entry => entry.id)).toEqual(['enabled'])
  })

  it('keeps a running extension mounted after its desired state is disabled', () => {
    const catalog = [extension('running', false), extension('next-load', true)]

    expect(selectRuntimeExtensions(catalog, {
      loaded: true,
      extensionIds: ['running'],
    }).map(entry => entry.id)).toEqual(['running'])
  })

  it('does not change the applied set when a toggle returns to its runtime state before reload', () => {
    const runtimeState = { loaded: true, extensionIds: ['running'] }

    expect(selectRuntimeExtensions([extension('running', false)], runtimeState).map(entry => entry.id)).toEqual(['running'])
    expect(selectRuntimeExtensions([extension('running', true)], runtimeState).map(entry => entry.id)).toEqual(['running'])
  })

  it('uses the desired state when no Workspace runtime has loaded yet', () => {
    const catalog = [extension('disabled', false), extension('enabled', true)]

    expect(selectRuntimeExtensions(catalog, {
      loaded: false,
      extensionIds: [],
    }).map(entry => entry.id)).toEqual(['enabled'])
  })

  it('applies the configured frontend set before the runtime snapshot resolves', async () => {
    const applied: string[][] = []
    let resolveRuntimeState!: (state: { loaded: boolean; extensionIds: string[] }) => void
    const runtimeState = new Promise<{ loaded: boolean; extensionIds: string[] }>((resolve) => {
      resolveRuntimeState = resolve
    })

    const refresh = refreshRuntimeExtensions({
      loadCatalog: async () => [extension('ask-user', true), extension('disabled', false)],
      loadRuntimeState: () => runtimeState,
      apply: extensions => applied.push(extensions.map(entry => entry.id)),
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(applied).toEqual([['ask-user']])

    resolveRuntimeState({ loaded: true, extensionIds: ['ask-user'] })
    await refresh
    expect(applied).toEqual([['ask-user'], ['ask-user']])
  })

  it('keeps the configured frontend set when the runtime snapshot fails', async () => {
    const applied: string[][] = []

    await expect(refreshRuntimeExtensions({
      loadCatalog: async () => [extension('ask-user', true)],
      loadRuntimeState: async () => { throw new Error('runtime unavailable') },
      apply: extensions => applied.push(extensions.map(entry => entry.id)),
    })).rejects.toThrow('runtime unavailable')

    expect(applied).toEqual([['ask-user']])
  })

  it('keeps the last runtime set mounted while refreshing an already loaded runtime', async () => {
    const applied: string[][] = []
    let resolveRuntimeState!: (state: { loaded: boolean; extensionIds: string[] }) => void
    const runtimeState = new Promise<{ loaded: boolean; extensionIds: string[] }>((resolve) => {
      resolveRuntimeState = resolve
    })

    const refresh = refreshRuntimeExtensions({
      loadCatalog: async () => [extension('running', false), extension('next-load', true)],
      loadRuntimeState: () => runtimeState,
      apply: extensions => applied.push(extensions.map(entry => entry.id)),
      applyConfigured: false,
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(applied).toEqual([])

    resolveRuntimeState({ loaded: true, extensionIds: ['running'] })
    await refresh
    expect(applied).toEqual([['running']])
  })
})
