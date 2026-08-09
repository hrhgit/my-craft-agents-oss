import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPiExtensionCatalog, patchPiExtensionConfig } from '../pi-global-config'
import { isMortiseModelCapabilityBridgeId } from '../pi-extension-settings'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Pi extension settings catalog', () => {
  it('discovers the current bundled extensions through the generic catalog', async () => {
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
    const browser = result.extensions.find((entry) => entry.id === 'mortise-browser')
    const messaging = result.extensions.find((entry) => entry.id === 'mortise-messaging')
    const permissions = result.extensions.find((entry) => entry.id === 'mortise-permissions')
    const webSearch = result.extensions.find((entry) => entry.id === 'mortise-web-search')

    expect(result.errors).toEqual([])
    expect(browser).toMatchObject({
      title: 'Mortise Browser',
      configurable: false,
      enabled: true,
      manifestStatus: 'compatible',
    })
    expect(messaging).toMatchObject({
      title: 'Mortise Messaging',
      configurable: false,
      enabled: true,
      manifestStatus: 'compatible',
    })
    expect(permissions).toMatchObject({
      title: 'Mortise Permissions',
      configurable: false,
      enabled: true,
      manifestStatus: 'compatible',
      config: { mode: 'ask' },
      ui: { schemaVersion: 2, frontends: [
        { id: 'toolbar', surface: 'composer.toolbar', mode: 'append', scope: 'session' },
        { id: 'approval', surface: 'composer.above', mode: 'append', scope: 'session' },
      ] },
      frontendDescriptors: [
        { frontendId: 'toolbar', surface: 'composer.toolbar', mode: 'append', scope: 'session' },
        { frontendId: 'approval', surface: 'composer.above', mode: 'append', scope: 'session' },
      ],
    })
    expect(webSearch).toMatchObject({
      title: '网页搜索',
      configurable: false,
      enabled: true,
      manifestStatus: 'compatible',
    })
    expect(isMortiseModelCapabilityBridgeId(browser!.id)).toBe(true)
    expect(isMortiseModelCapabilityBridgeId(messaging!.id)).toBe(true)
    expect(isMortiseModelCapabilityBridgeId(webSearch!.id)).toBe(true)
    expect(isMortiseModelCapabilityBridgeId('ordinary-extension')).toBe(false)
  })

  it('resolves a bundled extension dependency from the global extension directory', async () => {
    const root = join(tmpdir(), `mortise-cross-source-extension-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    roots.push(root)
    const cwd = join(root, 'project')
    const agentDir = join(root, 'agent')
    const extensionsDir = join(agentDir, 'extensions')
    const bundledDir = join(root, 'bundled')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(extensionsDir, { recursive: true })
    mkdirSync(bundledDir, { recursive: true })

    writeFileSync(join(extensionsDir, 'shared-kit.js'), 'export default function sharedKit() {}')
    writeFileSync(join(extensionsDir, 'package.json'), JSON.stringify({
      pi: {
        extensions: [{
          id: 'shared-kit',
          path: './shared-kit.js',
          manifest: { schemaVersion: 1, name: 'Shared Kit', version: '1.0.0', author: { name: 'Test' }, dependencies: {}, permissions: [] },
        }],
      },
    }))
    writeFileSync(join(bundledDir, 'consumer.js'), 'export default function consumer() {}')
    writeFileSync(join(bundledDir, 'package.json'), JSON.stringify({
      pi: {
        extensions: [{
          id: 'bundled-consumer',
          path: './consumer.js',
          manifest: {
            schemaVersion: 1,
            name: 'Bundled Consumer',
            version: '1.0.0',
            author: { name: 'Test' },
            dependencies: { 'shared-kit': '^1.0.0' },
            permissions: [],
          },
        }],
      },
    }))

    const result = await getPiExtensionCatalog({ cwd, agentDir, bundledExtensionPaths: [bundledDir] })
    expect(result.errors).toEqual([])
    expect(result.extensions.find((entry) => entry.id === 'bundled-consumer')).toMatchObject({
      enabled: true,
      manifestStatus: 'compatible',
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
