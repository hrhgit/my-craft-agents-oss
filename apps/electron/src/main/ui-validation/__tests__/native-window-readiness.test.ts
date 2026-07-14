import { describe, expect, it, mock } from 'bun:test'

mock.module('electron', () => ({ clipboard: { writeText() {} } }))
const { WindowsNativeUiDriver } = await import('../windows-native-driver')
const { ensureNativeWindowReady } = await import('../native-window-readiness')

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
      getTitle: () => 'Craft Agents',
    }
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: [{
      runtimeId: '1', role: 'Window', name: 'Craft Agents', enabled: true, focused: true,
      patterns: ['Window'], children: [],
    }] }), 'win32')

    const ready = await ensureNativeWindowReady(window as never, driver, { timeoutMs: 500 })

    expect(calls).toEqual(['restore', 'show', 'focus'])
    expect(ready.node.name).toBe('Craft Agents')
    expect(ready.node.actions).toContain('focus')
  })

  it('does not accept another process window with a different title', async () => {
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      focus() {},
      getTitle: () => 'Craft Agents',
    }
    const driver = new WindowsNativeUiDriver(42, async () => ({ windows: [{
      runtimeId: '1', role: 'Window', name: 'Other', enabled: true, focused: true, children: [],
    }] }), 'win32')

    await expect(ensureNativeWindowReady(window as never, driver, { timeoutMs: 5 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
