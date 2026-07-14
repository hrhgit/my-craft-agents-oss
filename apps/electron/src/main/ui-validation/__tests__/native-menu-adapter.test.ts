import { describe, expect, it, mock } from 'bun:test'

mock.module('electron', () => ({ clipboard: { writeText() {} } }))
const { ElectronNativeMenuAdapter } = await import('../native-menu-adapter')

describe('ElectronNativeMenuAdapter', () => {
  it('snapshots a bounded typed menu and invokes only leaf commands', async () => {
    let clicked = 0
    const leaf = { id: 'file.open', label: 'Open', type: 'normal', enabled: true, visible: true, click: () => { clicked += 1 } }
    const root = { label: 'File', type: 'submenu', enabled: true, visible: true, submenu: { items: [leaf] } }
    const adapter = new ElectronNativeMenuAdapter({ getApplicationMenu: () => ({ items: [root] } as never) }, () => null)
    const snapshot = adapter.snapshot()
    expect(snapshot.nodes.map(node => [node.role, node.name, node.actions])).toEqual([
      ['menu', 'File', []],
      ['menuitem', 'Open', ['click']],
    ])
    const target = snapshot.nodes[1]!
    const receipt = await adapter.action({ revision: snapshot.revision, ref: target.ref, action: 'click' })
    expect(clicked).toBe(1)
    expect(receipt.verificationLevel).toBe('native-verified')
  })

  it('rejects absent menus and stale refs', async () => {
    const missing = new ElectronNativeMenuAdapter({ getApplicationMenu: () => null }, () => null)
    expect(() => missing.snapshot()).toThrow('unavailable')
    const item = { label: 'About', type: 'normal', enabled: true, visible: true, click() {} }
    const adapter = new ElectronNativeMenuAdapter({ getApplicationMenu: () => ({ items: [item] } as never) }, () => null)
    const snapshot = adapter.snapshot()
    await expect(adapter.action({ revision: snapshot.revision + 1, ref: snapshot.nodes[0]!.ref, action: 'click' }))
      .rejects.toMatchObject({ code: 'STALE_REF' })
  })
})
