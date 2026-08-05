import type { ExtensionUIChannel, ExtensionUIMountContext } from './index'

export interface ExtensionUILifecycle {
  readonly signal: AbortSignal
  add(cleanup: () => void | Promise<void>): () => void
  listen(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): () => void
  subscribe<TState>(channel: ExtensionUIChannel<TState>, listener: (snapshot: { revision: number; state: TState }) => void): () => void
  observe(target: Node, options: MutationObserverInit, listener: MutationCallback): () => void
  portal(parent?: Node, tagName?: string): HTMLElement
  setAttribute(target: Element, name: string, value: string): () => void
  setStyle(target: HTMLElement, property: string, value: string, priority?: string): () => void
  toggleClass(target: Element, token: string, enabled: boolean): () => void
  timeout(callback: () => void, delayMs: number): () => void
  interval(callback: () => void, delayMs: number): () => void
  dispose(): Promise<void>
}

export function createExtensionLifecycle(context: Pick<ExtensionUIMountContext, 'signal'>): ExtensionUILifecycle {
  const cleanups: Array<() => void | Promise<void>> = []
  let disposed = false
  let disposing: Promise<void> | undefined

  const add = (cleanup: () => void | Promise<void>): (() => void) => {
    if (disposed) {
      void cleanup()
      return () => undefined
    }
    cleanups.push(cleanup)
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = cleanups.indexOf(cleanup)
      if (index >= 0) cleanups.splice(index, 1)
    }
  }

  const lifecycle: ExtensionUILifecycle = {
    signal: context.signal,
    add,
    listen(target, type, listener, options) {
      target.addEventListener(type, listener, options)
      return add(() => target.removeEventListener(type, listener, options))
    },
    subscribe(channel, listener) {
      return add(channel.subscribe(listener))
    },
    observe(target, options, listener) {
      const observer = new MutationObserver(listener)
      observer.observe(target, options)
      return add(() => observer.disconnect())
    },
    portal(parent = document.body, tagName = 'div') {
      const node = document.createElement(tagName)
      parent.appendChild(node)
      add(() => node.remove())
      return node
    },
    setAttribute(target, name, value) {
      const hadValue = target.hasAttribute(name)
      const previous = target.getAttribute(name)
      target.setAttribute(name, value)
      return add(() => {
        if (hadValue) target.setAttribute(name, previous ?? '')
        else target.removeAttribute(name)
      })
    },
    setStyle(target, property, value, priority = '') {
      const previous = target.style.getPropertyValue(property)
      const previousPriority = target.style.getPropertyPriority(property)
      target.style.setProperty(property, value, priority)
      return add(() => {
        if (previous) target.style.setProperty(property, previous, previousPriority)
        else target.style.removeProperty(property)
      })
    },
    toggleClass(target, token, enabled) {
      const previous = target.classList.contains(token)
      target.classList.toggle(token, enabled)
      return add(() => { target.classList.toggle(token, previous) })
    },
    timeout(callback, delayMs) {
      const handle = setTimeout(callback, delayMs)
      return add(() => clearTimeout(handle))
    },
    interval(callback, delayMs) {
      const handle = setInterval(callback, delayMs)
      return add(() => clearInterval(handle))
    },
    async dispose() {
      if (disposing) return disposing
      disposed = true
      disposing = (async () => {
        const errors: unknown[] = []
        while (cleanups.length > 0) {
          const cleanup = cleanups.pop()!
          try { await cleanup() } catch (error) { errors.push(error) }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'Extension UI lifecycle cleanup failed')
      })()
      return disposing
    },
  }

  context.signal.addEventListener('abort', () => {
    void lifecycle.dispose().catch(() => undefined)
  }, { once: true })
  return lifecycle
}
