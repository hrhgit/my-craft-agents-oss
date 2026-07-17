import type { BrowserWindow } from 'electron'
import type { WindowManager } from '../window-manager'

export type ElectronUiWindowMode = 'foreground' | 'background'

export function parseElectronUiWindowMode(value: string | undefined): ElectronUiWindowMode {
  if (value === undefined || value === 'foreground') return 'foreground'
  if (value === 'background') return 'background'
  throw new Error('CRAFT_UI_WINDOW_MODE must be foreground or background.')
}

/** Keeps source-development test windows minimized without affecting production windows. */
export class ElectronBackgroundWindowController {
  private readonly cleanups = new Map<number, () => void>()

  constructor(private readonly windowManager: WindowManager) {
    this.refresh()
  }

  refresh(): void {
    const liveIds = new Set<number>()
    for (const { window } of this.windowManager.getAllWindows()) {
      if (window.isDestroyed()) continue
      const id = window.webContents.id
      liveIds.add(id)
      if (!this.cleanups.has(id)) this.track(window)
      this.enforce(window)
    }
    for (const [id, cleanup] of this.cleanups) {
      if (liveIds.has(id)) continue
      cleanup()
      this.cleanups.delete(id)
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups.values()) cleanup()
    this.cleanups.clear()
  }

  private track(window: BrowserWindow): void {
    const enforce = () => this.enforce(window)
    window.on('show', enforce)
    window.on('restore', enforce)
    window.on('focus', enforce)
    this.cleanups.set(window.webContents.id, () => {
      window.removeListener('show', enforce)
      window.removeListener('restore', enforce)
      window.removeListener('focus', enforce)
    })
  }

  private enforce(window: BrowserWindow): void {
    if (window.isDestroyed() || window.isMinimized()) return
    if (window.isVisible() || window.isFocused()) window.minimize()
  }
}
