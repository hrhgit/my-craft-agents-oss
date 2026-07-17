import { BrowserWindow, shell, nativeTheme, Menu, app, screen } from 'electron'
import { windowLog } from './logger'
import { join, resolve, sep } from 'path'
import { existsSync } from 'fs'
import { release } from 'os'
import { fileURLToPath } from 'url'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { classifyExternalUrl, formatBlockedUrlError } from '@craft-agent/shared/utils/url-safety'
import { RPC_CHANNELS, type BrowserHostDockNavigationCommand, type WindowCloseRequestSource } from '../shared/types'
import type { SavedWindow } from './window-state'
import { clampWindowBounds, type WindowBounds } from './window-bounds'
import {
  applyWindowRendererRuntimeQuery,
  buildInitialWindowRendererQuery,
  resolveWindowLayoutRuntime,
  type WindowLayoutMode,
} from './window-renderer-query'
import { isKeyboardCloseShortcut } from './keyboard-close-shortcut'

// Vite dev server URL for hot reload
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const CRAFT_TEST_MODE = process.env.CRAFT_TEST_MODE === '1'

/**
 * Get the appropriate background material for Windows transparency effects
 * - Windows 11 (build 22000+): Mica effect
 * - Windows 10 1809+ (build 17763+): Acrylic effect
 * - Older versions: No transparency
 */
function getWindowsBackgroundMaterial(): 'mica' | 'acrylic' | undefined {
  if (process.platform !== 'win32') return undefined

  // os.release() returns "10.0.xxxxx" where xxxxx is the build number
  const buildNumber = parseInt(release().split('.')[2] || '0', 10)

  if (buildNumber >= 22000) {
    windowLog.info('Windows 11 detected (build ' + buildNumber + '), using Mica')
    return 'mica'
  } else if (buildNumber >= 17763) {
    windowLog.info('Windows 10 1809+ detected (build ' + buildNumber + '), using Acrylic')
    return 'acrylic'
  }

  windowLog.info('Older Windows detected (build ' + buildNumber + '), no transparency')
  return undefined
}


export type ManagedWindowRole = 'main' | 'child-session' | 'auxiliary'

export type WindowCloseHandshakeErrorCode =
  | 'not-found'
  | 'cancelled'
  | 'timeout'
  | 'close-failed'
  | 'redock-failed'

export class WindowCloseHandshakeError extends Error {
  constructor(
    readonly code: WindowCloseHandshakeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'WindowCloseHandshakeError'
  }
}

export function shouldScheduleWindowCloseFallback(hasGracefulCloseWaiter: boolean): boolean {
  return !hasGracefulCloseWaiter
}

export function restoreSourceWindowAfterAuxiliaryShow(
  sourceWindow: Pick<BrowserWindow, 'isDestroyed' | 'isMinimized' | 'isVisible' | 'restore' | 'showInactive'>,
  auxiliaryWindow: Pick<BrowserWindow, 'isDestroyed' | 'focus'>,
): void {
  if (sourceWindow.isDestroyed()) return
  if (sourceWindow.isMinimized()) sourceWindow.restore()
  if (!sourceWindow.isVisible()) sourceWindow.showInactive()
  if (!auxiliaryWindow.isDestroyed()) auxiliaryWindow.focus()
}

export interface ManagedWindow {
  window: BrowserWindow
  workspaceId: string
  role: ManagedWindowRole
  sessionId?: string
  parentWebContentsId?: number
  /** If set, this window's title is pinned to this string (e.g. child session name) */
  customTitle?: string
  layoutWindowId?: string
  layoutMode?: WindowLayoutMode
}

export interface LayoutWriteContext {
  workspaceId: string
  layoutWindowId: string
  role: 'primary' | 'auxiliary'
  ownerWebContentsId: number
}

export interface CreateWindowOptions {
  /** The workspace to open (empty string for onboarding) */
  workspaceId: string
  /** Whether to open in focused mode (smaller window, no sidebars) */
  focused?: boolean
  /** Deep link URL to navigate to after window loads (without ?window= param) */
  initialDeepLink?: string
  /** Session selected after the initial workspace session list has loaded. */
  initialSessionId?: string
  /** Full URL to restore from saved state (preserves route/query params) */
  restoreUrl?: string
  /** Custom window width (overrides focused/default size) */
  width?: number
  /** Custom window height (overrides focused/default size) */
  height?: number
  /** Optional screen position (used by detached layout groups). */
  x?: number
  y?: number
  /** Custom window title — overrides the workspace-name title policy */
  customTitle?: string
  /** Stable lifecycle role used for deterministic window selection. */
  role?: ManagedWindowRole
  sessionId?: string
  parentWebContentsId?: number
  layoutWindowId?: string
}

/** Options for creating a child session window (pi session tree branch) */
export interface CreateChildSessionWindowOptions {
  /** Workspace ID to associate with the window (defaults to calling window's workspace) */
  workspaceId?: string
  /** Window title (defaults to the sessionId) */
  title?: string
  /** Window width (default 800) */
  width?: number
  /** Window height (default 600) */
  height?: number
  /** webContents.id of the parent window, so the child can be closed when the parent closes */
  parentWebContentsId?: number
}

export class WindowManager {
  private windows: Map<number, ManagedWindow> = new Map()  // webContents.id → ManagedWindow
  private focusedModeWindows: Set<number> = new Set()  // webContents.id of windows in focused mode
  private pendingCloseTimeouts: Map<number, NodeJS.Timeout> = new Map()  // Fallback timeouts for window close
  private cascadingPrimaryCloses = new Set<number>()
  // F11: parent webContents.id → set of child window webContents.ids, so that
  // closing a parent window cascades to its child session windows.
  private childWindowsByParent: Map<number, Set<number>> = new Map()
  private eventSink: ((channel: string, target: import('@craft-agent/shared/protocol').PushTarget, ...args: any[]) => void) | null = null
  private clientResolver: ((wcId: number) => string | undefined) | null = null
  private keyboardCloseIntents: Set<number> = new Set()  // webContents.id flagged by Cmd/Ctrl+W before close
  private keyboardCloseIntentTimeouts: Map<number, NodeJS.Timeout> = new Map()  // Auto-clear stale keyboard-close intents
  private isAppQuitting = false  // Skip layered close interception during app quit
  private auxiliaryClosedHandler: ((layoutWindowId: string, workspaceId: string) => void | Promise<void>) | null = null
  private workspaceChangingHandler: ((webContentsId: number, oldWorkspaceId: string, newWorkspaceId: string) => void | Promise<void>) | null = null
  private primaryWebContentsByWorkspace: Map<string, number> = new Map()
  private auxiliaryRedockPromises = new Map<number, Promise<void>>()
  private auxiliaryCloseHandshakeTimeoutMs = 4_500
  private gracefulCloseCancellers = new Map<number, () => void>()

  constructor(private readonly backgroundTestWindows = false) {}

  setAuxiliaryClosedHandler(handler: (layoutWindowId: string, workspaceId: string) => void | Promise<void>): void {
    this.auxiliaryClosedHandler = handler
  }

  setWorkspaceChangingHandler(
    handler: (webContentsId: number, oldWorkspaceId: string, newWorkspaceId: string) => void | Promise<void>,
  ): void {
    this.workspaceChangingHandler = handler
  }

  /**
   * Set the event sink and client resolver for pushing events via the RPC server
   * instead of webContents.send. Called after server creation.
   */
  setRpcEventSink(
    sink: (channel: string, target: import('@craft-agent/shared/protocol').PushTarget, ...args: any[]) => void,
    resolver: (wcId: number) => string | undefined
  ): void {
    this.eventSink = sink
    this.clientResolver = resolver
  }

  /** Return current RPC event sink, if transport has been initialized. */
  getRpcEventSink(): ((channel: string, target: import('@craft-agent/shared/protocol').PushTarget, ...args: any[]) => void) | null {
    return this.eventSink
  }

  /** Resolve a window's current clientId from transport handshake state. */
  getClientIdForWindow(webContentsId: number): string | undefined {
    return this.clientResolver?.(webContentsId)
  }

  /** Push an event to a specific window via the RPC event sink. Falls back to webContents.send. */
  private pushToWindow(window: BrowserWindow, channel: string, ...args: any[]): void {
    if (this.eventSink && this.clientResolver) {
      const clientId = this.clientResolver(window.webContents.id)
      if (clientId) {
        this.eventSink(channel, { to: 'client', clientId }, ...args)
        return
      }
    }
    // Fallback: direct webContents.send (used before WS handshake completes)
    if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.mainFrame) {
      window.webContents.send(channel, ...args)
    }
  }

  private isRendererAppUrl(url: string): boolean {
    if (VITE_DEV_SERVER_URL) {
      try {
        const parsed = new URL(url)
        const devServer = new URL(VITE_DEV_SERVER_URL)
        if (parsed.origin === devServer.origin) return true
      } catch {
        // Fall through to file:// handling below.
      }
    }

    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'file:') return false

      const filePath = resolve(fileURLToPath(parsed))
      const rendererRoot = resolve(join(__dirname, 'renderer'))
      return filePath === join(rendererRoot, 'index.html') || filePath.startsWith(rendererRoot + sep)
    } catch {
      return false
    }
  }

  private openExternalFromRenderer(url: string, context: string, sourceWindow?: BrowserWindow): void {
    const classification = classifyExternalUrl(url)

    if (classification.kind === 'dangerous') {
      windowLog.warn(`[url-safety] Blocked ${context}: ${formatBlockedUrlError(classification)} url=${url}`)
      return
    }

    if (classification.kind === 'internal-deeplink') {
      if (!sourceWindow) {
        windowLog.warn(`[url-safety] Blocked ${context}: internal deep link has no target window url=${url}`)
        return
      }

      void import('./deep-link').then(async ({ handleDeepLink }) => {
        const result = await handleDeepLink(
          url,
          this,
          this.eventSink ?? undefined,
          this.clientResolver ?? undefined,
          this.clientResolver?.(sourceWindow.webContents.id),
        )
        if (!result.success) {
          windowLog.warn(`[url-safety] Blocked ${context}: unsupported internal deep link url=${url} error=${result.error ?? 'unknown'}`)
        }
      }).catch((error) => {
        windowLog.warn(`[url-safety] Failed to route internal deep link from ${context}: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }

    void shell.openExternal(url).catch((error) => {
      windowLog.warn(`[url-safety] Failed to open external URL from ${context}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Apply the window-title policy across all managed windows:
   *   1 window  → app name ("Craft Agents") on the lone window
   *   ≥2 windows → workspace name on each window, app-name fallback when the
   *                workspace can't be resolved (e.g. onboarding window).
   *
   * Called after createWindow() registers a new window and after the closed
   * handler removes one, so titles always reflect the current window count.
   * Renderer-driven page-title-updated events are suppressed in createWindow
   * so these setTitle() calls aren't clobbered by the static <title> tag.
   */
  private refreshWindowTitles(): void {
    const defaultTitle = app.getName()
    const showWorkspaceName = this.windows.size > 1
    for (const { window, workspaceId, customTitle } of this.windows.values()) {
      if (window.isDestroyed()) continue
      let title = defaultTitle
      if (customTitle) {
        // Child session windows always show their pinned title
        title = customTitle
      } else if (showWorkspaceName && workspaceId) {
        try {
          const ws = getWorkspaceByNameOrId(workspaceId)
          if (ws?.name) title = ws.name
        } catch (err) {
          windowLog.warn('refreshWindowTitles: workspace lookup failed', { workspaceId, err })
        }
      }
      window.setTitle(title)
    }
  }

  /**
   * Create a new window for a workspace
   * @param options - Window creation options
   */
  createWindow(options: CreateWindowOptions): BrowserWindow {
    const {
      workspaceId, focused = false, initialDeepLink, initialSessionId, restoreUrl, customTitle,
      role = 'main', sessionId, parentWebContentsId, layoutWindowId,
    } = options

    // Load platform-specific app icon
    // In packaged app, resources are at dist/resources/ (same level as __dirname)
    // In dev, resources are at ../resources/ (sibling of dist/)
    const getIconPath = () => {
      const iconName = process.platform === 'darwin' ? 'icon.icns'
        : process.platform === 'win32' ? 'icon.ico'
        : 'icon.png'
      return [
        join(__dirname, 'resources', iconName),
        join(__dirname, '../resources', iconName),
      ].find(p => existsSync(p)) ?? join(__dirname, '../resources', iconName)
    }

    const iconPath = getIconPath()
    const iconExists = existsSync(iconPath)

    if (!iconExists) {
      windowLog.warn('App icon not found at:', iconPath)
    }

    // Use smaller window size for focused mode (single session view)
    const windowWidth = options.width ?? (focused ? 900 : 1400)
    const windowHeight = options.height ?? (focused ? 700 : 900)

    // Platform-specific window options
    const isMac = process.platform === 'darwin'
    const isWindows = process.platform === 'win32'
    const windowsBackgroundMaterial = getWindowsBackgroundMaterial()

    const window = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      ...(options.x !== undefined ? { x: options.x } : {}),
      ...(options.y !== undefined ? { y: options.y } : {}),
      minWidth: 800,
      minHeight: 600,
      show: false, // Don't show until ready-to-show event (faster perceived startup)
      title: '',
      icon: iconExists ? iconPath : undefined,
      // macOS-specific: hidden title bar with inset traffic lights
      ...(isMac && {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 18, y: 16 },
        vibrancy: 'under-window',
        visualEffectState: 'active',
      }),
      // Windows: use native frame with Mica/Acrylic transparency (Windows 10/11)
      ...(isWindows && {
        frame: true, // Keep native frame for better UX
        autoHideMenuBar: true, // Menu is null on Windows, this is just for safety
        // Note: Don't use transparent:true with backgroundMaterial - it hides the window frame
        ...(windowsBackgroundMaterial && {
          backgroundMaterial: windowsBackgroundMaterial,
        }),
      }),
      // Linux: use native frame
      ...(!isMac && !isWindows && {
        frame: true,
        autoHideMenuBar: true,
      }),
      webPreferences: {
        preload: join(__dirname, 'bootstrap-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: false, // Browser integration uses WebContentsView, not <webview>
        ...(this.backgroundTestWindows ? { backgroundThrottling: false } : {}),
      }
    })

    // Show window when first paint is ready (faster perceived startup)
    window.once('ready-to-show', () => {
      if (this.backgroundTestWindows) {
        window.showInactive()
        window.minimize()
      } else {
        window.show()
      }
    })

    // Open external links in default browser, but never hand known-dangerous
    // schemes directly to shell.openExternal. Markdown normal-clicks go through
    // OPEN_URL; middle-clicks/window.open/top-navigation land here.
    window.webContents.setWindowOpenHandler((details) => {
      this.openExternalFromRenderer(details.url, 'window-open', window)
      return { action: 'deny' }
    })

    // Handle external navigation attempts from renderer WebContents
    window.webContents.on('will-navigate', (event, url) => {
      // Allow only the actual app shell (file:// in prod, Vite dev server in dev).
      // Any other navigation is treated as an external URL and goes through the
      // same URL-safety classifier used by OPEN_URL.
      if (this.isRendererAppUrl(url)) return

      event.preventDefault()
      this.openExternalFromRenderer(url, 'will-navigate', window)
    })

    // Enable right-click context menu in development
    if (!app.isPackaged) {
      window.webContents.on('context-menu', (_event, params) => {
        Menu.buildFromTemplate([
          { label: 'Inspect Element', click: () => window.webContents.inspectElement(params.x, params.y) },
          { type: 'separator' },
          { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
          { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
          { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        ]).popup()
      })
    }

    // The renderer's index.html ships with `<title>Craft Agents</title>`, so
    // without this Electron auto-syncs every window's title back to that on
    // load — clobbering the workspace-name policy applied below. Suppress the
    // default sync so setTitle() calls from refreshWindowTitles() stick.
    window.on('page-title-updated', (event) => {
      event.preventDefault()
    })

    // Store the window mapping BEFORE loadURL — bootstrap preload uses
    // __get-workspace-id (via sendSync) which reads this map during eval.
    const webContentsId = window.webContents.id
    const layoutRuntime = resolveWindowLayoutRuntime({
      role,
      workspaceHasPrimary: this.primaryWebContentsByWorkspace.has(workspaceId),
      webContentsId,
      requestedLayoutWindowId: layoutWindowId,
    })
    const resolvedLayoutWindowId = layoutRuntime.layoutWindowId
    this.windows.set(webContentsId, {
      window, workspaceId, role,
      ...(sessionId ? { sessionId } : {}),
      ...(parentWebContentsId != null ? { parentWebContentsId } : {}),
      ...(customTitle ? { customTitle } : {}),
      ...(resolvedLayoutWindowId ? { layoutWindowId: resolvedLayoutWindowId } : {}),
      layoutMode: layoutRuntime.mode,
    })
    if (role === 'main' && layoutRuntime.mode === 'coordinated') {
      this.primaryWebContentsByWorkspace.set(workspaceId, webContentsId)
    }
    const runtimeQueryOptions = {
      craftTestMode: CRAFT_TEST_MODE,
      layoutReadOnly: layoutRuntime.layoutReadOnly,
    }
    const withWindowRuntimeQuery = (query: Record<string, string>): Record<string, string> =>
      applyWindowRendererRuntimeQuery({
        ...query,
        ...(resolvedLayoutWindowId ? { layoutWindowId: resolvedLayoutWindowId } : {}),
      }, runtimeQueryOptions)
    const defaultRendererQuery = buildInitialWindowRendererQuery({
      workspaceId,
      focused,
      initialSessionId,
      layoutWindowId: resolvedLayoutWindowId,
      ...runtimeQueryOptions,
    })
    let rendererQuery = defaultRendererQuery

    // Apply window-title policy now that the map size reflects this window —
    // covers both the new window and any existing windows that should switch
    // from app name → workspace name as the count crosses 1 → 2.
    this.refreshWindowTitles()

    // Track focused mode state for persistence
    if (focused) {
      this.focusedModeWindows.add(webContentsId)
    }

    // Load the renderer - use restoreUrl if provided, otherwise build from options
    if (restoreUrl) {
      // Restore from saved URL - need to adapt for dev vs prod
      if (VITE_DEV_SERVER_URL) {
        // In dev mode, replace the base URL but keep the path and query
        try {
          const savedUrl = new URL(restoreUrl)
          const devUrl = new URL(VITE_DEV_SERVER_URL)
          // Preserve pathname and search from saved URL, use dev server host
          devUrl.pathname = savedUrl.pathname
          rendererQuery = withWindowRuntimeQuery({
            ...Object.fromEntries(savedUrl.searchParams),
            workspaceId,
          })
          devUrl.search = new URLSearchParams(rendererQuery).toString()
          window.loadURL(devUrl.toString())
        } catch {
          // Fallback if URL parsing fails
          windowLog.warn('Failed to parse restoreUrl, using default:', restoreUrl)
          rendererQuery = defaultRendererQuery
          const params = new URLSearchParams(rendererQuery).toString()
          window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
        }
      } else {
        // In prod, always extract query params and load from current __dirname.
        // Never load file:// URLs directly — the path may be stale (e.g. Linux AppImage
        // mounts to a different /tmp dir on each launch). See #13.
        try {
          const savedUrl = new URL(restoreUrl)
          rendererQuery = withWindowRuntimeQuery({
            ...Object.fromEntries(savedUrl.searchParams),
            workspaceId,
          })
          window.loadFile(join(__dirname, 'renderer/index.html'), { query: rendererQuery })
        } catch {
          rendererQuery = defaultRendererQuery
          window.loadFile(join(__dirname, 'renderer/index.html'), { query: rendererQuery })
        }
      }
    } else {
      if (VITE_DEV_SERVER_URL) {
        const params = new URLSearchParams(rendererQuery).toString()
        window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
      } else {
        window.loadFile(join(__dirname, 'renderer/index.html'), { query: rendererQuery })
      }
    }

    // Fallback: if the renderer fails to load (e.g. stale path, disk error),
    // recover gracefully by loading the default state instead of showing a white screen. See #13.
    // In dev mode, retry the Vite dev server (it may not be ready yet) instead of falling back
    // to file:// which doesn't exist during development.
    let failLoadRetries = 0
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
      // Chromium reports ERR_ABORTED when an intentional navigation supersedes an in-flight one.
      // Reloading index.html here would abort the new target and create a navigation loop.
      if (!isMainFrame || errorCode === -3) return
      windowLog.warn('Failed to load renderer:', errorCode, errorDescription)
      if (VITE_DEV_SERVER_URL && failLoadRetries < 5) {
        failLoadRetries++
        windowLog.info(`Retrying Vite dev server (attempt ${failLoadRetries}/5)...`)
        setTimeout(() => {
          const params = new URLSearchParams(rendererQuery).toString()
          window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
        }, 1000)
      } else {
        window.loadFile(join(__dirname, 'renderer/index.html'), { query: rendererQuery })
      }
    })

    // If an initial deep link was provided, navigate to it after the window is ready
    if (initialDeepLink) {
      window.once('ready-to-show', () => {
        // Import parseDeepLink dynamically to avoid circular dependency
        import('./deep-link').then(({ parseDeepLink }) => {
          const target = parseDeepLink(initialDeepLink)
          if (target && (target.view || target.action)) {
            // Wait a bit for React to mount and register IPC listeners
            setTimeout(() => {
              this.pushToWindow(window, RPC_CHANNELS.deeplink.NAVIGATE, {
                view: target.view,
                action: target.action,
                actionParams: target.actionParams,
              })
            }, 100)
          }
        })
      })
    }

    // Listen for system theme changes and notify this window's renderer
    const themeHandler = () => {
      this.pushToWindow(window, RPC_CHANNELS.theme.SYSTEM_CHANGED, nativeTheme.shouldUseDarkColors)
    }
    nativeTheme.on('updated', themeHandler)

    // Handle focus/blur to broadcast window focus state
    window.on('focus', () => {
      this.pushToWindow(window, RPC_CHANNELS.window.FOCUS_STATE, true)
    })
    window.on('blur', () => {
      this.pushToWindow(window, RPC_CHANNELS.window.FOCUS_STATE, false)
    })

    // Detect Cmd/Ctrl+W before close events so renderer can distinguish close source.
    // Intent is short-lived to avoid stale classification.
    window.webContents.on('before-input-event', (event, input) => {
      this.handleKeyboardCloseInput(window, event, input)
    })

    // Handle window close request (traffic-light button, menu close, Cmd/Ctrl+W)
    // and send source metadata so renderer can decide layered dismiss vs direct close.
    window.on('close', (event) => {
      // During app quit, bypass layered close behavior and allow native close flow.
      // This preserves expected Cmd+Q semantics (quit app instead of closing overlays/panels first).
      if (this.isAppQuitting) {
        return
      }

      // Check if renderer is ready (mainFrame exists) - if not, allow close directly
      if (!window.webContents.isDestroyed() && window.webContents.mainFrame) {
        event.preventDefault()
        const wcId = window.webContents.id
        let source: WindowCloseRequestSource = 'window-button'
        if (this.keyboardCloseIntents.has(wcId)) {
          source = 'keyboard-shortcut'
          this.keyboardCloseIntents.delete(wcId)
          const keyboardIntentTimeout = this.keyboardCloseIntentTimeouts.get(wcId)
          if (keyboardIntentTimeout) {
            clearTimeout(keyboardIntentTimeout)
            this.keyboardCloseIntentTimeouts.delete(wcId)
          }
        }

        // Send close request to renderer - it will either close a modal/panel or confirm close.
        this.pushToWindow(window, RPC_CHANNELS.window.CLOSE_REQUESTED, { source })

        // Fallback timeout: if IPC fails (e.g., on Hyprland/Wayland), force close after 3s.
        // Reset timeout on each attempt so active users closing modals aren't interrupted.
        const existingTimeout = this.pendingCloseTimeouts.get(wcId)
        if (existingTimeout) clearTimeout(existingTimeout)

        if (shouldScheduleWindowCloseFallback(this.gracefulCloseCancellers.has(wcId))) {
          this.pendingCloseTimeouts.set(wcId, setTimeout(() => {
            this.pendingCloseTimeouts.delete(wcId)
            if (!window.isDestroyed()) window.destroy()
          }, 3000))
        }
      }
      // If renderer not ready, allow default close behavior
    })

    // Handle window closed - clean up theme listener and internal state
    window.on('closed', () => {
      // Clean up any pending close timeout to prevent memory leaks
      const timeout = this.pendingCloseTimeouts.get(webContentsId)
      if (timeout) {
        clearTimeout(timeout)
        this.pendingCloseTimeouts.delete(webContentsId)
      }

      // Clean up short-lived keyboard-close intent tracking.
      const keyboardIntentTimeout = this.keyboardCloseIntentTimeouts.get(webContentsId)
      if (keyboardIntentTimeout) {
        clearTimeout(keyboardIntentTimeout)
        this.keyboardCloseIntentTimeouts.delete(webContentsId)
      }
      this.keyboardCloseIntents.delete(webContentsId)

      nativeTheme.removeListener('updated', themeHandler)
      const closedManaged = this.windows.get(webContentsId)
      const closedWorkspaceId = closedManaged?.workspaceId ?? workspaceId
      this.windows.delete(webContentsId)
      this.cascadingPrimaryCloses.delete(webContentsId)
      this.focusedModeWindows.delete(webContentsId)
      // Re-apply window-title policy — surviving windows revert from workspace
      // name back to app name when the count drops from 2 → 1.
      this.refreshWindowTitles()
      windowLog.info(`Window closed for workspace ${workspaceId}`)

      if (role === 'auxiliary' && resolvedLayoutWindowId) {
        void this.redockAuxiliaryOnce(webContentsId, resolvedLayoutWindowId, closedWorkspaceId)
          .catch(error => windowLog.error('Failed to redock closed auxiliary window', error))
      }
      if (this.primaryWebContentsByWorkspace.get(closedWorkspaceId) === webContentsId) {
        for (const managed of this.windows.values()) {
          if (
            managed.role === 'auxiliary'
            && managed.parentWebContentsId === webContentsId
            && !managed.window.isDestroyed()
          ) managed.window.destroy()
        }
        this.primaryWebContentsByWorkspace.delete(closedWorkspaceId)
        this.promotePrimaryLayoutWriter(closedWorkspaceId)
      }

      // F11: Cascade close — when a parent window closes, close all of its
      // child session windows so they don't keep rendering a (now-stale)
      // parent session's data. Child windows closing on their own do not
      // affect the parent (handled by the child's own 'closed' listener).
      const childIds = this.childWindowsByParent.get(webContentsId)
      if (childIds && childIds.size > 0) {
        for (const childId of childIds) {
          const managed = this.windows.get(childId)
          if (managed && !managed.window.isDestroyed()) {
            managed.window.close()
          }
        }
        this.childWindowsByParent.delete(webContentsId)
      }
    })

    windowLog.info(`Created window for workspace ${workspaceId} (focused: ${focused})`)
    return window
  }

  private handleKeyboardCloseInput(
    window: BrowserWindow,
    event: Electron.Event,
    input: Electron.Input,
  ): void {
    if (!isKeyboardCloseShortcut(input)) return

    // The Windows/Linux File menu has no native close-window accelerator, and
    // source-development windows may have no application menu at all. Consume
    // the shortcut and initiate the close explicitly on every platform so the
    // renderer's layered close policy always runs exactly once.
    event.preventDefault()
    this.requestKeyboardClose(window.webContents.id)
  }

  requestKeyboardClose(webContentsId: number): boolean {
    const window = this.getWindowByWebContentsId(webContentsId)
    if (!window || window.isDestroyed()) return false

    const wcId = window.webContents.id
    this.keyboardCloseIntents.add(wcId)
    const existingTimeout = this.keyboardCloseIntentTimeouts.get(wcId)
    if (existingTimeout) clearTimeout(existingTimeout)

    this.keyboardCloseIntentTimeouts.set(wcId, setTimeout(() => {
      this.keyboardCloseIntentTimeouts.delete(wcId)
      this.keyboardCloseIntents.delete(wcId)
    }, 500))
    window.close()
    return true
  }

  requestBrowserHostDockNavigation(
    webContentsId: number,
    command: BrowserHostDockNavigationCommand,
  ): boolean {
    const window = this.getWindowByWebContentsId(webContentsId)
    if (!window || window.isDestroyed()) return false
    this.pushToWindow(window, RPC_CHANNELS.browserPane.HOST_DOCK_NAVIGATION, command)
    return true
  }

  /**
   * Create a new window for a pi session tree child session.
   *
   * Child session windows are independent BrowserWindows that load the same
   * renderer as the main window but navigate directly to the child session's
   * ChatPage via a deep link. They reuse the existing preload, webPreferences,
   * and all lifecycle handling (close interception, theme sync, URL safety)
   * from `createWindow` — only the defaults differ:
   *
   * - Smaller default size (800×600)
   * - Title bar shows the child session name (pinned, not workspace name)
   * - Focused mode (no sidebars)
   *
   * Multiple child session windows can coexist. Closing one does not affect
   * the main window or other child session windows.
   *
   * @param sessionId - The Pi child session ID to display
   * @param options   - Optional window configuration
   */
  createChildSessionWindow(sessionId: string, options?: CreateChildSessionWindowOptions): BrowserWindow {
    const {
      workspaceId = '',
      title,
      width = 800,
      height = 600,
      parentWebContentsId,
    } = options ?? {}

    const deepLink = `craftagents://allSessions/session/${sessionId}`

    const childWindow = this.createWindow({
      workspaceId,
      focused: true,
      initialDeepLink: deepLink,
      width,
      height,
      customTitle: title || sessionId,
      role: 'child-session',
      sessionId,
      ...(parentWebContentsId != null ? { parentWebContentsId } : {}),
    })

    // F11: Auto-close the child window when its renderer process crashes,
    // otherwise a crashed renderer leaves a dead window pointing at a
    // (possibly already-destroyed) parent session's data.
    childWindow.webContents.on('render-process-gone', () => {
      if (!childWindow.isDestroyed()) childWindow.close()
    })

    // F11: Track parent ↔ child relationship so closing the parent window
    // cascades to its child session windows. Closing a child does not affect
    // the parent.
    if (parentWebContentsId != null) {
      const childId = childWindow.webContents.id
      let siblings = this.childWindowsByParent.get(parentWebContentsId)
      if (!siblings) {
        siblings = new Set()
        this.childWindowsByParent.set(parentWebContentsId, siblings)
      }
      siblings.add(childId)

      childWindow.on('closed', () => {
        const set = this.childWindowsByParent.get(parentWebContentsId)
        if (set) {
          set.delete(childId)
          if (set.size === 0) this.childWindowsByParent.delete(parentWebContentsId)
        }
      })
    }

    return childWindow
  }

  createAuxiliaryWindow(
    layoutWindowId: string,
    workspaceId: string,
    parentWebContentsId: number,
    bounds?: { x: number; y: number; width: number; height: number },
  ): BrowserWindow {
    const source = this.getLayoutWriteContext(parentWebContentsId)
    if (!source || source.role !== 'primary' || source.workspaceId !== workspaceId) {
      throw new Error('Auxiliary windows must be created by the primary layout writer')
    }
    const sourceWindow = this.getWindowByWebContentsId(parentWebContentsId)
    const preserveSourceVisibility = Boolean(
      sourceWindow
      && sourceWindow.isVisible()
      && !sourceWindow.isMinimized(),
    )
    const auxiliaryWindow = this.createWindow({
      workspaceId,
      focused: true,
      role: 'auxiliary',
      layoutWindowId,
      parentWebContentsId,
      customTitle: 'Craft Workbench',
      ...(bounds ? { width: bounds.width, height: bounds.height } : {}),
      ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    })
    if (sourceWindow && preserveSourceVisibility) {
      auxiliaryWindow.once('ready-to-show', () => {
        setImmediate(() => restoreSourceWindowAfterAuxiliaryShow(sourceWindow, auxiliaryWindow))
      })
    }
    return auxiliaryWindow
  }

  resolveAuxiliaryWindowBounds(webContentsId: number, requested?: WindowBounds): WindowBounds {
    const sourceBounds = this.getWindowByWebContentsId(webContentsId)?.getBounds()
    const cursor = screen.getCursorScreenPoint()
    const width = requested?.width ?? Math.min(sourceBounds?.width ?? 900, 1200)
    const height = requested?.height ?? Math.min(sourceBounds?.height ?? 700, 900)
    const desired = requested ?? {
      x: cursor.x - 96,
      y: cursor.y - 20,
      width,
      height,
    }
    const display = screen.getDisplayNearestPoint({
      x: requested ? requested.x + Math.min(96, requested.width / 2) : cursor.x,
      y: requested ? requested.y + Math.min(20, requested.height / 2) : cursor.y,
    })
    return clampWindowBounds(desired, display.workArea)
  }

  /**
   * Get window by webContents.id (used by IPC handlers instead of BrowserWindow.fromId)
   */
  getWindowByWebContentsId(wcId: number): BrowserWindow | null {
    const managed = this.windows.get(wcId)
    return managed?.window ?? null
  }

  /**
   * Get window by workspace ID (returns first match - for backwards compatibility)
   */
  getWindowByWorkspace(workspaceId: string): BrowserWindow | null {
    const primaryId = this.primaryWebContentsByWorkspace.get(workspaceId)
    if (primaryId != null) {
      const primary = this.windows.get(primaryId)?.window
      if (primary && !primary.isDestroyed()) return primary
    }
    for (const managed of this.windows.values()) {
      if (managed.role === 'main' && managed.workspaceId === workspaceId && !managed.window.isDestroyed()) {
        return managed.window
      }
    }
    for (const managed of this.windows.values()) {
      if (managed.workspaceId === workspaceId && !managed.window.isDestroyed()) {
        return managed.window
      }
    }
    return null
  }

  /**
   * Get ALL windows for a workspace (main window + tab content windows)
   * Used for broadcasting events to all windows showing the same workspace
   */
  getAllWindowsForWorkspace(workspaceId: string): BrowserWindow[] {
    const windows: BrowserWindow[] = []
    for (const managed of this.windows.values()) {
      if (managed.workspaceId === workspaceId && !managed.window.isDestroyed()) {
        windows.push(managed.window)
      }
    }
    // Debug: log registered workspaces when lookup fails
    if (windows.length === 0 && this.windows.size > 0) {
      const registered = Array.from(this.windows.values()).map(m => m.workspaceId)
      windowLog.warn(`No windows for workspace '${workspaceId}', have: [${registered.join(', ')}]`)
    }
    return windows
  }

  /**
   * Get workspace ID for a window (by webContents.id)
   */
  getWorkspaceForWindow(webContentsId: number): string | null {
    const managed = this.windows.get(webContentsId)
    return managed?.workspaceId ?? null
  }

  /** Return the trusted layout identity for primary writers and their auxiliary windows. */
  getLayoutWriteContext(webContentsId: number): LayoutWriteContext | null {
    const managed = this.windows.get(webContentsId)
    if (!managed || managed.layoutMode === 'standalone') return null
    if (managed.role === 'main') {
      return this.primaryWebContentsByWorkspace.get(managed.workspaceId) === webContentsId
        ? {
            workspaceId: managed.workspaceId,
            layoutWindowId: 'primary',
            role: 'primary',
            ownerWebContentsId: webContentsId,
          }
        : null
    }
    if (managed.role !== 'auxiliary' || !managed.layoutWindowId || managed.parentWebContentsId == null) return null
    return this.primaryWebContentsByWorkspace.get(managed.workspaceId) === managed.parentWebContentsId
      ? {
          workspaceId: managed.workspaceId,
          layoutWindowId: managed.layoutWindowId,
          role: 'auxiliary',
          ownerWebContentsId: managed.parentWebContentsId,
        }
      : null
  }

  private redockAuxiliaryOnce(
    webContentsId: number,
    layoutWindowId: string,
    workspaceId: string,
  ): Promise<void> {
    const existing = this.auxiliaryRedockPromises.get(webContentsId)
    if (existing) return existing
    const task = Promise.resolve().then(() => this.auxiliaryClosedHandler?.(layoutWindowId, workspaceId))
      .then(() => undefined)
    this.auxiliaryRedockPromises.set(webContentsId, task)
    void task.then(
      () => queueMicrotask(() => this.auxiliaryRedockPromises.delete(webContentsId)),
      () => queueMicrotask(() => this.auxiliaryRedockPromises.delete(webContentsId)),
    )
    return task
  }

  private requestManagedWindowCloseAndWait(
    webContentsId: number,
    managed: ManagedWindow,
  ): Promise<void> {
    if (managed.window.isDestroyed()) {
      return managed.role === 'auxiliary' && managed.layoutWindowId
        ? this.redockAuxiliaryOnce(webContentsId, managed.layoutWindowId, managed.workspaceId)
        : Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        managed.window.removeListener('closed', onClosed)
        if (this.gracefulCloseCancellers.get(webContentsId) === cancel) {
          this.gracefulCloseCancellers.delete(webContentsId)
        }
        if (error) reject(error)
        else resolve()
      }
      const onClosed = () => {
        if (managed.role !== 'auxiliary' || !managed.layoutWindowId) {
          finish()
          return
        }
        void this.redockAuxiliaryOnce(webContentsId, managed.layoutWindowId, managed.workspaceId)
          .then(
            () => finish(),
            cause => finish(new WindowCloseHandshakeError(
              'redock-failed',
              `Auxiliary window ${managed.layoutWindowId} closed but could not redock`,
              { cause },
            )),
          )
      }
      const cancel = () => finish(new WindowCloseHandshakeError(
        'cancelled',
        `Window ${webContentsId} close was cancelled because renderer state did not flush`,
      ))
      const timeout = setTimeout(() => finish(new WindowCloseHandshakeError(
        'timeout',
        `Window ${webContentsId} did not flush and close within ${this.auxiliaryCloseHandshakeTimeoutMs} ms`,
      )), this.auxiliaryCloseHandshakeTimeoutMs)
      this.gracefulCloseCancellers.set(webContentsId, cancel)
      managed.window.once('closed', onClosed)
      try {
        managed.window.close()
      } catch (error) {
        finish(new WindowCloseHandshakeError(
          'close-failed',
          `Window ${webContentsId} close request failed`,
          { cause: error },
        ))
      }
    })
  }

  /** Close every detached layout window and wait for renderer flush + redock. */
  async closeAuxiliaryWindowsGracefully(parentWebContentsId: number): Promise<void> {
    const auxiliaries = [...this.windows.entries()].filter(([, candidate]) =>
      candidate.role === 'auxiliary'
      && candidate.parentWebContentsId === parentWebContentsId)
    await Promise.all(auxiliaries.map(([webContentsId, managed]) =>
      this.requestManagedWindowCloseAndWait(webContentsId, managed)))
  }

  /** Close one managed window without bypassing renderer persistence. */
  async closeWindowGracefully(webContentsId: number): Promise<void> {
    const managed = this.windows.get(webContentsId)
    if (!managed) {
      throw new WindowCloseHandshakeError('not-found', `Window ${webContentsId} is not managed by Craft`)
    }
    if (managed.role === 'main') await this.closeAuxiliaryWindowsGracefully(webContentsId)
    await this.requestManagedWindowCloseAndWait(webContentsId, managed)
  }

  /**
   * Mark whether the app is in quit flow.
   * When true, window close events bypass layered close interception.
   */
  setAppQuitting(isQuitting: boolean): void {
    this.isAppQuitting = isQuitting
  }

  /**
   * Close window by webContents.id (triggers close event which may be intercepted)
   */
  closeWindow(webContentsId: number): void {
    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      managed.window.close()
    }
  }

  /**
   * Force close window by webContents.id (bypasses close event interception).
   * Used when renderer confirms the close action (no modals to close).
   */
  forceCloseWindow(webContentsId: number): void {
    // Clear any pending close timeout since renderer confirmed
    const timeout = this.pendingCloseTimeouts.get(webContentsId)
    if (timeout) {
      clearTimeout(timeout)
      this.pendingCloseTimeouts.delete(webContentsId)
    }

    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      if (managed.role === 'main' && this.cascadingPrimaryCloses.has(webContentsId)) return
      if (managed.role === 'main') {
        const auxiliaries = [...this.windows.values()].filter(candidate =>
          candidate.role === 'auxiliary'
          && candidate.parentWebContentsId === webContentsId
          && !candidate.window.isDestroyed())
        if (auxiliaries.length > 0) {
          this.cascadingPrimaryCloses.add(webContentsId)
          let remaining = auxiliaries.length
          const closePrimary = () => {
            remaining -= 1
            if (remaining > 0) return
            this.cascadingPrimaryCloses.delete(webContentsId)
            if (!managed.window.isDestroyed()) managed.window.destroy()
          }
          for (const auxiliary of auxiliaries) {
            auxiliary.window.once('closed', closePrimary)
            auxiliary.window.close()
          }
          return
        }
      }
      // Remove close listener temporarily to avoid infinite loop,
      // then destroy the window directly
      this.cascadingPrimaryCloses.delete(webContentsId)
      managed.window.destroy()
    }
  }

  /**
   * Cancel a pending close request (renderer handled it by closing a modal/panel).
   * Clears the fallback timeout so the window stays open.
   */
  cancelPendingClose(webContentsId: number): void {
    const timeout = this.pendingCloseTimeouts.get(webContentsId)
    if (timeout) {
      clearTimeout(timeout)
      this.pendingCloseTimeouts.delete(webContentsId)
    }
    this.gracefulCloseCancellers.get(webContentsId)?.()
  }

  /**
   * Close window for a specific workspace
   */
  closeWindowForWorkspace(workspaceId: string): void {
    const window = this.getWindowByWorkspace(workspaceId)
    if (window && !window.isDestroyed()) {
      window.close()
    }
  }

  /**
   * Update the workspace ID for an existing window (for in-window switching)
   * @param webContentsId - The webContents.id of the window
   * @param workspaceId - The new workspace ID
   * @returns true if window was found and updated, false otherwise
   */
  async updateWindowWorkspace(webContentsId: number, workspaceId: string): Promise<boolean> {
    const managed = this.windows.get(webContentsId)
    if (managed) {
      const oldWorkspaceId = managed.workspaceId
      if (oldWorkspaceId === workspaceId) return true
      if (managed.role !== 'main') {
        throw new Error(`${managed.role} windows cannot switch workspaces directly`)
      }
      const wasPrimaryWriter = managed.role === 'main'
        && this.primaryWebContentsByWorkspace.get(oldWorkspaceId) === webContentsId
      const destinationPrimary = this.primaryWebContentsByWorkspace.get(workspaceId)
      if (wasPrimaryWriter && destinationPrimary != null && destinationPrimary !== webContentsId) {
        throw new Error(`Workspace ${workspaceId} already has a primary layout window`)
      }

      if (wasPrimaryWriter) {
        await this.closeAuxiliaryWindowsGracefully(webContentsId)
      }
      await this.workspaceChangingHandler?.(webContentsId, oldWorkspaceId, workspaceId)

      managed.workspaceId = workspaceId
      if (wasPrimaryWriter) {
        this.primaryWebContentsByWorkspace.delete(oldWorkspaceId)
        this.promotePrimaryLayoutWriter(oldWorkspaceId)
      }
      if (managed.layoutMode !== 'standalone' && !this.primaryWebContentsByWorkspace.has(workspaceId)) {
        this.primaryWebContentsByWorkspace.set(workspaceId, webContentsId)
      }
      // Re-apply window-title policy so in-window workspace switches update
      // the titlebar immediately (relevant when ≥2 windows are open).
      this.refreshWindowTitles()
      windowLog.info(`Updated window ${webContentsId} from workspace ${oldWorkspaceId} to ${workspaceId}`)
      return true
    }
    // Window not found - log for debugging
    windowLog.warn(`Cannot update workspace for unknown window ${webContentsId}, registered: [${Array.from(this.windows.keys()).join(', ')}]`)
    return false
  }

  /**
   * Register an existing window with a workspace ID
   * Used for re-registration when window mapping is lost (e.g., after refresh)
   * @param window - The BrowserWindow to register
   * @param workspaceId - The workspace ID to associate with
   */
  registerWindow(window: BrowserWindow, workspaceId: string): void {
    const webContentsId = window.webContents.id
    const existing = this.windows.get(webContentsId)
    this.windows.set(webContentsId, {
      window,
      workspaceId,
      role: existing?.role ?? 'main',
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      ...(existing?.parentWebContentsId != null ? { parentWebContentsId: existing.parentWebContentsId } : {}),
      ...(existing?.customTitle ? { customTitle: existing.customTitle } : {}),
      ...(existing?.layoutWindowId ? { layoutWindowId: existing.layoutWindowId } : {}),
      layoutMode: existing?.layoutMode ?? (
        (existing?.role ?? 'main') === 'child-session'
          || ((existing?.role ?? 'main') === 'main' && this.primaryWebContentsByWorkspace.has(workspaceId))
          ? 'standalone'
          : 'coordinated'
      ),
    })
    if (
      (existing?.role ?? 'main') === 'main'
      && existing?.layoutMode !== 'standalone'
      && !this.primaryWebContentsByWorkspace.has(workspaceId)
    ) {
      this.primaryWebContentsByWorkspace.set(workspaceId, webContentsId)
    }
    // Re-apply window-title policy after re-registration (e.g. post-refresh).
    this.refreshWindowTitles()
    windowLog.info(`Registered window ${webContentsId} for workspace ${workspaceId}`)
  }

  /**
   * Get all managed windows
   */
  getAllWindows(): ManagedWindow[] {
    return Array.from(this.windows.values()).filter(m => !m.window.isDestroyed())
  }

  /**
   * Focus existing window for workspace or create new one
   */
  focusOrCreateWindow(workspaceId: string): BrowserWindow {
    const primaryId = this.primaryWebContentsByWorkspace.get(workspaceId)
    const existing = primaryId == null ? null : this.getWindowByWebContentsId(primaryId)
    if (existing) {
      if (existing.isMinimized()) {
        existing.restore()
      }
      existing.focus()
      return existing
    }
    return this.createWindow({ workspaceId })
  }

  private promotePrimaryLayoutWriter(workspaceId: string): void {
    if (this.primaryWebContentsByWorkspace.has(workspaceId)) return
    for (const [webContentsId, managed] of this.windows) {
      if (
        managed.role === 'main'
        && managed.layoutMode !== 'standalone'
        && managed.workspaceId === workspaceId
        && !managed.window.isDestroyed()
      ) {
        this.primaryWebContentsByWorkspace.set(workspaceId, webContentsId)
        return
      }
    }
  }

  /**
   * Get window states for persistence (includes bounds and focused mode)
   * Used by window-state.ts to save/restore windows
   */
  getWindowStates(): SavedWindow[] {
    return this.getAllWindows().filter(managed => managed.role === 'main').map(managed => {
      const webContentsId = managed.window.webContents.id
      const isFocused = this.focusedModeWindows.has(webContentsId)
      const url = managed.window.webContents.getURL()
      return {
        type: 'main' as const,
        workspaceId: managed.workspaceId,
        bounds: managed.window.getBounds(),
        ...(isFocused && { focused: true }),
        ...(url && { url }),
      }
    })
  }

  /**
   * Check if any windows are open
   */
  hasWindows(): boolean {
    return this.getAllWindows().length > 0
  }

  /**
   * Get the currently focused window
   */
  getFocusedWindow(): BrowserWindow | null {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && !focused.isDestroyed()) {
      return focused
    }
    return null
  }

  /**
   * Get the last active window (most recently used)
   * Falls back to any available window if none focused
   */
  getLastActiveWindow(): BrowserWindow | null {
    // First try focused window
    const focused = this.getFocusedWindow()
    if (focused) {
      return focused
    }

    // Fall back to any available window
    const allWindows = this.getAllWindows()
    if (allWindows.length > 0) {
      return allWindows[0].window
    }

    return null
  }

  /**
   * Show or hide macOS traffic light buttons (close/minimize/maximize).
   * Used to hide them when fullscreen overlays are open to prevent accidental clicks.
   * No-op on non-macOS platforms.
   */
  setTrafficLightsVisible(webContentsId: number, visible: boolean): void {
    if (process.platform !== 'darwin') return

    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      managed.window.setWindowButtonVisibility(visible)
      // Re-apply custom traffic light position after showing buttons
      // setWindowButtonVisibility can reset position to default, so we need
      // to restore the custom position using the modern setWindowButtonPosition API
      if (visible) {
        managed.window.setWindowButtonPosition({ x: 18, y: 19 })
      }
    }
  }
}
