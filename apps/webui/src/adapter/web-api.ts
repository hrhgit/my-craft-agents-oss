/**
 * Web API adapter — browser-compatible ElectronAPI implementation.
 *
 * Reuses the same WsRpcClient + buildClientApi() + CHANNEL_MAP from the Electron app.
 * Overrides LOCAL_ONLY methods (window management, native dialogs, etc.) with web equivalents.
 *
 * Auth: the browser's session cookie (set by /api/auth) is automatically sent
 * on the WebSocket upgrade request — no bearer token needed.
 */

import i18n from 'i18next'
import { toast } from 'sonner'
import { openExternalUrl } from '@mortise/ui'
import { WsRpcClient } from '@mortise/server-core/transport/client'
import { buildClientApi } from '../../../electron/src/transport/build-api'
import { CHANNEL_MAP } from '../../../electron/src/transport/channel-map'
import type { ElectronAPI, TransportConnectionState } from '../../../electron/src/shared/types'
import {
  WEBUI_PLATFORM_CAPABILITIES,
  attachWebPlatformCapabilities,
  createUnsupportedWebApiOverrides,
} from './platform-capabilities'
import { BACKEND_TYPE_CAPABILITY } from '@mortise/shared/protocol'

// ---------------------------------------------------------------------------
// Web platform contract
// ---------------------------------------------------------------------------

export { WEBUI_PLATFORM_CAPABILITIES }

// ---------------------------------------------------------------------------
// System theme detection
// ---------------------------------------------------------------------------

const darkMediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

function getSystemTheme(): boolean {
  return darkMediaQuery?.matches ?? false
}

// ---------------------------------------------------------------------------
// Create web API
// ---------------------------------------------------------------------------

export interface WebApiOptions {
  /** WebSocket server URL (ws:// or wss://) */
  serverUrl: string
  /** Workspace ID to connect as. */
  workspaceId?: string
}

/** Keep recovery responsive while the RPC service restarts. */
export const WEBUI_MAX_RECONNECT_DELAY_MS = 5_000

export function createWebApi(options: WebApiOptions): {
  api: ElectronAPI
  client: WsRpcClient
} {
  const { serverUrl, workspaceId } = options

  const client = new WsRpcClient(serverUrl, {
    workspaceId,
    autoReconnect: true,
    maxReconnectDelay: WEBUI_MAX_RECONNECT_DELAY_MS,
    mode: 'remote',
    clientCapabilities: [BACKEND_TYPE_CAPABILITY.webui],
    // No token — auth is via session cookie sent on WebSocket upgrade
  })

  // Build the API proxy from the same channel map the Electron app uses
  const baseApi = buildClientApi(
    client,
    CHANNEL_MAP,
    (ch) => client.isChannelAvailable(ch),
  )

  // Override LOCAL_ONLY methods with web-compatible implementations
  const webOverrides: Partial<ElectronAPI> = {
    ...createUnsupportedWebApiOverrides(),
    platformCapabilities: WEBUI_PLATFORM_CAPABILITIES,
    // Shell operations — use browser APIs
    openUrl: (url: string) => {
      const result = openExternalUrl(url)
      if (!result.opened) {
        if (result.reason === 'dangerous') {
          toast.error(`Blocked unsafe URL (${result.detail})`)
        } else if (result.reason === 'internal-deeplink') {
          console.warn('[openUrl] mortise:// deep links require the desktop app')
        } else {
          console.warn('[openUrl] Malformed URL:', url)
        }
      }
      return Promise.resolve()
    },
    // System info
    getVersions: () => ({ node: 'n/a', chrome: navigator.userAgent, electron: 'web' }),
    getRuntimeEnvironment: () => 'web',
    getSystemWarnings: () => Promise.resolve({ vcredistMissing: false, workspaceRuntimeDegraded: false }),
    isDebugMode: () => Promise.resolve(import.meta.env.DEV),

    // Theme
    getSystemTheme: () => Promise.resolve(getSystemTheme()),
    onSystemThemeChange: (cb: (isDark: boolean) => void) => {
      if (!darkMediaQuery) return () => {}
      const handler = (e: MediaQueryListEvent) => cb(e.matches)
      darkMediaQuery.addEventListener('change', handler)
      return () => darkMediaQuery.removeEventListener('change', handler)
    },

    // Window management browser equivalents
    onCloseRequested: () => () => {},
    getWindowFocusState: () => Promise.resolve(document.hasFocus()),
    onWindowFocusChange: (cb: (focused: boolean) => void) => {
      const onFocus = () => cb(true)
      const onBlur = () => cb(false)
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      return () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
      }
    },

    // Workspace operations — web UI works with a single connection
    getWindowWorkspace: () => Promise.resolve(workspaceId ?? null),
    getWindowMode: () => Promise.resolve('main'),
    // switchWorkspace must call the server so it registers the client's
    // workspaceId — otherwise push events (session updates) won't arrive.
    switchWorkspace: async (wsId: string) => {
      await client.invoke('window:switchWorkspace', wsId)
    },
    openSessionInNewWindow: async (_wsId: string, sessionId: string) => {
      // Open in new tab
      window.open(`${window.location.origin}/?session=${sessionId}`, '_blank')
    },
    openChildSessionWindow: async (sessionId: string) => {
      // Web fallback: open in a new browser tab
      window.open(`${window.location.origin}/?session=${sessionId}`, '_blank')
    },

    // Auto-update — not applicable to web (but expose server version for About page)
    onUpdateAvailable: () => () => {},
    onUpdateDownloadProgress: () => () => {},
    // Menu events — register as keyboard shortcuts
    onMenuNewChat: () => () => {},
    onMenuOpenSettings: () => () => {},
    onMenuKeyboardShortcuts: () => () => {},
    onMenuToggleFocusMode: () => () => {},
    onMenuToggleSidebar: () => () => {},
    onDeepLinkNavigate: () => () => {},

    // Menu actions with browser equivalents
    menuNewWindow: () => { window.open(window.location.href, '_blank'); return Promise.resolve() },
    menuUndo: () => { document.execCommand('undo'); return Promise.resolve() },
    menuRedo: () => { document.execCommand('redo'); return Promise.resolve() },
    menuCut: () => { document.execCommand('cut'); return Promise.resolve() },
    menuCopy: () => { document.execCommand('copy'); return Promise.resolve() },
    menuPaste: () => { document.execCommand('paste'); return Promise.resolve() },
    menuSelectAll: () => { document.execCommand('selectAll'); return Promise.resolve() },

    // Badge — use document title
    onBadgeDraw: () => () => {},
    onBadgeDrawWindows: () => () => {},

    // Notifications — Web Notifications API
    showNotification: async (title: string, body: string) => {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body })
      }
    },
    onNotificationNavigate: () => () => {},

    // Confirmation dialogs — use browser confirm()
    showDeleteSessionConfirmation: (name: string) => Promise.resolve(window.confirm(i18n.t('dialog.deleteSessionConfirmation', { name }))),

    // Transport state
    getTransportConnectionState: () => Promise.resolve(client.getConnectionState() as TransportConnectionState),
    onTransportConnectionStateChanged: (cb: (state: TransportConnectionState) => void) => {
      return client.onConnectionStateChanged(cb as any)
    },
    reconnectTransport: () => { client.reconnectNow(); return Promise.resolve() },
    isChannelAvailable: (ch: string) => client.isChannelAvailable(ch),

    // Relaunch — reload page
    relaunchApp: () => { window.location.reload(); return Promise.resolve() },
  }

  const api = attachWebPlatformCapabilities({ ...baseApi, ...webOverrides }) as ElectronAPI

  return { api, client }
}
