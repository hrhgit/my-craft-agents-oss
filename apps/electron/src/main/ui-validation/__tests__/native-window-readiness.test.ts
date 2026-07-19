import { describe, expect, it, mock } from 'bun:test'

mock.module('electron', () => ({ clipboard: { writeText() {} } }))
const { WindowsNativeUiDriver } = await import('../windows-native-driver')
const { ElectronNativeWindowController, ensureNativeWindowReady } = await import('../native-window-readiness')

describe('ensureNativeWindowReady', () => {
  it('restores and shows a hidden window before waiting for its matching UIA root', async () => {
    const calls: string[] = []
    let visible = false
    let minimized = true
    const window = {
      isDestroyed: () => false,
      isMinimized: () => minimized,
      restore: () => { calls.push('restore'); minimized = false },
      isVisible: () => visible,
      show: () => { calls.push('show'); visible = true },
      focus: () => calls.push('focus'),
      getTitle: () => 'Mortise',
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    }
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: [{
      runtimeId: '1', role: 'Window', name: 'Mortise', enabled: true, focused: true,
      bounds: { x: 125, y: 62.5, width: 1_000, height: 750 }, patterns: ['Window'], children: [],
    }] }), 'win32')

    const ready = await ensureNativeWindowReady(window as never, driver, { timeoutMs: 500 })

    expect(calls).toEqual(['restore', 'show', 'focus'])
    expect(ready.node.name).toBe('Mortise')
    expect(ready.node.actions).toContain('focus')
  })

  it('does not accept another process window with a different title', async () => {
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      focus() {},
      getTitle: () => 'Mortise',
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    }
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: [{
      runtimeId: '1', role: 'Window', name: 'Other', enabled: true, focused: true, children: [],
    }] }), 'win32')

    await expect(ensureNativeWindowReady(window as never, driver, { timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('matches the selected native root by DPI-scaled bounds when titles are duplicated', async () => {
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      focus() {},
      getTitle: () => 'Mortise',
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    }
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: [
      { runtimeId: 'wrong', role: 'Window', name: 'Mortise', enabled: true, focused: false, bounds: { x: 1_200, y: 60, width: 960, height: 720 }, children: [] },
      { runtimeId: 'right', role: 'Window', name: 'Mortise', enabled: true, focused: true, bounds: { x: 120, y: 60, width: 960, height: 720 }, children: [] },
    ] }), 'win32')

    const ready = await ensureNativeWindowReady(window as never, driver, { timeoutMs: 500 })

    expect(ready.node.runtimeId).toBe('right')
  })

  it('keeps availability separate from verified window readiness', async () => {
    const calls: string[] = []
    const phases: string[] = []
    let visible = false
    let focused = false
    const window = {
      webContents: { id: 7, isLoading: () => false },
      isDestroyed: () => false,
      isMinimized: () => false,
      restore() {},
      isVisible: () => visible,
      isFocused: () => focused,
      show: () => { calls.push('show'); visible = true },
      showInactive: () => { calls.push('showInactive'); visible = true },
      focus: () => { calls.push('focus'); focused = true },
      getTitle: () => 'Mortise',
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    }
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: visible ? [{
      runtimeId: 'root', role: 'Window', name: 'Mortise', enabled: true, focused,
      bounds: { x: 120, y: 60, width: 960, height: 720 }, patterns: ['Window'], children: [],
    }] : [] }), 'win32')
    const controller = new ElectronNativeWindowController(driver, (_webContentsId, phase) => phases.push(phase))

    expect(controller.status(window as never)).toMatchObject({ available: true, ready: false, reason: 'window-hidden' })
    controller.reveal(window as never, { focus: false })
    expect(calls).toEqual(['showInactive'])
    expect(controller.status(window as never)).toMatchObject({ available: true, ready: false, reason: 'uia-not-verified' })

    const snapshot = await controller.snapshot(window as never, { timeoutMs: 500 })

    expect(snapshot.verificationLevel).toBe('native-verified')
    expect(snapshot.windows).toHaveLength(1)
    expect(controller.status(window as never)).toMatchObject({ available: true, ready: true, verified: true, reason: 'ready' })
    expect(phases).toEqual(['loading', 'ready'])
    expect(calls).toEqual(['showInactive', 'focus'])
  })

  it('serializes native snapshots so concurrent requests cannot invalidate each other', async () => {
    let active = 0
    let maxActive = 0
    const window = {
      webContents: { id: 9, isLoading: () => false },
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      isFocused: () => true,
      focus() {},
      getTitle: () => 'Mortise',
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    }
    const driver = new WindowsNativeUiDriver(42, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { windows: [{
        runtimeId: 'root', role: 'Window', name: 'Mortise', enabled: true, focused: true,
        bounds: { x: 120, y: 60, width: 960, height: 720 }, patterns: ['Window'], children: [],
      }] }
    }, 'win32')
    const controller = new ElectronNativeWindowController(driver)

    const [first, second] = await Promise.all([
      controller.snapshot(window as never, { timeoutMs: 500 }),
      controller.snapshot(window as never, { timeoutMs: 500 }),
    ])

    expect(maxActive).toBe(1)
    expect(second.revision).toBe(first.revision)
  })

  it('accepts a selected foreground window when a descendant owns keyboard focus', async () => {
    let snapshotReads = 0
    const requests: Record<string, unknown>[] = []
    const window = {
      webContents: { id: 11, isLoading: () => false },
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      isFocused: () => true,
      focus() {},
      getTitle: () => 'Mortise',
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    }
    const driver = new WindowsNativeUiDriver(42, async request => {
      requests.push(request)
      if (request.operation === 'action') return { ok: true }
      snapshotReads += 1
      return { windows: [{
        runtimeId: 'root', role: 'Window', name: 'Mortise', enabled: true, focused: false,
        bounds: { x: 120, y: 60, width: 960, height: 720 }, patterns: ['Window'], children: [{
          runtimeId: 'focused-child', role: 'Edit', name: 'Composer', enabled: true, focused: true,
        }],
      }] }
    }, 'win32')
    const controller = new ElectronNativeWindowController(driver)

    const snapshot = await controller.snapshot(window as never, { timeoutMs: 500 })
    const root = snapshot.windows[0]!.nodes.find(node => node.name === 'Mortise')!
    const receipt = await controller.action(window as never, {
      revision: snapshot.revision, ref: root.ref, action: 'focus',
    }, { timeoutMs: 500 })

    expect(snapshotReads).toBe(2)
    expect(receipt.verificationLevel).toBe('native-verified')
    expect(requests.some(request => request.operation === 'action' && request.action === 'focus')).toBeTrue()
  })

  it('does not invalidate a published ref with a redundant readiness snapshot', async () => {
    let snapshotReads = 0
    const window = {
      webContents: { id: 12, isLoading: () => false },
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      isFocused: () => true,
      focus() {},
      getTitle: () => 'Mortise',
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    }
    const driver = new WindowsNativeUiDriver(42, async request => {
      if (request.operation === 'action') return { ok: true }
      snapshotReads += 1
      return { windows: [{
        runtimeId: 'root', role: 'Window', name: 'Mortise', enabled: true, focused: true,
        bounds: { x: 120, y: 60, width: 960, height: 720 }, patterns: ['Window'], children: [{
          runtimeId: 'dynamic', role: 'Text', name: `Dynamic ${snapshotReads}`, enabled: true, focused: false,
        }],
      }] }
    }, 'win32')
    const controller = new ElectronNativeWindowController(driver)

    const snapshot = await controller.snapshot(window as never, { timeoutMs: 500 })
    const root = snapshot.windows[0]!.nodes.find(node => node.name === 'Mortise')!
    const receipt = await controller.action(window as never, {
      revision: snapshot.revision, ref: root.ref, action: 'focus',
    }, { timeoutMs: 500 })

    expect(receipt.beforeRevision).toBe(snapshot.revision)
    expect(receipt.afterRevision).toBeGreaterThan(snapshot.revision)
    expect(snapshotReads).toBe(2)
  })

  it('keeps a minimized window in the background and filters foreground-only native actions', async () => {
    const requests: Record<string, unknown>[] = []
    const window = {
      webContents: { id: 10, isLoading: () => false },
      isDestroyed: () => false,
      isMinimized: () => true,
      isVisible: () => false,
      isFocused: () => false,
      getTitle: () => 'Mortise',
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    }
    const driver = new WindowsNativeUiDriver(42, async request => {
      requests.push(request)
      if (request.operation === 'action') return { ok: true }
      return { windows: [{
        runtimeId: 'root', role: 'Window', name: 'Mortise', enabled: true, focused: false, patterns: ['Window'], children: [
          { runtimeId: 'button', role: 'Button', name: 'Run', enabled: true, focused: false, patterns: ['Invoke'] },
          { runtimeId: 'coordinate', role: 'Button', name: 'Coordinates only', enabled: true, focused: false, bounds: { x: 10, y: 10, width: 20, height: 20 } },
        ],
      }] }
    }, 'win32')
    const controller = new ElectronNativeWindowController(driver, () => undefined, 'background')

    expect(controller.status(window as never)).toMatchObject({ ready: false, reason: 'uia-not-verified', windowMode: 'background' })
    const snapshot = await controller.snapshot(window as never, { timeoutMs: 500 })
    const root = snapshot.windows[0]!.nodes.find(node => node.name === 'Mortise')!
    const invoke = snapshot.windows[0]!.nodes.find(node => node.name === 'Run')!
    const coordinate = snapshot.windows[0]!.nodes.find(node => node.name === 'Coordinates only')!

    expect(snapshot.windowMode).toBe('background')
    expect(root.actions).toEqual(['minimize', 'close'])
    expect(invoke.actions).toEqual(['click'])
    expect(coordinate.actions).toEqual([])
    expect(controller.status(window as never)).toMatchObject({ ready: true, reason: 'background-ready', windowMode: 'background' })
    await expect(controller.action(window as never, {
      revision: snapshot.revision - 1, ref: invoke.ref, action: 'click',
    }, { timeoutMs: 500 })).rejects.toMatchObject({ code: 'STALE_REF' })
    await expect(controller.action(window as never, {
      revision: snapshot.revision, ref: root.ref, action: 'focus',
    }, { timeoutMs: 500 })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    const receipt = await controller.action(window as never, {
      revision: snapshot.revision, ref: invoke.ref, action: 'click',
    }, { timeoutMs: 500 })
    expect(receipt.warnings).toContain('Background UIA pattern operation has no foreground hit-test evidence.')
    expect(requests.some(request => request.operation === 'action' && request.action === 'click')).toBeTrue()
  })

  it('keeps native validation ready after the user restores a background window', async () => {
    let minimized = true
    let visible = false
    let userForeground = false
    const window = {
      webContents: { id: 13, isLoading: () => false },
      isDestroyed: () => false,
      isMinimized: () => minimized,
      isVisible: () => visible,
      isFocused: () => userForeground,
      getTitle: () => 'Mortise',
      getBounds: () => ({ x: 100, y: 50, width: 800, height: 600 }),
    }
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: [{
      runtimeId: 'root', role: 'Window', name: 'Mortise', enabled: true, focused: userForeground,
      bounds: { x: 120, y: 60, width: 960, height: 720 }, patterns: ['Window'], children: [],
    }] }), 'win32')
    const controller = new ElectronNativeWindowController(
      driver,
      () => undefined,
      'background',
      () => userForeground,
    )

    await controller.snapshot(window as never, { timeoutMs: 500 })
    expect(controller.status(window as never)).toMatchObject({ ready: true, reason: 'background-ready' })

    minimized = false
    visible = true
    userForeground = true

    const snapshot = await controller.snapshot(window as never, { timeoutMs: 500 })
    const root = snapshot.windows[0]!.nodes.find(node => node.name === 'Mortise')!
    expect(root.actions).toEqual(['minimize', 'close'])
    expect(controller.status(window as never)).toMatchObject({
      ready: true,
      reason: 'user-foreground-ready',
      windowMode: 'background',
    })
  })
})
