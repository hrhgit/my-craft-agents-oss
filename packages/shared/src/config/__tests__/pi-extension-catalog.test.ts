import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPiExtensionCatalog, patchPiExtensionConfig } from '../pi-global-config'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Pi extension settings catalog', () => {
  it('discovers bundled permissions settings through the generic extension catalog', async () => {
    const root = join(tmpdir(), `mortise-bundled-extension-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    roots.push(root)
    const cwd = join(root, 'project')
    const agentDir = join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      extensionConfig: { 'mortise-permissions': { mode: 'ask' } },
    }))
    const bundledExtensions = join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'pi-extensions')

    const result = await getPiExtensionCatalog({ cwd, agentDir, bundledExtensionPaths: [bundledExtensions] })
    const permissions = result.extensions.find((entry) => entry.id === 'mortise-permissions')

    expect(result.errors).toEqual([])
    expect(permissions).toMatchObject({
      title: 'Mortise Permissions',
      configurable: true,
      enabled: true,
      manifestStatus: 'compatible',
      config: { mode: 'ask' },
      ui: {
        settings: {
          fields: [{
            key: 'mode',
            type: 'select',
            default: 'allow-all',
            requiresReload: true,
            options: [{ value: 'ask' }, { value: 'allow-all' }],
          }],
        },
      },
    })
  })

  it('retains disabled Mortise extensions and their manifest UI', async () => {
    const root = join(tmpdir(), `mortise-extension-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    roots.push(root)
    const cwd = join(root, 'project')
    const agentDir = join(root, 'agent')
    const extensionsDir = join(agentDir, 'extensions')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(extensionsDir, { recursive: true })
    writeFileSync(join(extensionsDir, 'disabled.js'), 'export default function () {}')
    writeFileSync(join(extensionsDir, 'package.json'), JSON.stringify({
      pi: {
        extensions: [{
          id: 'disabled-extension',
          path: './disabled.js',
          ui: {
            schemaVersion: 1,
            title: 'Disabled extension',
            category: 'ui',
            settings: {
              schemaVersion: 1,
              fields: [{ key: 'visible', type: 'boolean', label: 'Visible', default: true }],
            },
          },
        }],
      },
    }))
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      extensionConfig: { 'disabled-extension': { enabled: false, visible: false } },
    }))

    const result = await getPiExtensionCatalog({ cwd, agentDir })

    expect(result.errors).toEqual([])
    expect(result.extensions).toHaveLength(1)
    expect(result.extensions[0]).toMatchObject({
      id: 'disabled-extension',
      enabled: false,
      title: 'Disabled extension',
      configurable: true,
      config: { enabled: false, visible: false },
      ui: { settings: { fields: [{ key: 'visible' }] } },
    })

    await patchPiExtensionConfig(result.extensions[0]!, {
      schemaVersion: 1,
      extensionId: 'disabled-extension',
      unset: ['visible'],
    }, { cwd, agentDir })
    const persisted = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(persisted.extensionConfig['disabled-extension']).toEqual({ enabled: false })
  })
})
