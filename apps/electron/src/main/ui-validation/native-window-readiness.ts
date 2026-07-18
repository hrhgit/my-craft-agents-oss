import type { BrowserWindow } from 'electron'
import { ElectronUiDriverError } from './electron-surface-driver'
import type { ElectronUiWindowMode } from './background-window-mode'
import type {
  WindowsNativeActionReceipt,
  WindowsNativeActionRequest,
  WindowsNativeNode,
  WindowsNativeSnapshot,
  WindowsNativeUiDriver,
} from './windows-native-driver'

export interface NativeWindowReadyResult {
  snapshot: WindowsNativeSnapshot
  node: WindowsNativeNode
}

export interface NativeWindowStatus {
  available: boolean
  ready: boolean
  verified: boolean
  reason: 'ready' | 'background-ready' | 'unsupported-platform' | 'window-not-selected' | 'window-gone' | 'window-hidden' | 'window-minimized' | 'window-not-minimized' | 'uia-not-verified'
  windowMode: ElectronUiWindowMode
  webContentsId?: number
  visible?: boolean
  focused?: boolean
  minimized?: boolean
  rendererLoading?: boolean
}

type NativeDriverStatePhase = 'loading' | 'ready' | 'error' | 'disposed'
type NativeDriverStatePublisher = (webContentsId: number, phase: NativeDriverStatePhase, detail: Record<string, unknown>) => void

export class ElectronNativeWindowController {
  private readonly verifiedWindows = new Map<number, string>()
  private operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly driver: WindowsNativeUiDriver,
    private readonly publishState: NativeDriverStatePublisher = () => undefined,
    private readonly windowMode: ElectronUiWindowMode = 'foreground',
  ) {}

  available(): boolean {
    return this.driver.available()
  }

  reveal(window: BrowserWindow, options: { focus?: boolean } = {}): void {
    revealNativeWindow(window, options)
  }

  status(window?: BrowserWindow): NativeWindowStatus {
    const mode = { windowMode: this.windowMode }
    if (!this.available()) return { ...mode, available: false, ready: false, verified: false, reason: 'unsupported-platform' }
    if (!window) return { ...mode, available: true, ready: false, verified: false, reason: 'window-not-selected' }
    if (window.isDestroyed()) return { ...mode, available: true, ready: false, verified: false, reason: 'window-gone' }

    const webContentsId = window.webContents.id
    const visible = window.isVisible()
    const focused = window.isFocused()
    const minimized = window.isMinimized()
    const rendererLoading = window.webContents.isLoading()
    const verified = this.verifiedWindows.has(webContentsId)
    const shared = { ...mode, available: true, webContentsId, visible, focused, minimized, rendererLoading, verified }
    if (this.windowMode === 'background') {
      if (!minimized) return { ...shared, ready: false, reason: visible ? 'window-not-minimized' : 'window-hidden' }
      if (!verified) return { ...shared, ready: false, reason: 'uia-not-verified' }
      return { ...shared, ready: true, reason: 'background-ready' }
    }
    if (minimized) return { ...shared, ready: false, reason: 'window-minimized' }
    if (!visible) return { ...shared, ready: false, reason: 'window-hidden' }
    if (!verified) return { ...shared, ready: false, reason: 'uia-not-verified' }
    return { ...shared, ready: true, reason: 'ready' }
  }

  async ensure(
    window: BrowserWindow,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<NativeWindowReadyResult> {
    return await this.withReadyWindow(window, options, ready => ready)
  }

  async withReadyWindow<T>(
    window: BrowserWindow,
    options: { timeoutMs?: number; signal?: AbortSignal },
    operation: (ready: NativeWindowReadyResult) => Promise<T> | T,
  ): Promise<T> {
    return await this.runExclusive(async () => operation(await this.ensureNow(window, options)))
  }

  async snapshot(
    window: BrowserWindow,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<WindowsNativeSnapshot> {
    return await this.withReadyWindow(window, options, ready => ready.snapshot)
  }

  async action(
    window: BrowserWindow,
    request: WindowsNativeActionRequest,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<WindowsNativeActionReceipt> {
    return await this.runExclusive(async () => {
      if (!this.status(window).ready) await this.ensureNow(window, options)
      const target = this.driver.resolvePublishedTarget(request)
      if (this.windowMode === 'background') {
        if (!target.backgroundActions.some(action => action === request.action)) {
          throw new ElectronUiDriverError(
            'UNSUPPORTED',
            `${request.action} requires a foreground window and is unavailable in background mode.`,
            { windowMode: this.windowMode, action: request.action },
          )
        }
      }
      const receipt = await this.driver.action(request)
      return this.windowMode === 'background'
        ? { ...receipt, warnings: [...receipt.warnings, 'Background UIA pattern operation has no foreground hit-test evidence.'] }
        : receipt
    })
  }

  private async ensureNow(
    window: BrowserWindow,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<NativeWindowReadyResult> {
    const webContentsId = window.webContents.id
    this.publishState(webContentsId, 'loading', this.stateDetail(window, false))
    try {
      const ready = await ensureNativeWindowReady(window, this.driver, { ...options, windowMode: this.windowMode })
      this.verifiedWindows.set(webContentsId, ready.node.runtimeId)
      this.publishState(webContentsId, 'ready', this.stateDetail(window, true, ready.node.runtimeId))
      return ready
    } catch (error) {
      this.verifiedWindows.delete(webContentsId)
      this.publishState(webContentsId, window.isDestroyed() ? 'disposed' : 'error', {
        ...this.stateDetail(window, false),
        errorCode: error instanceof ElectronUiDriverError ? error.code : 'DRIVER_DISCONNECTED',
      })
      throw error
    }
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail
    let release: (() => void) | undefined
    this.operationTail = new Promise<void>(resolve => { release = resolve })
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release?.()
    }
  }

  private stateDetail(window: BrowserWindow, verified: boolean, runtimeId?: string): Record<string, unknown> {
    return {
      available: this.available(),
      windowMode: this.windowMode,
      verified,
      destroyed: window.isDestroyed(),
      visible: !window.isDestroyed() && window.isVisible(),
      focused: !window.isDestroyed() && window.isFocused(),
      minimized: !window.isDestroyed() && window.isMinimized(),
      rendererLoading: !window.isDestroyed() && window.webContents.isLoading(),
      ...(runtimeId ? { runtimeId } : {}),
    }
  }
}

export function revealNativeWindow(window: BrowserWindow, options: { focus?: boolean } = {}): void {
  if (window.isDestroyed()) throw new ElectronUiDriverError('WINDOW_GONE', 'Renderer window no longer exists.')
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) {
    if (options.focus === false) window.showInactive()
    else window.show()
  }
  if (options.focus !== false) window.focus()
}

/** Make the selected Electron window eligible for Windows UI Automation before querying it. */
export async function ensureNativeWindowReady(
  window: BrowserWindow,
  driver: WindowsNativeUiDriver,
  options: { timeoutMs?: number; signal?: AbortSignal; windowMode?: ElectronUiWindowMode } = {},
): Promise<NativeWindowReadyResult> {
  const windowMode = options.windowMode ?? 'foreground'
  if (windowMode === 'foreground') {
    revealNativeWindow(window)
  } else {
    if (window.isDestroyed()) throw new ElectronUiDriverError('WINDOW_GONE', 'Renderer window no longer exists.')
    if (!window.isMinimized()) {
      throw new ElectronUiDriverError('NOT_READY', 'Background native validation requires the selected window to remain minimized.', { windowMode })
    }
  }

  const expectedTitle = window.getTitle()
  const expectedBounds = window.getBounds()
  const expectedNativeWindowHandle = getNativeWindowHandle(window)
  const ready = await driver.waitForNode(node => matchesSelectedWindow(node, {
    expectedTitle,
    expectedBounds,
    expectedNativeWindowHandle,
    windowMode,
  }), options)
  const snapshot = snapshotForWindowMode(ready.snapshot, windowMode)
  const node = snapshot.windows.flatMap(entry => entry.nodes).find(candidate => candidate.runtimeId === ready.node.runtimeId)
  if (!node) throw new ElectronUiDriverError('DRIVER_DISCONNECTED', 'Selected native window disappeared while applying the run window mode.')
  return { snapshot, node }
}

function matchesSelectedWindow(
  node: WindowsNativeNode,
  expected: {
    expectedTitle: string
    expectedBounds: { x: number; y: number; width: number; height: number }
    expectedNativeWindowHandle?: number
    windowMode: ElectronUiWindowMode
  },
): boolean {
  if (node.role !== 'Window') return false
  if (expected.expectedTitle.length > 0 && node.name !== expected.expectedTitle) return false
  if (expected.windowMode === 'foreground' && !node.focused) return false
  if (expected.expectedNativeWindowHandle !== undefined && node.nativeWindowHandle !== undefined) {
    return node.nativeWindowHandle === expected.expectedNativeWindowHandle
  }
  return expected.windowMode === 'background' || matchesWindowBounds(expected.expectedBounds, node.bounds)
}

function snapshotForWindowMode(snapshot: WindowsNativeSnapshot, windowMode: ElectronUiWindowMode): WindowsNativeSnapshot {
  return {
    ...snapshot,
    windowMode,
    windows: snapshot.windows.map(window => ({
      ...window,
      nodes: window.nodes.map(node => ({
        ...node,
        actions: windowMode === 'background' ? [...node.backgroundActions] : node.actions,
      })),
    })),
  }
}

function getNativeWindowHandle(window: BrowserWindow): number | undefined {
  if (typeof window.getNativeWindowHandle !== 'function') return undefined
  const buffer = window.getNativeWindowHandle()
  if (buffer.length >= 8) {
    const value = Number(buffer.readBigUInt64LE(0))
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }
  if (buffer.length >= 4) {
    const value = buffer.readUInt32LE(0)
    return value > 0 ? value : undefined
  }
  return undefined
}

function matchesWindowBounds(
  electron: { x: number; y: number; width: number; height: number },
  native?: { x: number; y: number; width: number; height: number },
): boolean {
  if (!native || electron.width <= 0 || electron.height <= 0 || native.width <= 0 || native.height <= 0) return true
  const scaleX = native.width / electron.width
  const scaleY = native.height / electron.height
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || Math.abs(scaleX - scaleY) > 0.15) return false
  const scale = (scaleX + scaleY) / 2
  const tolerance = Math.max(32, Math.max(native.width, native.height) * 0.03)
  return Math.abs(native.x - electron.x * scale) <= tolerance
    && Math.abs(native.y - electron.y * scale) <= tolerance
    && Math.abs(native.width - electron.width * scale) <= tolerance
    && Math.abs(native.height - electron.height * scale) <= tolerance
}
