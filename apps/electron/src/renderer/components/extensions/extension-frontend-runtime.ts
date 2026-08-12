import type {
  ExtensionFrontendDescriptorV2,
  ExtensionFrontendModeV2,
  ExtensionUIModuleDescriptorV2,
  ExtensionUIOverrideDescriptorV2,
} from '@mortise/shared/protocol'
import type { PiExtensionCapabilityBindingV1 } from '@mortise/shared/config'
import {
  disposeExtensionUI,
  type ExtensionUIBackend,
  type ExtensionUIChannel,
  type ExtensionUIDependencies,
  type ExtensionUIHost,
  type ExtensionUIMountContext,
  type ExtensionUIDisposer,
  type ExtensionUIRoute,
  type ExtensionUISemantics,
  type ExtensionUITheme,
} from '@mortise/extension-ui'

export interface ExtensionFrontendRuntimeContext {
  route: ExtensionUIRoute
  theme: ExtensionUITheme
  locale: string
  notify: ExtensionUIMountContext['notify']
  backend: ExtensionUIBackend
  dependencies: ExtensionUIDependencies
  host: ExtensionUIHost
}

export interface ExtensionFrontendModule {
  mount?: ExtensionUIMountContext['root'] extends never ? never : (context: ExtensionUIMountContext) => ExtensionUIDisposer | Promise<ExtensionUIDisposer>
  default?: { mount?: (context: ExtensionUIMountContext) => ExtensionUIDisposer | Promise<ExtensionUIDisposer> }
}

function withRevision(url: string, revision: number): string {
  const parsed = new URL(url, window.location.href)
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return parsed.toString()
  parsed.searchParams.set('mortiseRevision', String(revision))
  return parsed.toString()
}

function createSemantics(rootId: string): ExtensionUISemantics {
  const registered = new Map<string, Element>()
  return {
    rootId,
    register(id, element) {
      registered.set(id, element)
      return () => {
        if (registered.get(id) === element) registered.delete(id)
      }
    },
  }
}

function createRootNode(parent: HTMLElement, descriptor: ExtensionFrontendDescriptorV2): HTMLElement {
  const root = document.createElement('div')
  root.dataset.mortiseExtensionFrontend = descriptor.frontendId
  root.dataset.mortiseExtensionId = descriptor.extensionId
  root.dataset.mortiseExtensionMode = descriptor.mode
  root.id = `mortise-extension-${descriptor.extensionId}-${descriptor.frontendId}`
  if (descriptor.mode === 'overlay') {
    root.style.position = 'absolute'
    root.style.inset = '0'
    root.style.zIndex = '1'
  }
  parent.appendChild(root)
  return root
}

function observeRootVisibility(root: HTMLElement): MutationObserver {
  const sync = () => {
    root.hidden = !root.hasChildNodes()
  }
  const Observer = root.ownerDocument.defaultView?.MutationObserver ?? MutationObserver
  const observer = new Observer(sync)
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  sync()
  return observer
}

function mountFunction(module: ExtensionFrontendModule): NonNullable<ExtensionFrontendModule['mount']> {
  const mount = module.mount ?? module.default?.mount
  if (!mount) throw new Error('Extension frontend module must export mount(context) or default.mount(context)')
  return mount as NonNullable<ExtensionFrontendModule['mount']>
}

export function createExtensionUIHost(documentRef: Document = document): ExtensionUIHost {
  const escapeCss = (value: string) => globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  const resolve = (query: string | { semanticId: string; entityId?: string }): Element[] => {
    if (typeof query === 'string') return Array.from(documentRef.querySelectorAll(`[data-mortise-ui-anchor="${escapeCss(query)}"]`))
    const semantic = escapeCss(query.semanticId)
    const entity = query.entityId === undefined ? '' : `[data-mortise-ui-entity="${escapeCss(query.entityId)}"]`
    return Array.from(documentRef.querySelectorAll(`[data-mortise-ui-semantic="${semantic}"]${entity}`))
  }
  return {
    get(anchor) { return resolve(anchor)[0] ?? null },
    query(query) { return resolve(query)[0] ?? null },
    queryAll(query) { return resolve(query) },
    watch(query, listener) {
      const notify = () => listener(resolve(query))
      const observer = new MutationObserver(notify)
      observer.observe(documentRef.documentElement ?? documentRef, { subtree: true, childList: true, attributes: true })
      notify()
      return () => observer.disconnect()
    },
  }
}

type ModuleOverride = ExtensionUIOverrideDescriptorV2
type LoadedModule = Record<string, unknown> | ((previous: unknown) => unknown | Promise<unknown>)
const moduleStyles = new Map<string, { link: HTMLLinkElement; refs: number }>()

function moduleExport(module: LoadedModule): LoadedModule {
  if (typeof module === 'function') return module
  if (typeof module === 'object' && module !== null) {
    const candidate = module as Record<string, unknown>
    return (candidate.default ?? candidate.decorate ?? candidate.replace ?? candidate) as LoadedModule
  }
  return module
}

function ensureModuleStyles(descriptor: ExtensionUIModuleDescriptorV2 | ModuleOverride, acquired: Set<string>): void {
  for (const url of descriptor.styleUrls) {
    const key = `${descriptor.extensionId}\0${url}`
    if (acquired.has(key)) continue
    acquired.add(key)
    const current = moduleStyles.get(key)
    if (current) { current.refs += 1; continue }
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.dataset.mortiseExtensionModuleStyle = key
    link.href = withRevision(url, descriptor.revision)
    document.head.appendChild(link)
    moduleStyles.set(key, { link, refs: 1 })
  }
}

function releaseModuleStyles(acquired: Set<string>): void {
  for (const key of acquired) {
    const current = moduleStyles.get(key)
    if (!current) continue
    current.refs -= 1
    if (current.refs <= 0) {
      current.link.remove()
      moduleStyles.delete(key)
    }
  }
  acquired.clear()
}

export function createExtensionUIDependencies(
  modules: ExtensionUIModuleDescriptorV2[] = [],
  overrides: ModuleOverride[] = [],
  bindings: Array<{ extensionId: string; capabilityBindings?: PiExtensionCapabilityBindingV1[] }> = [],
  consumerExtensionId?: string,
): ExtensionUIDependencies {
  const cache = new Map<string, Promise<unknown>>()
  const acquiredStyles = new Set<string>()
  const loadBase = (extensionId: string, moduleId: string): Promise<unknown> => {
    const key = `${extensionId}\0${moduleId}`
    const existing = cache.get(key)
    if (existing) return existing
    const descriptor = modules.find(item => item.extensionId === extensionId && item.moduleId === moduleId)
    if (!descriptor) return Promise.reject(new Error(`UI module ${extensionId}/${moduleId} is unavailable`))
    const pending = (async () => {
      ensureModuleStyles(descriptor, acquiredStyles)
      const imported = await import(/* @vite-ignore */ withRevision(descriptor.entryUrl, descriptor.revision)) as LoadedModule
      let value: unknown = moduleExport(imported)
      let targetExtensionId = extensionId
      let targetId = moduleId
      const applied = new Set<string>()
      while (true) {
        const override = overrides.find(item => item.target.kind === 'module'
          && item.target.extensionId === targetExtensionId
          && item.target.id === targetId
          && !applied.has(item.overrideId))
        if (!override) break
        applied.add(override.overrideId)
        const overrideModule = moduleExport(await import(/* @vite-ignore */ withRevision(override.entryUrl, override.revision)) as LoadedModule)
        ensureModuleStyles(override, acquiredStyles)
        if (override.mode === 'replace') value = typeof overrideModule === 'function' ? await overrideModule(value) : overrideModule
        else if (typeof overrideModule === 'function') value = await overrideModule(value)
        targetExtensionId = override.extensionId
        targetId = override.overrideId
      }
      return value
    })()
    cache.set(key, pending)
    return pending
  }
  return {
    extension(extensionId) {
      return {
        module(moduleId) {
          return { load: <T = unknown>() => loadBase(extensionId, moduleId) as Promise<T> }
        },
      }
    },
    use(alias) {
      return {
        module(moduleId) {
          return { load: <T = unknown>() => {
            const key = bindings.find(extension => extension.extensionId === consumerExtensionId)?.capabilityBindings?.find(binding => binding.alias === alias && binding.status === 'bound')
            const providerId = key?.providerExtensionId
            if (!providerId) return Promise.reject(new Error(`UI capability alias ${alias} is unavailable`))
            return loadBase(providerId, moduleId) as Promise<T>
          } }
        },
      }
    },
    dispose() { releaseModuleStyles(acquiredStyles); cache.clear() },
  } as ExtensionUIDependencies & { dispose(): void }
}

export class ExtensionFrontendHost {
  private current?: { key: string; abort: AbortController; root: HTMLElement; disposer: ExtensionUIDisposer; styles: HTMLLinkElement[]; visibilityObserver: MutationObserver }
  private mountAbort?: AbortController
  private generation = 0

  async mount(
    descriptor: ExtensionFrontendDescriptorV2,
    parent: HTMLElement,
    runtime: ExtensionFrontendRuntimeContext,
  ): Promise<{ mode: ExtensionFrontendModeV2; root: HTMLElement }> {
    const generation = ++this.generation
    this.mountAbort?.abort()
    const key = `${descriptor.extensionId}\0${descriptor.frontendId}`
    await this.cleanupCurrent()
    if (generation !== this.generation) throw new DOMException('Extension frontend mount was superseded', 'AbortError')

    const root = createRootNode(parent, descriptor)
    const visibilityObserver = observeRootVisibility(root)
    const styles = descriptor.styleUrls.map((url) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.dataset.mortiseExtensionStyle = key
      link.href = withRevision(url, descriptor.revision)
      document.head.appendChild(link)
      return link
    })
    const abort = new AbortController()
    this.mountAbort = abort
    const context: ExtensionUIMountContext = {
      root,
      surface: descriptor.surface as ExtensionUIMountContext['surface'],
      mode: descriptor.mode,
      scope: descriptor.scope,
      route: runtime.route,
      signal: abort.signal,
      theme: runtime.theme,
      locale: runtime.locale,
      notify: runtime.notify,
      semantics: createSemantics(root.id),
      backend: runtime.backend,
      dependencies: runtime.dependencies,
      host: runtime.host,
    }
    try {
      const module = await import(/* @vite-ignore */ withRevision(descriptor.entryUrl, descriptor.revision)) as ExtensionFrontendModule
      const disposer = await mountFunction(module)(context)
      if (abort.signal.aborted || generation !== this.generation) {
        await disposeExtensionUI(disposer)
        throw new DOMException('Extension frontend mount was aborted', 'AbortError')
      }
      this.current = { key, abort, root, disposer, styles, visibilityObserver }
      this.mountAbort = undefined
      return { mode: descriptor.mode, root }
    } catch (error) {
      abort.abort()
      if (this.mountAbort === abort) this.mountAbort = undefined
      visibilityObserver.disconnect()
      for (const link of styles) link.remove()
      root.remove()
      throw error
    }
  }

  async dispose(): Promise<void> {
    this.generation += 1
    this.mountAbort?.abort()
    this.mountAbort = undefined
    await this.cleanupCurrent()
  }

  private async cleanupCurrent(): Promise<void> {
    const current = this.current
    if (!current) return
    this.current = undefined
    current.abort.abort()
    await disposeExtensionUI(current.disposer)
    current.visibilityObserver.disconnect()
    for (const link of current.styles) link.remove()
    current.root.remove()
  }
}
