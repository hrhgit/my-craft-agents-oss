import { describe, expect, it } from 'bun:test'
import type { PiExtensionCatalogEntry } from '@craft-agent/shared/config/pi-extension-settings'
import {
  findExtensionsMissingGuiPanel,
  GUI_CONFIGURABLE_EXTENSIONS,
  isExtensionConfigurable,
} from '../PiExtensionsSettingsPanel'

const EXPECTED_CONFIGURABLE_EXTENSIONS = [
  'plan-mode',
  'prompt-automation',
  'repo-memory',
  'subagent',
  'trace-audit',
  'yourself',
]

function catalogEntry(id: string, configurable: boolean): PiExtensionCatalogEntry {
  return {
    id,
    target: 'craft',
    loaded: true,
    title: id,
    description: '',
    category: 'other',
    configurable,
    enabled: true,
    path: `${id}.ts`,
    resolvedPath: `C:\\extensions\\${id}.ts`,
    commands: [],
    tools: [],
    flags: [],
    shortcuts: [],
  }
}

describe('Craft extension settings panel registry', () => {
  it('has a GUI panel for every currently configurable Craft extension', () => {
    expect([...GUI_CONFIGURABLE_EXTENSIONS].sort()).toEqual([...EXPECTED_CONFIGURABLE_EXTENSIONS].sort())
    expect(findExtensionsMissingGuiPanel(EXPECTED_CONFIGURABLE_EXTENSIONS.map(id => catalogEntry(id, true)))).toEqual([])
    for (const id of EXPECTED_CONFIGURABLE_EXTENSIONS) {
      expect(isExtensionConfigurable(id)).toBe(true)
    }
  })

  it('reports a configurable catalog entry without a registered GUI panel', () => {
    expect(findExtensionsMissingGuiPanel([
      catalogEntry('plan-mode', true),
      catalogEntry('new-configurable-extension', true),
      catalogEntry('plain-extension', false),
    ])).toEqual(['new-configurable-extension'])
  })
})
