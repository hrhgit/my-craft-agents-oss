import type { BrowserWindow } from 'electron'
import { ElectronUiDriverError } from './electron-surface-driver'
import type { WindowsNativeNode, WindowsNativeSnapshot, WindowsNativeUiDriver } from './windows-native-driver'

export interface NativeWindowReadyResult {
  snapshot: WindowsNativeSnapshot
  node: WindowsNativeNode
}

/** Make the selected Electron window eligible for Windows UI Automation before querying it. */
export async function ensureNativeWindowReady(
  window: BrowserWindow,
  driver: WindowsNativeUiDriver,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<NativeWindowReadyResult> {
  if (window.isDestroyed()) throw new ElectronUiDriverError('WINDOW_GONE', 'Renderer window no longer exists.')
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()

  const expectedTitle = window.getTitle()
  return await driver.waitForNode(node =>
    node.role === 'Window' && (expectedTitle.length === 0 || node.name === expectedTitle),
  options)
}
