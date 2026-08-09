import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { JSDOM } from 'jsdom'
import { createExtensionUIDependencies, createExtensionUIHost, ExtensionFrontendHost } from './extension-frontend-runtime'
import type { ExtensionFrontendDescriptorV2 } from '@mortise/shared/protocol'
import type { ExtensionUIDependencies } from '@mortise/extension-ui'

let dom: JSDOM

beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, DOMException: dom.window.DOMException })
})

afterEach(() => {
  dom.window.close()
  delete (globalThis as { window?: unknown }).window
  delete (globalThis as { document?: unknown }).document
})

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).href

const descriptor = (entryUrl = fixture('ok.js'), revision = 0): ExtensionFrontendDescriptorV2 => ({
  schemaVersion: 2,
  extensionId: 'lab',
  frontendId: 'toolbar',
  entryUrl,
  styleUrls: ['data:text/css,.lab%7Bcolor:red%7D'],
  surface: 'composer.toolbar',
  mode: 'append',
  scope: 'session',
  revision,
})

const runtime = {
  route: { sessionId: 'session' },
  theme: { mode: 'light' as const, tokens: {} },
  locale: 'en',
  notify: () => {},
  backend: { channel: () => ({ getSnapshot: () => undefined, subscribe: () => () => {}, send: async () => undefined }) },
  dependencies: { extension: () => ({ module: () => ({ load: async <T = unknown>() => ({} as T) }) }) },
  host: { get: () => null, query: () => null, queryAll: () => [], watch: () => () => {} },
}

describe('ExtensionFrontendHost', () => {
  it('loads a dependency module and applies a decorate override in order', async () => {
    const dependencies = createExtensionUIDependencies([
      {
        schemaVersion: 2,
        extensionId: 'mortise-ui-kit',
        moduleId: 'components',
        entryUrl: fixture('module.js'),
        styleUrls: [],
        apiVersion: '1.0.0',
        revision: 1,
      },
    ], [
      {
        schemaVersion: 2,
        extensionId: 'mortise-ui-kit-compact',
        overrideId: 'compact-components',
        target: { extensionId: 'mortise-ui-kit', kind: 'module', id: 'components' },
        mode: 'decorate',
        entryUrl: fixture('decorate-module.js'),
        styleUrls: [],
        revision: 1,
      },
    ])
    const kit = await dependencies.extension('mortise-ui-kit').module<{ Button: (label: string) => string; spacing: number }>('components').load()
    expect(kit.Button('send')).toBe('compact:button:send')
    expect(kit.spacing).toBe(4)
  })

  it('releases dependency module styles when the frontend zone is disposed', async () => {
    const dependencies = createExtensionUIDependencies([
      {
        schemaVersion: 2,
        extensionId: 'mortise-ui-kit',
        moduleId: 'components',
        entryUrl: fixture('module.js'),
        styleUrls: ['data:text/css,.kit%7Bcolor:red%7D'],
        apiVersion: '1.0.0',
        revision: 1,
      },
    ]) as ExtensionUIDependencies & { dispose?: () => void }
    await dependencies.extension('mortise-ui-kit').module('components').load()
    expect(document.head.querySelectorAll('link[data-mortise-extension-module-style]')).toHaveLength(1)
    dependencies.dispose?.()
    expect(document.head.querySelectorAll('link[data-mortise-extension-module-style]')).toHaveLength(0)
  })

  it('resolves stable host anchors and semantic entities', () => {
    document.body.innerHTML = `
      <main data-mortise-ui-anchor="conversation.root">
        <section data-mortise-ui-anchor="conversation.timeline">
          <article data-mortise-ui-semantic="conversation.message" data-mortise-ui-entity="m-1"></article>
        </section>
      </main>
    `
    const host = createExtensionUIHost(document)
    expect(host.get('conversation.root')?.tagName).toBe('MAIN')
    expect(host.query({ semanticId: 'conversation.message', entityId: 'm-1' })?.tagName).toBe('ARTICLE')
    expect(host.queryAll({ semanticId: 'conversation.message' })).toHaveLength(1)
  })

  it('mounts a module, injects styles, and disposes async DOM cleanup', async () => {
    const entry = fixture('ok.js')
    const parent = document.createElement('section')
    document.body.append(parent)
    const host = new ExtensionFrontendHost()
    await host.mount(descriptor(entry), parent, runtime)
    expect(parent.querySelector('[data-mortise-extension-frontend="toolbar"] span')?.textContent).toBe('mounted')
    expect(document.head.querySelectorAll('link[data-mortise-extension-style]').length).toBe(1)
    await host.dispose()
    expect(parent.querySelector('[data-mortise-extension-frontend="toolbar"]')).toBeNull()
    expect(document.head.querySelectorAll('link[data-mortise-extension-style]').length).toBe(0)
  })

  it('hides empty frontend roots and restores them when content appears', async () => {
    const parent = document.createElement('section')
    document.body.append(parent)
    const host = new ExtensionFrontendHost()
    await host.mount(descriptor(fixture('empty.js')), parent, runtime)
    const root = parent.querySelector<HTMLElement>('[data-mortise-extension-frontend="toolbar"]')!

    expect(root.hidden).toBe(true)
    root.append(document.createElement('span'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(root.hidden).toBe(false)
    root.replaceChildren()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(root.hidden).toBe(true)

    await host.dispose()
  })

  it('drops a failed mount and does not leave a root or style behind', async () => {
    const entry = fixture('fail.js')
    const parent = document.createElement('section')
    document.body.append(parent)
    await expect(new ExtensionFrontendHost().mount(descriptor(entry), parent, runtime)).rejects.toThrow('boom')
    expect(parent.children).toHaveLength(0)
    expect(document.head.querySelectorAll('link[data-mortise-extension-style]')).toHaveLength(0)
  })

  it('replaces a previous revision and disposes the old module before mounting', async () => {
    const first = fixture('ok.js')
    const second = fixture('ok.js')
    const parent = document.createElement('section')
    document.body.append(parent)
    const host = new ExtensionFrontendHost()
    await host.mount(descriptor(first, 1), parent, runtime)
    await host.mount(descriptor(second, 2), parent, runtime)
    expect(parent.textContent).toBe('mounted')
    await host.dispose()
    expect(parent.children).toHaveLength(0)
  })

  it('aborts an in-flight mount when a newer revision supersedes it', async () => {
    const parent = document.createElement('section')
    document.body.append(parent)
    const host = new ExtensionFrontendHost()
    const slow = host.mount(descriptor(fixture('slow.js'), 1), parent, runtime)
    const latest = host.mount(descriptor(fixture('ok.js'), 2), parent, runtime)
    await expect(slow).rejects.toMatchObject({ name: 'AbortError' })
    await latest
    expect(parent.textContent).toBe('mounted')
    expect(parent.querySelectorAll('[data-mortise-extension-frontend="toolbar"]')).toHaveLength(1)
  })
})
