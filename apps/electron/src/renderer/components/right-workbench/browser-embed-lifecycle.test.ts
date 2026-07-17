import { describe, expect, it, mock } from 'bun:test'
import type { BrowserEmbedBounds } from '../../../shared/types'
import {
  createBrowserEmbedLifecycle,
  getVisibleBrowserEmbedBounds,
} from './browser-embed-lifecycle'

const bounds: BrowserEmbedBounds = { x: 20, y: 40, width: 600, height: 420 }

async function flushLifecycle(): Promise<void> {
  await Bun.sleep(0)
  await Bun.sleep(0)
}

describe('browser embed lifecycle', () => {
  it('treats disconnected, hidden ancestors, hidden targets, and zero-sized targets as hidden', () => {
    const element = {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 20, top: 40, width: 600, height: 420 }),
    } as HTMLElement

    expect(getVisibleBrowserEmbedBounds(element, () => ({ display: 'block', visibility: 'visible' }))).toEqual(bounds)
    expect(getVisibleBrowserEmbedBounds(element, () => ({ display: 'none', visibility: 'visible' }))).toBeNull()
    expect(getVisibleBrowserEmbedBounds(element, () => ({ display: 'block', visibility: 'hidden' }))).toBeNull()

    const hiddenTabPanel = { parentElement: null } as HTMLElement
    const childOfHiddenTab = { ...element, parentElement: hiddenTabPanel } as HTMLElement
    expect(getVisibleBrowserEmbedBounds(childOfHiddenTab, current => (
      current === hiddenTabPanel
        ? { display: 'none', visibility: 'visible' }
        : { display: 'block', visibility: 'visible' }
    ))).toBeNull()

    const invisibleAncestor = { parentElement: null } as HTMLElement
    const childOfInvisibleAncestor = { ...element, parentElement: invisibleAncestor } as HTMLElement
    expect(getVisibleBrowserEmbedBounds(childOfInvisibleAncestor, current => (
      current === invisibleAncestor
        ? { display: 'block', visibility: 'collapse' }
        : { display: 'block', visibility: 'visible' }
    ))).toBeNull()

    const zeroSized = {
      isConnected: true,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 20, top: 40, width: 0, height: 420 }),
    } as HTMLElement
    expect(getVisibleBrowserEmbedBounds(zeroSized, () => ({ display: 'block', visibility: 'visible' }))).toBeNull()

    const disconnected = { ...element, isConnected: false } as HTMLElement
    expect(getVisibleBrowserEmbedBounds(disconnected, () => ({ display: 'block', visibility: 'visible' }))).toBeNull()
  })

  it('detaches while hidden and re-embeds at the same bounds when visible again', async () => {
    const api = {
      embed: mock(async () => {}),
      updateEmbedBounds: mock(async () => {}),
      detach: mock(async () => {}),
    }
    const lifecycle = createBrowserEmbedLifecycle('browser-1', api, () => {})

    lifecycle.update(bounds)
    await flushLifecycle()
    lifecycle.update(null)
    await flushLifecycle()
    lifecycle.update(bounds)
    await flushLifecycle()

    expect(api.embed).toHaveBeenCalledTimes(2)
    expect(api.embed).toHaveBeenNthCalledWith(1, 'browser-1', bounds)
    expect(api.embed).toHaveBeenNthCalledWith(2, 'browser-1', bounds)
    expect(api.detach).toHaveBeenCalledTimes(1)
    expect(api.updateEmbedBounds).not.toHaveBeenCalled()
  })

  it('serializes a hide that arrives while embed is still pending', async () => {
    let finishEmbed: (() => void) | undefined
    const api = {
      embed: mock(() => new Promise<void>((resolve) => { finishEmbed = resolve })),
      updateEmbedBounds: mock(async () => {}),
      detach: mock(async () => {}),
    }
    const lifecycle = createBrowserEmbedLifecycle('browser-2', api, () => {})

    lifecycle.update(bounds)
    lifecycle.update(null)
    finishEmbed?.()
    await flushLifecycle()

    expect(api.embed).toHaveBeenCalledTimes(1)
    expect(api.detach).toHaveBeenCalledTimes(1)
  })

  it('serializes disposal while embed is still pending', async () => {
    let finishEmbed: (() => void) | undefined
    const api = {
      embed: mock(() => new Promise<void>((resolve) => { finishEmbed = resolve })),
      updateEmbedBounds: mock(async () => {}),
      detach: mock(async () => {}),
    }
    const lifecycle = createBrowserEmbedLifecycle('browser-pending-dispose', api, () => {})

    lifecycle.update(bounds)
    lifecycle.dispose()
    finishEmbed?.()
    await flushLifecycle()

    expect(api.embed).toHaveBeenCalledTimes(1)
    expect(api.detach).toHaveBeenCalledWith('browser-pending-dispose')
  })

  it('converges to detached when a pending embed rejects during disposal', async () => {
    let rejectEmbed: ((error: Error) => void) | undefined
    const api = {
      embed: mock(() => new Promise<void>((_resolve, reject) => { rejectEmbed = reject })),
      updateEmbedBounds: mock(async () => {}),
      detach: mock(async () => {}),
    }
    const lifecycle = createBrowserEmbedLifecycle('browser-rejected-dispose', api, () => {})

    lifecycle.update(bounds)
    lifecycle.dispose()
    rejectEmbed?.(new Error('host replaced'))
    await flushLifecycle()

    expect(api.detach).toHaveBeenCalledWith('browser-rejected-dispose')
  })

  it('converges to newer bounds after an in-flight resize rejects', async () => {
    const resized = { ...bounds, width: bounds.width + 10 }
    const latest = { ...bounds, width: bounds.width + 20 }
    let rejectResize: ((error: Error) => void) | undefined
    const api = {
      embed: mock(async () => {}),
      updateEmbedBounds: mock((_id: string, next: BrowserEmbedBounds) => (
        next.width === resized.width
          ? new Promise<void>((_resolve, reject) => { rejectResize = reject })
          : Promise.resolve()
      )),
      detach: mock(async () => {}),
    }
    const lifecycle = createBrowserEmbedLifecycle('browser-latest-bounds', api, () => {})

    lifecycle.update(bounds)
    await flushLifecycle()
    lifecycle.update(resized)
    lifecycle.update(latest)
    rejectResize?.(new Error('host changed'))
    await flushLifecycle()

    expect(api.updateEmbedBounds).toHaveBeenCalledTimes(2)
    expect(api.updateEmbedBounds).toHaveBeenNthCalledWith(1, 'browser-latest-bounds', resized)
    expect(api.updateEmbedBounds).toHaveBeenNthCalledWith(2, 'browser-latest-bounds', latest)
  })

  it('still detaches on disposal when an in-flight resize rejects', async () => {
    const resized = { ...bounds, width: bounds.width + 10 }
    let rejectResize: ((error: Error) => void) | undefined
    const api = {
      embed: mock(async () => {}),
      updateEmbedBounds: mock(() => new Promise<void>((_resolve, reject) => { rejectResize = reject })),
      detach: mock(async () => {}),
    }
    const lifecycle = createBrowserEmbedLifecycle('browser-resize-dispose', api, () => {})

    lifecycle.update(bounds)
    await flushLifecycle()
    lifecycle.update(resized)
    lifecycle.dispose()
    rejectResize?.(new Error('resize rejected'))
    await flushLifecycle()

    expect(api.detach).toHaveBeenCalledWith('browser-resize-dispose')
  })

  it('retries transient embed, resize, and detach failures with bounded backoff', async () => {
    let embedAttempts = 0
    let resizeAttempts = 0
    let detachAttempts = 0
    const resized = { ...bounds, width: bounds.width + 10 }
    const api = {
      embed: mock(async () => {
        embedAttempts += 1
        if (embedAttempts === 1) throw new Error('embed unavailable')
      }),
      updateEmbedBounds: mock(async () => {
        resizeAttempts += 1
        if (resizeAttempts === 1) throw new Error('resize unavailable')
      }),
      detach: mock(async () => {
        detachAttempts += 1
        if (detachAttempts === 1) throw new Error('detach unavailable')
      }),
    }
    const lifecycle = createBrowserEmbedLifecycle('browser-transient-retry', api, () => {})

    lifecycle.update(bounds)
    await Bun.sleep(80)
    lifecycle.update(resized)
    await Bun.sleep(80)
    lifecycle.update(null)
    await Bun.sleep(80)

    expect(api.embed).toHaveBeenCalledTimes(2)
    expect(api.updateEmbedBounds).toHaveBeenCalledTimes(2)
    expect(api.detach).toHaveBeenCalledTimes(2)
  })

  it('disposes by detaching an embedded view', async () => {
    const api = {
      embed: mock(async () => {}),
      updateEmbedBounds: mock(async () => {}),
      detach: mock(async () => {}),
    }
    const lifecycle = createBrowserEmbedLifecycle('browser-3', api, () => {})

    lifecycle.update(bounds)
    await flushLifecycle()
    lifecycle.dispose()
    await flushLifecycle()

    expect(api.detach).toHaveBeenCalledWith('browser-3')
  })

  it('does not retry a rejected phantom embed on every measurement frame', async () => {
    const api = {
      embed: mock(async () => { throw new Error('workspace mismatch') }),
      updateEmbedBounds: mock(async () => {}),
      detach: mock(async () => {}),
    }
    const errors = mock(() => {})
    const lifecycle = createBrowserEmbedLifecycle('phantom-browser', api, errors)

    lifecycle.update(bounds)
    await Bun.sleep(100)
    for (let i = 0; i < 20; i += 1) lifecycle.update(bounds)
    await Bun.sleep(100)

    expect(api.embed).toHaveBeenCalledTimes(3)
    expect(errors).toHaveBeenCalledTimes(3)

    lifecycle.update({ ...bounds, width: bounds.width + 1 })
    await Bun.sleep(100)
    expect(api.embed).toHaveBeenCalledTimes(6)
  })
})
