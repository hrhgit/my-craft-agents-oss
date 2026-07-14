import { describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { WindowManager } from '../../window-manager'

mock.module('electron', () => ({
  clipboard: {
    readText: () => '',
    writeText: () => {},
  },
}))

const { ElectronUiSurfaceDriver } = await import('../electron-surface-driver')

describe('ElectronUiSurfaceDriver window actions', () => {
  it('does not acknowledge close until Electron emits closed', async () => {
    const window = new EventEmitter() as EventEmitter & {
      webContents: { id: number }
      isDestroyed(): boolean
      close(): void
    }
    let closeRequested = false
    window.webContents = { id: 41 }
    window.isDestroyed = () => false
    window.close = () => { closeRequested = true }

    const windowManager = {
      getWindowByWebContentsId: (id: number) => id === 41 ? window as unknown as BrowserWindow : null,
      getWorkspaceForWindow: () => 'workspace-1',
      getAllWindows: () => [{ window: window as unknown as BrowserWindow, workspaceId: 'workspace-1', role: 'main' }],
      getAllWindowsForWorkspace: () => [window as unknown as BrowserWindow],
    } as unknown as WindowManager
    const driver = new ElectronUiSurfaceDriver(windowManager)

    let settled = false
    const action = driver.electronWindowAction({ webContentsId: 41 }, 'close').then((level) => {
      settled = true
      return level
    })
    await Promise.resolve()

    expect(closeRequested).toBe(true)
    expect(settled).toBe(false)
    window.emit('closed')
    expect(await action).toBe('native-verified')
  })

  it('exposes stable roles and resolves role and workspace together', async () => {
    const main = fakeWindow(51, 'Main')
    const child = fakeWindow(52, 'Child')
    const driver = new ElectronUiSurfaceDriver(fakeWindowManager([
      { window: main.window, workspaceId: 'workspace-1', role: 'main' },
      { window: child.window, workspaceId: 'workspace-1', role: 'child-session', sessionId: 'session-1', parentWebContentsId: 51 },
    ]))

    expect(driver.windows()).toEqual([
      expect.objectContaining({ webContentsId: 51, workspaceId: 'workspace-1', role: 'main' }),
      expect.objectContaining({ webContentsId: 52, workspaceId: 'workspace-1', role: 'child-session', sessionId: 'session-1', parentWebContentsId: 51 }),
    ])
    expect(await driver.electronWindowAction({ workspaceId: 'workspace-1', role: 'child-session' }, 'focus')).toBe('native-verified')
    expect(child.focused).toBe(true)
    expect(main.focused).toBe(false)
  })

  it('rejects ambiguous roles and mismatched explicit identities', async () => {
    const first = fakeWindow(61, 'First')
    const second = fakeWindow(62, 'Second')
    const driver = new ElectronUiSurfaceDriver(fakeWindowManager([
      { window: first.window, workspaceId: 'workspace-1', role: 'main' },
      { window: second.window, workspaceId: 'workspace-2', role: 'main' },
    ]))

    await expect(driver.electronWindowAction({ role: 'main' }, 'focus')).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' })
    await expect(driver.electronWindowAction({ webContentsId: 61, role: 'child-session' }, 'focus')).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
  })
})

function fakeWindow(id: number, title: string) {
  let focused = false
  const window = Object.assign(new EventEmitter(), {
    webContents: { id },
    isDestroyed: () => false,
    getTitle: () => title,
    isFocused: () => focused,
    isVisible: () => true,
    focus: () => { focused = true },
    minimize: () => {},
    maximize: () => {},
    restore: () => {},
  }) as unknown as BrowserWindow
  return { window, get focused() { return focused } }
}

function fakeWindowManager(entries: Array<{
  window: BrowserWindow
  workspaceId: string
  role: 'main' | 'child-session'
  sessionId?: string
  parentWebContentsId?: number
}>): WindowManager {
  return {
    getWindowByWebContentsId: (id: number) => entries.find(entry => entry.window.webContents.id === id)?.window ?? null,
    getWorkspaceForWindow: (id: number) => entries.find(entry => entry.window.webContents.id === id)?.workspaceId ?? null,
    getAllWindows: () => entries,
    getAllWindowsForWorkspace: (workspaceId: string) => entries.filter(entry => entry.workspaceId === workspaceId).map(entry => entry.window),
  } as unknown as WindowManager
}
