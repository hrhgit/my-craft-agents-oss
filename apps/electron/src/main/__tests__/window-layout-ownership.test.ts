import { describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'

mock.module('electron', () => ({
  app: { isPackaged: false, getName: () => 'Mortise' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  clipboard: { readText: () => '', writeText() {} },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  nativeTheme: { shouldUseDarkColors: false, on() {}, removeListener() {} },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  shell: { openExternal: async () => {} },
}))
mock.module('@mortise/shared/config', () => ({
  getWorkspaceByNameOrId: () => null,
}))

const {
  WindowManager,
  restoreSourceWindowAfterAuxiliaryShow,
  shouldScheduleWindowCloseFallback,
} = await import('../window-manager')

function managed(workspaceId: string, role: 'main' | 'child-session' | 'auxiliary', extra: Record<string, unknown> = {}) {
  return {
    window: { isDestroyed: () => false, setTitle() {} },
    workspaceId,
    role,
    ...extra,
  }
}

describe('WindowManager layout ownership', () => {
  it('disables the destructive fallback while a graceful close owns the timeout', () => {
    expect(shouldScheduleWindowCloseFallback(true)).toBe(false)
    expect(shouldScheduleWindowCloseFallback(false)).toBe(true)
  })
  it('turns Ctrl+W into an explicit layered window-close request', () => {
    const manager = new WindowManager() as any
    const close = mock(() => {})
    const preventDefault = mock(() => {})
    const window = {
      webContents: { id: 7 },
      isDestroyed: () => false,
      close,
    }
    manager.windows.set(7, { window, workspaceId: 'ws-a', role: 'main' })

    manager.handleKeyboardCloseInput(window, { preventDefault }, {
      type: 'keyDown',
      key: 'w',
      control: true,
      meta: false,
    })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(manager.keyboardCloseIntents.has(7)).toBe(true)
    clearTimeout(manager.keyboardCloseIntentTimeouts.get(7))
  })

  it('does not consume an unmodified W key', () => {
    const manager = new WindowManager() as any
    const close = mock(() => {})
    const preventDefault = mock(() => {})
    const window = {
      webContents: { id: 8 },
      isDestroyed: () => false,
      close,
    }
    manager.windows.set(8, { window, workspaceId: 'ws-a', role: 'main' })

    manager.handleKeyboardCloseInput(window, { preventDefault }, {
      type: 'keyDown',
      key: 'w',
      control: false,
      meta: false,
    })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('restores a detach source that Windows minimizes while showing the auxiliary window', async () => {
    const manager = new WindowManager() as any
    const auxiliary = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      focus: mock(() => {}),
    })
    let sourceVisible = true
    let sourceMinimized = false
    const source = {
      webContents: { id: 1 },
      isDestroyed: () => false,
      isVisible: () => sourceVisible,
      isMinimized: () => sourceMinimized,
      restore: mock(() => {
        sourceMinimized = false
        sourceVisible = true
      }),
      showInactive: mock(() => { sourceVisible = true }),
      setTitle() {},
    }
    manager.windows.set(1, { window: source, workspaceId: 'ws-a', role: 'main' })
    manager.primaryWebContentsByWorkspace.set('ws-a', 1)
    manager.createWindow = mock(() => auxiliary)

    manager.createAuxiliaryWindow('aux-a', 'ws-a', 1)
    sourceMinimized = true
    sourceVisible = false
    auxiliary.emit('ready-to-show')
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(source.restore).toHaveBeenCalledTimes(1)
    expect(source.showInactive).not.toHaveBeenCalled()
    expect(auxiliary.focus).toHaveBeenCalledTimes(1)
  })

  it('reveals a preserved detach source if restoring it does not make it visible', () => {
    const source = {
      isDestroyed: () => false,
      isMinimized: () => true,
      isVisible: () => false,
      restore: mock(() => {}),
      showInactive: mock(() => {}),
    }
    const auxiliary = { isDestroyed: () => false, focus: mock(() => {}) }

    restoreSourceWindowAfterAuxiliaryShow(source, auxiliary)

    expect(source.restore).toHaveBeenCalledTimes(1)
    expect(source.showInactive).toHaveBeenCalledTimes(1)
    expect(auxiliary.focus).toHaveBeenCalledTimes(1)
  })

  it('assigns one independent primary writer per workspace and scopes auxiliaries to it', () => {
    const manager = new WindowManager() as any
    manager.windows.set(1, managed('ws-a', 'main'))
    manager.windows.set(2, managed('ws-b', 'main'))
    manager.windows.set(3, managed('ws-a', 'main'))
    manager.windows.set(4, managed('ws-a', 'auxiliary', {
      layoutWindowId: 'aux-a',
      parentWebContentsId: 1,
    }))
    manager.windows.set(5, managed('ws-a', 'child-session'))
    manager.primaryWebContentsByWorkspace.set('ws-a', 1)
    manager.primaryWebContentsByWorkspace.set('ws-b', 2)

    expect(manager.getLayoutWriteContext(1)).toEqual({
      workspaceId: 'ws-a', layoutWindowId: 'primary', role: 'primary', ownerWebContentsId: 1,
    })
    expect(manager.getLayoutWriteContext(2)?.workspaceId).toBe('ws-b')
    expect(manager.getLayoutWriteContext(3)).toBeNull()
    expect(manager.getLayoutWriteContext(4)).toEqual({
      workspaceId: 'ws-a', layoutWindowId: 'aux-a', role: 'auxiliary', ownerWebContentsId: 1,
    })
    expect(manager.getLayoutWriteContext(5)).toBeNull()
  })

  it('promotes only a surviving main window from the same workspace', () => {
    const manager = new WindowManager() as any
    manager.windows.set(2, managed('ws-b', 'main'))
    manager.windows.set(3, managed('ws-a', 'main'))
    manager.windows.set(4, managed('ws-a', 'auxiliary', {
      layoutWindowId: 'aux-a',
      parentWebContentsId: 1,
    }))

    manager.promotePrimaryLayoutWriter('ws-a')
    expect(manager.getLayoutWriteContext(3)?.role).toBe('primary')
    expect(manager.getLayoutWriteContext(2)).toBeNull()
    expect(manager.getLayoutWriteContext(4)).toBeNull()
  })

  it('runs workspace-change cleanup before transferring window ownership', async () => {
    const manager = new WindowManager() as any
    manager.windows.set(1, managed('ws-a', 'main'))
    manager.primaryWebContentsByWorkspace.set('ws-a', 1)
    const cleanup = mock((webContentsId: number, oldWorkspaceId: string, newWorkspaceId: string) => {
      expect(manager.windows.get(webContentsId).workspaceId).toBe(oldWorkspaceId)
      expect(newWorkspaceId).toBe('ws-b')
    })
    manager.setWorkspaceChangingHandler(cleanup)

    expect(await manager.updateWindowWorkspace(1, 'ws-b')).toBe(true)

    expect(cleanup).toHaveBeenCalledWith(1, 'ws-a', 'ws-b')
    expect(manager.windows.get(1).workspaceId).toBe('ws-b')
  })

  it('rejects direct workspace switches from auxiliary windows', async () => {
    const manager = new WindowManager() as any
    manager.windows.set(1, managed('ws-a', 'main'))
    manager.windows.set(2, managed('ws-a', 'auxiliary', {
      layoutWindowId: 'aux-a',
      parentWebContentsId: 1,
    }))
    manager.primaryWebContentsByWorkspace.set('ws-a', 1)

    await expect(manager.updateWindowWorkspace(2, 'ws-b')).rejects.toThrow(
      'auxiliary windows cannot switch workspaces directly',
    )
    expect(manager.windows.get(2).workspaceId).toBe('ws-a')
  })

  it('waits for auxiliary flush, close, and redock before committing a workspace switch', async () => {
    const manager = new WindowManager() as any
    const auxiliaryEvents = new EventEmitter()
    const order: string[] = []
    const auxiliary = Object.assign(auxiliaryEvents, {
      isDestroyed: () => false,
      setTitle() {},
      close: () => {
        order.push('close-requested')
        queueMicrotask(() => auxiliary.emit('closed'))
      },
    })
    manager.windows.set(1, managed('ws-a', 'main'))
    manager.windows.set(2, {
      window: auxiliary,
      workspaceId: 'ws-a',
      role: 'auxiliary',
      layoutWindowId: 'aux-a',
      parentWebContentsId: 1,
    })
    manager.primaryWebContentsByWorkspace.set('ws-a', 1)
    manager.setAuxiliaryClosedHandler(async () => { order.push('redocked') })
    manager.setWorkspaceChangingHandler(() => { order.push('workspace-cleanup') })

    await expect(manager.updateWindowWorkspace(1, 'ws-b')).resolves.toBe(true)

    expect(order).toEqual(['close-requested', 'redocked', 'workspace-cleanup'])
    expect(manager.windows.get(1).workspaceId).toBe('ws-b')
    expect(manager.primaryWebContentsByWorkspace.get('ws-b')).toBe(1)
  })

  it('aborts a workspace switch when an auxiliary renderer cancels its close', async () => {
    const manager = new WindowManager() as any
    const auxiliary = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      close: () => manager.cancelPendingClose(2),
    })
    manager.windows.set(1, managed('ws-a', 'main'))
    manager.windows.set(2, {
      window: auxiliary,
      workspaceId: 'ws-a',
      role: 'auxiliary',
      layoutWindowId: 'aux-a',
      parentWebContentsId: 1,
    })
    manager.primaryWebContentsByWorkspace.set('ws-a', 1)

    await expect(manager.updateWindowWorkspace(1, 'ws-b')).rejects.toMatchObject({ code: 'cancelled' })
    expect(manager.windows.get(1).workspaceId).toBe('ws-a')
    expect(manager.primaryWebContentsByWorkspace.get('ws-a')).toBe(1)
  })

  it('waits for auxiliary close handshakes before destroying the primary window', () => {
    const manager = new WindowManager() as any
    const primaryEvents = new EventEmitter()
    const auxiliaryEvents = new EventEmitter()
    let primaryDestroyed = false
    let auxiliaryCloseRequested = false
    const primary = Object.assign(primaryEvents, {
      isDestroyed: () => primaryDestroyed,
      destroy: () => { primaryDestroyed = true },
    })
    const auxiliary = Object.assign(auxiliaryEvents, {
      isDestroyed: () => false,
      close: () => { auxiliaryCloseRequested = true },
    })
    manager.windows.set(1, { window: primary, workspaceId: 'ws-a', role: 'main' })
    manager.windows.set(2, {
      window: auxiliary,
      workspaceId: 'ws-a',
      role: 'auxiliary',
      layoutWindowId: 'aux-a',
      parentWebContentsId: 1,
    })
    manager.primaryWebContentsByWorkspace.set('ws-a', 1)

    manager.forceCloseWindow(1)
    expect(auxiliaryCloseRequested).toBe(true)
    expect(primaryDestroyed).toBe(false)

    auxiliary.emit('closed')
    expect(primaryDestroyed).toBe(true)
  })
})
