import { describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { WindowManager } from '../../window-manager'

mock.module('electron', () => ({
  app: { isPackaged: false, getName: () => 'Mortise' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  clipboard: {
    readText: () => '',
    writeText: () => {},
  },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  nativeTheme: { shouldUseDarkColors: false, on() {}, removeListener() {} },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  shell: { openExternal: async () => {} },
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

  it('restores and reveals a minimized or hidden window before focusing it', async () => {
    const target = fakeWindow(53, 'Hidden', { visible: false, minimized: true })
    const driver = new ElectronUiSurfaceDriver(fakeWindowManager([
      { window: target.window, workspaceId: 'workspace-1', role: 'main' },
    ]))

    expect(await driver.electronWindowAction({ webContentsId: 53 }, 'focus')).toBe('native-verified')

    expect(target.restored).toBe(true)
    expect(target.visible).toBe(true)
    expect(target.focused).toBe(true)
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

  it('keeps an action bound to its starting window when drag creates another window', async () => {
    const main = fakeWindow(71, 'Main')
    const auxiliary = fakeWindow(72, 'Auxiliary')
    const entries: Array<{
      window: BrowserWindow
      workspaceId: string
      role: 'main' | 'child-session' | 'auxiliary'
    }> = [{ window: main.window, workspaceId: 'workspace-1', role: 'main' }]
    const driver = new ElectronUiSurfaceDriver(fakeWindowManager(entries)) as any
    const snapshotSelectors: Array<Record<string, unknown>> = []
    const state = {
      revision: 1,
      refs: new Map([['r1:drag-target', {
        cdpRef: 'node-1',
        node: {
          ref: 'r1:drag-target',
          role: 'tab',
          name: 'New Tab',
          state: {},
          actions: ['drag'],
          actionModes: { semantic: [], physical: ['drag'] },
        },
      }]]),
      cdp: {
        getElementGeometry: async () => ({ clickPoint: { x: 10, y: 10 } }),
        drag: async () => {
          entries.push({ window: auxiliary.window, workspaceId: 'workspace-1', role: 'auxiliary' })
        },
      },
    }
    driver.stateFor = () => state
    driver.snapshot = async (selector: Record<string, unknown>) => {
      snapshotSelectors.push({ ...selector })
      if (selector.webContentsId === undefined && entries.length > 1) {
        throw Object.assign(new Error('ambiguous'), { code: 'AMBIGUOUS_TARGET' })
      }
      return { revision: 1, window: { webContentsId: 71 }, regions: {}, truncated: false }
    }

    const receipt = await driver.action({}, {
      revision: 1,
      ref: 'r1:drag-target',
      action: 'drag',
      to: { x: 1000, y: 700 },
    })

    expect(receipt.afterRevision).toBe(1)
    expect(entries).toHaveLength(2)
    expect(snapshotSelectors).toEqual([
      { webContentsId: 71 },
      { webContentsId: 71 },
    ])
  })
})

function fakeWindow(id: number, title: string, initial: { visible?: boolean; minimized?: boolean } = {}) {
  let focused = false
  let visible = initial.visible ?? true
  let minimized = initial.minimized ?? false
  let restored = false
  const window = Object.assign(new EventEmitter(), {
    webContents: { id },
    isDestroyed: () => false,
    getTitle: () => title,
    isFocused: () => focused,
    isVisible: () => visible,
    isMinimized: () => minimized,
    focus: () => { focused = true },
    show: () => { visible = true },
    minimize: () => { minimized = true; visible = false; focused = false },
    maximize: () => {},
    restore: () => { restored = true; minimized = false },
  }) as unknown as BrowserWindow
  return {
    window,
    get focused() { return focused },
    get visible() { return visible },
    get restored() { return restored },
  }
}

function fakeWindowManager(entries: Array<{
  window: BrowserWindow
  workspaceId: string
  role: 'main' | 'child-session' | 'auxiliary'
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
