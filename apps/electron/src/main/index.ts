// Load user's shell environment first (before other imports that may use env)
// This ensures tools like Homebrew, nvm, etc. are available to the agent
import { loadShellEnv } from './shell-env'
loadShellEnv()

import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { hostname, homedir } from 'os'
import * as Sentry from '@sentry/electron/main'

// Initialize Sentry error tracking as early as possible after app import.
// Only enabled in production (packaged) builds to avoid noise during development.
// DSN is baked in at build time via esbuild --define (same pattern as OAuth secrets).
//
// NOTE: Source map upload is intentionally disabled. Stack traces in Sentry will show
// bundled/minified code. To enable source map upload in the future:
//   1. Add SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT to CI secrets
//   2. Re-enable the @sentry/vite-plugin in vite.config.ts (handles renderer maps)
//   3. Add @sentry/esbuild-plugin to scripts/electron-build-main.ts (handles main process maps)
Sentry.init({
  dsn: process.env.SENTRY_ELECTRON_INGEST_URL,
  environment: app.isPackaged ? 'production' : 'development',
  release: app.getVersion(),
  // Enabled whenever the ingest URL is available — works in both production (baked via CI)
  // and development (injected via .env / 1Password). Filter by environment in Sentry dashboard.
  enabled: !!process.env.SENTRY_ELECTRON_INGEST_URL,

  // Scrub sensitive data before sending to Sentry.
  // Removes authorization headers, API keys/tokens, and credential-like values.
  beforeSend(event) {
    // Scrub request headers (authorization, cookies)
    if (event.request?.headers) {
      const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key']
      for (const header of sensitiveHeaders) {
        if (event.request.headers[header]) {
          event.request.headers[header] = '[REDACTED]'
        }
      }
    }

    // Scrub breadcrumb data that may contain sensitive values
    if (event.breadcrumbs) {
      for (const breadcrumb of event.breadcrumbs) {
        if (breadcrumb.data) {
          for (const key of Object.keys(breadcrumb.data)) {
            const lowerKey = key.toLowerCase()
            if (lowerKey.includes('token') || lowerKey.includes('key') ||
                lowerKey.includes('secret') || lowerKey.includes('password') ||
                lowerKey.includes('credential') || lowerKey.includes('auth')) {
              breadcrumb.data[key] = '[REDACTED]'
            }
          }
        }
      }
    }

    return event
  },
})

// Initialize i18n for main process (menus, dialogs, etc.)
//
// The main-process i18n instance has no detection plugin (no localStorage in Node)
// — it always starts at `fallbackLng: 'zh-Hans'`. We hydrate it here from the persisted
// `uiLanguage` preference, which is maintained by the `i18n:changeLanguage` IPC
// handler whenever the user changes Appearance → Language. Without this, the
// renderer would restore its language from localStorage on every restart while
// the main process silently stayed at the fallback language — breaking session title language,
// the system prompt's "Preferred language" line, and the native menu.
import { setupI18n, i18n, SUPPORTED_LANGUAGE_CODES, type LanguageCode } from '@mortise/shared/i18n'
import { getPersistedUiLanguage, setPersistedUiLanguage } from '@mortise/shared/config'
setupI18n()
const persistedUiLanguage = getPersistedUiLanguage()
if (persistedUiLanguage) {
  void i18n.changeLanguage(persistedUiLanguage)
}
// Note: deferred startup log lives below where mainLog is available (after log.initialize()).

// Set anonymous machine ID for Sentry user tracking (no PII — just a hash).
// Uses hostname + homedir to produce a stable per-machine identifier.
const machineId = createHash('sha256').update(hostname() + homedir()).digest('hex').slice(0, 16)
Sentry.setUser({ id: machineId })

function redactBrowserUrl(value: string): string {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

import { join, delimiter } from 'path'
import { existsSync, readFileSync } from 'fs'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@mortise/server-core/sessions'
import { createAutomationWorkspaceCapabilityProvider, createBrowserCommandProvider, createBrowserControlProvider, createBrowserOperationsProvider, createBrowserProvider, createFilePreviewProvider, createFilesProvider, createMessagingSessionCapabilityProvider, createSessionShareCapabilityProvider, createSessionTransferCapabilityProvider, createSystemNotificationProvider, getWorkspaceAllowedDirs, validateFilePath } from '@mortise/server-core'
import { executeAutomationWorkspaceOperationV1 } from '@mortise/server-core/handlers/rpc/automations'
import { registerAutomationWorkspaceRpcHandlers } from '@mortise/server-core/handlers'
import { AutomationIngressTokenRegistry, createAutomationIngressHandler } from '@mortise/server-core/services'
import { nodeHttpAdapter } from '@mortise/server-core/webui'
import { registerAllRpcHandlers } from './handlers/index'
import { registerCoreRpcHandlers, cleanupClientFileWatches } from '@mortise/server-core/handlers/rpc'
import type { PlatformServices } from '../runtime/platform'
import { createElectronPlatform } from './platform'
import type { HandlerDeps } from './handlers/handler-deps'
import {
  bootstrapServer,
  publishServerEndpoint,
  readLiveServerConnection,
  releaseServerLock,
  removeServerEndpoint,
} from '@mortise/server-core/bootstrap'
import { createMessagingBootstrap, type MessagingBootstrapHandle } from '@mortise/messaging-gateway'
import { getCredentialManager } from '@mortise/shared/credentials'
import { initModelRefreshService, getModelRefreshService, setFetcherPlatform } from '@mortise/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@mortise/server-core/services'
import { createApplicationMenu } from './menu'
import { WindowManager } from './window-manager'
import { resolveInitialWindowTarget } from './initial-window-target'
import { routes } from '../shared/routes'
import { LayoutCoordinator } from './layout-coordinator'
import { loadWindowState, saveWindowState } from './window-state'
import { getWorkspaces, getWorkspaceByNameOrId, loadStoredConfig, addWorkspace, saveConfig, CONFIG_DIR } from '@mortise/shared/config'
import { getDefaultWorkspacesDir } from '@mortise/shared/workspaces'
import { initializeDocs } from '@mortise/shared/docs'
import { ensureDefaultPermissions } from '@mortise/shared/agent/permissions-config'
import { ensureToolIcons, ensurePresetThemes } from '@mortise/shared/config'
import { setBundledAssetsRoot, writeRuntimeLog } from '@mortise/shared/utils'
import { initializeBackendHostRuntime } from '@mortise/shared/agent/backend'
import { setPowerShellValidatorRoot } from '@mortise/shared/agent'
import { handleDeepLink } from './deep-link'
import { BrowserPaneManager } from './browser-pane-manager'
import { createBrowserCapabilityAdapter } from './browser-capability-adapter'
import { registerThumbnailScheme, registerThumbnailHandler } from './thumbnail-protocol'
import log, { isDebugMode, mainLog, getLogFilePath, getMessagingGatewayLogFilePath, messagingGatewayLog, autoUpdateLog } from './logger'
import { setPerfEnabled, enableDebug } from '@mortise/shared/utils'
import { initNotificationService, initBadgeIcon, initInstanceBadge, updateBadgeCount, showNotification } from './notifications'
import { setAutoUpdateEventSink, isUpdating, setBeforeUpdateQuitHook } from './auto-update'
import type { EventSink } from '@mortise/server-core/transport'
import { validateGitBashPath, checkVCRedistInstalled } from '@mortise/server-core/services'
import { PRELOAD_LOCAL_CHANNELS } from '../shared/ipc-channels'
import { spawnWorkspaceServer, type SpawnedWorkspaceServer } from './workspace-server-spawner'
import { resolveElectronResourcePaths } from './electron-resource-paths'
const isPackagedDeveloperHost = __MORTISE_DEV_HOST_BUILD__ && app.isPackaged
process.env.MORTISE_PROCESS_ROLE ??= 'electron-main'
process.env.MORTISE_BACKEND_KIND ??= 'electron'
process.env.MORTISE_PRODUCT_VERSION ??= app.getVersion()
process.env.MORTISE_BUILD_ID ??= process.env.MORTISE_UI_BUILD_ID ?? `${app.isPackaged ? 'packaged' : 'source'}:${app.getVersion()}`
writeRuntimeLog('info', { scope: 'process', event: 'started', data: { argv0: process.argv0 } })
process.once('exit', code => writeRuntimeLog('info', { scope: 'process', event: 'finished', data: { exitCode: code } }))

if (__MORTISE_UI_VALIDATION_BUILD__ && process.env.MORTISE_UI_TEST_HOST === '1' && ((!app.isPackaged && process.env.NODE_ENV !== 'production') || isPackagedDeveloperHost)) {
  const isolatedElectronData = process.env.MORTISE_UI_ELECTRON_USER_DATA_DIR
  if (!isolatedElectronData) throw new Error('MORTISE_UI_ELECTRON_USER_DATA_DIR is required for UI validation runs.')
  app.setPath('userData', isolatedElectronData)
}

// Initialize electron-log for renderer process support
log.initialize()

const electronResourcePaths = resolveElectronResourcePaths({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  bundledAssetsRoot: __dirname,
  sourceResourcesPath: process.env.MORTISE_UI_RUNTIME_RESOURCES_DIR,
})

// Host-capability tools are Pi extensions, explicitly injected into every Mortise runtime.
process.env.MORTISE_BROWSER_EXTENSION_PATH = electronResourcePaths.browserExtensionPath
process.env.MORTISE_MESSAGING_EXTENSION_PATH = electronResourcePaths.messagingExtensionPath

// Diagnostic: report main-process i18n hydration result. We log here (not inline
// at the hydration site above) because mainLog is only available after this point.
mainLog.info('[i18n] startup hydration', {
  persistedUiLanguage: persistedUiLanguage ?? null,
  resolvedLanguageAfterHydration: i18n.resolvedLanguage ?? null,
})

// Enable debug/perf in dev mode (running from source)
if (isDebugMode) {
  process.env.MORTISE_DEBUG = '1'
  enableDebug()
  setPerfEnabled(true)
}

// Bundle CLI tools: resolve platform-specific uv binary and wrapper scripts.
// These are available to all agent Bash sessions via MORTISE_UV, MORTISE_SCRIPTS env vars
// and PATH prepend. uv auto-downloads Python 3.12 on first use (~5s, then cached).
{
  const platformKey = `${process.platform}-${process.arch}`
  const uvPlatformDir = join(electronResourcePaths.toolResourcesPath, 'bin', platformKey)
  const uvBinary = join(uvPlatformDir, process.platform === 'win32' ? 'uv.exe' : 'uv')
  const binDir = join(electronResourcePaths.toolResourcesPath, 'bin')
  const scriptsDir = join(electronResourcePaths.toolResourcesPath, 'scripts')

  const bundledUvExists = existsSync(uvBinary)
  const fallbackUv = bundledUvExists ? null : 'uv'

  // Runtime resolver hints for shared session tools
  process.env.MORTISE_IS_PACKAGED = app.isPackaged ? '1' : '0'
  process.env.MORTISE_RESOURCES_BASE = process.env.MORTISE_UI_RUNTIME_RESOURCES_BASE
    ?? (app.isPackaged ? app.getAppPath() : join(__dirname, '..'))
  process.env.MORTISE_APP_ROOT = process.env.MORTISE_UI_RUNTIME_APP_ROOT
    ?? (app.isPackaged ? app.getAppPath() : process.cwd())

  process.env.MORTISE_UV = bundledUvExists ? uvBinary : (fallbackUv ?? uvBinary)

  // Bun runtime (packaged builds should prefer bundled runtime over PATH)
  if (electronResourcePaths.bunBinaryPath) {
    process.env.MORTISE_BUN = electronResourcePaths.bunBinaryPath
  }

  process.env.MORTISE_SCRIPTS = scriptsDir
  delete process.env.MORTISE_COMMANDS_ENTRY
  delete process.env.MORTISE_CLI_ENTRY
  process.env.MORTISE_COMMANDS_DOC_PATH = electronResourcePaths.commandDocsPath
  process.env.MORTISE_CLI_DOC_PATH = process.env.MORTISE_COMMANDS_DOC_PATH
  process.env.MORTISE_AGENT_VERSION = app.getVersion()
  // Prepend both generic wrappers dir and platform uv dir:
  // - binDir exposes wrapper commands (pdf-tool, docx-tool, ...)
  // - uvPlatformDir exposes raw `uv` for direct shell usage / debugging
  process.env.PATH = `${binDir}${delimiter}${uvPlatformDir}${delimiter}${process.env.PATH}`

  if (!bundledUvExists) {
    mainLog.warn('Bundled uv binary missing, CLI document tools may fail unless uv is available on PATH.', {
      expectedUvPath: uvBinary,
      usingCraftUv: process.env.MORTISE_UV,
    })
  }

  if (isDebugMode) {
    mainLog.info('CLI tools configured:', { uvBinary: process.env.MORTISE_UV, binDir, scriptsDir, bundledUvExists })
  }
}

// Custom URL scheme for deeplinks (e.g., mortise://auth-complete)
// Supports multi-instance dev: MORTISE_DEEPLINK_SCHEME env var (mortise1, mortise2, etc.)
const DEEPLINK_SCHEME = process.env.MORTISE_DEEPLINK_SCHEME || 'mortise'

let windowManager: WindowManager | null = null
let layoutCoordinator: LayoutCoordinator | null = null
let sessionManager: SessionManager | null = null
let browserPaneManager: BrowserPaneManager | null = null
let moduleSink: EventSink | null = null
let moduleClientResolver: ((webContentsId: number) => string | undefined) | null = null
let uiTestHost: { url: string; close(): Promise<void> } | null = null
let workspaceServer: SpawnedWorkspaceServer | null = null

// Messaging gateway: the bootstrap handle is created once sessionManager is
// available (inside createHandlerDeps) and populated with the WS publisher
// after bootstrapServer resolves. Both hosts (Electron + standalone) wire
// through createMessagingBootstrap — do not construct MessagingGatewayRegistry
// directly.
let messagingHandle: MessagingBootstrapHandle | null = null
const automationIngressTokens = new AutomationIngressTokenRegistry()
let automationWorkspaceDispatcher: import('@mortise/server-core/services').AutomationWorkspaceDispatcherV1 | null = null

// Store pending deep link if app not ready yet (cold start)
let pendingDeepLink: string | null = null

// Set app name early (before app.whenReady) to ensure correct macOS menu bar title
// Supports multi-instance dev: MORTISE_APP_NAME env var (e.g., "Mortise [1]")
app.setName(process.env.MORTISE_APP_NAME || (__MORTISE_DEV_HOST_BUILD__ ? 'Mortise Developer Host' : 'Mortise'))

// Register as default protocol client for mortise:// URLs
// This must be done before app.whenReady() on some platforms
if (__MORTISE_DEV_HOST_BUILD__ || (__MORTISE_UI_VALIDATION_BUILD__ && process.env.MORTISE_UI_TEST_HOST === '1')) {
  mainLog.info('Skipping mortise:// protocol registration in the isolated validation host')
} else if (process.defaultApp) {
  // Development mode: need to pass the app path
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [process.argv[1]])
  }
} else {
  // Production mode
  app.setAsDefaultProtocolClient(DEEPLINK_SCHEME)
}

// Apply network proxy settings early (Node-level only — Electron sessions require app.whenReady)
import { applyConfiguredProxySettings } from './network-proxy'
import {
  BeforeQuitGate,
  captureRecoverableWindowSnapshot,
  closeRendererWindowsGracefully,
  restoreRecoverableWindows,
  runCommittedExit,
} from './application-exit'
void applyConfiguredProxySettings()

// Thin-client mode may explicitly opt into a self-signed certificate. The
// bypass remains origin-scoped; normal and workspace-configured connections
// use WsRpcClient's per-connection TLS policy instead.
//
// Electron's certificate-error always reports URLs with https:// scheme, so we normalize
// wss:// → https:// (and ws:// → http://) to ensure origins compare correctly.
function normalizeOriginForCert(urlStr: string): string {
  const u = new URL(urlStr)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  else if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.origin
}

if (process.env.MORTISE_SERVER_URL && process.env.MORTISE_ALLOW_INSECURE_TLS === '1') {
  let serverOrigin: string | undefined
  try {
    serverOrigin = normalizeOriginForCert(process.env.MORTISE_SERVER_URL)
  } catch {
    // Invalid URL — will fail later during connection, no need to handle here
  }
  if (serverOrigin) {
    app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
      try {
        if (normalizeOriginForCert(url) === serverOrigin) {
          event.preventDefault()
          callback(true)
          return
        }
      } catch {
        // URL parse failure — fall through to default rejection
      }
      callback(false)
    })
  }
}

// Register thumbnail:// custom protocol for file preview thumbnails in the sidebar.
// Must happen before app.whenReady() — Electron requires early scheme registration.
registerThumbnailScheme()

// Handle deeplink on macOS (when app is already running)
app.on('open-url', (event, url) => {
  event.preventDefault()
  mainLog.info('Received deeplink:', url)

  if (windowManager) {
    handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
      mainLog.error('Failed to handle deep link:', err)
    })
  } else {
    // App not ready - store for later
    pendingDeepLink = url
  }
})

// Handle deeplink on Windows/Linux (single instance check)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine, _workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    // On Windows/Linux, the deeplink is in commandLine
    const url = commandLine.find(arg => arg.startsWith(`${DEEPLINK_SCHEME}://`))
    if (url && windowManager) {
      mainLog.info('Received deeplink from second instance:', url)
      handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
        mainLog.error('Failed to handle deep link:', err)
      })
    } else if (windowManager) {
      // No deep link - just focus the first window
      const windows = windowManager.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0].window
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    }
  })
}

// Helper to create initial windows on startup
async function createInitialWindows(): Promise<void> {
  if (!windowManager) return

  // Load saved window state
  const savedState = loadWindowState()
  let workspaces = getWorkspaces()

  // If no workspaces exist, create default "My Workspace" on first run
  if (workspaces.length === 0) {
    // Ensure config file exists (addWorkspace requires it)
    if (!loadStoredConfig()) {
      saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null })
    }
    const defaultPath = join(getDefaultWorkspacesDir(), 'my-workspace')
    addWorkspace({ rootPath: defaultPath, name: 'My Workspace' })
    workspaces = getWorkspaces() // Refresh after creation
    mainLog.info('Created default workspace on first run')
  }

  const validWorkspaceIds = workspaces.map(ws => ws.id)

  if (savedState?.windows.length) {
    // Restore windows from saved state
    let restoredCount = 0

    for (const saved of savedState.windows) {
      // Skip invalid workspaces
      if (!validWorkspaceIds.includes(saved.workspaceId)) continue

      // Restore main window with focused mode if it was saved
      mainLog.info(`Restoring window: workspaceId=${saved.workspaceId}, focused=${saved.focused ?? false}, url=${saved.url ?? 'none'}`)
      const win = windowManager.createWindow({
        workspaceId: saved.workspaceId,
        focused: saved.focused,
        restoreUrl: saved.url,
        initialRoute: routes.view.newConversation(),
      })
      win.setBounds(saved.bounds)

      restoredCount++
    }

    if (restoredCount > 0) {
      mainLog.info(`Restored ${restoredCount} window(s) from saved state`)
      return
    }
  }

  const storedConfig = loadStoredConfig()
  const target = resolveInitialWindowTarget({
    workspaces,
    sessions: sessionManager?.getSessions() ?? [],
    activeWorkspaceId: storedConfig?.activeWorkspaceId,
    activeSessionId: storedConfig?.activeSessionId,
  })
  if (!target) return

  windowManager.createWindow({
    workspaceId: target.workspaceId,
    initialRoute: routes.view.newConversation(),
  })
  mainLog.info('Created initial workspace window', target)
}

app.whenReady().then(async () => {
  // Export packaged state as env var so logger.ts (and headless Bun) don't need 'electron'
  process.env.MORTISE_IS_PACKAGED = app.isPackaged ? 'true' : 'false'

  // Register bundled assets root so all seeding functions can find their files
  // (docs, permissions, themes, tool-icons resolve via getBundledAssetsDir)
  setBundledAssetsRoot(__dirname)

  // Initialize backend runtime bootstrapping (Codex vendor root, Pi agent server paths).
  initializeBackendHostRuntime({
    hostRuntime: {
      appRootPath: process.env.MORTISE_UI_RUNTIME_APP_ROOT ?? (app.isPackaged ? app.getAppPath() : process.cwd()),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    },
  })

  // Register PowerShell validator root so it can find the bundled parser script
  // (Windows only: validates PowerShell commands in Explore mode using AST analysis)
  setPowerShellValidatorRoot(join(__dirname, 'resources'))

  // Initialize bundled docs
  initializeDocs()

  // Ensure default permissions file exists (copies bundled default.json on first run)
  ensureDefaultPermissions()

  // Seed tool icons to ~/.mortise/tool-icons/ (copies bundled SVGs on first run)
  ensureToolIcons()

  // Seed preset themes to ~/.mortise/themes/ (copies bundled theme JSONs on first run)
  ensurePresetThemes()

  // Register thumbnail:// protocol handler (scheme was registered earlier, before app.whenReady)
  registerThumbnailHandler()

  // Re-apply proxy settings now that Electron sessions are available
  // (first call before app.whenReady only configured Node-level proxy)
  await applyConfiguredProxySettings()

  // Note: electron-updater handles pending updates internally via autoInstallOnAppQuit

  // Application menu is created after windowManager initialization (see below)

  // Set dock icon on macOS (required for dev mode, bundled apps use Info.plist)
  if (process.platform === 'darwin' && app.dock) {
    // In packaged app, resources are at dist/resources/ (same level as __dirname)
    // In dev, resources are at ../resources/ (sibling of dist/)
    const dockIconPath = [
      join(__dirname, 'resources/icon.png'),
      join(__dirname, '../resources/icon.png'),
    ].find(p => existsSync(p))

    if (dockIconPath) {
      app.dock.setIcon(dockIconPath)
      // Initialize badge icon for canvas-based badge overlay
      initBadgeIcon(dockIconPath)
    }

    // Multi-instance dev: show instance number badge on dock icon
    // MORTISE_INSTANCE_NUMBER is set by detect-instance.sh for numbered folders
    const instanceNum = process.env.MORTISE_INSTANCE_NUMBER
    if (instanceNum) {
      const num = parseInt(instanceNum, 10)
      if (!isNaN(num) && num > 0) {
        initInstanceBadge(num)
      }
    }
  }

  try {
    // Initialize window manager
    windowManager = new WindowManager(
      __MORTISE_UI_VALIDATION_BUILD__
        && process.env.MORTISE_UI_TEST_HOST === '1'
        && process.env.MORTISE_UI_WINDOW_MODE === 'background',
    )
    layoutCoordinator = new LayoutCoordinator({
      authorizeContentRef: ref => ref.workspaceId === '' || !!getWorkspaceByNameOrId(ref.workspaceId),
      resolveServerId: workspaceId => {
        if (!workspaceId) return 'local'
        const workspace = getWorkspaceByNameOrId(workspaceId)
        return workspace ? workspace.remoteServer?.url ?? 'local' : undefined
      },
    })
    windowManager.setAuxiliaryClosedHandler((windowId, workspaceId) => {
      layoutCoordinator?.redockWindow(windowId, workspaceId)
    })

    // Create the application menu (needs windowManager for New Window action)
    createApplicationMenu(windowManager)

    // Launcher scripts normally configure thin-client mode before Electron
    // starts. Keep a source-development fallback here so direct Electron
    // launches also reuse the backend that owns this config directory.
    if (!app.isPackaged && !process.env.MORTISE_SERVER_URL) {
      const sharedBackend = await readLiveServerConnection()
      if (sharedBackend) {
        process.env.MORTISE_SERVER_URL = sharedBackend.endpoint.url
        process.env.MORTISE_SERVER_TOKEN = sharedBackend.token
        mainLog.info(`Reusing shared backend PID ${sharedBackend.endpoint.pid} at ${sharedBackend.endpoint.url}`)
      }
    }

    // When MORTISE_SERVER_URL is set, this Electron instance is a thin client —
    // it only creates windows whose preload connects to the remote server.
    // Skip server-side initialization (SessionManager, model refresh, platform injection).
    const isClientOnly = !!process.env.MORTISE_SERVER_URL
    const isHeadless = !!process.env.MORTISE_HEADLESS

    if (isClientOnly) {
      mainLog.info(`Client-only mode: MORTISE_SERVER_URL=${process.env.MORTISE_SERVER_URL} (server initialization skipped)`)
    }

    // Initialize notification service (always — triggered by server push events)
    initNotificationService(windowManager)

    // Initialize browser pane manager (always — even in headless, for deps wiring)
    browserPaneManager = new BrowserPaneManager()
    browserPaneManager.setWindowManager(windowManager)
    windowManager.setWorkspaceChangingHandler((webContentsId) => {
      browserPaneManager?.detachAllFromHost(webContentsId)
    })
    browserPaneManager.registerToolbarIpc()
    browserPaneManager.registerCapabilityIpc()

    // Build real PlatformServices from Electron APIs
    const platform: PlatformServices = createElectronPlatform({
      app,
      nativeImage,
      shell,
      nativeTheme,
      logger: log,
      isDebugMode,
      getLogFilePath,
      captureError: (err) => Sentry.captureException(err),
    })

    // Bootstrap IPC handlers — preload uses sendSync for window-local details
    ipcMain.on('__get-web-contents-id', (e) => {
      e.returnValue = e.sender.id
    })
    ipcMain.on('__get-workspace-id', (e) => {
      e.returnValue = windowManager?.getWorkspaceForWindow(e.sender.id) ?? ''
    })

    // Transport diagnostics bridge — preload reports remote WS connection state changes
    // so failures are visible in terminal/main.log (not only renderer console).
    ipcMain.on(PRELOAD_LOCAL_CHANNELS.TRANSPORT_STATUS, (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        level?: 'info' | 'warn' | 'error'
        message?: string
        status?: string
        attempt?: number
        nextRetryInMs?: number
        error?: unknown
        close?: unknown
        url?: string
      }

      const level = p.level ?? 'info'
      const message = p.message ?? '[transport] status update'
      const context = {
        status: p.status,
        attempt: p.attempt,
        nextRetryInMs: p.nextRetryInMs,
        error: p.error,
        close: p.close,
        url: p.url,
      }

      if (level === 'error') {
        mainLog.error(message, context)
      } else if (level === 'warn') {
        mainLog.warn(message, context)
      } else {
        mainLog.info(message, context)
      }
    })

    if (__MORTISE_UI_VALIDATION_BUILD__) {
      const { installUiValidationStateBridge } = await import('./ui-validation.dev')
      installUiValidationStateBridge({
        enabled: process.env.MORTISE_UI_TEST_HOST === '1',
        isPackaged: app.isPackaged,
        allowPackagedDevHost: __MORTISE_DEV_HOST_BUILD__,
      })
    }

    // Dialog bridge — preload capability handlers use ipcRenderer.invoke to
    // call main-process-only dialog APIs (dialog, BrowserWindow).
    ipcMain.handle(PRELOAD_LOCAL_CHANNELS.DIALOG_SHOW_MESSAGE_BOX, async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showMessageBox(win, spec)
      return { response: result.response }
    })
    ipcMain.handle('__dialog:showOpenDialog', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win, spec)
      return { canceled: result.canceled, filePaths: result.filePaths }
    })

    if (!isClientOnly) {
      // Restore persisted Git Bash path on Windows (must happen before any SDK subprocess spawn)
      if (process.platform === 'win32') {
        const { getGitBashPath, clearGitBashPath } = await import('@mortise/shared/config')
        const gitBashPath = getGitBashPath()
        if (gitBashPath) {
          const validation = await validateGitBashPath(gitBashPath)
          if (validation.valid) {
            process.env.CLAUDE_CODE_GIT_BASH_PATH = validation.path
          } else {
            clearGitBashPath()
            delete process.env.CLAUDE_CODE_GIT_BASH_PATH
            mainLog.warn(`Cleared invalid persisted Git Bash path: ${gitBashPath}`)
          }
        }
      }

      // Check for VC++ Redistributable on Windows (required by onnxruntime / markitdown).
      // Without it, document conversion tools (PDF, PPTX, DOCX, XLSX) crash with DLL errors.
      // Sets env var so renderer can show an actionable toast with install button.
      if (process.platform === 'win32') {
        const vcCheck = checkVCRedistInstalled()
        if (!vcCheck.installed) {
          mainLog.warn('[vcredist]', vcCheck.message)
          process.env.MORTISE_VCREDIST_MISSING = '1'
          if (vcCheck.downloadUrl) {
            process.env.MORTISE_VCREDIST_URL = vcCheck.downloadUrl
          }
        } else if (isDebugMode) {
          mainLog.info('[vcredist]', vcCheck.message)
        }
      }

      // Pre-import power manager (async import needed for applyPlatformToSubsystems)
      const { onSessionStarted, onSessionStopped } = await import('./power-manager')

      // Client ID tracking for Electron IPC bridge (webContentsId → clientId)
      const clientMap = new Map<number, string>()
      const resolveClientId = (wcId: number) => clientMap.get(wcId)

      // Read embedded server config (Server settings page)
      const { getServerConfig } = await import('@mortise/shared/config')
      const embeddedServerConfig = getServerConfig()
      const serverModeEnabled = embeddedServerConfig.enabled && !isClientOnly

      // Derive host/port/token from server config (or env overrides)
      const serverToken = serverModeEnabled && embeddedServerConfig.token
        ? embeddedServerConfig.token
        : randomUUID()
      const rpcHost = process.env.MORTISE_RPC_HOST
        ?? (serverModeEnabled ? '0.0.0.0' : '127.0.0.1')
      const rpcPort = process.env.MORTISE_RPC_PORT
        ? parseInt(process.env.MORTISE_RPC_PORT, 10)
        : (serverModeEnabled ? embeddedServerConfig.port : 0)

      // Load TLS certificates if configured
      let tls: import('@mortise/server-core/transport').WsRpcTlsOptions | undefined
      if (serverModeEnabled && embeddedServerConfig.tlsCertPath && embeddedServerConfig.tlsKeyPath) {
        try {
          tls = {
            cert: readFileSync(embeddedServerConfig.tlsCertPath),
            key: readFileSync(embeddedServerConfig.tlsKeyPath),
          }
          mainLog.info('[server-mode] TLS enabled')
        } catch (err) {
          mainLog.error('[server-mode] Failed to load TLS certificates:', err)
        }
      }

      if (serverModeEnabled) {
        mainLog.info(`[server-mode] Enabled — binding ${rpcHost}:${rpcPort}${tls ? ' (TLS)' : ''}`)
      }

      const automationIngressHandler = createAutomationIngressHandler({
        tokens: automationIngressTokens,
        workspaceExists: workspaceId => Boolean(getWorkspaceByNameOrId(workspaceId)),
        dispatcher: {
          execute: (workspaceId, command, context) => {
            if (!automationWorkspaceDispatcher) throw new Error('Automation dispatcher is still starting')
            return automationWorkspaceDispatcher.execute(workspaceId, command, context)
          },
        },
      })

      // Bootstrap the WS RPC server via shared bootstrap function.
      const instance = await bootstrapServer<SessionManager, HandlerDeps>({
        serverToken,
        rpcHost,
        rpcPort,
        tls,
        bundledAssetsRoot: __dirname,
        serverId: 'local',
        serverVersion: app.getVersion(),
        httpHandler: nodeHttpAdapter(async (request, context) =>
          await automationIngressHandler(request, context.peerAddress)
            ?? new Response('Not Found', { status: 404 })),
        authorizeWorkspace: ({ workspaceId, webContentsId, phase }) => {
          if (!workspaceId) return true
          if (!getWorkspaceByNameOrId(workspaceId)) return false

          if ((phase === 'handshake' || phase === 'reconnect') && webContentsId != null && windowManager) {
            const windowWorkspaceId = windowManager.getWorkspaceForWindow(webContentsId)
            return !windowWorkspaceId || windowWorkspaceId === workspaceId
          }

          return true
        },
        platformFactory: () => platform,
        applyPlatformToSubsystems: (p) => {
          setFetcherPlatform(p)
          setSessionPlatform(p)
          setSessionRuntimeHooks({
            updateBadgeCount,
            onSessionStarted,
            onSessionStopped,
            captureException: (error, context) => {
              Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
                tags: {
                  ...(context?.errorSource ? { errorSource: context.errorSource } : {}),
                  ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
                },
              })
            },
          })
          setSearchPlatform(p)
          setImageProcessor(p.imageProcessor)
        },
        createSessionManager: () => {
          const sm = new SessionManager()
          if (isHeadless) return sm
          sm.setBrowserPaneManager(browserPaneManager!)
          sm.setCapabilityPrompt(async (request) => {
            const result = await dialog.showMessageBox({
              type: 'question',
              title: 'Extension permission',
              message: `Allow ${request.extensionId} to use ${request.capability}?`,
              detail: `Operation: ${request.operation}\nSession: ${request.sessionId}`,
              buttons: ['Deny', 'Allow'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
            return result.response === 1
          })
          sm.registerCapabilityProvider(createSystemNotificationProvider(async ({ title, body }, route) => {
            const session = await sm.getSession(route.sessionId)
            showNotification(title, body, session?.workspaceId ?? '', route.sessionId)
          }))
          sm.registerCapabilityProvider(createFilesProvider(async ({ title, mode = 'file', multiple = false, extensions }) => {
            const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [mode === 'directory' ? 'openDirectory' : 'openFile']
            if (multiple) properties.push('multiSelections')
            const result = await dialog.showOpenDialog({
              title,
              properties,
              ...(extensions?.length ? { filters: [{ name: 'Allowed files', extensions }] } : {}),
            })
            return { cancelled: result.canceled, paths: result.filePaths }
          }))
          sm.registerCapabilityProvider(createFilePreviewProvider(async ({ path, maxBytes }, route) => {
            const session = await sm.getSession(route.sessionId)
            if (!session) throw new Error('Session not found')
            const safePath = await validateFilePath(path, getWorkspaceAllowedDirs(session.workspaceId))
            const { readFile, stat } = await import('fs/promises')
            const info = await stat(safePath)
            if (!info.isFile()) throw new Error('Preview path must be a file')
            if (info.size > maxBytes) throw new Error(`Preview exceeds ${maxBytes} bytes`)
            const ext = safePath.split('.').pop()?.toLowerCase() ?? ''
            const mimeType = ({
              png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
              webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
              avif: 'image/avif', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
            } as Record<string, string>)[ext] ?? 'application/octet-stream'
            const buffer = await readFile(safePath)
            return { mimeType, size: buffer.byteLength, dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` }
          }))
          sm.registerCapabilityProvider(createBrowserProvider(async ({ url, focus }, route) => {
            const session = await sm.getSession(route.sessionId)
            if (!session) throw new Error('Session not found')
            const instanceId = await browserPaneManager!.getOrCreateForSessionAsync(route.sessionId, { workspaceId: session.workspaceId })
            const navigated = await browserPaneManager!.navigate(instanceId, url)
            if (focus) browserPaneManager!.focus(instanceId)
            return { instanceId, ...navigated }
          }))
          sm.registerCapabilityProvider(createBrowserControlProvider(async (operation, { instanceId }, route) => {
            const instance = await browserPaneManager!.getInstanceAsync(instanceId)
            if (!instance || instance.ownerSessionId !== route.sessionId) {
              throw new Error('Browser instance is not owned by this session')
            }
            switch (operation) {
              case 'back': await browserPaneManager!.goBack(instanceId); break
              case 'forward': await browserPaneManager!.goForward(instanceId); break
              case 'focus': browserPaneManager!.focus(instanceId); break
              case 'hide': browserPaneManager!.hide(instanceId); break
              case 'close': browserPaneManager!.destroyInstance(instanceId); break
            }
          }))
          sm.registerCapabilityProvider(createBrowserCommandProvider(
            async ({ sessionId }) => {
              const session = await sm.getSession(sessionId)
              if (!session) return undefined
              return createBrowserCapabilityAdapter(browserPaneManager!, sessionId, session.workspaceId)
            },
            async (image, { sessionId }) => {
              const sessionPath = sm.getSessionPath(sessionId)
              if (!sessionPath) throw new Error('Session not found')
              const { mkdir, writeFile } = await import('fs/promises')
              const artifactsDir = join(sessionPath, 'artifacts')
              await mkdir(artifactsDir, { recursive: true })
              const extension = image.mimeType === 'image/jpeg' ? 'jpg' : 'png'
              const path = join(artifactsDir, `browser-${randomUUID()}.${extension}`)
              await writeFile(path, Buffer.from(image.data, 'base64'))
              return { path }
            },
          ))
          sm.registerCapabilityProvider(createBrowserOperationsProvider(async (operation, input, route) => {
            const instanceId = String(input.instanceId)
            const instance = await browserPaneManager!.getInstanceAsync(instanceId)
            if (!instance || instance.ownerSessionId !== route.sessionId) throw new Error('Browser instance is not owned by this session')
            if (route.signal.aborted) throw route.signal.reason
            switch (operation) {
              case 'snapshot': return browserPaneManager!.getAccessibilitySnapshot(instanceId)
              case 'click': await browserPaneManager!.clickElement(instanceId, String(input.ref), { waitFor: input.waitFor as 'none' | 'navigation' | 'network-idle' | undefined, timeoutMs: input.timeoutMs as number | undefined }); return { completed: true }
              case 'click-at': await browserPaneManager!.clickAtCoordinates(instanceId, Number(input.x), Number(input.y)); return { completed: true }
              case 'drag': await browserPaneManager!.drag(instanceId, Number(input.x1), Number(input.y1), Number(input.x2), Number(input.y2)); return { completed: true }
              case 'fill': await browserPaneManager!.fillElement(instanceId, String(input.ref), String(input.value)); return { completed: true }
              case 'type': await browserPaneManager!.typeText(instanceId, String(input.text)); return { completed: true }
              case 'select': await browserPaneManager!.selectOption(instanceId, String(input.ref), String(input.value)); return { completed: true }
              case 'screenshot': {
                const result = await browserPaneManager!.screenshot(instanceId, { format: input.format as 'png' | 'jpeg' | undefined, jpegQuality: input.jpegQuality as number | undefined, annotate: input.annotate as boolean | undefined })
                return { format: result.imageFormat, dataUrl: `data:image/${result.imageFormat};base64,${result.imageBuffer.toString('base64')}`, metadata: result.metadata }
              }
              case 'screenshot-region': {
                const result = await browserPaneManager!.screenshotRegion(instanceId, input as never)
                return { format: result.imageFormat, dataUrl: `data:image/${result.imageFormat};base64,${result.imageBuffer.toString('base64')}`, metadata: result.metadata }
              }
              case 'wait': return browserPaneManager!.waitFor(instanceId, { kind: input.kind as 'selector' | 'text' | 'url' | 'network-idle', value: input.value as string | undefined, timeoutMs: input.timeoutMs as number | undefined })
              case 'key': await browserPaneManager!.sendKey(instanceId, { key: String(input.key), modifiers: input.modifiers as Array<'shift' | 'control' | 'alt' | 'meta'> | undefined }); return { completed: true }
              case 'scroll': await browserPaneManager!.scroll(instanceId, input.direction as 'up' | 'down' | 'left' | 'right', input.amount as number | undefined); return { completed: true }
              case 'console': return browserPaneManager!.getConsoleLogs(instanceId, { level: input.level as never, limit: input.limit as number | undefined }).map(entry => ({ timestamp: entry.timestamp, level: entry.level, message: entry.message.slice(0, 10_000) }))
              case 'network': return browserPaneManager!.getNetworkLogs(instanceId, { status: input.status as never, method: input.method as string | undefined, resourceType: input.resourceType as string | undefined, limit: input.limit as number | undefined }).map(entry => ({ ...entry, url: redactBrowserUrl(entry.url) }))
              case 'downloads': return (await browserPaneManager!.getDownloads(instanceId, { action: input.action as never, limit: input.limit as number | undefined, timeoutMs: input.timeoutMs as number | undefined })).map(({ savePath: _savePath, url, ...entry }) => ({ ...entry, url: redactBrowserUrl(url) }))
              case 'resize': return browserPaneManager!.windowResize(instanceId, Number(input.width), Number(input.height))
              case 'challenge': return browserPaneManager!.detectSecurityChallenge(instanceId)
            }
          }))
          sm.registerCapabilityProvider(createSessionShareCapabilityProvider({
            async status(sessionId: string) {
              const session = await sm.getSession(sessionId)
              if (!session) throw new Error('Session not found')
              return session.sharedUrl
                ? { published: true, url: session.sharedUrl }
                : { published: false }
            },
            publish: sessionId => sm.shareTransferService.publish(sessionId),
            refresh: sessionId => sm.shareTransferService.refresh(sessionId),
            revoke: sessionId => sm.shareTransferService.revoke(sessionId),
          }))
          sm.registerCapabilityProvider(createSessionTransferCapabilityProvider({
            async exportSummary(sessionId) {
              const session = await sm.getSession(sessionId)
              if (!session) throw new Error('Session not found')
              return sm.shareTransferService.exportSummary(sessionId, session.workspaceId)
            },
            async importSummary(sessionId, payload) {
              const session = await sm.getSession(sessionId)
              if (!session) throw new Error('Session not found')
              return sm.shareTransferService.importSummary(session.workspaceId, payload)
            },
          }))
          return sm
        },
        bindRpcServer: (sm, server) => sm.setRpcServer(server),
        createHandlerDeps: ({ sessionManager: sm, platform: p }) => {
          // The messaging handle is built here because it needs sessionManager.
          // The WS publisher is attached after bootstrapServer resolves (via
          // handle.setPublisher) because wsServer isn't available yet.
          messagingHandle = createMessagingBootstrap({
            sessionManager: sm,
            credentialManager: getCredentialManager(),
            getMessagingDir: (wsId: string) =>
              join(process.env.MORTISE_CONFIG_DIR || join(homedir(), '.mortise'), 'workspaces', wsId, 'messaging'),
            // Route messaging diagnostics through the dedicated messaging log
            // at ~/.mortise/logs/messaging-gateway.log.
            logger: messagingGatewayLog,
            // WhatsApp worker runs under Electron's embedded Node via
            // ELECTRON_RUN_AS_NODE (WhatsAppAdapter defaults nodeBin to
            // process.execPath). In dev we resolve worker.cjs from the
            // monorepo; in packaged builds it's shipped via extraResources
            // (see apps/electron/electron-builder.yml).
            whatsapp: {
              workerEntry: app.isPackaged
                ? join(process.resourcesPath, 'messaging-whatsapp-worker', 'worker.cjs')
                : join(process.cwd(), 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'),
              pairingMode: 'qr',
            },
          })
          const resolveCapabilitySession = async (sessionId: string) => {
            const session = await sm.getSession(sessionId)
            if (!session) throw new Error('Session not found')
            const workspace = getWorkspaceByNameOrId(session.workspaceId)
            if (!workspace) throw new Error('Workspace not found')
            return { session, workspace }
          }
          if (!isHeadless) sm.registerCapabilityProvider(createMessagingSessionCapabilityProvider({
            async status(sessionId: string) {
              const { session } = await resolveCapabilitySession(sessionId)
              const config = messagingHandle!.registry.getConfig(session.workspaceId)
              return {
                enabled: config?.enabled ?? false,
                platforms: Object.entries(config?.runtime ?? {}).flatMap(([platform, runtime]) => runtime ? [{
                  platform,
                  configured: runtime.configured,
                  connected: runtime.connected,
                  state: runtime.state,
                }] : []),
              }
            },
            async listBindings(sessionId) {
              const { session } = await resolveCapabilitySession(sessionId)
              return messagingHandle!.registry.getBindings(session.workspaceId)
                .filter(binding => binding.sessionId === sessionId)
                .map(binding => ({
                  id: binding.id,
                  platform: binding.platform,
                  channelId: binding.channelId,
                  ...(binding.threadId !== undefined ? { threadId: binding.threadId } : {}),
                  ...(binding.channelName ? { channelName: binding.channelName } : {}),
                  enabled: binding.enabled,
                  createdAt: binding.createdAt,
                }))
            },
            async pair(sessionId, platform) {
              const { session } = await resolveCapabilitySession(sessionId)
              return messagingHandle!.registry.generatePairingCode(session.workspaceId, sessionId, platform)
            },
            async unbind(sessionId, platform) {
              const { session } = await resolveCapabilitySession(sessionId)
              const before = messagingHandle!.registry.getBindings(session.workspaceId)
                .filter(binding => binding.sessionId === sessionId && (!platform || binding.platform === platform)).length
              messagingHandle!.registry.unbindSession(session.workspaceId, sessionId, platform)
              return { removed: before }
            },
          }))
          const automationCapabilityAdapter = {
            async execute(command: import('@mortise/shared/protocol').AutomationWorkspaceCommandV1, context: {
              sessionId: string
              eventSourceKind: 'agent' | 'extension'
            }) {
              const { workspace } = await resolveCapabilitySession(context.sessionId)
              return executeAutomationWorkspaceOperationV1({
                workspaceId: workspace.id,
                workspaceRootPath: workspace.rootPath,
                eventSourceKind: context.eventSourceKind,
                host: sm.getAutomationHost(workspace.id) ?? undefined,
              }, command)
            },
          }
          sm.registerCapabilityProvider(createAutomationWorkspaceCapabilityProvider(automationCapabilityAdapter))
          automationWorkspaceDispatcher = {
            async execute(workspaceId, command, context) {
              const workspace = getWorkspaceByNameOrId(workspaceId)
              if (!workspace) return { schemaVersion: 1, status: 'invalid', error: { code: 'workspace_not_found', message: 'Workspace not found', retryable: false } }
              return executeAutomationWorkspaceOperationV1({
                workspaceId: workspace.id,
                workspaceRootPath: workspace.rootPath,
                eventSourceKind: context.eventSourceKind,
                host: sm.getAutomationHost(workspace.id) ?? undefined,
              }, command)
            },
          }
          return {
            sessionManager: sm,
            platform: p,
            windowManager: windowManager ?? undefined,
            browserPaneManager: browserPaneManager ?? undefined,
            layoutCoordinator: layoutCoordinator ?? undefined,
            messagingRegistry: messagingHandle.registry,
          }
        },
        // Headless: register only core handlers (no GUI handlers for browser, settings, etc.)
        // GUI: register all handlers (core + GUI)
        registerAllRpcHandlers: (server, deps, serverCtx) => {
          if (isHeadless) registerCoreRpcHandlers(server, deps, serverCtx)
          else registerAllRpcHandlers(server, deps, serverCtx)
          registerAutomationWorkspaceRpcHandlers(server, {
            dispatcher: {
              execute: (workspaceId, command, context) => {
                if (!automationWorkspaceDispatcher) throw new Error('Automation dispatcher is still starting')
                return automationWorkspaceDispatcher.execute(workspaceId, command, context)
              },
            },
            tokens: automationIngressTokens,
          })
        },
        setSessionEventSink: (sm, sink) => sm.setEventSink(sink),
        initializeSessionManager: (sm) => sm.initialize(),
        initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
          const { getCredentialManager } = await import('@mortise/shared/credentials')
          const manager = getCredentialManager()
          const [apiKey, oauth] = await Promise.all([
            manager.getProviderApiKey(slug).catch(() => null),
            manager.getProviderOAuth(slug).catch(() => null),
          ])
          return {
            apiKey: apiKey ?? undefined,
            oauthAccessToken: oauth?.accessToken,
            oauthRefreshToken: oauth?.refreshToken,
            oauthIdToken: oauth?.idToken,
          }
        }),
        onClientConnected: ({ clientId, webContentsId }) => {
          if (webContentsId != null) clientMap.set(webContentsId, clientId)
        },
        cleanupClientResources: (clientId) => {
          for (const [wcId, cId] of clientMap) {
            if (cId === clientId) { clientMap.delete(wcId); break }
          }
          cleanupClientFileWatches(clientId)
        },
      })

      // Capture module-level references for before-quit cleanup and deep-link handlers
      sessionManager = instance.sessionManager
      moduleSink = instance.wsServer.push.bind(instance.wsServer)
      moduleClientResolver = resolveClientId
      for (const workspace of getWorkspaces()) {
        if (!workspace.remoteServer) automationIngressTokens.ensure(workspace.id)
      }
      layoutCoordinator?.setChangedHandler(layout => {
        moduleSink?.(RPC_CHANNELS.layout.CHANGED, { to: 'workspace', workspaceId: layout.workspaceId }, layout)
      })

      // -----------------------------------------------------------------------
      // Messaging Gateway — attach the WS publisher, init local workspaces,
      // install the fan-out event sink. The handle was created inside
      // createHandlerDeps so the registry could be wired into HandlerDeps.
      // -----------------------------------------------------------------------
      try {
        if (!messagingHandle) {
          throw new Error('Messaging handle was not constructed in createHandlerDeps')
        }

        messagingHandle.setPublisher(instance.wsServer.push.bind(instance.wsServer))

        // Skip remote-owned workspaces — messaging runs on the remote server.
        const localWorkspaceIds = getWorkspaces()
          .filter((ws) => !ws.remoteServer)
          .map((ws) => ws.id)
        await messagingHandle.initializeWorkspaces(localWorkspaceIds)

        // Compose fan-out event sink: RPC push + messaging gateway dispatch.
        // Always install — this lets workspaces enable messaging at runtime
        // without a process restart.
        const baseSink = instance.wsServer.push.bind(instance.wsServer)
        instance.sessionManager.setEventSink(messagingHandle.wrapSink(baseSink))
        if (messagingHandle.registry.size > 0) {
          mainLog.info(`[messaging] Fan-out sink active for ${messagingHandle.registry.size} workspace(s)`)
        }
      } catch (err) {
        mainLog.error('[messaging] Gateway initialization failed:', err)
      }

      // IPC handlers — preload uses sendSync to get WS connection details

      // Remove workspace from config (cleanup stale entries)
      ipcMain.handle(PRELOAD_LOCAL_CHANNELS.WORKSPACE_REMOVE, async (_event, workspaceId: string) => {
        const { removeWorkspace: remove } = await import('@mortise/shared/config')
        return remove(workspaceId)
      })

      // Cross-server RPC — invoke a channel on an arbitrary remote server
      ipcMain.handle(PRELOAD_LOCAL_CHANNELS.SERVER_INVOKE_ON_SERVER, async (
        _event,
        url: string,
        token: string,
        channel: string,
        connection: { allowInsecureTls?: boolean },
        ...args: unknown[]
      ) => {
        const { connectToRemote } = await import('./handlers/workspace')
        const { client, error } = await connectToRemote(url, token, connection)
        if (!client) throw new Error(error ?? 'Connection failed')
        try {
          return await client.invoke(channel, ...args)
        } finally {
          client.destroy()
        }
      })

      // Transfer session to another workspace — orchestrated in main process
      // so large bundles can be moved directly between owning servers.
      ipcMain.handle(PRELOAD_LOCAL_CHANNELS.SESSION_TRANSFER_TO_REMOTE_WORKSPACE, async (_event, sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) => {
        const idx = sessionIndex ?? 0
        const count = sessionCount ?? 1
        const { getWorkspaceByNameOrId } = await import('@mortise/shared/config')
        const { connectToRemote } = await import('./handlers/workspace')
        const { CHUNKED_TRANSFER_THRESHOLD, getChunkCount, invokeChunked, prepareChunkedPayload } = await import('./chunked-rpc')

        const targetWorkspace = getWorkspaceByNameOrId(targetWorkspaceId)
        if (!targetWorkspace?.remoteServer) throw new Error(`Workspace ${targetWorkspaceId} has no remote server`)
        if (!sessionManager) throw new Error('Session manager not initialized')

        const sourceWorkspaceLocalId = windowManager?.getWorkspaceForWindow(_event.sender.id)
        if (!sourceWorkspaceLocalId) throw new Error('Unable to resolve source workspace for transfer')

        const sourceWorkspace = getWorkspaceByNameOrId(sourceWorkspaceLocalId)
        if (!sourceWorkspace) throw new Error(`Source workspace ${sourceWorkspaceLocalId} not found`)

        let bundle: any = null

        if (sourceWorkspace.remoteServer) {
          const sourceRemote = sourceWorkspace.remoteServer
          const { url: sourceUrl, token: sourceToken, remoteWorkspaceId: sourceRemoteWorkspaceId } = sourceRemote
          console.log(`[Transfer] Exporting remote-owned session ${sessionId} from workspace ${sourceRemoteWorkspaceId}...`)
          const { client: sourceClient, error: sourceError } = await connectToRemote(sourceUrl, sourceToken, {
            workspaceId: sourceRemoteWorkspaceId,
            allowInsecureTls: sourceRemote.allowInsecureTls,
          })
          if (!sourceClient) throw new Error(sourceError ?? 'Connection failed to source remote server')

          try {
            bundle = await sourceClient.invoke('sessions:export', sessionId)
            if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

            try {
              console.log('[Transfer] Generating conversation summary on source server...')
              const transferPayload = await sourceClient.invoke('sessions:exportRemoteTransfer', sessionId)
              if (transferPayload?.summary && bundle.session?.header) {
                ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
                ;(bundle.session.header as any).transferredSessionSummaryApplied = false
                console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
              }
            } catch (err) {
              console.warn('[Transfer] Source-server summary generation failed:', err)
            }
          } finally {
            sourceClient.destroy()
          }
        } else {
          console.log(`[Transfer] Exporting local-owned session ${sessionId} from workspace ${sourceWorkspace.id}...`)
          bundle = await sessionManager.exportSession(sessionId, sourceWorkspace.id)
          if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

          try {
            console.log('[Transfer] Generating conversation summary...')
            const transferPayload = await sessionManager.shareTransferService.exportSummary(sessionId, sourceWorkspace.id)
            if (transferPayload?.summary && bundle.session?.header) {
              ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
              ;(bundle.session.header as any).transferredSessionSummaryApplied = false
              console.log(`[Transfer] Summary generated: ${transferPayload.summary.length} chars`)
            }
          } catch (err) {
            console.warn('[Transfer] Summary generation failed:', err)
          }
        }

        console.log(`[Transfer] Export complete: ${bundle.session?.messages?.length ?? 0} messages, ${bundle.files?.length ?? 0} files`)

        const targetRemote = targetWorkspace.remoteServer
        const { url, token, remoteWorkspaceId } = targetRemote
        console.log(`[Transfer] Connecting to target remote server: ${url}`)
        const { client, error } = await connectToRemote(url, token, {
          workspaceId: remoteWorkspaceId,
          allowInsecureTls: targetRemote.allowInsecureTls,
        })
        if (!client) throw new Error(error ?? 'Connection failed to target remote server')
        console.log('[Transfer] Connected to target remote server')

        try {
          const preparedBundle = await prepareChunkedPayload(bundle)
          const payloadSize = preparedBundle.bytes.length
          const payloadMB = (payloadSize / (1024 * 1024)).toFixed(1)

          const emitProgress = (chunkSent: number, chunkTotal: number) => {
            try { _event.sender.send('transfer:progress', { sessionIndex: idx, sessionCount: count, chunkSent, chunkTotal }) } catch { /* renderer may be gone */ }
          }

          if (payloadSize < CHUNKED_TRANSFER_THRESHOLD) {
            console.log(`[Transfer] Bundle size: ${payloadMB}MB (< 5MB threshold) → using direct RPC`)
            emitProgress(0, 1)
            const result = await client.invoke('sessions:import', remoteWorkspaceId, bundle, 'fork')
            emitProgress(1, 1)
            return result
          }

          const chunkCount = getChunkCount(payloadSize)
          console.log(`[Transfer] Bundle size: ${payloadMB}MB (>= 5MB threshold) → using chunked transfer (${chunkCount} chunks)`)
          return await invokeChunked(
            client,
            'sessions:import',
            [remoteWorkspaceId, bundle, 'fork'],
            1,
            emitProgress,
            preparedBundle,
          )
        } finally {
          client.destroy()
        }
      })

      // App relaunch (for server config changes — NOT an update install)
      ipcMain.handle(PRELOAD_LOCAL_CHANNELS.APP_RELAUNCH, () => {
        app.relaunch()
        app.exit(0)
      })

      // Language change: sync from renderer to main process, persist, and rebuild native menu.
      // Persistence here is what lets the next app launch hydrate main's i18n correctly —
      // see the `getPersistedUiLanguage()` block at the top of this file.
      ipcMain.handle(PRELOAD_LOCAL_CHANNELS.I18N_CHANGE_LANGUAGE, async (_event, lang: unknown) => {
        const previousResolved = i18n.resolvedLanguage ?? null
        if (typeof lang !== 'string' || !SUPPORTED_LANGUAGE_CODES.includes(lang as LanguageCode)) {
          // Defense-in-depth: renderer guarantees a supported code, but if a renegade
          // caller hands us garbage we drop it silently rather than poison i18n state.
          mainLog.warn('[i18n] changeLanguage IPC rejected — unsupported code', {
            incoming: lang,
            previousResolved,
          })
          return
        }
        const code = lang as LanguageCode
        await i18n.changeLanguage(code)
        setPersistedUiLanguage(code)
        mainLog.info('[i18n] changeLanguage IPC applied', {
          incoming: code,
          previousResolved,
          newResolved: i18n.resolvedLanguage ?? null,
        })
        const { rebuildMenu } = await import('./menu')
        await rebuildMenu()
      })

      ipcMain.on(PRELOAD_LOCAL_CHANNELS.GET_WS_PORT, (e) => {
        e.returnValue = instance.port
      })
      ipcMain.on('__get-ws-token', (e) => {
        e.returnValue = instance.token
      })
      ipcMain.on('__get-workspace-remote-config', (e) => {
        const wsId = windowManager?.getWorkspaceForWindow(e.sender.id)
        if (!wsId) { e.returnValue = null; return }
        const ws = getWorkspaceByNameOrId(wsId)
        e.returnValue = ws?.remoteServer ?? null
      })

      // Server config RPC handlers (LOCAL_ONLY — Electron-specific)
      const runningServerState = {
        host: rpcHost,
        port: instance.port,
        tls: !!tls,
        token: serverToken,
        enabled: serverModeEnabled,
      }

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_CONFIG, async () => {
        const { getServerConfig: getConfig } = await import('@mortise/shared/config')
        return getConfig()
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.SET_SERVER_CONFIG, async (_ctx: unknown, config: unknown) => {
        const { setServerConfig: setConfig } = await import('@mortise/shared/config')
        const cfg = config as import('@mortise/shared/config/server-config').ServerConfig
        // Validate port range
        if (cfg.port < 1024 || cfg.port > 65535) {
          throw new Error(`Port must be between 1024 and 65535, got ${cfg.port}`)
        }
        // Validate cert/key files exist if provided
        if (cfg.tlsCertPath && !existsSync(cfg.tlsCertPath)) {
          throw new Error(`Certificate file not found: ${cfg.tlsCertPath}`)
        }
        if (cfg.tlsKeyPath && !existsSync(cfg.tlsKeyPath)) {
          throw new Error(`Private key file not found: ${cfg.tlsKeyPath}`)
        }
        setConfig(cfg)
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_STATUS, async () => {
        const { getServerConfig: getConfig } = await import('@mortise/shared/config')
        const saved = getConfig()
        const protocol = runningServerState.tls ? 'wss' : 'ws'

        // Determine display host (LAN IP if bound to 0.0.0.0)
        let displayHost = runningServerState.host
        if (displayHost === '0.0.0.0' || displayHost === '::') {
          const os = await import('os')
          const nets = os.networkInterfaces()
          for (const name of Object.keys(nets)) {
            for (const net of nets[name] ?? []) {
              if (net.family === 'IPv4' && !net.internal) {
                displayHost = net.address
                break
              }
            }
            if (displayHost !== '0.0.0.0' && displayHost !== '::') break
          }
        }

        // Only compare port/tls/token when at least one side has server mode enabled.
        // When both are disabled, the running port is random — comparing it to the
        // saved default (9100) would always produce a false "restart required" banner.
        const needsRestart = saved.enabled !== runningServerState.enabled
          || ((saved.enabled || runningServerState.enabled) && (
            saved.port !== runningServerState.port
            || (!!saved.tlsCertPath) !== runningServerState.tls
            || (saved.token ?? '') !== runningServerState.token
          ))

        return {
          running: true,
          host: runningServerState.host,
          port: runningServerState.port,
          tls: runningServerState.tls,
          url: `${protocol}://${displayHost}:${runningServerState.port}`,
          token: runningServerState.token,
          needsRestart,
          insecureWarning: isInsecureBind,
        }
      })

      // TLS enforcement — warn when server mode binds to a network address without TLS
      // Mirrors the hard guard in packages/server/src/index.ts but warns instead of blocking,
      // since the user explicitly enabled server mode via UI (may be on a trusted LAN).
      const isInsecureBind = serverModeEnabled && !tls
        && !['127.0.0.1', 'localhost', '::1'].includes(rpcHost)
      if (isInsecureBind) {
        mainLog.warn(
          '[server-mode] WARNING: Listening on a network address without TLS. ' +
          'Auth tokens will be sent in cleartext. ' +
          'Configure TLS certificates in Settings > Server.'
        )
      }

      // Wire EventSink to Electron-specific services
      // Must happen BEFORE createInitialWindows() so event handlers use WS from the start
      windowManager.setRpcEventSink(moduleSink!, resolveClientId)
      const { setMenuEventSink } = await import('./menu')
      setMenuEventSink(moduleSink!, resolveClientId)
      const { setNotificationEventSink } = await import('./notifications')
      setNotificationEventSink(moduleSink!, resolveClientId)

      const workspaceServerIsolationEnabled = !isHeadless
        && !serverModeEnabled
        && process.env.MORTISE_ELECTRON_WORKSPACE_SERVER !== '0'

      if (workspaceServerIsolationEnabled && !process.env.MORTISE_LOCAL_WORKSPACE_SERVER_URL) {
        delete process.env.MORTISE_WORKSPACE_RUNTIME_DEGRADED
        delete process.env.MORTISE_WORKSPACE_RUNTIME_DEGRADED_REASON
        try {
          const timeoutMs = Number.parseInt(process.env.MORTISE_WORKSPACE_SERVER_STARTUP_TIMEOUT_MS ?? '', 10)
          workspaceServer = await spawnWorkspaceServer({
            isPackaged: app.isPackaged,
            appPath: app.getAppPath(),
            resourcesPath: process.resourcesPath,
            bundledAssetsRoot: __dirname,
            version: app.getVersion(),
            runtimeCachePath: join(app.getPath('userData'), 'runtime-cache'),
            nodeBinary: process.execPath,
            useNodeRuntime: process.env.MORTISE_UI_BUILD_ID !== undefined,
            messagingWorkerPath: electronResourcePaths.messagingWorkerPath,
            startupTimeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
          })

          process.env.MORTISE_LOCAL_WORKSPACE_SERVER_URL = workspaceServer.url
          process.env.MORTISE_LOCAL_WORKSPACE_SERVER_TOKEN = workspaceServer.token
          delete process.env.MORTISE_WORKSPACE_RUNTIME_DEGRADED
          delete process.env.MORTISE_WORKSPACE_RUNTIME_DEGRADED_REASON
          mainLog.info('[workspace-server] Local workspace RPC isolated in child process', {
            url: workspaceServer.url,
            pid: workspaceServer.pid,
          })
        } catch (err) {
          workspaceServer = null
          const reason = err instanceof Error ? err.message : String(err)
          writeRuntimeLog('error', {
            scope: 'workspace-server',
            event: 'startup.failed',
            message: reason,
            meta: { reason, error: err },
          })
          mainLog.error('[workspace-server] Failed to start child-process workspace server; falling back to embedded runtime:', {
            reason,
            ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
          })
          delete process.env.MORTISE_LOCAL_WORKSPACE_SERVER_URL
          delete process.env.MORTISE_LOCAL_WORKSPACE_SERVER_TOKEN
          process.env.MORTISE_WORKSPACE_RUNTIME_DEGRADED = '1'
          process.env.MORTISE_WORKSPACE_RUNTIME_DEGRADED_REASON = reason
        }
      } else if (process.env.MORTISE_LOCAL_WORKSPACE_SERVER_URL) {
        mainLog.info('[workspace-server] Using preconfigured local workspace server', {
          url: process.env.MORTISE_LOCAL_WORKSPACE_SERVER_URL,
        })
      } else if (serverModeEnabled) {
        mainLog.info('[workspace-server] Isolation disabled while server mode is enabled; embedded server remains authoritative.')
      }

      // Source-development Electron processes publish their embedded backend so
      // later test windows can enter thin-client mode instead of competing for
      // the same config lock. Packaged GUI builds keep this surface disabled.
      if (isHeadless || !app.isPackaged) {
        // Write token to a file with 0600 permissions instead of stdout,
        // because container/logging systems often persist stdout and would leak the token.
        const tokenFilePath = join(CONFIG_DIR, '.server-token')
        const { writeOwnerOnlyFileSync } = await import('./secure-files')
        writeOwnerOnlyFileSync(tokenFilePath, instance.token)
        publishServerEndpoint({
          host: instance.host,
          port: instance.port,
          protocol: instance.protocol,
          tokenFile: tokenFilePath,
        })
        if (isHeadless) {
          console.log(`MORTISE_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
          console.log(`MORTISE_SERVER_TOKEN_FILE=${tokenFilePath}`)
        }
      }
    }

    // Create initial windows (restores from saved state or opens first workspace)
    // In headless mode the server runs without any UI — skip window creation.
    if (!isHeadless) {
      await createInitialWindows()
    }

    // Development-only, authenticated UI validation control plane. The host
    // itself enforces the packaged/production guard before binding loopback.
    if (__MORTISE_UI_VALIDATION_BUILD__ && !isHeadless && process.env.MORTISE_UI_TEST_HOST === '1') {
      const { loadRendererTarget, startUiTestHost, resolveUiValidationRoute } = await import('./ui-validation.dev')
      uiTestHost = await startUiTestHost({
        isPackaged: app.isPackaged,
        allowPackagedDevHost: __MORTISE_DEV_HOST_BUILD__,
        windowManager,
        browserPaneManager: browserPaneManager ?? undefined,
        runtimeLogPath: join(CONFIG_DIR, 'logs', 'runtime.log'),
        shutdown: () => app.quit(),
        openRoute: async (params, target) => {
          const resolvedRoute = resolveUiValidationRoute(params, String(target.webContentsId))
          if (resolvedRoute.route.surface === 'workspace-picker') {
            const window = windowManager!.getWindowByWebContentsId(target.webContentsId)
            if (!window || window.isDestroyed()) throw new Error('Target window is no longer available.')
            if (!await windowManager!.updateWindowWorkspace(target.webContentsId, '')) {
              throw new Error('Target window is not managed by Mortise.')
            }
            const targetUrl = new URL(window.webContents.getURL())
            targetUrl.pathname = targetUrl.pathname.replace(/[^/]*$/, 'index.html')
            targetUrl.search = ''
            targetUrl.hash = ''
            await loadRendererTarget(window, targetUrl.toString())
            return {
              route: resolvedRoute.route,
              ready: resolvedRoute.ready,
              dependencies: resolvedRoute.dependencies,
            }
          }
          if (!resolvedRoute.deepLinkRoute) throw new Error('Resolved route has no renderer target.')
          const url = `mortise://${resolvedRoute.deepLinkRoute}`
          const result = await handleDeepLink(
            url,
            windowManager!,
            moduleSink ?? undefined,
            moduleClientResolver ?? undefined,
          )
          if (!result.success) throw new Error(result.error ?? 'Route navigation failed.')
          return {
            ...result,
            route: resolvedRoute.route,
            ready: resolvedRoute.ready,
            dependencies: resolvedRoute.dependencies,
          }
        },
      })
      mainLog.info('[ui-validation] Test Host ready', { url: uiTestHost?.url })
    }

    // Run credential health check at startup to detect issues early
    // (corruption, machine migration, missing credentials for default connection)
    // Skip in thin-client mode — credentials are managed by the remote server.
    if (!isClientOnly) {
      try {
        const { getCredentialManager } = await import('@mortise/shared/credentials')
        const credentialManager = getCredentialManager()
        const health = await credentialManager.checkHealth()
        if (!health.healthy) {
          mainLog.warn('Credential health check failed:', health.issues)
          // Issues will be displayed in Settings → AI when user navigates there
        }
      } catch (err) {
        mainLog.error('Credential health check error:', err)
      }
    }

    // Initialize power manager (loads setting, must happen after config is available)
    // Non-critical — powerSaveBlocker may not work on headless/xvfb setups
    try {
      const { initPowerManager } = await import('./power-manager')
      await initPowerManager()
    } catch (err) {
      mainLog.warn('[power] Power manager init failed (non-critical):', err instanceof Error ? err.message : err)
    }

    // Set Sentry context tags for error grouping (no PII — just config classification).
    // Runs after init so config and auth state are available.
    // Derive values directly from Pi's selected provider and model.
    try {
      const { readPiGlobalProviders, readPiGlobalSettings } = await import('@mortise/shared/config')
      const workspaces = getWorkspaces()
      const settings = readPiGlobalSettings()
      const provider = settings.defaultProvider ? readPiGlobalProviders()[settings.defaultProvider] : undefined
      Sentry.setTag('provider', settings.defaultProvider ?? 'unknown')
      Sentry.setTag('hasCustomEndpoint', String(!!provider?.baseUrl))
      Sentry.setTag('model', settings.defaultModel ?? 'default')
      Sentry.setTag('workspaceCount', String(workspaces.length))
    } catch (err) {
      mainLog.warn('Failed to set Sentry context tags:', err)
    }

    // Initialize auto-update (check immediately on launch)
    // Skip in dev mode to avoid replacing /Applications app and launching it instead
    if (moduleSink) setAutoUpdateEventSink(moduleSink)
    // Snapshot multi-window state BEFORE quitAndInstall. electron-updater
    // (Squirrel.Mac) destroys BrowserWindows between quitAndInstall and
    // before-quit firing; saving from before-quit alone would overwrite
    // window-state.json with an empty array.
    setBeforeUpdateQuitHook(async () => {
      const recoverableSnapshot = captureRecoverableWindowSnapshot(windowManager)
      captureAndSaveWindowState('pre-update')
      isPreparingUpdateQuit = true
      try {
        await closeRendererWindowsGracefully(windowManager)
      } catch (error) {
        try {
          restoreRecoverableWindows(windowManager, recoverableSnapshot)
        } finally {
          isPreparingUpdateQuit = false
        }
        throw error
      }
      return () => {
        try {
          const restored = restoreRecoverableWindows(windowManager, recoverableSnapshot)
          mainLog.warn('[update-flow] Restored windows after failed installer handoff', { restored })
        } finally {
          isPreparingUpdateQuit = false
          windowManager?.setAppQuitting(false)
        }
      }
    })
    // Mortise has no built-in update service. Deployments can opt in through
    // MORTISE_UPDATE_URL and still trigger checks from the menu or settings.
    mainLog.info('[auto-update] Launch update check disabled; no default update service is configured')

    // Process pending deep link from cold start
    if (pendingDeepLink) {
      mainLog.info('Processing pending deep link:', pendingDeepLink)
      await handleDeepLink(pendingDeepLink, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined)
      pendingDeepLink = null
    }

    mainLog.info('App initialized successfully')
    if (isDebugMode) {
      mainLog.info('Debug mode enabled - logs at:', getLogFilePath())
    }
    mainLog.info('Messaging gateway log path:', getMessagingGatewayLogFilePath())
  } catch (error) {
    mainLog.error('Failed to initialize app:', error instanceof Error ? error.message : error, (error as any)?.stack)
    // Continue anyway - the app will show errors in the UI
  }

  // macOS: Re-create window when dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && windowManager) {
      // Open first workspace or last focused
      const workspaces = getWorkspaces()
      if (workspaces.length > 0) {
        const savedState = loadWindowState()
        const wsId = savedState?.lastFocusedWorkspaceId || workspaces[0].id
        // Verify workspace still exists
        if (workspaces.some(ws => ws.id === wsId)) {
          windowManager.createWindow({ workspaceId: wsId })
        } else {
          windowManager.createWindow({ workspaceId: workspaces[0].id })
        }
      }
    }
  })
})

// Guard both the normal quit sequence and the pre-update renderer flush.
const beforeQuitGate = new BeforeQuitGate()
let isPreparingUpdateQuit = false

app.on('window-all-closed', () => {
  if (process.env.MORTISE_HEADLESS) return  // headless server stays alive
  if (beforeQuitGate.isPreparing() || isPreparingUpdateQuit) return
  // On macOS, apps typically stay active until explicitly quit
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * Capture the current multi-window state and persist it to disk.
 * Called from two sites:
 *   - before-quit (normal quit path, reason='before-quit')
 *   - installUpdate hook (auto-update path, reason='pre-update'), because
 *     electron-updater destroys BrowserWindows between quitAndInstall and
 *     before-quit firing — by the time before-quit runs, getWindowStates()
 *     returns an empty array and would clobber the on-disk state.
 */
function captureAndSaveWindowState(reason: 'before-quit' | 'pre-update'): void {
  if (!windowManager) return
  const windows = windowManager.getWindowStates()
  const focusedWindow = BrowserWindow.getFocusedWindow()
  const lastFocusedWorkspaceId = focusedWindow
    ? windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
    : undefined
  const state = { windows, lastFocusedWorkspaceId }
  saveWindowState(state)
  mainLog.info('[window-state] saved', { windowCount: windows.length, reason })
}

// Save window state and clean up resources before quitting
app.on('before-quit', async (event) => {
  const decision = beforeQuitGate.enter(event)
  if (decision !== 'start') return

  const recoverableSnapshot = captureRecoverableWindowSnapshot(windowManager)
  if (windowManager) {
    const windows = windowManager.getWindowStates()
    // Empty-snapshot guard: during update-quit, electron-updater has already
    // destroyed all BrowserWindows by the time before-quit fires. The pre-update
    // hook already saved the real state — don't let this late save overwrite it.
    if (windows.length === 0 && isUpdating()) {
      mainLog.warn('[window-state] skip save: empty snapshot during update-quit (pre-update snapshot wins)')
    } else {
      captureAndSaveWindowState('before-quit')
    }
    // Diagnostic correlation with installUpdate's [update-flow] log. During an
    // update-quit, record it to the dedicated always-on auto-update log (#891)
    // so the install/quit handoff is diagnosable in production; normal quits
    // stay on the debug-only main log.
    const isUpdateQuit = isUpdating()
    const beforeQuitSave = {
      windowCount: windows.length,
      electronWindowCount: BrowserWindow.getAllWindows().length,
      isUpdating: isUpdateQuit,
      reason: isUpdateQuit ? 'update-quit' : 'user-quit',
    }
    if (isUpdateQuit) {
      autoUpdateLog.info('before-quit save', beforeQuitSave)
    } else {
      mainLog.info('[update-flow] before-quit save', beforeQuitSave)
    }
  }

  try {
    await closeRendererWindowsGracefully(windowManager)
  } catch (error) {
    mainLog.error('[quit] Renderer state did not flush; quit cancelled', error)
    try {
      const restored = restoreRecoverableWindows(windowManager, recoverableSnapshot)
      if (restored > 0) mainLog.warn('[quit] Restored windows closed before cancellation', { restored })
    } catch (restoreError) {
      mainLog.error('[quit] Failed to restore a window after cancellation', restoreError)
    } finally {
      isPreparingUpdateQuit = false
      windowManager?.setAppQuitting(false)
      // Keep window-all-closed suppressed until replacement windows exist.
      beforeQuitGate.cancel()
    }
    return
  }

  // Renderer-owned state is now durable and every BrowserWindow is closed.
  // Remaining quit activity may bypass the layered window-close policy.
  windowManager?.setAppQuitting(true)

  await runCommittedExit([
    {
      name: 'ui-validation-host',
      run: async () => {
        if (!uiTestHost) return
        const host = uiTestHost
        uiTestHost = null
        await host.close()
      },
    },
    {
      name: 'session-flush',
      run: async () => {
        if (!sessionManager) return
        await sessionManager.flushAllSessions()
        mainLog.info('Flushed all pending session writes')
      },
    },
    {
      name: 'session-cleanup',
      run: async () => sessionManager?.cleanup(),
    },
    {
      name: 'browser-panes',
      run: () => browserPaneManager?.destroyAll(),
    },
    {
      name: 'model-refresh',
      run: () => getModelRefreshService().stopAll(),
    },
    {
      name: 'messaging-gateway',
      run: async () => messagingHandle?.dispose(),
    },
    {
      name: 'workspace-server',
      run: async () => {
        if (!workspaceServer) return
        try {
          await workspaceServer.stop()
          mainLog.info('[workspace-server] Stopped child-process workspace server')
        } finally {
          workspaceServer = null
          delete process.env.MORTISE_LOCAL_WORKSPACE_SERVER_URL
          delete process.env.MORTISE_LOCAL_WORKSPACE_SERVER_TOKEN
        }
      },
    },
    {
      name: 'power-manager',
      run: async () => {
        const { cleanup: cleanupPowerManager } = await import('./power-manager')
        cleanupPowerManager()
      },
    },
    {
      name: 'server-endpoint',
      run: () => removeServerEndpoint(),
    },
    {
      name: 'server-lock',
      run: () => releaseServerLock(),
    },
  ], (name, error) => {
    mainLog.error(`[quit] Cleanup failed (${name}); continuing exit`, error)
  }, () => {
    beforeQuitGate.commit()
    // Force exit breaks the NSIS installer on Windows, so update shutdown
    // re-enters app.quit() only after the gate has explicitly committed.
    if (isUpdating()) {
      mainLog.info('Update in progress, letting electron-updater handle quit')
      app.quit()
    } else {
      app.exit(0)
    }
  })
})

// Handle uncaught exceptions — forward to Sentry explicitly since registering
// a custom handler can interfere with @sentry/electron's automatic capture.
process.on('uncaughtException', (error) => {
  mainLog.error('Uncaught exception:', error)
  Sentry.captureException(error)
})

process.on('unhandledRejection', (reason, promise) => {
  mainLog.error('Unhandled rejection at:', promise, 'reason:', reason)
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)))
})
