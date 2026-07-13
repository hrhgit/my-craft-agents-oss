import { describe, expect, it } from 'bun:test'
import type { PiExtensionCatalogEntry } from '@craft-agent/shared/config/pi-extension-settings'
import { isExtensionConfigurable } from '../PiExtensionsSettingsPanel'
import { buildExtensionSettingSections, parseExtensionNumberDraft } from '../ExtensionDetailPanel'
import { patchCatalogField } from '../extension-settings-utils'

function catalogEntry(configurable: boolean, withSchema: boolean): PiExtensionCatalogEntry {
  return {
    id: 'extension', target: 'craft', loaded: true, title: 'Extension', description: '', category: 'other',
    configurable, enabled: true, path: 'extension.ts', resolvedPath: 'C:\\extensions\\extension.ts',
    commands: [], tools: [], flags: [], shortcuts: [],
    ui: withSchema ? {
      schemaVersion: 1,
      settings: { schemaVersion: 1, fields: [{ key: 'enabledFeature', type: 'boolean', label: 'Enabled', default: true }] },
    } : undefined,
  }
}

describe('Craft extension settings panels', () => {
  it('derives configurability from the extension manifest schema', () => {
    expect(isExtensionConfigurable(catalogEntry(true, true))).toBe(true)
    expect(isExtensionConfigurable(catalogEntry(true, false))).toBe(false)
    expect(isExtensionConfigurable(catalogEntry(false, true))).toBe(false)
  })

  it('keeps ungrouped and unknown-group fields when groups are declared', () => {
    const extension = catalogEntry(true, true)
    extension.ui!.settings = {
      schemaVersion: 1,
      groups: [{ id: 'advanced', title: 'Advanced' }],
      fields: [
        { key: 'grouped', type: 'boolean', label: 'Grouped', default: true, group: 'advanced' },
        { key: 'plain', type: 'string', label: 'Plain' },
        { key: 'orphan', type: 'string', label: 'Orphan', group: 'missing' },
      ],
    }

    const sections = buildExtensionSettingSections(extension)
    expect(sections.map((section) => section.fields.map((field) => field.key))).toEqual([
      ['grouped'],
      ['plain', 'orphan'],
    ])
  })

  it('validates number drafts without coercing blank input to zero', () => {
    const field = { key: 'workers', type: 'number' as const, label: 'Workers', min: 1, max: 8, step: 1 }
    expect(parseExtensionNumberDraft('', field)).toBeNull()
    expect(parseExtensionNumberDraft('not-a-number', field)).toBeNull()
    expect(parseExtensionNumberDraft('0', field)).toBeNull()
    expect(parseExtensionNumberDraft('9', field)).toBeNull()
    expect(parseExtensionNumberDraft('1.5', field)).toBeNull()
    expect(parseExtensionNumberDraft('4', field)).toBe(4)
    expect(parseExtensionNumberDraft('1.3', { ...field, step: 0.1 })).toBe(1.3)
  })

  it('patches or rolls back one config field without overwriting other values', () => {
    const extension = { ...catalogEntry(true, true), config: { alpha: 1, beta: 2 } }
    const patched = patchCatalogField([extension], extension.id, 'alpha', { present: true, value: 3 })
    expect(patched[0]?.config).toEqual({ alpha: 3, beta: 2 })

    const removed = patchCatalogField(patched, extension.id, 'alpha', { present: false })
    expect(removed[0]?.config).toEqual({ beta: 2 })
  })
})
