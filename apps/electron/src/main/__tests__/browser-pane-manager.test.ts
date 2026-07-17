/**
 * Tests for BrowserPaneManager.
 *
 * Mocks Electron BrowserWindow and session modules to validate lifecycle,
 * session binding, and navigation behavior.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { validateFilePath as validateFilePathImpl } from '../../../../../packages/server-core/src/handlers/utils'

const createdWindows: any[] = []
let toolbarLoadFailuresRemaining = 0
const mockShellOpenExternal = mock(async () => {})
const mockIpcMainHandle = mock(() => {})
const workspaceAllowedDirs = new Map<string, string[]>()
const mockGetWorkspaceAllowedDirs = mock((workspaceId?: string | null) => (
  workspaceId ? workspaceAllowedDirs.get(workspaceId) ?? [] : []
))

function createMockWebContents() {
  const listeners: Record<string, Function[]> = {}
  let currentUrl = 'about:blank'
  let zoomFactor = 1
  return {
    id: 0,
    userAgent: 'Mock Chrome Electron/99.0.0',
    session: {},
    isDestroyed: mock(() => false),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    removeListener: (event: string, cb: Function) => {
      listeners[event] = (listeners[event] || []).filter(fn => fn !== cb)
    },
    loadURL: mock(async (url: string) => {
      currentUrl = url
      const isToolbarUrl = typeof url === 'string' && url.includes('browser-toolbar.html')
      if (isToolbarUrl && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    loadFile: mock(async (path: string, _opts?: unknown) => {
      if (path.includes('browser-toolbar.html') && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
      currentUrl = pathToFileURL(path).toString()
    }),
    getTitle: mock(() => 'Test Page'),
    getURL: mock(() => currentUrl),
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => {}),
    goForward: mock(() => {}),
    reload: mock(() => {}),
    getZoomFactor: mock(() => zoomFactor),
    setZoomFactor: mock((value: number) => { zoomFactor = value }),
    stop: mock(() => {}),
    setUserAgent: mock(() => {}),
    setBackgroundColor: mock(() => {}),
    capturePage: mock(async () => {
      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: (_opts: any) => img,
        toPNG: () => Buffer.from('fake-png'),
        toJPEG: (_quality: number) => Buffer.from('fake-jpeg'),
      }
      return img
    }),
    executeJavaScript: mock(async (expr: string) => eval(expr)),
    focus: mock(() => {}),
    setWindowOpenHandler: mock((_handler: any) => {}),
    send: mock((_channel: string, _payload?: unknown) => {}),
    sendInputEvent: mock((_event: unknown) => {}),
    debugger: {
      attach: mock(() => {}),
      detach: mock(() => {}),
      sendCommand: mock(async () => ({ nodes: [] })),
      on: mock(() => {}),
    },
    _listeners: listeners,
    _emit: (event: string, ...args: any[]) => {
      if ((event === 'did-navigate' || event === 'did-navigate-in-page') && typeof args[0] === 'string') {
        currentUrl = args[0]
      }
      for (const cb of listeners[event] || []) {
        if (event === 'did-create-window') cb(...args)
        else cb({}, ...args)
      }
    },
  }
}

function createMockBrowserView() {
  const webContents = createMockWebContents()
  return {
    webContents,
    setBounds: mock(() => {}),
    setAutoResize: mock(() => {}),
  }
}

function createMockWindow(opts?: { width?: number; height?: number; minWidth?: number; minHeight?: number }) {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let contentWidth = opts?.width ?? 1200
  let contentHeight = opts?.height ?? 900
  let visible = false
  const minWidth = opts?.minWidth ?? 0
  const minHeight = opts?.minHeight ?? 0

  const win = {
    webContents,
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    removeListener: (event: string, cb: Function) => {
      listeners[event] = (listeners[event] || []).filter(fn => fn !== cb && (fn as { listener?: Function }).listener !== cb)
    },
    once: (event: string, cb: Function) => {
      const wrapped = (...args: any[]) => {
        listeners[event] = (listeners[event] || []).filter(fn => fn !== wrapped)
        cb(...args)
      }
      ;(wrapped as { listener?: Function }).listener = cb
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(wrapped)
    },
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb(...args)
    },
    _listeners: listeners,
    _listenerCount: (event: string) => listeners[event]?.length ?? 0,
    isDestroyed: mock(() => false),
    isVisible: mock(() => visible),
    isMinimized: mock(() => false),
    restore: mock(() => {}),
    show: mock(() => { visible = true }),
    showInactive: mock(() => {}),
    setWindowButtonVisibility: mock((_visible: boolean) => {}),
    hide: mock(() => {
      visible = false
      win._emit('hide')
    }),
    focus: mock(() => {}),
    destroy: mock(() => {
      win._emit('closed')
    }),
    setBrowserView: mock((_view: any) => {}),
    addBrowserView: mock((_view: any) => {}),
    removeBrowserView: mock((_view: any) => {}),
    setTopBrowserView: mock((_view: any) => {}),
    getContentSize: mock(() => [contentWidth, contentHeight]),
    setContentSize: mock((width: number, height: number) => {
      contentWidth = Math.max(minWidth, Math.floor(width))
      contentHeight = Math.max(minHeight, Math.floor(height))
    }),
    loadURL: mock(async (_url: string) => {}),
  }
  createdWindows.push(win)
  return win
}

mock.module('electron', () => ({
  app: {
    getPath: mock((name: string) => name === 'downloads' ? '/tmp/mock-downloads' : `/tmp/mock-${name}`),
  },
  BrowserWindow: class MockBrowserWindow {
    static getAllWindows() {
      return createdWindows
    }

    webContents: any
    constructor(opts?: any) {
      const win = createMockWindow(opts)
      this.webContents = win.webContents
      Object.assign(this, win)
    }
  },
  BrowserView: class MockBrowserView {
    webContents: any
    constructor(_opts?: any) {
      const view = createMockBrowserView()
      this.webContents = view.webContents
      Object.assign(this, view)
    }
  },
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  Menu: {
    buildFromTemplate: mock(() => ({
      popup: mock(() => {}),
    })),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  session: {
    fromPartition: mock(() => ({
      setPermissionCheckHandler: mock(() => {}),
      setPermissionRequestHandler: mock(() => {}),
      webRequest: {
        onBeforeRequest: mock((_cb: any) => {}),
        onCompleted: mock((_cb: any) => {}),
        onErrorOccurred: mock((_cb: any) => {}),
      },
      on: mock((_event: string, _cb: any) => {}),
    })),
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

mock.module('@craft-agent/server-core/handlers', () => ({
  validateFilePath: validateFilePathImpl,
  getWorkspaceAllowedDirs: mockGetWorkspaceAllowedDirs,
}))

mock.module('../browser-cdp', () => ({
  BrowserCDP: class MockBrowserCDP {
    detach = mock(() => {})
    getAccessibilitySnapshot = mock(async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [],
    }))
    clickElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    fillElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    selectOption = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    setFileInputFiles = mock(async () => ({
      ref: '@upload',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    renderTemporaryOverlay = mock(async () => {})
    clearTemporaryOverlay = mock(async () => {})
    getViewportMetrics = mock(async () => ({ width: 1200, height: 900, dpr: 2, scrollX: 0, scrollY: 0 }))
    getElementGeometry = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    getElementGeometryBySelector = mock(async () => ({
      ref: 'selector:div.card',
      box: { x: 5, y: 5, width: 20, height: 20 },
      clickPoint: { x: 15, y: 15 },
    }))
  },
}))

const { BrowserPaneManager } = await import('../browser-pane-manager')

describe('BrowserPaneManager', () => {
  let manager: InstanceType<typeof BrowserPaneManager>

  beforeEach(() => {
    createdWindows.length = 0
    toolbarLoadFailuresRemaining = 0
    mockShellOpenExternal.mockClear()
    mockIpcMainHandle.mockClear()
    workspaceAllowedDirs.clear()
    mockGetWorkspaceAllowedDirs.mockClear()
    manager = new BrowserPaneManager()
  })

  it('creates and lists instances', () => {
    const id = manager.createInstance('test-1')
    const list = manager.listInstances()
    expect(id).toBe('test-1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('test-1')
    expect(list[0].agentControlActive).toBe(false)
  })

  it('is idempotent when explicit ID already exists', () => {
    const first = manager.createInstance('same-id')
    const second = manager.createInstance('same-id')
    expect(first).toBe('same-id')
    expect(second).toBe('same-id')
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('reparents the page and control overlay into a workbench host and detaches cleanly', () => {
    manager.createInstance('embedded-browser')
    manager.bindSession('embedded-browser', 'session-embed')
    const instance = (manager as any).instances.get('embedded-browser')
    instance.nativeOverlayReady = true
    manager.setAgentControl('session-embed', { displayName: 'Inspect', intent: 'Reading page' })

    const hostWindow = createMockWindow({ width: 1000, height: 700 })
    hostWindow.webContents.id = 42
    const bounds = { x: 650, y: 50, width: 340, height: 640 }

    manager.embedInHost('embedded-browser', 42, bounds)

    expect(instance.window.removeBrowserView).toHaveBeenCalledWith(instance.pageView)
    expect(instance.window.removeBrowserView).toHaveBeenCalledWith(instance.nativeOverlayView)
    expect(hostWindow.addBrowserView).toHaveBeenCalledWith(instance.pageView)
    expect(hostWindow.addBrowserView).toHaveBeenCalledWith(instance.nativeOverlayView)
    expect(instance.pageView.setBounds).toHaveBeenLastCalledWith(bounds)
    expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith(bounds)
    expect(hostWindow.setTopBrowserView).toHaveBeenLastCalledWith(instance.nativeOverlayView)
    expect(manager.listInstances().find(item => item.id === 'embedded-browser')?.isEmbedded).toBe(true)

    manager.detachFromHost('embedded-browser', 42)

    expect(hostWindow.removeBrowserView).toHaveBeenCalledWith(instance.pageView)
    expect(hostWindow.removeBrowserView).toHaveBeenCalledWith(instance.nativeOverlayView)
    expect(instance.window.addBrowserView).toHaveBeenCalledWith(instance.pageView)
    expect(instance.window.addBrowserView).toHaveBeenCalledWith(instance.nativeOverlayView)
    expect(manager.listInstances().find(item => item.id === 'embedded-browser')?.isEmbedded).toBe(false)
  })

  it('keeps two browser instances embedded in split panels of the same host', () => {
    manager.createInstance('split-browser-a')
    manager.createInstance('split-browser-b')
    const first = (manager as any).instances.get('split-browser-a')
    const second = (manager as any).instances.get('split-browser-b')
    const hostWindow = createMockWindow({ width: 1200, height: 800 })
    hostWindow.webContents.id = 43
    first.window.addBrowserView.mockClear()
    second.window.addBrowserView.mockClear()

    manager.embedInHost('split-browser-a', 43, { x: 0, y: 40, width: 600, height: 760 })
    manager.embedInHost('split-browser-b', 43, { x: 600, y: 40, width: 600, height: 760 })

    expect(first.embeddedHostWindow).toBe(hostWindow)
    expect(second.embeddedHostWindow).toBe(hostWindow)
    expect(first.window.addBrowserView).not.toHaveBeenCalledWith(first.pageView)
    expect(first.window.addBrowserView).not.toHaveBeenCalledWith(first.nativeOverlayView)
    expect(hostWindow.addBrowserView).toHaveBeenCalledWith(first.pageView)
    expect(hostWindow.addBrowserView).toHaveBeenCalledWith(second.pageView)
    expect(manager.listInstances().filter(item => item.isEmbedded).map(item => item.id)).toEqual([
      'split-browser-a',
      'split-browser-b',
    ])
  })

  it('uses one host lifecycle listener for more than ten embedded browser instances', () => {
    const hostWindow = createMockWindow({ width: 1200, height: 800 })
    hostWindow.webContents.id = 53

    for (let index = 0; index < 12; index += 1) {
      const id = `shared-host-${index}`
      manager.createInstance(id)
      manager.embedInHost(id, 53, { x: index * 10, y: 40, width: 500, height: 600 })
    }

    expect(hostWindow._listenerCount('closed')).toBe(1)
    expect(hostWindow.webContents._listeners['zoom-changed']).toHaveLength(1)
    expect((manager as any).embeddedHostsByWebContentsId.get(53)?.instanceIds.size).toBe(12)
  })

  it('does not accumulate host listeners while repeatedly reparenting one instance', () => {
    manager.createInstance('reparented-browser')
    const firstHost = createMockWindow({ width: 1000, height: 700 })
    const secondHost = createMockWindow({ width: 1000, height: 700 })
    firstHost.webContents.id = 54
    secondHost.webContents.id = 55

    for (let index = 0; index < 20; index += 1) {
      const host = index % 2 === 0 ? firstHost : secondHost
      const otherHost = index % 2 === 0 ? secondHost : firstHost
      manager.embedInHost('reparented-browser', host.webContents.id, { x: 20, y: 40, width: 600, height: 420 })
      expect(host._listenerCount('closed')).toBe(1)
      expect(host.webContents._listeners['zoom-changed']).toHaveLength(1)
      expect(otherHost._listenerCount('closed')).toBe(0)
      expect(otherHost.webContents._listeners['zoom-changed'] ?? []).toHaveLength(0)
    }

    expect((manager as any).embeddedHostsByWebContentsId.size).toBe(1)
  })

  it('detaches every registered instance when its shared host closes', () => {
    const hostWindow = createMockWindow({ width: 1200, height: 800 })
    hostWindow.webContents.id = 56
    const instances = Array.from({ length: 12 }, (_, index) => {
      const id = `closed-host-${index}`
      manager.createInstance(id)
      manager.embedInHost(id, 56, { x: 20, y: 40, width: 600, height: 420 })
      return (manager as any).instances.get(id)
    })

    hostWindow.isDestroyed.mockReturnValue(true)
    hostWindow._emit('closed')

    expect(instances.every(instance => instance.embeddedHostWindow === null)).toBe(true)
    expect(instances.every(instance => instance.window.addBrowserView.mock.calls.some(
      (call: unknown[]) => call[0] === instance.pageView,
    ))).toBe(true)
    expect((manager as any).embeddedHostsByWebContentsId.has(56)).toBe(false)
    expect(hostWindow._listenerCount('closed')).toBe(0)
    expect(hostWindow.webContents._listeners['zoom-changed'] ?? []).toHaveLength(0)
  })

  it('cleans up the shared host listeners when the final instance is removed', () => {
    const hostWindow = createMockWindow({ width: 1200, height: 800 })
    hostWindow.webContents.id = 57
    manager.createInstance('cleanup-first')
    manager.createInstance('cleanup-last')
    manager.embedInHost('cleanup-first', 57, { x: 0, y: 40, width: 600, height: 700 })
    manager.embedInHost('cleanup-last', 57, { x: 600, y: 40, width: 600, height: 700 })

    manager.detachFromHost('cleanup-first', 57)
    manager.detachFromHost('cleanup-first', 57)
    expect(hostWindow._listenerCount('closed')).toBe(1)
    expect(hostWindow.webContents._listeners['zoom-changed']).toHaveLength(1)

    manager.destroyInstance('cleanup-last')
    manager.destroyInstance('cleanup-last')
    expect(hostWindow._listenerCount('closed')).toBe(0)
    expect(hostWindow.webContents._listeners['zoom-changed'] ?? []).toHaveLength(0)
    expect((manager as any).embeddedHostsByWebContentsId.has(57)).toBe(false)
  })

  it('routes Ctrl+W from every embedded BrowserView through the host layered close policy', () => {
    const requestKeyboardClose = mock(() => true)
    manager.setWindowManager({ requestKeyboardClose } as any)
    manager.createInstance('embedded-close-shortcut')
    const instance = (manager as any).instances.get('embedded-close-shortcut')
    const hostWindow = createMockWindow({ width: 1000, height: 700 })
    hostWindow.webContents.id = 47
    manager.embedInHost('embedded-close-shortcut', 47, { x: 20, y: 40, width: 600, height: 420 })

    for (const view of [instance.pageView, instance.toolbarView, instance.nativeOverlayView]) {
      const preventDefault = mock(() => {})
      const listener = view.webContents._listeners['before-input-event'][0]
      listener({ preventDefault }, { type: 'keyDown', key: 'w', control: true, meta: false })
      expect(preventDefault).toHaveBeenCalledTimes(1)
    }

    expect(requestKeyboardClose).toHaveBeenCalledTimes(3)
    expect(requestKeyboardClose).toHaveBeenCalledWith(47)
  })

  it('routes only the supported dock shortcuts from an embedded BrowserView', () => {
    const requestBrowserHostDockNavigation = mock(() => true)
    manager.setWindowManager({ requestBrowserHostDockNavigation } as any)
    manager.createInstance('embedded-dock-shortcuts')
    const instance = (manager as any).instances.get('embedded-dock-shortcuts')
    const hostWindow = createMockWindow({ width: 1000, height: 700 })
    hostWindow.webContents.id = 48
    manager.embedInHost('embedded-dock-shortcuts', 48, { x: 20, y: 40, width: 600, height: 420 })
    const listener = instance.pageView.webContents._listeners['before-input-event'][0]

    for (const [input, command] of [
      [{ type: 'keyDown', key: 'F6', control: false, meta: false, alt: false, shift: false }, 'focus-active-tab'],
      [{ type: 'keyDown', key: ']', code: 'BracketRight', control: true, meta: false, alt: false, shift: false }, 'focus-next-group'],
      [{ type: 'keyDown', key: '[', code: 'BracketLeft', control: true, meta: false, alt: false, shift: false }, 'focus-previous-group'],
    ] as const) {
      const preventDefault = mock(() => {})
      listener({ preventDefault }, input)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(requestBrowserHostDockNavigation).toHaveBeenLastCalledWith(48, command)
    }

    const preventDefault = mock(() => {})
    listener({ preventDefault }, { type: 'keyDown', key: 'F7', control: false, meta: false })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(requestBrowserHostDockNavigation).toHaveBeenCalledTimes(3)
  })

  it('injects a bounded shortcut only into the selected embedded host', async () => {
    manager.createInstance('embedded-test-host-key', { workspaceId: 'workspace-a' })
    const instance = (manager as any).instances.get('embedded-test-host-key')
    const hostWindow = createMockWindow({ width: 1000, height: 700 })
    hostWindow.webContents.id = 50
    manager.embedInHost('embedded-test-host-key', 50, { x: 20, y: 40, width: 600, height: 420 })

    await manager.sendKeyToEmbeddedHost('embedded-test-host-key', 50, {
      key: 'F6',
      modifiers: [],
    })

    expect(instance.pageView.webContents.sendInputEvent).toHaveBeenNthCalledWith(1, {
      type: 'keyDown',
      keyCode: 'F6',
      modifiers: [],
    })
    expect(instance.pageView.webContents.sendInputEvent).toHaveBeenNthCalledWith(2, {
      type: 'keyUp',
      keyCode: 'F6',
      modifiers: [],
    })
    await expect(manager.sendKeyToEmbeddedHost('embedded-test-host-key', 51, { key: 'F6' }))
      .rejects.toThrow('not embedded in host 51')
  })

  it('scales CSS embed bounds by host zoom and recomputes after zoom changes', async () => {
    manager.createInstance('embedded-zoom')
    manager.createInstance('embedded-zoom-second')
    const instance = (manager as any).instances.get('embedded-zoom')
    const secondInstance = (manager as any).instances.get('embedded-zoom-second')
    const hostWindow = createMockWindow({ width: 1200, height: 900 })
    hostWindow.webContents.id = 49
    hostWindow.webContents.setZoomFactor(1.5)

    manager.embedInHost('embedded-zoom', 49, { x: 20, y: 40, width: 600, height: 420 })
    manager.embedInHost('embedded-zoom-second', 49, { x: 300, y: 100, width: 200, height: 200 })
    expect(instance.pageView.setBounds).toHaveBeenLastCalledWith({ x: 30, y: 60, width: 900, height: 630 })
    expect(secondInstance.pageView.setBounds).toHaveBeenLastCalledWith({ x: 450, y: 150, width: 300, height: 300 })

    hostWindow.webContents.setZoomFactor(2)
    hostWindow.webContents._emit('zoom-changed', 'in')
    await Bun.sleep(10)

    expect(instance.pageView.setBounds).toHaveBeenLastCalledWith({ x: 40, y: 80, width: 1160, height: 820 })
    expect(secondInstance.pageView.setBounds).toHaveBeenLastCalledWith({ x: 600, y: 200, width: 400, height: 400 })
  })

  it('keeps embedded views attached when a host close is cancelled and detaches after it closes', () => {
    manager.createInstance('cancelled-host-close')
    const instance = (manager as any).instances.get('cancelled-host-close')
    const hostWindow = createMockWindow({ width: 1000, height: 700 })
    hostWindow.webContents.id = 44

    manager.embedInHost('cancelled-host-close', 44, { x: 20, y: 40, width: 600, height: 420 })
    hostWindow._emit('close', { preventDefault() {} })

    expect(instance.embeddedHostWindow).toBe(hostWindow)
    expect(hostWindow.removeBrowserView).not.toHaveBeenCalledWith(instance.pageView)

    hostWindow.isDestroyed.mockReturnValue(true)
    hostWindow._emit('closed')

    expect(instance.embeddedHostWindow).toBeNull()
    expect(instance.window.addBrowserView).toHaveBeenCalledWith(instance.pageView)
    expect(instance.window.addBrowserView).toHaveBeenCalledWith(instance.nativeOverlayView)
  })

  it('detaches every embedded view owned by one host before its workspace changes', () => {
    manager.createInstance('workspace-switch-a')
    manager.createInstance('workspace-switch-b')
    manager.createInstance('other-host')
    const first = (manager as any).instances.get('workspace-switch-a')
    const second = (manager as any).instances.get('workspace-switch-b')
    const other = (manager as any).instances.get('other-host')
    const hostWindow = createMockWindow({ width: 1200, height: 800 })
    const otherHostWindow = createMockWindow({ width: 1200, height: 800 })
    hostWindow.webContents.id = 45
    otherHostWindow.webContents.id = 46

    manager.embedInHost('workspace-switch-a', 45, { x: 0, y: 0, width: 600, height: 800 })
    manager.embedInHost('workspace-switch-b', 45, { x: 600, y: 0, width: 600, height: 800 })
    manager.embedInHost('other-host', 46, { x: 0, y: 0, width: 1200, height: 800 })

    manager.detachAllFromHost(45)

    expect(first.embeddedHostWindow).toBeNull()
    expect(second.embeddedHostWindow).toBeNull()
    expect(other.embeddedHostWindow).toBe(otherHostWindow)
  })

  it('centralizes exact workspace ownership checks and filtered listing', () => {
    manager.createInstance('browser-workspace-a', { workspaceId: 'workspace-a' })
    manager.createInstance('browser-workspace-b', { workspaceId: 'workspace-b' })
    manager.createInstance('browser-unscoped')

    expect(manager.listInstancesForWorkspace('workspace-a').map(item => item.id)).toEqual(['browser-workspace-a'])
    expect(manager.listInstancesForWorkspace(null).map(item => item.id)).toEqual(['browser-unscoped'])
    expect(() => manager.assertInstanceOwnedByWorkspace('browser-workspace-a', 'workspace-a')).not.toThrow()
    expect(() => manager.assertInstanceOwnedByWorkspace('browser-workspace-a', 'workspace-b'))
      .toThrow('Browser instance does not belong to the active workspace')
    expect(() => manager.assertInstanceOwnedByWorkspace('missing-browser', 'workspace-a'))
      .toThrow('Browser instance not found')
  })

  it('accepts only explicitly configured workspace aliases', () => {
    manager.createInstance('browser-local', { workspaceId: 'workspace-local' })
    manager.createInstance('browser-remote', { workspaceId: 'workspace-remote' })
    manager.createInstance('browser-foreign', { workspaceId: 'workspace-foreign' })

    const aliases = ['workspace-local', 'workspace-remote']
    expect(manager.listInstancesForWorkspaceAliases(aliases).map(item => item.id)).toEqual([
      'browser-local',
      'browser-remote',
    ])
    expect(() => manager.assertInstanceOwnedByWorkspaceAliases('browser-local', aliases)).not.toThrow()
    expect(() => manager.assertInstanceOwnedByWorkspaceAliases('browser-remote', aliases)).not.toThrow()
    expect(() => manager.assertInstanceOwnedByWorkspaceAliases('browser-foreign', aliases))
      .toThrow('Browser instance does not belong to the active workspace')
  })

  it('uploads files inside the instance workspace when its root is a symlink', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'craft-browser-upload-'))
    try {
      const targetRoot = join(sandbox, 'workspace-target')
      const linkedRoot = join(sandbox, 'workspace-root')
      const targetFile = join(targetRoot, 'inside.txt')
      await mkdir(targetRoot)
      await writeFile(targetFile, 'inside')
      await symlink(targetRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')

      workspaceAllowedDirs.set('workspace-upload', [linkedRoot])
      manager.createInstance('browser-upload', { workspaceId: 'workspace-upload' })
      const instance = (manager as any).instances.get('browser-upload')

      const result = await manager.uploadFile('browser-upload', '@upload', [join(linkedRoot, 'inside.txt')])
      const resolvedFile = await realpath(targetFile)

      expect(mockGetWorkspaceAllowedDirs).toHaveBeenCalledWith('workspace-upload')
      expect(instance.cdp.setFileInputFiles).toHaveBeenCalledWith('@upload', [resolvedFile])
      expect(result.ref).toBe('@upload')
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('rejects files in home or temp outside the instance workspace', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'craft-browser-upload-scope-'))
    try {
      const workspaceRoot = join(sandbox, 'workspace')
      const outsideTmpFile = join(sandbox, 'outside.txt')
      await mkdir(workspaceRoot)
      await writeFile(outsideTmpFile, 'outside')

      workspaceAllowedDirs.set('workspace-upload-scope', [workspaceRoot])
      manager.createInstance('browser-upload-scope', { workspaceId: 'workspace-upload-scope' })
      const instance = (manager as any).instances.get('browser-upload-scope')
      const outsideHomeFile = join(homedir(), `craft-browser-upload-outside-${process.pid}.txt`)

      await expect(manager.uploadFile('browser-upload-scope', '@upload', [outsideTmpFile]))
        .rejects.toThrow('Access denied')
      await expect(manager.uploadFile('browser-upload-scope', '@upload', [outsideHomeFile]))
        .rejects.toThrow('Access denied')
      expect(instance.cdp.setFileInputFiles).not.toHaveBeenCalled()
    } finally {
      await rm(sandbox, { recursive: true, force: true })
    }
  })

  it('rejects uploads from a browser instance without a workspace', async () => {
    manager.createInstance('browser-upload-unbound')
    const instance = (manager as any).instances.get('browser-upload-unbound')

    await expect(manager.uploadFile('browser-upload-unbound', '@upload', [join(tmpdir(), 'file.txt')]))
      .rejects.toThrow('Browser file upload requires a workspaceId')
    expect(mockGetWorkspaceAllowedDirs).not.toHaveBeenCalled()
    expect(instance.cdp.setFileInputFiles).not.toHaveBeenCalled()
  })

  it('allows http(s) popups with shared browser partition', () => {
    manager.createInstance('popup-allow')
    const instance = (manager as any).instances.get('popup-allow')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      disposition: 'new-popup',
      frameName: 'oauth-popup',
    })

    expect(result.action).toBe('allow')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.partition).toBe('persist:browser-pane')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.nodeIntegration).toBe(false)
    expect(result.overrideBrowserWindowOptions?.webPreferences?.contextIsolation).toBe(true)
  })

  it('denies app deep-link popups and forwards to deep-link handler', async () => {
    manager.createInstance('popup-deeplink')
    const instance = (manager as any).instances.get('popup-deeplink')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'craftagents://settings',
      disposition: 'new-popup',
      frameName: '',
    })

    expect(result).toEqual({ action: 'deny' })
    await Bun.sleep(0)
    expect(mockShellOpenExternal).toHaveBeenCalledWith('craftagents://settings')
  })

  it('destroys child popups when parent instance is destroyed', () => {
    manager.createInstance('popup-parent')
    const instance = (manager as any).instances.get('popup-parent')

    const popupWindow = createMockWindow({ width: 520, height: 720 })
    instance.pageView.webContents._emit('did-create-window', popupWindow, { url: 'https://accounts.google.com/signin' })

    expect((manager as any).popupWindowsByParentInstanceId.get('popup-parent')?.size).toBe(1)

    manager.destroyInstance('popup-parent')

    expect(popupWindow.destroy).toHaveBeenCalledTimes(1)
    expect((manager as any).popupWindowsByParentInstanceId.has('popup-parent')).toBe(false)
  })

  it('destroys instances', () => {
    manager.createInstance('d1')
    manager.destroyInstance('d1')
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('destroys instance via toolbar destroy IPC handler', async () => {
    manager.createInstance('d-ipc-destroy')
    manager.registerToolbarIpc()

    const destroyRegistration = (
      mockIpcMainHandle.mock.calls as unknown as Array<[
        string,
        (_event: unknown, instanceId: string) => Promise<void>,
      ]>
    ).find(([channel]) => channel === 'browser-toolbar:destroy')

    expect(destroyRegistration).toBeTruthy()
    if (!destroyRegistration) throw new Error('Expected browser-toolbar:destroy IPC registration')

    const [, destroyHandler] = destroyRegistration
    await destroyHandler({}, 'd-ipc-destroy')

    expect(manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback exactly once when destroy triggers closed', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))

    manager.createInstance('d-removed-once')
    manager.destroyInstance('d-removed-once')

    expect(removed).toEqual(['d-removed-once'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('ignores late state events after instance was removed', () => {
    const states: string[] = []
    manager.onStateChange((info) => states.push(info.id))

    manager.createInstance('d-late-state')
    const instance = (manager as any).instances.get('d-late-state')
    states.length = 0

    manager.destroyInstance('d-late-state')
    const countAfterDestroy = states.length

    instance.window._emit('hide')
    instance.window._emit('show')

    expect(states.length).toBe(countAfterDestroy)
  })

  it('binds and unbinds sessions', () => {
    manager.createInstance('b1')
    manager.bindSession('b1', 'session-abc')
    expect(manager.listInstances()[0].boundSessionId).toBe('session-abc')
    expect(manager.listInstances()[0].ownerType).toBe('session')

    manager.unbindSession('b1')
    expect(manager.listInstances()[0].boundSessionId).toBeNull()
    expect(manager.listInstances()[0].ownerType).toBe('manual')
  })

  it('createForSession returns canonical bound instance', () => {
    const id1 = manager.createForSession('sess-1')
    const id2 = manager.createForSession('sess-1')
    const info = manager.listInstances()[0]

    expect(id1).toBe(id2)
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-1')
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('getOrCreateForSession reuses existing instance', () => {
    const id1 = manager.getOrCreateForSession('sess-1')
    const id2 = manager.getOrCreateForSession('sess-1')
    expect(id1).toBe(id2)
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('createForSession reuses an unbound manual window before creating new', () => {
    manager.createInstance('manual-1')

    const id = manager.createForSession('sess-reuse')

    expect(id).toBe('manual-1')
    const info = manager.listInstances()[0]
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-reuse')
    expect(info.boundSessionId).toBe('sess-reuse')
    expect(manager.listInstances()).toHaveLength(1)
  })

  describe('workspaceId stamping', () => {
    it('createForSession with workspaceId stamps the field on a new instance', () => {
      const id = manager.createForSession('sess-ws', { workspaceId: 'ws-alpha' })
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBe('ws-alpha')
    })

    it('createForSession without workspaceId defaults to null', () => {
      const id = manager.createForSession('sess-plain')
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance with no options leaves workspaceId null (unbound window)', () => {
      manager.createInstance('manual-ws')
      const info = manager.listInstances().find((i) => i.id === 'manual-ws')
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance accepts workspaceId option (TopBar manual open)', () => {
      // The browser-pane CREATE handler passes ctx.workspaceId so TopBar-
      // opened windows stay scoped to the workspace the user clicked from,
      // rather than being broadcast to every workspace.
      manager.createInstance('manual-scoped', { workspaceId: 'ws-toolbar' })
      const info = manager.listInstances().find((i) => i.id === 'manual-scoped')
      expect(info?.workspaceId).toBe('ws-toolbar')
    })

    it('reusing an unbound manual window adopts the new binder workspace', () => {
      manager.createInstance('manual-reuse')
      expect(manager.listInstances().find((i) => i.id === 'manual-reuse')?.workspaceId).toBeNull()

      const id = manager.createForSession('sess-reuse-ws', { workspaceId: 'ws-beta' })
      expect(id).toBe('manual-reuse')

      const info = manager.listInstances().find((i) => i.id === 'manual-reuse')
      expect(info?.workspaceId).toBe('ws-beta')
      expect(info?.ownerSessionId).toBe('sess-reuse-ws')
    })

    it('bindSession with workspaceId overwrites the instance workspaceId', () => {
      manager.createInstance('bind-ws')
      manager.bindSession('bind-ws', 'sess-bound', { workspaceId: 'ws-gamma' })
      const info = manager.listInstances().find((i) => i.id === 'bind-ws')
      expect(info?.workspaceId).toBe('ws-gamma')
      expect(info?.boundSessionId).toBe('sess-bound')
    })

    it('setAgentControl backfills workspaceId when previously null', () => {
      // Legacy path: instance was created without a workspace, then the overlay
      // path supplies it. Backfill should stamp it.
      manager.createInstance('legacy-overlay')
      manager.bindSession('legacy-overlay', 'sess-legacy')
      manager.setAgentControl('sess-legacy', { displayName: 'browser_navigate' }, { workspaceId: 'ws-delta' })

      const info = manager.listInstances().find((i) => i.id === 'legacy-overlay')
      expect(info?.workspaceId).toBe('ws-delta')
    })

    it('toInfo emits workspaceId on the DTO', () => {
      manager.createForSession('sess-dto', { workspaceId: 'ws-epsilon' })
      const dto = manager.listInstances().find((i) => i.ownerSessionId === 'sess-dto')
      expect(dto).toBeDefined()
      expect(dto).toHaveProperty('workspaceId', 'ws-epsilon')
    })

    describe('cross-workspace reuse', () => {
      it('does NOT reuse an unbound session window from another workspace', () => {
        // Session in workspace A opens a window, then its turn ends — the
        // unbind path sets ownerType='manual' and clears boundSessionId, but
        // workspaceId stays = A. A session in workspace B asking for a window
        // must NOT pick it up; that would "move" the window across workspaces.
        const wsA = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a')

        // Sanity: instance is now unbound + manual but retains workspaceId=A.
        const after = manager.listInstances().find((i) => i.id === wsA)
        expect(after?.boundSessionId).toBeNull()
        expect(after?.ownerType).toBe('manual')
        expect(after?.workspaceId).toBe('ws-a')

        const wsB = manager.createForSession('sess-b', { workspaceId: 'ws-b' })
        expect(wsB).not.toBe(wsA)
        expect(manager.listInstances()).toHaveLength(2)

        // Workspace-A's window still belongs to A.
        const stillA = manager.listInstances().find((i) => i.id === wsA)
        expect(stillA?.workspaceId).toBe('ws-a')
      })

      it('DOES reuse an unbound window within the same workspace (next-turn case)', () => {
        // The legitimate same-workspace reuse: session-A ends a turn, leaves
        // an unbound window behind; the same workspace's session-A (or any
        // session in workspace A) should grab it on the next turn.
        const original = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a1')

        const reused = manager.createForSession('sess-a2', { workspaceId: 'ws-a' })
        expect(reused).toBe(original)
        expect(manager.listInstances()).toHaveLength(1)
      })

      it('lets any workspace adopt a truly unbound (workspaceId=null) manual window', () => {
        manager.createInstance('manual-anyworkspace')
        expect(manager.listInstances().find((i) => i.id === 'manual-anyworkspace')?.workspaceId).toBeNull()

        const adopted = manager.createForSession('sess-c', { workspaceId: 'ws-c' })
        expect(adopted).toBe('manual-anyworkspace')
        expect(manager.listInstances().find((i) => i.id === 'manual-anyworkspace')?.workspaceId).toBe('ws-c')
      })

      it('does NOT reuse a workspaceId=null unbound window when allowReuseManual=false', () => {
        // Remote-bridge dispatcher path: every lifecycle call passes
        // allowReuseManual=false so a stale window from before workspace
        // stamping (workspaceId=null) cannot get hijacked by a remote agent
        // for an unrelated workspace.
        manager.createInstance('legacy-unstamped')
        expect(manager.listInstances().find((i) => i.id === 'legacy-unstamped')?.workspaceId).toBeNull()

        const fresh = manager.createForSession('sess-d', {
          workspaceId: 'ws-d',
          allowReuseManual: false,
        })
        expect(fresh).not.toBe('legacy-unstamped')
        // Legacy window is left untouched.
        expect(manager.listInstances().find((i) => i.id === 'legacy-unstamped')?.workspaceId).toBeNull()
        // A new instance was created for the remote session.
        expect(manager.listInstances().find((i) => i.id === fresh)?.ownerSessionId).toBe('sess-d')
      })
    })
  })

  it('navigate normalizes hostnames to https', async () => {
    manager.createInstance('nav-1')
    await manager.navigate('nav-1', 'example.com')
    const instance = (manager as any).instances.get('nav-1')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith('https://example.com')
  })

  it('navigate treats plain text as search query', async () => {
    manager.createInstance('nav-2')
    await manager.navigate('nav-2', 'craft agents browser tools')
    const instance = (manager as any).instances.get('nav-2')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=craft%20agents%20browser%20tools'
    )
  })

  it('clears navigation timeout timer on success', async () => {
    manager.createInstance('nav-timeout')

    const originalClearTimeout = globalThis.clearTimeout
    const clearTimeoutSpy = mock((handle: Parameters<typeof clearTimeout>[0]) => originalClearTimeout(handle))
    ;(globalThis as any).clearTimeout = clearTimeoutSpy

    try {
      await manager.navigate('nav-timeout', 'https://example.com')
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      ;(globalThis as any).clearTimeout = originalClearTimeout
    }
  })

  it('focus brings the instance window to front', () => {
    manager.createInstance('f1')
    const instance = (manager as any).instances.get('f1')
    instance.toolbarReady = true

    manager.focus('f1')

    expect(instance.window.show).toHaveBeenCalled()
    expect(instance.window.focus).toHaveBeenCalled()
  })

  it('dedupes repeated focus calls before ready-to-show', () => {
    manager.createInstance('f2')

    manager.focus('f2')
    manager.focus('f2')
    manager.focus('f2')

    const instance = (manager as any).instances.get('f2')
    ;(manager as any).markToolbarReady(instance, 'test')

    expect(instance.window.show.mock.calls.length).toBe(1)
    expect(instance.window.focus.mock.calls.length).toBe(1)
  })

  it('cancels deferred pre-ready focus when hide happens first', () => {
    manager.createInstance('f-hide-race')

    manager.focus('f-hide-race')
    manager.hide('f-hide-race')

    const instance = (manager as any).instances.get('f-hide-race')
    const showCallsBeforeReady = instance.window.show.mock.calls.length
    const focusCallsBeforeReady = instance.window.focus.mock.calls.length

    ;(manager as any).markToolbarReady(instance, 'test')

    expect(instance.window.show.mock.calls.length).toBe(showCallsBeforeReady)
    expect(instance.window.focus.mock.calls.length).toBe(focusCallsBeforeReady)
  })

  it('user close hides window and keeps instance alive', () => {
    manager.createInstance('h1')
    const instance = (manager as any).instances.get('h1')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(manager.listInstances()).toHaveLength(1)
    expect(manager.listInstances()[0].isVisible).toBe(false)
  })

  it('does not intercept close when destroy is explicit', () => {
    manager.createInstance('h-explicit-destroy')
    const instance = (manager as any).instances.get('h-explicit-destroy')

    ;(manager as any).destroyingIds.add('h-explicit-destroy')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(instance.window.hide).not.toHaveBeenCalled()
  })

  it('still destroys instance when cleanup throws', () => {
    manager.createInstance('destroy-cleanup-throw')
    const instance = (manager as any).instances.get('destroy-cleanup-throw')

    ;(manager as any).updateNativeOverlayState = () => {
      throw new Error('mock overlay cleanup failure')
    }

    expect(() => manager.destroyInstance('destroy-cleanup-throw')).not.toThrow()
    expect(instance.window.destroy).toHaveBeenCalledTimes(1)
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback when window closes', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))
    manager.createInstance('r1')

    const instance = (manager as any).instances.get('r1')
    instance.window._emit('closed')

    expect(removed).toEqual(['r1'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('retries toolbar load and recovers', async () => {
    toolbarLoadFailuresRemaining = 2
    manager.createInstance('retry-toolbar')
    const instance = (manager as any).instances.get('retry-toolbar')

    const toolbarWebContents = instance.toolbarView.webContents
    for (let attempt = 0; attempt < 25; attempt++) {
      const observedAttempts = toolbarWebContents.loadFile.mock.calls.length
        + toolbarWebContents.loadURL.mock.calls
          .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
      if (observedAttempts >= 3) break
      await Bun.sleep(100)
    }

    const fileAttempts = toolbarWebContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWebContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(3)
    expect(toolbarWebContents.loadURL).not.toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('loads toolbar fallback page after retry exhaustion', async () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('fallback-toolbar')
    const instance = (manager as any).instances.get('fallback-toolbar')

    await Bun.sleep(3200)

    const toolbarWebContents = instance.toolbarView.webContents
    const fileAttempts = toolbarWebContents.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWebContents.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(5)
    expect(toolbarWebContents.loadURL).toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('captures and filters console entries', () => {
    manager.createInstance('console-1')
    const instance = (manager as any).instances.get('console-1')

    instance.pageView.webContents._emit('console-message', 2, 'warn message')
    instance.pageView.webContents._emit('console-message', 3, 'error message')

    const allEntries = manager.getConsoleLogs('console-1', { level: 'all', limit: 10 })
    expect(allEntries).toHaveLength(2)

    const warnEntries = manager.getConsoleLogs('console-1', { level: 'warn', limit: 10 })
    expect(warnEntries).toHaveLength(1)
    expect(warnEntries[0].message).toBe('warn message')
  })

  it('applies observer theme signal and skips regular console logging for it', () => {
    manager.createInstance('theme-signal')
    const instance = (manager as any).instances.get('theme-signal')
    instance.themeObserverToken = 'tok-1'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-1:#123456')

    expect(manager.listInstances().find(i => i.id === 'theme-signal')?.themeColor).toBe('#123456')
    expect(manager.getConsoleLogs('theme-signal', { level: 'all', limit: 10 })).toHaveLength(0)
  })

  it('dedupes repeated observer theme signals', () => {
    manager.createInstance('theme-dedupe')
    const instance = (manager as any).instances.get('theme-dedupe')
    instance.themeObserverToken = 'tok-2'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterFirst = instance.window.webContents.send.mock.calls.length

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-2:#445566')
    const sendCallsAfterSecond = instance.window.webContents.send.mock.calls.length

    expect(sendCallsAfterSecond).toBe(sendCallsAfterFirst)
  })

  it('ignores observer theme signals from stale token', () => {
    manager.createInstance('theme-stale-token')
    const instance = (manager as any).instances.get('theme-stale-token')
    instance.themeObserverToken = 'tok-current'
    instance.themeColor = '#aaaaaa'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-old:#bbccdd')

    expect(manager.listInstances().find(i => i.id === 'theme-stale-token')?.themeColor).toBe('#aaaaaa')
  })

  it('clears theme on explicit null sentinel signal', () => {
    manager.createInstance('theme-null')
    const instance = (manager as any).instances.get('theme-null')
    instance.themeObserverToken = 'tok-null'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:#223344')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBe('#223344')

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-null:__NULL__')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBeNull()
  })

  it('replays toolbar state with theme color when window is shown', () => {
    manager.createInstance('theme-show-replay')
    const instance = (manager as any).instances.get('theme-show-replay')

    instance.currentUrl = 'https://example.com'
    instance.title = 'Example'
    instance.canGoBack = true
    instance.canGoForward = false
    instance.themeColor = '#123456'

    const sendsBeforeShow = instance.toolbarView.webContents.send.mock.calls.length
    instance.window._emit('show')

    const sendCallsAfterShow = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeShow)
    expect(sendCallsAfterShow).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://example.com',
        title: 'Example',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
        themeColor: '#123456',
      },
    ])
  })

  it('replays full toolbar state when toolbar renderer finishes loading', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-finish-load-replay')
    const instance = (manager as any).instances.get('toolbar-finish-load-replay')

    instance.currentUrl = 'https://craft.do'
    instance.title = 'Craft'
    instance.isLoading = true
    instance.canGoBack = true
    instance.canGoForward = true
    instance.themeColor = '#654321'

    instance.toolbarView.webContents.getURL = mock(() => 'http://localhost:5173/browser-toolbar.html?instanceId=toolbar-finish-load-replay')

    const sendsBeforeFinishLoad = instance.toolbarView.webContents.send.mock.calls.length
    instance.toolbarView.webContents._emit('did-finish-load')

    const sendCallsAfterFinishLoad = instance.toolbarView.webContents.send.mock.calls.slice(sendsBeforeFinishLoad)
    expect(sendCallsAfterFinishLoad).toContainEqual([
      'browser-toolbar:state-update',
      {
        url: 'https://craft.do',
        title: 'Craft',
        isLoading: true,
        canGoBack: true,
        canGoForward: true,
        themeColor: '#654321',
      },
    ])
  })

  it('does not mark toolbar ready for about:blank did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-ignore-about-blank')
    const instance = (manager as any).instances.get('toolbar-ignore-about-blank')

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(false)
  })

  it('marks toolbar ready for fallback data page did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-fallback-ready')
    const instance = (manager as any).instances.get('toolbar-fallback-ready')

    instance.toolbarView.webContents.getURL = mock(() => 'data:text/html;charset=UTF-8,%3Chtml%3E%3C%2Fhtml%3E')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
  })

  it('keeps focus deferred until a valid toolbar document loads', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-focus-guard')
    const instance = (manager as any).instances.get('toolbar-focus-guard')

    manager.focus('toolbar-focus-guard')
    expect(instance.pendingShowOnReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).toHaveBeenCalledTimes(1)
  })

  it('runs early theme extraction shortly after navigation', async () => {
    manager.createInstance('theme-early')
    const instance = (manager as any).instances.get('theme-early')
    instance.pageView.webContents.executeJavaScript = mock(async () => '#0f1e2d')

    instance.pageView.webContents._emit('did-navigate', 'https://example.com')

    await Bun.sleep(140)

    expect(manager.listInstances().find(i => i.id === 'theme-early')?.themeColor).toBe('#0f1e2d')
  })

  it('clears pending in-page theme timer on full navigation', async () => {
    manager.createInstance('theme-timer-clear')
    const instance = (manager as any).instances.get('theme-timer-clear')

    instance.pageView.webContents._emit('did-navigate-in-page', 'https://example.com/route-a')
    await Bun.sleep(0)
    expect(instance.inPageThemeTimer).not.toBeNull()

    instance.pageView.webContents._emit('did-navigate', 'https://example.com/full-nav')
    expect(instance.inPageThemeTimer).toBeNull()
  })

  it('throws when screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('screenshot-empty-image')
    const instance = (manager as any).instances.get('screenshot-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshot('screenshot-empty-image')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('throws when screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('screenshot-empty-png')
    const instance = (manager as any).instances.get('screenshot-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshot('screenshot-empty-png')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('recovers screenshot via non-disruptive inactive reveal and restores hidden state', async () => {
    manager.createInstance('screenshot-rescue-success')
    const instance = (manager as any).instances.get('screenshot-rescue-success')

    let captureCalls = 0
    instance.pageView.webContents.capturePage = mock(async () => {
      captureCalls += 1
      if (captureCalls <= 3) {
        return {
          isEmpty: () => true,
          getSize: () => ({ width: 0, height: 0 }),
          resize: function() { return this },
          toPNG: () => Buffer.alloc(0),
          toJPEG: () => Buffer.alloc(0),
        }
      }

      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: () => img,
        toPNG: () => Buffer.from('rescued-png'),
        toJPEG: (_q: number) => Buffer.from('rescued-jpeg'),
      }
      return img
    })

    const result = await manager.screenshot('screenshot-rescue-success', { includeMetadata: true })

    expect(result.imageBuffer.toString()).toBe('rescued-png')
    expect(instance.window.showInactive).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).not.toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(result.metadata?.warnings?.some((w: string) => w.includes('temporary inactive reveal'))).toBe(true)
  })

  it('throws when region screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('region-empty-image')
    const instance = (manager as any).instances.get('region-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshotRegion('region-empty-image', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('throws when region screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('region-empty-png')
    const instance = (manager as any).instances.get('region-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshotRegion('region-empty-png', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('captures screenshot region from ref target', async () => {
    manager.createInstance('region-ref')
    const result = await manager.screenshotRegion('region-ref', { ref: '@e1' })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('ref')
  })

  it('captures screenshot region from selector target', async () => {
    manager.createInstance('region-selector')
    const result = await manager.screenshotRegion('region-selector', { selector: 'div.card', padding: 4 })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('selector')
  })

  it('throws for ambiguous screenshot region target modes', async () => {
    manager.createInstance('region-ambiguous')

    await expect(
      manager.screenshotRegion('region-ambiguous', { ref: '@e1', selector: 'div.card' })
    ).rejects.toThrow('Region screenshot target is ambiguous')
  })

  it('throws when selector target cannot be resolved', async () => {
    manager.createInstance('region-selector-missing')
    const instance = (manager as any).instances.get('region-selector-missing')
    instance.cdp.getElementGeometryBySelector = mock(async () => {
      throw new Error('No element found for selector "div.missing"')
    })

    await expect(
      manager.screenshotRegion('region-selector-missing', { selector: 'div.missing' })
    ).rejects.toThrow('No element found for selector "div.missing"')
  })

  it('throws when resolved region is outside viewport', async () => {
    manager.createInstance('region-oob')

    await expect(
      manager.screenshotRegion('region-oob', { x: 5000, y: 5000, width: 100, height: 100 })
    ).rejects.toThrow('Resolved screenshot region is outside the current viewport')
  })

  it('resizes browser window viewport and returns effective applied size', () => {
    manager.createInstance('resize-1')
    const resized = manager.windowResize('resize-1', 1280, 720)

    const instance = (manager as any).instances.get('resize-1')
    expect(instance.window.setContentSize).toHaveBeenCalledWith(1280, 768)
    expect(resized).toEqual({ width: 1280, height: 720 })
  })

  it('returns effective viewport size when min window constraints apply', () => {
    manager.createInstance('resize-min')
    const resized = manager.windowResize('resize-min', 200, 200)

    // BrowserWindow minHeight is 500, toolbar is 48, so effective viewport height is 452.
    expect(resized).toEqual({ width: 700, height: 452 })
  })

  describe('agent control overlay', () => {
    it('setAgentControl activates native overlay on bound instance', async () => {
      manager.createInstance('ac-1')
      manager.bindSession('ac-1', 'sess-1')

      manager.setAgentControl('sess-1', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-1')
      expect(instance.agentControl).toEqual({
        active: true,
        sessionId: 'sess-1',
        displayName: 'Navigate Page',
        intent: 'Loading example.com',
      })
      expect(instance.nativeOverlayView.webContents.executeJavaScript).toHaveBeenCalled()
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-1')?.agentControlActive).toBe(true)
    })

    it('keeps native overlay visible for active session control', async () => {
      manager.createInstance('ac-idle')
      manager.bindSession('ac-idle', 'sess-idle')

      manager.setAgentControl('sess-idle', {
        displayName: 'Browser',
        intent: 'Session controls this window',
      })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-idle')
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 48, width: 1200, height: 852 })
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-idle')?.agentControlActive).toBe(true)
    })

    it('emits state change when agent control is set and cleared', () => {
      const stateEvents: any[] = []
      manager.onStateChange((info) => stateEvents.push(info))

      manager.createInstance('ac-state')
      manager.bindSession('ac-state', 'sess-state')

      manager.setAgentControl('sess-state', { displayName: 'Browser Snapshot' })
      manager.clearAgentControl('sess-state')

      const acStateEvents = stateEvents.filter((event) => event.id === 'ac-state')
      expect(acStateEvents.some((event) => event.agentControlActive === true)).toBe(true)
      expect(acStateEvents.some((event) => event.agentControlActive === false)).toBe(true)
    })

    it('reapplies native overlay after did-stop-loading while control is active', async () => {
      manager.createInstance('ac-reapply')
      manager.bindSession('ac-reapply', 'sess-reapply')

      manager.setAgentControl('sess-reapply', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.pageView.webContents._emit('did-stop-loading')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('reapplies native overlay after hide/show while control is active', async () => {
      manager.createInstance('ac-show-reapply')
      manager.bindSession('ac-show-reapply', 'sess-show-reapply')

      manager.setAgentControl('sess-show-reapply', { displayName: 'Click Button', intent: 'Clicking submit' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-show-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.window._emit('hide')
      instance.window._emit('show')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('setAgentControl uses fallback label when no intent', async () => {
      manager.createInstance('ac-2')
      manager.bindSession('ac-2', 'sess-2')

      manager.setAgentControl('sess-2', { displayName: 'Browser Snapshot' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-2')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Browser Snapshot')
    })

    it('setAgentControl uses default label when no metadata', async () => {
      manager.createInstance('ac-3')
      manager.bindSession('ac-3', 'sess-3')

      manager.setAgentControl('sess-3', {})
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-3')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Agent is working…')
    })

    it('clearAgentControl dismisses native overlay', () => {
      manager.createInstance('ac-4')
      manager.bindSession('ac-4', 'sess-4')

      manager.setAgentControl('sess-4', { displayName: 'Click Button', intent: 'Clicking submit' })
      manager.clearAgentControl('sess-4')

      const instance = (manager as any).instances.get('ac-4')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('clearAgentControl is a no-op when not active', () => {
      manager.createInstance('ac-5')
      manager.bindSession('ac-5', 'sess-5')

      manager.clearAgentControl('sess-5')

      const instance = (manager as any).instances.get('ac-5')
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('clearVisualsForSession resets agent control state', async () => {
      manager.createInstance('ac-6')
      manager.bindSession('ac-6', 'sess-6')

      manager.setAgentControl('sess-6', { displayName: 'Fill Input', intent: 'Typing email' })
      await manager.clearVisualsForSession('sess-6')

      const instance = (manager as any).instances.get('ac-6')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('setAgentControl ignores unbound sessions', () => {
      manager.createInstance('ac-7')

      manager.setAgentControl('nonexistent-session', { displayName: 'Test' })

      const instance = (manager as any).instances.get('ac-7')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('navigate does not trigger overlay by itself', async () => {
      manager.createInstance('ac-8')
      manager.bindSession('ac-8', 'sess-8')

      await manager.navigate('ac-8', 'https://example.com')

      const instance = (manager as any).instances.get('ac-8')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })
  })

  describe('failed interaction tracking', () => {
    it('clickElement records failed lastAction on error', async () => {
      manager.createInstance('fail-click')
      const instance = (manager as any).instances.get('fail-click')
      instance.cdp.clickElement = mock(async () => { throw new Error('click failed') })

      await expect(manager.clickElement('fail-click', '@e1')).rejects.toThrow('click failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_click',
        ref: '@e1',
        status: 'failed',
      })
    })

    it('fillElement records failed lastAction on error', async () => {
      manager.createInstance('fail-fill')
      const instance = (manager as any).instances.get('fail-fill')
      instance.cdp.fillElement = mock(async () => { throw new Error('fill failed') })

      await expect(manager.fillElement('fail-fill', '@e2', 'hello')).rejects.toThrow('fill failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_fill',
        ref: '@e2',
        status: 'failed',
      })
    })

    it('selectOption records failed lastAction on error', async () => {
      manager.createInstance('fail-select')
      const instance = (manager as any).instances.get('fail-select')
      instance.cdp.selectOption = mock(async () => { throw new Error('select failed') })

      await expect(manager.selectOption('fail-select', '@e3', 'opt-1')).rejects.toThrow('select failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_select',
        ref: '@e3',
        status: 'failed',
      })
    })
  })
})
