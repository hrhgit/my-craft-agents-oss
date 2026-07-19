import type { BrowserWindow } from 'electron'
import type { WindowManager } from '../window-manager'

export type ElectronUiWindowMode = 'foreground' | 'background'

export function parseElectronUiWindowMode(value: string | undefined): ElectronUiWindowMode {
  if (value === undefined || value === 'background') return 'background'
  if (value === 'foreground') return 'foreground'
  throw new Error('MORTISE_UI_WINDOW_MODE must be foreground or background.')
}

interface TrackedBackgroundWindow {
  cleanup: () => void
  userForeground: boolean
}

/** Starts source-development test windows minimized, then yields to an explicit user restore. */
export class ElectronBackgroundWindowController {
  private readonly trackedWindows = new Map<number, TrackedBackgroundWindow>()

  constructor(private readonly windowManager: WindowManager) {
    this.refresh()
  }

  refresh(): void {
    const liveIds = new Set<number>()
    for (const { window } of this.windowManager.getAllWindows()) {
      if (window.isDestroyed()) continue
      const id = window.webContents.id
      liveIds.add(id)
      const tracked = this.trackedWindows.get(id) ?? this.track(window)
      if (!tracked.userForeground) this.enforce(window)
    }
    for (const [id, tracked] of this.trackedWindows) {
      if (liveIds.has(id)) continue
      tracked.cleanup()
      this.trackedWindows.delete(id)
    }
  }

  hasUserForegroundControl(window: BrowserWindow): boolean {
    return this.trackedWindows.get(window.webContents.id)?.userForeground === true
  }

  dispose(): void {
    for (const tracked of this.trackedWindows.values()) tracked.cleanup()
    this.trackedWindows.clear()
  }

  private track(window: BrowserWindow): TrackedBackgroundWindow {
    const tracked: TrackedBackgroundWindow = {
      cleanup: () => undefined,
      userForeground: false,
    }
    const enforce = () => {
      if (!tracked.userForeground) this.enforce(window)
    }
    const releaseToUser = () => {
      tracked.userForeground = true
    }
    window.on('show', enforce)
    window.on('focus', enforce)
    window.on('restore', releaseToUser)
    tracked.cleanup = () => {
      window.removeListener('show', enforce)
      window.removeListener('focus', enforce)
      window.removeListener('restore', releaseToUser)
    }
    this.trackedWindows.set(window.webContents.id, tracked)
    return tracked
  }

  private enforce(window: BrowserWindow): void {
    if (window.isDestroyed() || window.isMinimized()) return
    if (window.isVisible() || window.isFocused()) window.minimize()
  }
}
