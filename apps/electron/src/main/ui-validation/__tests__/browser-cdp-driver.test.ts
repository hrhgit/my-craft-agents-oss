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
    if (method === 'DOM.resolveNode' && sessionId === 'oopif-session') return { object: { objectId: 'child-button' } }
    if (method === 'Runtime.callFunctionOn' && sessionId === 'oopif-session') return { result: { value: null } }
    if (method === 'Input.dispatchMouseEvent' && sessionId === 'oopif-session') return {}
    throw new Error(`Unexpected CDP method ${method}`)
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
    await driver.clickElement(button.ref)
    expect(driver.cdpCalls.filter(call => call.method === 'Input.dispatchMouseEvent')).toEqual([
      { method: 'Input.dispatchMouseEvent', sessionId: 'oopif-session' },
      { method: 'Input.dispatchMouseEvent', sessionId: 'oopif-session' },
    ])
    expect(driver.inputEvents).toEqual([])
  })
})
