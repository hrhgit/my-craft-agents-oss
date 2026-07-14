import { describe, expect, it, mock } from 'bun:test'

mock.module('electron', () => ({ clipboard: { writeText() {} } }))
const { WindowsNativeUiDriver } = await import('../windows-native-driver')

describe('WindowsNativeUiDriver', () => {
  it('binds refs to revisions and reports native verification', async () => {
    let name = 'Open'
    const requests: Record<string, unknown>[] = []
    const driver = new WindowsNativeUiDriver(42, async request => {
      requests.push(request)
      if (request.operation === 'action') { name = 'Opened'; return { ok: true } }
      return { windows: [{ runtimeId: '1', role: 'Window', name: 'Craft', enabled: true, focused: true, children: [
        { runtimeId: '1.2', role: 'Button', name, enabled: true, focused: false, patterns: ['Invoke'], children: [] },
      ] }] }
    }, 'win32')
    const snapshot = await driver.snapshot()
    const target = snapshot.windows[0]!.nodes.find(node => node.name === 'Open')!
    expect(target.actions).toContain('click')
    const receipt = await driver.action({ revision: snapshot.revision, ref: target.ref, action: 'click' })
    expect(receipt.verificationLevel).toBe('native-verified')
    expect(receipt.afterRevision).toBeGreaterThan(receipt.beforeRevision)
    expect(requests.some(request => request.operation === 'action' && request.runtimeId === '1.2')).toBeTrue()
  })

  it('rejects stale refs and unsupported platforms', async () => {
    const runner = async () => ({ windows: [{ runtimeId: '1', role: 'Window', name: 'Craft', enabled: true, focused: true, children: [] }] })
    const driver = new WindowsNativeUiDriver(42, runner, 'win32')
    const snapshot = await driver.snapshot()
    await expect(driver.action({ revision: snapshot.revision - 1, ref: 'n0:stale', action: 'focus' })).rejects.toMatchObject({ code: 'STALE_REF' })
    await expect(new WindowsNativeUiDriver(42, runner, 'linux').snapshot()).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('does not invalidate a published ref with a hidden pre-action snapshot', async () => {
    let snapshotReads = 0
    const driver = new WindowsNativeUiDriver(42, async request => {
      if (request.operation === 'action') return { ok: true }
      snapshotReads += 1
      return { windows: [{
        runtimeId: '1', role: 'Window', name: 'Craft', enabled: true,
        focused: snapshotReads > 1, patterns: ['Window'], children: [],
      }] }
    }, 'win32')
    const snapshot = await driver.snapshot()
    const target = snapshot.windows[0]!.nodes[0]!

    const receipt = await driver.action({ revision: snapshot.revision, ref: target.ref, action: 'focus' })

    expect(receipt.beforeRevision).toBe(snapshot.revision)
    expect(snapshotReads).toBe(2)
  })

  it('waits in the native driver until a target appears', async () => {
    let reads = 0
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: [{
      runtimeId: '1', role: 'Window', name: 'Craft', enabled: true, focused: true,
      children: ++reads > 1 ? [{ runtimeId: '2', role: 'Window', name: 'Folder picker', enabled: true, focused: true, patterns: ['Window'] }] : [],
    }] }), 'win32')
    const result = await driver.waitForNode(node => node.name === 'Folder picker', { timeoutMs: 500 })
    expect(result.node.actions).toContain('close')
    expect(reads).toBe(2)
  })
})
