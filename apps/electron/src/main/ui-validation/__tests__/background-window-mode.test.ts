import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { WindowManager } from '../../window-manager'
import { ElectronBackgroundWindowController, parseElectronUiWindowMode } from '../background-window-mode'

describe('ElectronBackgroundWindowController', () => {
  it('validates the run window mode', () => {
    expect(parseElectronUiWindowMode(undefined)).toBe('background')
    expect(parseElectronUiWindowMode('background')).toBe('background')
    expect(() => parseElectronUiWindowMode('hidden')).toThrow('foreground or background')
  })

  it('minimizes visible windows and suppresses later restore or focus events', () => {
    const fake = fakeWindow(11, true)
    const manager = { getAllWindows: () => [{ window: fake.window }] } as unknown as WindowManager
    const controller = new ElectronBackgroundWindowController(manager)

    expect(fake.minimizeCount).toBe(1)
    fake.restore()
    expect(fake.minimizeCount).toBe(2)
    fake.focus()
    expect(fake.minimizeCount).toBe(3)

    controller.dispose()
    fake.restore()
    expect(fake.minimizeCount).toBe(3)
  })

  it('tracks windows that are created after the host starts', () => {
    const windows: Array<{ window: BrowserWindow }> = []
    const manager = { getAllWindows: () => windows } as unknown as WindowManager
    const controller = new ElectronBackgroundWindowController(manager)
    const fake = fakeWindow(12, false)
    windows.push({ window: fake.window })

    controller.refresh()
    expect(fake.minimizeCount).toBe(0)
    fake.show()
    expect(fake.minimizeCount).toBe(1)
  })
})

function fakeWindow(id: number, initiallyVisible: boolean) {
  const emitter = new EventEmitter()
  let visible = initiallyVisible
  let minimized = false
  let focused = false
  let minimizeCount = 0
  const window = Object.assign(emitter, {
    webContents: { id },
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    isFocused: () => focused,
    minimize: () => { minimizeCount += 1; minimized = true; focused = false },
  }) as unknown as BrowserWindow
  return {
    window,
    get minimizeCount() { return minimizeCount },
    show() { visible = true; minimized = false; emitter.emit('show') },
    restore() { visible = true; minimized = false; emitter.emit('restore') },
    focus() { visible = true; minimized = false; focused = true; emitter.emit('focus') },
  }
}
