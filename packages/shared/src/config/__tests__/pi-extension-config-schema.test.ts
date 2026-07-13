import { describe, expect, it } from 'bun:test'
import type { PiExtensionCatalogEntry, PiExtensionConfigPatch } from '../pi-extension-settings'
import { validatePiExtensionConfigPatch } from '../pi-global-config'

const entry: PiExtensionCatalogEntry = {
  id: 'example', target: 'craft', loaded: true, title: 'Example', description: '', category: 'other',
  configurable: true, enabled: true, path: 'example.ts', resolvedPath: 'example.ts',
  commands: [], tools: [], flags: [], shortcuts: [],
  ui: { schemaVersion: 1, settings: { schemaVersion: 1, fields: [
    { key: 'enabledFeature', type: 'boolean', label: 'Enabled', default: true },
    { key: 'limit', type: 'number', label: 'Limit', min: 1, max: 10, requiresReload: true },
    { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'fast', label: 'Fast' }] },
  ] } },
}

const patch = (set: PiExtensionConfigPatch['set']): PiExtensionConfigPatch => ({ schemaVersion: 1, extensionId: 'example', set })

describe('extension config schema validation', () => {
  it('accepts declared values and derives reload behavior', () => {
    expect(validatePiExtensionConfigPatch(entry, patch({ enabledFeature: false }))).toEqual({ requiresReload: false })
    expect(validatePiExtensionConfigPatch(entry, patch({ limit: 4 }))).toEqual({ requiresReload: true })
  })

  it('rejects unknown, mistyped, out-of-range, and undeclared option values', () => {
    expect(() => validatePiExtensionConfigPatch(entry, patch({ missing: true }))).toThrow('Unknown')
    expect(() => validatePiExtensionConfigPatch(entry, patch({ enabledFeature: 'yes' }))).toThrow('boolean')
    expect(() => validatePiExtensionConfigPatch(entry, patch({ limit: 20 }))).toThrow('at most')
    expect(() => validatePiExtensionConfigPatch(entry, patch({ mode: 'slow' }))).toThrow('declared option')
  })
})
