import { describe, expect, it } from 'bun:test'
import type { WebContents } from 'electron'
import { UiValidationBrowserCDP } from '../browser-cdp-driver'

class FixtureDriver extends UiValidationBrowserCDP {
  constructor() {
    super({ getURL: () => 'file:///fixture', getTitle: () => 'Fixture' } as unknown as WebContents)
  }

  protected override async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (method === 'Accessibility.getFullAXTree') {
      if (params?.frameId === 'sandbox-frame') return { nodes: [{
        backendDOMNodeId: 20,
        role: { value: 'button' },
        name: { value: 'Increment sandbox count' },
        properties: [{ name: 'focusable', value: { value: true } }],
      }] }
      return {
        nodes: [
          {
            backendDOMNodeId: 10,
            role: { value: 'button' },
            name: { value: 'Run' },
            properties: [{ name: 'focusable', value: { value: true } }],
          },
          { backendDOMNodeId: 12, role: { value: 'StaticText' }, name: { value: 'Completed' } },
        ],
      }
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' }, childFrames: [{ frame: { id: 'sandbox-frame' } }] } }
    if (method === 'DOM.getDocument') return { root: {} }
    if (method === 'DOMSnapshot.captureSnapshot') {
      return {
        strings: ['DIV', 'BUTTON', 'SPAN', 'id', 'run'],
        documents: [{
          nodes: {
            backendNodeId: [1, 10, 11, 12],
            parentIndex: [-1, 0, 1, 0],
            nodeName: [0, 1, 2, 2],
            attributes: [[], [3, 4], [], []],
          },
          layout: {
            nodeIndex: [0, 1, 2, 3],
            bounds: [[0, 0, 800, 600], [20, 30, 120, 40], [25, 35, 20, 10], [20, 90, 120, 20]],
          },
        }],
      }
    }
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 11 }
    throw new Error(`Unexpected CDP method ${method}`)
  }
}

class OopifFixtureDriver extends UiValidationBrowserCDP {
  readonly inputEvents: Array<Record<string, unknown>>
  readonly cdpCalls: Array<{ method: string; sessionId?: string }> = []

  constructor() {
    const inputEvents: Array<Record<string, unknown>> = []
    super({
      getURL: () => 'file:///fixture',
      getTitle: () => 'Fixture',
      sendInputEvent: (event: Record<string, unknown>) => inputEvents.push(event),
    } as unknown as WebContents)
    this.inputEvents = inputEvents
  }

  protected override async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> {
    this.cdpCalls.push({ method, ...(sessionId ? { sessionId } : {}) })
    if (method === 'Accessibility.getFullAXTree') {
      if (params?.frameId === 'oopif-frame') throw new Error('Frame is owned by another target')
      if (sessionId === 'oopif-session') return { nodes: [{
        backendDOMNodeId: 10,
        role: { value: 'button' },
        name: { value: 'Increment sandbox count' },
      }] }
      return { nodes: [] }
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' } } }
    if (method === 'DOM.getDocument') return { root: { children: [{ nodeName: 'IFRAME', frameId: 'oopif-frame' }] } }
    if (method === 'Target.setDiscoverTargets') return {}
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'oopif-frame', type: 'iframe' }] }
    if (method === 'Target.attachToTarget') return { sessionId: 'oopif-session' }
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 40 }
    if (method === 'DOMSnapshot.captureSnapshot') return { strings: [], documents: [] }
    if (method === 'DOM.getBoxModel' && sessionId === 'oopif-session') {
      return { model: { content: [5, 6, 105, 6, 105, 36, 5, 36] } }
    }
    if (method === 'DOM.getBoxModel' && params?.backendNodeId === 40) {
      return { model: { content: [200, 100, 500, 100, 500, 300, 200, 300] } }
    }
    if (method === 'DOM.getNodeForLocation') return params?.x === 255 && params?.y === 121
      ? { backendNodeId: 10, frameId: 'oopif-frame' }
      : { backendNodeId: 1, frameId: 'root' }
    if (method === 'DOM.focus' && sessionId === 'oopif-session') return {}
    if (method === 'DOM.resolveNode' && sessionId === 'oopif-session') return { object: { objectId: 'child-button' } }
    if (method === 'Runtime.callFunctionOn' && sessionId === 'oopif-session') return { result: { value: null } }
    if (method === 'Input.dispatchMouseEvent' && sessionId === 'oopif-session') return {}
    throw new Error(`Unexpected CDP method ${method}`)
  }
}

class DragFixtureDriver extends UiValidationBrowserCDP {
  readonly cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
  readonly nativeInputEvents: Array<Record<string, unknown>>
  private readonly messageListeners: Set<(...args: any[]) => void>
  private pressed = false
  private intercepted = false
  private failed = false

  constructor(
    private readonly options: {
      interceptHtmlDrag?: boolean
      interceptDelayMs?: number
      dragInterceptTimeoutMs?: number
      failOnce?: (method: string, params?: Record<string, unknown>) => boolean
      blockFirstDrop?: () => Promise<void>
    } = {},
  ) {
    const nativeInputEvents: Array<Record<string, unknown>> = []
    const messageListeners = new Set<(...args: any[]) => void>()
    super({
      getURL: () => 'file:///fixture',
      getTitle: () => 'Fixture',
      sendInputEvent: (event: Record<string, unknown>) => nativeInputEvents.push(event),
      debugger: {
        on: (event: string, listener: (...args: any[]) => void) => {
          if (event === 'message') messageListeners.add(listener)
        },
        removeListener: (event: string, listener: (...args: any[]) => void) => {
          if (event === 'message') messageListeners.delete(listener)
        },
      },
    } as unknown as WebContents, options.dragInterceptTimeoutMs)
    this.nativeInputEvents = nativeInputEvents
    this.messageListeners = messageListeners
  }

  get messageListenerCount(): number { return this.messageListeners.size }

  protected override async send(method: string, params?: Record<string, unknown>): Promise<any> {
    this.cdpCalls.push({ method, ...(params ? { params } : {}) })
    if (!this.failed && this.options.failOnce?.(method, params)) {
      this.failed = true
      throw new Error('injected drag failure')
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params?.expression ?? '')
      if (expression.includes('return probe ? probe.read() : false')) {
        return { result: { value: this.options.interceptHtmlDrag !== false } }
      }
      return { result: { value: true } }
    }
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') this.pressed = true
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
      this.pressed = false
      this.intercepted = false
    }
    if (
      method === 'Input.dispatchMouseEvent'
      && params?.type === 'mouseMoved'
      && this.pressed
      && this.options.interceptHtmlDrag !== false
      && !this.intercepted
    ) {
      this.intercepted = true
      const data = { items: [{ mimeType: 'text/plain', data: '--flexlayout--' }], dragOperationsMask: 16 }
      const emit = () => {
        for (const listener of this.messageListeners) listener({}, 'Input.dragIntercepted', { data })
      }
      if (this.options.interceptDelayMs) setTimeout(emit, this.options.interceptDelayMs)
      else emit()
    }
    if (method === 'Input.dispatchDragEvent' && params?.type === 'drop' && this.options.blockFirstDrop) {
      const block = this.options.blockFirstDrop
      this.options.blockFirstDrop = undefined
      await block()
    }
    return {}
  }
}

describe('UiValidationBrowserCDP accessibility geometry', () => {
  it('merges DOMSnapshot bounds and descendant-aware hit information into AX nodes', async () => {
    const snapshot = await new FixtureDriver().getAccessibilitySnapshot()
    expect(snapshot.nodes[0]).toEqual(expect.objectContaining({
      role: 'button',
      name: 'Run',
      bounds: { x: 20, y: 30, width: 120, height: 40 },
      hit: true,
    }))
    expect(snapshot.nodes[1]).toEqual(expect.objectContaining({ role: 'statictext', name: 'Completed' }))
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ role: 'button', name: 'Increment sandbox count' }))
    expect(snapshot.nodes[0]?.obscuredBy).toBeUndefined()
  })

  it('attaches to an OOPIF target and maps child geometry into the main renderer viewport', async () => {
    const driver = new OopifFixtureDriver()
    const snapshot = await driver.getAccessibilitySnapshot()
    const button = snapshot.nodes.find(node => node.name === 'Increment sandbox count')
    if (!button) throw new Error('OOPIF button was not aggregated')
    const repeated = await driver.getAccessibilitySnapshot()
    expect(repeated.nodes.find(node => node.name === button.name)?.ref).toBe(button.ref)
    const geometry = await driver.getElementGeometry(button.ref)
    expect(geometry.box).toEqual({ x: 205, y: 106, width: 100, height: 30 })
    expect(geometry.clickPoint).toEqual({ x: 255, y: 121 })
    await driver.focusElement(button.ref)
    expect(driver.cdpCalls).toContainEqual({ method: 'DOM.focus', sessionId: 'oopif-session' })
    await driver.clickElement(button.ref)
    expect(driver.cdpCalls.filter(call => call.method === 'Input.dispatchMouseEvent')).toEqual([
      { method: 'Input.dispatchMouseEvent', sessionId: 'oopif-session' },
      { method: 'Input.dispatchMouseEvent', sessionId: 'oopif-session' },
    ])
    expect(driver.inputEvents).toEqual([])
  })
})

describe('UiValidationBrowserCDP drag', () => {
  it('uses intercepted CDP drag events without native webContents input', async () => {
    const driver = new DragFixtureDriver()

    await driver.drag(10, 20, 110, 20)

    expect(driver.nativeInputEvents).toEqual([])
    expect(driver.cdpCalls.filter(call => call.method === 'Input.dispatchDragEvent').map(call => call.params?.type))
      .toEqual(expect.arrayContaining(['dragEnter', 'dragOver', 'drop']))
    expect(driver.cdpCalls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseReleased')).toBe(true)
    expect(driver.cdpCalls.at(-1)).toEqual({ method: 'Input.setInterceptDrags', params: { enabled: false } })
    expect(driver.messageListenerCount).toBe(0)
  })

  it('waits for a delayed dragIntercepted event instead of falling back to pointer drag', async () => {
    const driver = new DragFixtureDriver({ interceptDelayMs: 80 })

    await driver.drag(10, 20, 110, 20)

    expect(driver.cdpCalls.filter(call => call.method === 'Input.dispatchDragEvent').map(call => call.params?.type))
      .toEqual(expect.arrayContaining(['dragEnter', 'dragOver', 'drop']))
    expect(driver.messageListenerCount).toBe(0)
  })

  it('fails and cleans up when dragstart is observed without dragIntercepted', async () => {
    const driver = new DragFixtureDriver({ interceptDelayMs: 100, dragInterceptTimeoutMs: 20 })

    await expect(driver.drag(10, 20, 110, 20)).rejects.toThrow('Input.dragIntercepted was not received within 20ms')

    expect(driver.cdpCalls.some(call => call.method === 'Input.dispatchDragEvent' && call.params?.type === 'dragCancel')).toBe(true)
    expect(driver.cdpCalls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseReleased')).toBe(true)
    expect(driver.cdpCalls.at(-1)).toEqual({ method: 'Input.setInterceptDrags', params: { enabled: false } })
    expect(driver.messageListenerCount).toBe(0)
  })

  it('cancels, releases, disables interception, and removes listeners after failure', async () => {
    const driver = new DragFixtureDriver({
      failOnce: (method, params) => method === 'Input.dispatchDragEvent' && params?.type === 'dragOver',
    })

    await expect(driver.drag(10, 20, 110, 20)).rejects.toThrow('injected drag failure')

    expect(driver.nativeInputEvents).toEqual([])
    expect(driver.cdpCalls.some(call => call.method === 'Input.dispatchDragEvent' && call.params?.type === 'dragCancel')).toBe(true)
    expect(driver.cdpCalls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseReleased')).toBe(true)
    expect(driver.cdpCalls.at(-1)).toEqual({ method: 'Input.setInterceptDrags', params: { enabled: false } })
    expect(driver.messageListenerCount).toBe(0)
  })

  it('keeps pointer-based drag on CDP mouse input and still releases it', async () => {
    const driver = new DragFixtureDriver({ interceptHtmlDrag: false })

    await driver.drag(10, 20, 110, 20)

    expect(driver.nativeInputEvents).toEqual([])
    expect(driver.cdpCalls.some(call => call.method === 'Input.dispatchDragEvent')).toBe(false)
    expect(driver.cdpCalls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseReleased')).toBe(true)
    expect(driver.messageListenerCount).toBe(0)
  })

  it('serializes drags so shared interception is not toggled by a second operation', async () => {
    let markFirstDrop!: () => void
    let releaseFirstDrop!: () => void
    const firstDropReached = new Promise<void>((resolve) => { markFirstDrop = resolve })
    const firstDropGate = new Promise<void>((resolve) => { releaseFirstDrop = resolve })
    const driver = new DragFixtureDriver({
      blockFirstDrop: async () => {
        markFirstDrop()
        await firstDropGate
      },
    })

    const first = driver.drag(10, 20, 110, 20)
    await firstDropReached
    const second = driver.drag(20, 30, 120, 30)
    await Promise.resolve()

    expect(driver.cdpCalls.filter(call => call.method === 'Input.setInterceptDrags' && call.params?.enabled === true)).toHaveLength(1)
    expect(driver.cdpCalls.filter(call => call.method === 'Input.setInterceptDrags' && call.params?.enabled === false)).toHaveLength(0)

    releaseFirstDrop()
    await Promise.all([first, second])
    expect(driver.cdpCalls.filter(call => call.method === 'Input.setInterceptDrags').map(call => call.params?.enabled))
      .toEqual([true, false, true, false])
  })
})
