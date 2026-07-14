import { describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'

mock.module('electron', () => ({ clipboard: { writeText() {} } }))
const { loadRendererTarget, rendererPageUrl } = await import('../renderer-navigation')

class FakeWebContents extends EventEmitter {
  url = 'file:///app/index.html?workspaceId=w1'
  loading = false
  getURL() { return this.url }
  isLoadingMainFrame() { return this.loading }
  isDestroyed() { return false }
}

describe('loadRendererTarget', () => {
  it('builds a canonical cross-page URL without leaking prior page state', () => {
    const playground = rendererPageUrl('file:///app/index.html?workspaceId=w1&ws=alpha#session', 'playground.html')
    playground.searchParams.set('scenario', 'remote-ui-composer')
    expect(playground.toString()).toBe('file:///app/playground.html?scenario=remote-ui-composer')
    expect(rendererPageUrl(playground.toString(), 'index.html').toString()).toBe('file:///app/index.html')
  })

  it('settles only when the requested target finishes despite an ERR_ABORTED startup navigation', async () => {
    const webContents = new FakeWebContents()
    const target = 'file:///app/playground.html?scenario=remote-ui-composer'
    const window = {
      isDestroyed: () => false,
      webContents,
      loadURL: async (url: string) => {
        webContents.loading = true
        queueMicrotask(() => {
          webContents.emit('did-fail-load', {}, -3, '', 'file:///app/index.html?workspaceId=w1', true)
          webContents.url = url
          webContents.loading = false
          webContents.emit('did-finish-load')
        })
        throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
      },
    }

    await expect(loadRendererTarget(window, target, { timeoutMs: 500 })).resolves.toBeUndefined()
    expect(webContents.url).toBe(target)
  })

  it('waits for the current main-frame navigation before requesting the target', async () => {
    const webContents = new FakeWebContents()
    webContents.loading = true
    const target = 'file:///app/playground.html?scenario=after-start'
    let loads = 0
    const navigation = loadRendererTarget({
      isDestroyed: () => false,
      webContents,
      loadURL: async (url: string) => {
        loads += 1
        webContents.loading = true
        queueMicrotask(() => {
          webContents.url = url
          webContents.loading = false
          webContents.emit('did-finish-load')
        })
      },
    }, target, { timeoutMs: 500 })

    await Promise.resolve()
    expect(loads).toBe(0)
    webContents.loading = false
    webContents.emit('did-stop-loading')
    await navigation
    expect(loads).toBe(1)
  })

  it('rejects a non-abort failure for the requested target', async () => {
    const webContents = new FakeWebContents()
    const target = 'file:///app/playground.html?scenario=missing'
    const window = {
      isDestroyed: () => false,
      webContents,
      loadURL: async (url: string) => {
        queueMicrotask(() => webContents.emit('did-fail-load', {}, -6, 'FILE_NOT_FOUND', url, true))
      },
    }

    await expect(loadRendererTarget(window, target, { timeoutMs: 500 })).rejects.toMatchObject({ code: 'DRIVER_DISCONNECTED' })
  })

  it('rejects ERR_ABORTED when the requested target itself was superseded', async () => {
    const webContents = new FakeWebContents()
    const target = 'file:///app/playground.html?scenario=superseded'
    const window = {
      isDestroyed: () => false,
      webContents,
      loadURL: async (url: string) => {
        queueMicrotask(() => webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', url, true))
        throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
      },
    }

    await expect(loadRendererTarget(window, target, { timeoutMs: 500 })).rejects.toMatchObject({ code: 'DRIVER_DISCONNECTED' })
  })

  it('does not navigate again when the exact target is already settled', async () => {
    const webContents = new FakeWebContents()
    webContents.url = 'file:///app/playground.html?scenario=ready'
    let loads = 0
    await loadRendererTarget({
      isDestroyed: () => false,
      webContents,
      loadURL: async () => { loads += 1 },
    }, webContents.url, { timeoutMs: 500 })
    expect(loads).toBe(0)
  })
})
