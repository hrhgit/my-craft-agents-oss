import { ElectronUiDriverError } from './electron-surface-driver'
import { UI_VALIDATION_DEFAULT_TIMEOUT_MS, UI_VALIDATION_MAX_WAIT_MS } from '@craft-agent/shared/ui-validation'

interface RendererNavigationWebContents {
  getURL(): string
  isLoadingMainFrame(): boolean
  isDestroyed(): boolean
  on(event: 'did-finish-load', listener: () => void): unknown
  on(event: 'did-stop-loading', listener: () => void): unknown
  on(event: 'did-fail-load', listener: (event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => void): unknown
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'did-finish-load', listener: () => void): unknown
  removeListener(event: 'did-stop-loading', listener: () => void): unknown
  removeListener(event: 'did-fail-load', listener: (event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

export interface RendererNavigationWindow {
  isDestroyed(): boolean
  loadURL(url: string): Promise<void>
  webContents: RendererNavigationWebContents
}

export function rendererPageUrl(current: string, page: 'index.html' | 'playground.html'): URL {
  const url = new URL(current)
  if (url.protocol !== 'file:' && url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ElectronUiDriverError('UNSUPPORTED', 'Current renderer URL cannot host scenarios.')
  }
  url.pathname = url.pathname.replace(/[^/]*$/, page)
  // Query and hash state belong to the old renderer page. Callers add only target-owned parameters.
  url.search = ''
  url.hash = ''
  return url
}

export async function loadRendererTarget(
  window: RendererNavigationWindow,
  targetUrl: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? UI_VALIDATION_DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > UI_VALIDATION_MAX_WAIT_MS) {
    throw new ElectronUiDriverError('INVALID_REQUEST', `Renderer navigation timeout must be between 1 and ${UI_VALIDATION_MAX_WAIT_MS}ms.`)
  }
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    throw new ElectronUiDriverError('WINDOW_GONE', 'Renderer window no longer exists.')
  }
  const deadline = Date.now() + timeoutMs
  await waitForCurrentNavigation(window, timeoutMs, options.signal)
  const remainingMs = Math.max(1, deadline - Date.now())
  const target = normalizedUrl(targetUrl)
  if (normalizedUrl(window.webContents.getURL()) === target && !window.webContents.isLoadingMainFrame()) return

  await new Promise<void>((resolveNavigation, rejectNavigation) => {
    let settled = false
    const finish = () => {
      if (normalizedUrl(window.webContents.getURL()) !== target) return
      cleanup()
      resolveNavigation()
    }
    const fail = (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
      if (!isMainFrame || normalizedUrl(validatedURL) !== target) return
      cleanup()
      rejectNavigation(new ElectronUiDriverError('DRIVER_DISCONNECTED', `Renderer target failed to load: ${errorDescription || errorCode}.`, {
        errorCode,
        targetUrl: target,
      }))
    }
    const destroyed = () => {
      cleanup()
      rejectNavigation(new ElectronUiDriverError('WINDOW_GONE', 'Renderer window was destroyed during navigation.'))
    }
    const aborted = () => {
      cleanup()
      rejectNavigation(new ElectronUiDriverError('DRIVER_DISCONNECTED', 'Renderer navigation was aborted.'))
    }
    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', aborted)
      window.webContents.removeListener('did-finish-load', finish)
      window.webContents.removeListener('did-fail-load', fail)
      window.webContents.removeListener('destroyed', destroyed)
    }
    const timeout = setTimeout(() => {
      cleanup()
      rejectNavigation(new ElectronUiDriverError('TIMEOUT', `Renderer target did not settle within ${timeoutMs}ms.`, {
        targetUrl: target,
        currentUrl: window.webContents.getURL(),
      }))
    }, remainingMs)

    window.webContents.on('did-finish-load', finish)
    window.webContents.on('did-fail-load', fail)
    window.webContents.once('destroyed', destroyed)
    options.signal?.addEventListener('abort', aborted, { once: true })

    void window.loadURL(target).then(finish, error => {
      // A superseded navigation reports ERR_ABORTED. The target-aware events remain authoritative.
      if (!isNavigationAborted(error)) {
        cleanup()
        rejectNavigation(new ElectronUiDriverError('DRIVER_DISCONNECTED', error instanceof Error ? error.message : String(error)))
      }
    })
  })
}

async function waitForCurrentNavigation(
  window: RendererNavigationWindow,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!window.webContents.isLoadingMainFrame()) return
  await new Promise<void>((resolveNavigation, rejectNavigation) => {
    let settled = false
    const finish = () => {
      if (window.webContents.isLoadingMainFrame()) return
      cleanup()
      resolveNavigation()
    }
    const fail = (_event: unknown, errorCode: number, errorDescription: string, _validatedURL: string, isMainFrame: boolean) => {
      if (!isMainFrame || errorCode === -3) return
      cleanup()
      rejectNavigation(new ElectronUiDriverError('DRIVER_DISCONNECTED', `Current renderer target failed to load: ${errorDescription || errorCode}.`, {
        errorCode,
      }))
    }
    const destroyed = () => {
      cleanup()
      rejectNavigation(new ElectronUiDriverError('WINDOW_GONE', 'Renderer window was destroyed during navigation.'))
    }
    const aborted = () => {
      cleanup()
      rejectNavigation(new ElectronUiDriverError('DRIVER_DISCONNECTED', 'Renderer navigation was aborted.'))
    }
    const cleanup = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', aborted)
      window.webContents.removeListener('did-stop-loading', finish)
      window.webContents.removeListener('did-fail-load', fail)
      window.webContents.removeListener('destroyed', destroyed)
    }
    const timeout = setTimeout(() => {
      cleanup()
      rejectNavigation(new ElectronUiDriverError('TIMEOUT', `Current renderer target did not settle within ${timeoutMs}ms.`, {
        currentUrl: window.webContents.getURL(),
      }))
    }, timeoutMs)

    window.webContents.on('did-stop-loading', finish)
    window.webContents.on('did-fail-load', fail)
    window.webContents.once('destroyed', destroyed)
    signal?.addEventListener('abort', aborted, { once: true })
    finish()
  })
}

function normalizedUrl(value: string): string {
  try { return new URL(value).toString() } catch { return value }
}

function isNavigationAborted(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown }
  return candidate?.code === 'ERR_ABORTED' || candidate?.errno === -3 || String(candidate?.message ?? error).includes('ERR_ABORTED')
}
