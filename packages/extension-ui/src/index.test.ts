import { describe, expect, it } from 'bun:test'
import { defineExtensionUI, disposeExtensionUI, createExtensionLifecycle } from './index'
import { JSDOM } from 'jsdom'

describe('@mortise/extension-ui', () => {
  it('requires a mount function and supports async disposal', async () => {
    expect(() => defineExtensionUI({ mount: null as never })).toThrow()
    let disposed = false
    const definition = defineExtensionUI({ mount: () => ({ dispose: async () => { disposed = true } }) })
    await disposeExtensionUI(await definition.mount({} as never))
    expect(disposed).toBe(true)
  })

  it('cleans registered DOM resources in reverse order and restores mutations', async () => {
    const dom = new JSDOM('<!doctype html><body><button id="target">go</button></body>')
    const previous = {
      document: globalThis.document,
      MutationObserver: globalThis.MutationObserver,
      window: globalThis.window,
    }
    Object.assign(globalThis, {
      document: dom.window.document,
      MutationObserver: dom.window.MutationObserver,
      window: dom.window,
    })
    try {
      const target = dom.window.document.querySelector('#target') as HTMLButtonElement
      const controller = new AbortController()
      const lifecycle = createExtensionLifecycle({ signal: controller.signal })
      const order: string[] = []
      lifecycle.add(() => { order.push('first') })
      lifecycle.add(() => { order.push('second') })
      lifecycle.setAttribute(target, 'data-mode', 'compact')
      lifecycle.setStyle(target, '--gap', '4px')
      lifecycle.toggleClass(target, 'is-active', true)
      const portal = lifecycle.portal(dom.window.document.body, 'aside')
      lifecycle.listen(target, 'click', () => { order.push('event') })
      target.click()
      expect(order).toContain('event')
      expect(portal.isConnected).toBe(true)
      expect(target.getAttribute('data-mode')).toBe('compact')
      expect(target.style.getPropertyValue('--gap')).toBe('4px')
      expect(target.classList.contains('is-active')).toBe(true)

      await lifecycle.dispose()
      await lifecycle.dispose()
      target.click()
      expect(order).toEqual(['event', 'second', 'first'])
      expect(portal.isConnected).toBe(false)
      expect(target.hasAttribute('data-mode')).toBe(false)
      expect(target.style.getPropertyValue('--gap')).toBe('')
      expect(target.classList.contains('is-active')).toBe(false)
    } finally {
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })

  it('disposes automatically when the mount signal aborts', async () => {
    const dom = new JSDOM('<!doctype html><body></body>')
    const previous = { document: globalThis.document, window: globalThis.window }
    Object.assign(globalThis, { document: dom.window.document, window: dom.window })
    try {
      const controller = new AbortController()
      const lifecycle = createExtensionLifecycle({ signal: controller.signal })
      let disposed = false
      lifecycle.add(() => { disposed = true })
      controller.abort()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(disposed).toBe(true)
    } finally {
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
