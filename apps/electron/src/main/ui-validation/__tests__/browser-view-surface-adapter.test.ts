import { describe, expect, it } from 'bun:test'
import type { BrowserPaneManager } from '../../browser-pane-manager'
import { ElectronBrowserViewSurfaceAdapter } from '../browser-view-surface-adapter'

describe('BrowserView validation surfaces', () => {
  it('returns a bounded namespaced tree and routes revision-bound actions', async () => {
    let value = 'secret-value'
    const calls: unknown[][] = []
    const manager = {
      listEmbeddedValidationSurfaces: () => [{
        surfaceId: 'browser:browser-1', instanceId: 'browser-1', hostWebContentsId: 41, pageWebContentsId: 51,
        workspaceId: 'workspace-1', visible: true,
        bounds: { x: 200, y: 80, width: 800, height: 600 },
        requestedBounds: { x: 200, y: 80, width: 800, height: 600 },
        url: 'https://example.com/?token=raw', title: 'Example',
      }],
      getAccessibilitySnapshot: async () => ({
        url: 'https://example.com/?token=raw', title: 'Example',
        nodes: [{ ref: '@e1', role: 'textbox', name: 'Password', value }],
      }),
      clickElement: async (...args: unknown[]) => { calls.push(['click', ...args]) },
      fillElement: async (...args: unknown[]) => { calls.push(['fill', ...args]); value = String(args[2]) },
      selectOption: async (...args: unknown[]) => { calls.push(['select', ...args]) },
    } as unknown as BrowserPaneManager
    const adapter = new ElectronBrowserViewSurfaceAdapter(manager)

    const [surface] = await adapter.snapshot(41)
    expect(surface).toMatchObject({
      surfaceId: 'browser:browser-1', revision: 1, url: 'https://example.com/',
      nodes: [{ ref: 'b1:browser-1:e1', value: '[REDACTED]', actions: ['click', 'fill'] }],
    })

    const receipt = await adapter.action(41, {
      instanceId: 'browser-1', revision: 1, ref: 'b1:browser-1:e1', action: 'fill', value: 'updated',
    })
    expect(calls).toEqual([['fill', 'browser-1', '@e1', 'updated']])
    expect(receipt).toMatchObject({
      beforeRevision: 1,
      afterRevision: 2,
      targetResolved: { kind: 'browser', instanceId: 'browser-1', ref: 'b1:browser-1:e1' },
    })
  })

  it('rejects refs after the BrowserView semantic revision changes', async () => {
    let name = 'Before'
    const manager = {
      listEmbeddedValidationSurfaces: () => [{
        surfaceId: 'browser:browser-1', instanceId: 'browser-1', hostWebContentsId: 41, pageWebContentsId: 51,
        workspaceId: 'workspace-1', visible: true,
        bounds: { x: 0, y: 0, width: 10, height: 10 }, requestedBounds: { x: 0, y: 0, width: 10, height: 10 },
        url: 'about:blank', title: '',
      }],
      getAccessibilitySnapshot: async () => ({ url: 'about:blank', title: '', nodes: [{ ref: '@e1', role: 'button', name }] }),
    } as unknown as BrowserPaneManager
    const adapter = new ElectronBrowserViewSurfaceAdapter(manager)
    await adapter.snapshot(41)
    name = 'After'

    await expect(adapter.action(41, {
      instanceId: 'browser-1', revision: 1, ref: 'b1:browser-1:e1', action: 'click',
    })).rejects.toMatchObject({ code: 'STALE_REF' })
  })
})
