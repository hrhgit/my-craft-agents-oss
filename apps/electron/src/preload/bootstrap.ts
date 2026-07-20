/**
 * WS-mode preload — replaces the full IPC preload (index.ts).
 *
 * Normal mode (local server):
 *   Creates a RoutedClient that routes LOCAL_ONLY channels to the local
 *   Electron server and REMOTE_ELIGIBLE channels to whichever server owns
 *   the active workspace (local or remote). Workspace switches swap the
 *   workspace client transparently.
 *
 * Thin-client mode (MORTISE_SERVER_URL):
 *   Creates a single WsRpcClient connected to the remote server.
 *   All channels go to the remote server.
 *
 * On localhost the WS handshake completes in <1ms. The React app takes >100ms
 * to initialise, so by the time any component calls an API method, the
 * connection is established.
 */

import '@sentry/electron/preload'
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
import { WsRpcClient, type TransportConnectionState } from '@mortise/server-core/transport'
import { RoutedClient } from '../transport/routed-client'
import { buildClientApi, type ChannelMapEntry } from '../transport/build-api'
import { CHANNEL_MAP } from '../transport/channel-map'
import { buildWorkspaceClientApi, evictWorkspaceApiCache, resolveWorkspaceApiMethod } from '../transport/workspace-api'
import { workspaceRouteKey } from '../transport/workspace-runtime-registry'
import { WorkspaceRuntimeGenerationTracker, WorkspaceRuntimeUpdateQueue } from '../transport/workspace-runtime-generation'
import {
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_BROWSER_INVOKE,
  LOCAL_CLIENT_CAPABILITIES,
} from '@mortise/server-core/transport'
import type { ConfirmDialogSpec, FileDialogSpec, BrowserCapabilityRequest } from '@mortise/server-core/transport'
import type { RpcClient } from '@mortise/server-core/transport'
import type { RemoteServerConfig, Workspace } from '@mortise/core/types'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { ElectronAPI } from '../shared/types'
import type { WorkspaceRoute } from '../shared/app-layout'
import { PRELOAD_LOCAL_CHANNELS } from '../shared/ipc-channels'
import type { UiValidationRendererStateBatch } from '../shared/ui-validation-state-bridge'
import { allowsInsecureTlsFromEnvironment, shouldRejectUnauthorizedTls } from '../shared/remote-tls'

// ---------------------------------------------------------------------------
// Client interface — common surface for both RoutedClient and WsRpcClient
// ---------------------------------------------------------------------------

interface TransportClient extends RpcClient {
  isChannelAvailable(channel: string): boolean
  getConnectionState(): TransportConnectionState
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  reconnectNow(): void
}

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

const webContentsId: number = ipcRenderer.sendSync('__get-web-contents-id')
const isClientOnly = !!process.env.MORTISE_SERVER_URL

let client: TransportClient
let workspaceApiTransport: import('../transport/workspace-api').WorkspaceApiTransport
const workspaceApis = new Map<string, ElectronAPI>()

if (isClientOnly) {
  // ── Thin-client mode ───────────────────────────────────────────────────
  // Single WsRpcClient connected directly to the remote server.
  // No local server, no routing — all channels go to remote.

  const wsUrl = process.env.MORTISE_SERVER_URL!
  const wsToken = process.env.MORTISE_SERVER_TOKEN ?? ''
  const allowInsecureTls = allowsInsecureTlsFromEnvironment()

  // Block unencrypted ws:// to non-localhost servers — tokens would be sent in cleartext
  const parsed = new URL(wsUrl)
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol === 'ws:' && !isLocalhost) {
    throw new Error(
      `Refusing to connect to remote server over unencrypted ws://. ` +
      `Use wss:// (TLS) for non-localhost connections. ` +
      `Set MORTISE_RPC_TLS_CERT/KEY on the server to enable TLS.`
    )
  }

  // Workspace ID is optional — if missing, renderer shows a workspace picker
  const workspaceId = process.env.MORTISE_WORKSPACE_ID || ipcRenderer.sendSync('__get-workspace-id') || undefined

  const wsClient = new WsRpcClient(wsUrl, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'remote',
    clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
    tlsRejectUnauthorized: !allowInsecureTls,
  })
  wsClient.connect()
  client = wsClient
  workspaceApiTransport = {
    invoke: async (route, channel, ...args) => {
      assertThinClientRoute(route, wsUrl, workspaceId)
      return wsClient.invoke(channel, ...args)
    },
    on: (route, channel, callback) => {
      assertThinClientRoute(route, wsUrl, workspaceId)
      return wsClient.on(channel, callback)
    },
    isChannelAvailable: (route, channel) => {
      try {
        assertThinClientRoute(route, wsUrl, workspaceId)
        return wsClient.isChannelAvailable(channel)
      } catch {
        return false
      }
    },
  }

} else {
  // ── Normal mode ────────────────────────────────────────────────────────
  // RoutedClient routes LOCAL_ONLY to local server, REMOTE_ELIGIBLE to
  // whichever server owns the workspace (local or remote).

  const wsPort: number = ipcRenderer.sendSync(PRELOAD_LOCAL_CHANNELS.GET_WS_PORT)
  const wsToken: string = ipcRenderer.sendSync('__get-ws-token')
  const workspaceId: string = ipcRenderer.sendSync('__get-workspace-id')
  const localWorkspaceServerUrl = process.env.MORTISE_LOCAL_WORKSPACE_SERVER_URL
  const localWorkspaceServerToken = process.env.MORTISE_LOCAL_WORKSPACE_SERVER_TOKEN ?? ''

  const localClient = new WsRpcClient(`ws://127.0.0.1:${wsPort}`, {
    token: wsToken,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'local',
    clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
  })

  // Check if the current workspace is remote (synchronous IPC during preload eval)
  const remoteConfig: RemoteServerConfig | null = ipcRenderer.sendSync('__get-workspace-remote-config')

  const localWorkspaceClient = localWorkspaceServerUrl
    ? new WsRpcClient(localWorkspaceServerUrl, {
        token: localWorkspaceServerToken,
        workspaceId,
        webContentsId,
        autoReconnect: true,
        mode: 'remote',
        clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      })
    : undefined

  let initialWorkspaceClient: WsRpcClient
  if (remoteConfig && typeof remoteConfig.url === 'string') {
    // Workspace is remote — create a direct connection to the remote server
    initialWorkspaceClient = new WsRpcClient(remoteConfig.url, {
      token: remoteConfig.token,
      workspaceId: remoteConfig.remoteWorkspaceId,
      webContentsId,
      autoReconnect: true,
      mode: 'remote',
      clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      tlsRejectUnauthorized: shouldRejectUnauthorizedTls(remoteConfig),
    })
    initialWorkspaceClient.connect()
  } else if (localWorkspaceClient) {
    // Workspace is local, but the heavy workspace runtime is isolated in a
    // child-process server so Electron's main process remains responsive.
    initialWorkspaceClient = localWorkspaceClient
    initialWorkspaceClient.connect()
  } else {
    // Workspace is local — workspace client IS the local client
    initialWorkspaceClient = localClient
  }

  const routedClient = new RoutedClient(localClient, initialWorkspaceClient, {
    localWorkspaceClient,
  })

  // Set workspace ID mapping if initial workspace is remote
  if (remoteConfig) {
    routedClient.setWorkspaceMapping(workspaceId, remoteConfig.remoteWorkspaceId)
  }

  // Factory for creating remote workspace clients on switch
  routedClient.setClientFactory((remoteServer: RemoteServerConfig) => {
    return new WsRpcClient(remoteServer.url, {
      token: remoteServer.token,
      workspaceId: remoteServer.remoteWorkspaceId,
      webContentsId,
      autoReconnect: true,
      mode: 'remote',
      clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      tlsRejectUnauthorized: shouldRejectUnauthorizedTls(remoteServer),
    })
  })

  localClient.connect()
  if (localWorkspaceClient && localWorkspaceClient !== initialWorkspaceClient) {
    localWorkspaceClient.connect()
  }
  client = routedClient

  type RuntimeWorkspace = Pick<Workspace, 'id' | 'remoteServer'>
  const runtimeGenerations = new WorkspaceRuntimeGenerationTracker()
  const workspaceRuntimeUpdates = new WorkspaceRuntimeUpdateQueue()
  const runtimeUpdates = new Map<string, Promise<void>>()
  const runtimeLeases = new Map<string, { generation: string; release: () => void }>()

  const queueRuntimeUpdate = (key: string, update: () => Promise<void>): Promise<void> => {
    const previous = runtimeUpdates.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(update).finally(() => {
      if (runtimeUpdates.get(key) === pending) runtimeUpdates.delete(key)
    })
    runtimeUpdates.set(key, pending)
    return pending
  }

  const runtimeGeneration = (workspace: RuntimeWorkspace): string => workspace.remoteServer
    ? runtimeGenerations.forRemote(workspace.id, workspace.remoteServer)
    : runtimeGenerations.forLocal(workspace.id)

  const installWorkspaceRuntime = (
    route: WorkspaceRoute,
    workspace: RuntimeWorkspace,
    mode: 'register' | 'replace' | 'move',
    fromRoute?: WorkspaceRoute,
  ): void => {
    const key = workspaceRouteKey(route)
    const generation = runtimeGeneration(workspace)
    if (runtimeLeases.get(key)?.generation === generation && routedClient.hasWorkspaceRuntime(route)) return

    let runtime: WsRpcClient
    let targetWorkspaceId: string | undefined
    if (workspace.remoteServer) {
      const remote = workspace.remoteServer
      targetWorkspaceId = remote.remoteWorkspaceId
      runtime = new WsRpcClient(remote.url, {
        token: remote.token,
        workspaceId: remote.remoteWorkspaceId,
        webContentsId,
        autoReconnect: true,
        mode: 'remote',
        clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
        tlsRejectUnauthorized: shouldRejectUnauthorizedTls(remote),
      })
    } else {
      const runtimeUrl = localWorkspaceServerUrl ?? `ws://127.0.0.1:${wsPort}`
      runtime = new WsRpcClient(runtimeUrl, {
        token: localWorkspaceServerUrl ? localWorkspaceServerToken : wsToken,
        workspaceId: workspace.id,
        webContentsId,
        autoReconnect: true,
        mode: localWorkspaceServerUrl ? 'remote' : 'local',
        clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      })
    }

    try {
      runtime.connect()
      const registration = {
        route,
        client: runtime,
        targetWorkspaceId,
        generation,
        dispose: () => runtime.destroy(),
      }
      const release = mode === 'move'
        ? routedClient.moveWorkspaceRuntime(fromRoute!, registration)
        : mode === 'replace'
          ? routedClient.replaceWorkspaceRuntime(registration)
          : routedClient.registerWorkspaceRuntime(registration)
      const previousKey = mode === 'move' ? workspaceRouteKey(fromRoute!) : key
      const previous = runtimeLeases.get(previousKey)
      const previousAtTarget = previousKey === key ? undefined : runtimeLeases.get(key)
      if (previousKey !== key) runtimeLeases.delete(previousKey)
      runtimeLeases.set(key, { generation, release })
      previous?.release()
      previousAtTarget?.release()
    } catch (error) {
      runtime.destroy()
      throw error
    }
  }

  const ensureWorkspaceRuntime = (route: WorkspaceRoute): Promise<void> => {
    const key = workspaceRouteKey(route)
    if (routedClient.hasWorkspaceRuntime(route)) return Promise.resolve()

    return queueRuntimeUpdate(key, async () => {
      if (routedClient.hasWorkspaceRuntime(route)) return
      const workspaces = await localClient.invoke(RPC_CHANNELS.workspaces.GET) as Workspace[]
      const workspace = workspaces.find(candidate => candidate.id === route.workspaceId)
      if (!workspace) throw new Error(`Workspace route is not authorized: ${key}`)
      const expectedServerId = workspace.remoteServer?.url ?? 'local'
      if (route.serverId !== expectedServerId) {
        throw new Error(`Workspace route server mismatch for ${route.workspaceId}`)
      }

      for (const registeredRoute of routedClient.getRegisteredWorkspaceRoutes()) {
        if (registeredRoute.workspaceId !== route.workspaceId || workspaceRouteKey(registeredRoute) === key) continue
        runtimeLeases.get(workspaceRouteKey(registeredRoute))?.release()
        runtimeLeases.delete(workspaceRouteKey(registeredRoute))
      }
      routedClient.removeWorkspaceRuntimes(route.workspaceId, route)
      installWorkspaceRuntime(route, workspace, 'register')
    })
  }

  const refreshWorkspaceRuntimes = (workspaceId: string): Promise<void> => workspaceRuntimeUpdates.run(
    workspaceId,
    async () => {
      const workspaces = await localClient.invoke(RPC_CHANNELS.workspaces.GET) as Workspace[]
      const workspace = workspaces.find(candidate => candidate.id === workspaceId)
      if (!workspace) return
      evictWorkspaceApiCache(workspaceApis, workspace.id, workspace.remoteServer?.url ?? 'local')
      const initialRoutes = routedClient.getRegisteredWorkspaceRoutes()
        .filter(route => route.workspaceId === workspace.id)
      if (initialRoutes.length === 0) return
      const nextRoute: WorkspaceRoute = {
        serverId: workspace.remoteServer?.url ?? 'local',
        workspaceId: workspace.id,
      }
      const nextKey = workspaceRouteKey(nextRoute)
      await Promise.all(initialRoutes.map(route => runtimeUpdates.get(workspaceRouteKey(route))?.catch(() => {})))
      await queueRuntimeUpdate(nextKey, async () => {
        const routes = routedClient.getRegisteredWorkspaceRoutes()
          .filter(route => route.workspaceId === workspace.id)
        if (routes.length === 0) return
        const exactRoute = routes.find(route => workspaceRouteKey(route) === nextKey)
        const sourceRoute = exactRoute ?? routes[0]!

        try {
          installWorkspaceRuntime(
            nextRoute,
            workspace,
            exactRoute ? 'replace' : 'move',
            exactRoute ? undefined : sourceRoute,
          )
          for (const route of routes) {
            const key = workspaceRouteKey(route)
            if (key === nextKey || (!exactRoute && key === workspaceRouteKey(sourceRoute))) continue
            runtimeLeases.get(key)?.release()
            runtimeLeases.delete(key)
          }
          routedClient.removeWorkspaceRuntimes(workspace.id, nextRoute)
        } catch (error) {
          for (const route of [...routes, nextRoute]) {
            const key = workspaceRouteKey(route)
            runtimeLeases.get(key)?.release()
            runtimeLeases.delete(key)
          }
          routedClient.removeWorkspaceRuntimes(workspace.id)
          throw error
        }
      })
    },
  )

  routedClient.setWorkspaceSwitchHandler(async (result) => {
    await refreshWorkspaceRuntimes(result.workspaceId)
  })

  localClient.on(RPC_CHANNELS.workspaces.REMOTE_UPDATED, ({ workspaceId: changedWorkspaceId }: { workspaceId: string }) => {
    void (async () => {
      const workspaces = await localClient.invoke(RPC_CHANNELS.workspaces.GET) as Workspace[]
      const workspace = workspaces.find(candidate => candidate.id === changedWorkspaceId)
      if (!workspace) return
      const activeWorkspaceId = await localClient.invoke(RPC_CHANNELS.window.GET_WORKSPACE) as string | null
      if (activeWorkspaceId === changedWorkspaceId) {
        await routedClient.invoke(RPC_CHANNELS.window.SWITCH_WORKSPACE, changedWorkspaceId)
      } else {
        await refreshWorkspaceRuntimes(workspace.id)
      }
    })().catch(error => {
      console.error(`[WorkspaceRuntime] Failed to refresh workspace ${changedWorkspaceId}:`, error)
    })
  })

  workspaceApiTransport = {
    invoke: async (route, channel, ...args) => {
      await ensureWorkspaceRuntime(route)
      return routedClient.invokeForWorkspace(route, channel, ...args)
    },
    on: (route, channel, callback) => {
      let disposed = false
      let unsubscribe: (() => void) | undefined
      void ensureWorkspaceRuntime(route).then(() => {
        if (!disposed) unsubscribe = routedClient.onForWorkspace(route, channel, callback)
      }).catch(error => {
        console.error(`[WorkspaceAPI] Failed to subscribe ${channel}:`, error)
      })
      return () => {
        disposed = true
        unsubscribe?.()
      }
    },
    isChannelAvailable: (route, channel) => routedClient.isChannelAvailableForWorkspace(route, channel),
  }
}

// ---------------------------------------------------------------------------
// Register client-side capability handlers (server can invoke these)
// ---------------------------------------------------------------------------

client.handleCapability(CLIENT_OPEN_EXTERNAL, (url: string) => shell.openExternal(url))

client.handleCapability(CLIENT_OPEN_PATH, async (path: string) => {
  const error = await shell.openPath(path)
  return { error: error || undefined }
})

client.handleCapability(CLIENT_SHOW_IN_FOLDER, (path: string) => {
  shell.showItemInFolder(path)
})

client.handleCapability(CLIENT_CONFIRM_DIALOG, async (spec: ConfirmDialogSpec) => {
  return await ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.DIALOG_SHOW_MESSAGE_BOX, spec)
})

client.handleCapability(CLIENT_OPEN_FILE_DIALOG, async (spec: FileDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showOpenDialog', spec)
})

// Browser pane invocation. The remote server packages an IBrowserPaneManager
// method call as a BrowserCapabilityRequest; we dispatch it to the local
// `BrowserPaneManager` via the `__browser:invoke` IPC channel registered in
// `apps/electron/src/main/browser-pane-manager.ts:registerCapabilityIpc()`.
client.handleCapability(CLIENT_BROWSER_INVOKE, async (req: BrowserCapabilityRequest) => {
  return await ipcRenderer.invoke('__browser:invoke', req)
})

// ---------------------------------------------------------------------------
// Build ElectronAPI proxy
// ---------------------------------------------------------------------------

const api = buildClientApi(client, CHANNEL_MAP, (ch) => client.isChannelAvailable(ch))
function getWorkspaceApi(route: WorkspaceRoute): ElectronAPI {
  const key = `${encodeURIComponent(route.serverId)}::${encodeURIComponent(route.workspaceId)}`
  const existing = workspaceApis.get(key)
  if (existing) return existing
  const scoped = buildWorkspaceClientApi(workspaceApiTransport, route, CHANNEL_MAP)
  workspaceApis.set(key, scoped)
  return scoped
}

function getWorkspaceMethod(route: WorkspaceRoute, method: string, expectedType: 'invoke' | 'listener') {
  const entry = (CHANNEL_MAP as Record<string, ChannelMapEntry>)[method]
  if (!entry || entry.type !== expectedType) {
    throw new Error(`Workspace API ${expectedType} method is not allowed: ${method}`)
  }
  const resolved = resolveWorkspaceApiMethod(getWorkspaceApi(route), method)
  if (!resolved) throw new Error(`Workspace API method is unavailable: ${method}`)
  return resolved
}

;(api as any).getRuntimeEnvironment = (): 'electron' | 'web' => 'electron'

if (__MORTISE_UI_VALIDATION_BUILD__ && process.env.MORTISE_UI_TEST_HOST === '1' && process.env.NODE_ENV !== 'production') {
  ;(api as ElectronAPI).uiValidation = {
    publishState: (batch: UiValidationRendererStateBatch) => {
      ipcRenderer.send(PRELOAD_LOCAL_CHANNELS.UI_VALIDATION_STATE_PUBLISH, batch)
    },
    dispose: () => ipcRenderer.send(PRELOAD_LOCAL_CHANNELS.UI_VALIDATION_STATE_DISPOSE),
  }
}

// ---------------------------------------------------------------------------
// Transport connection state logging (for remote connections)
// ---------------------------------------------------------------------------

function formatTransportReason(state: TransportConnectionState): string {
  const err = state.lastError
  if (err) {
    const codePart = err.code ? ` [${err.code}]` : ''
    return `${err.kind}${codePart}: ${err.message}`
  }

  if (state.lastClose?.code != null) {
    const reason = state.lastClose.reason ? ` (${state.lastClose.reason})` : ''
    return `close ${state.lastClose.code}${reason}`
  }

  return 'no additional details'
}

// Log remote connection state changes to main process (visible in terminal + main.log).
// Activates whenever the workspace connection is remote (thin client or remote workspace).
client.onConnectionStateChanged((state) => {
  if (state.mode !== 'remote') return

  const emitToMain = (level: 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.send(PRELOAD_LOCAL_CHANNELS.TRANSPORT_STATUS, {
      level,
      message,
      status: state.status,
      attempt: state.attempt,
      nextRetryInMs: state.nextRetryInMs,
      error: state.lastError,
      close: state.lastClose,
      url: state.url,
    })
  }

  if (state.status === 'connected') {
    const message = `[transport] connected to ${state.url}`
    console.info(message)
    emitToMain('info', message)
    return
  }

  if (state.status === 'reconnecting') {
    const retry = state.nextRetryInMs != null ? ` retry in ${state.nextRetryInMs}ms` : ''
    const message = `[transport] reconnecting (attempt ${state.attempt})${retry} — ${formatTransportReason(state)}`
    console.warn(message)
    emitToMain('warn', message)
    return
  }

  if (state.status === 'failed' || state.status === 'disconnected') {
    const message = `[transport] ${state.status} — ${formatTransportReason(state)}`
    console.error(message)
    emitToMain('error', message)
  }
})

// ---------------------------------------------------------------------------
// Transport state API (exposed to renderer)
// ---------------------------------------------------------------------------

;(api as any).getTransportConnectionState = async () => client.getConnectionState()
;(api as any).onTransportConnectionStateChanged = (callback: (state: TransportConnectionState) => void) => {
  return client.onConnectionStateChanged(callback)
}
;(api as any).reconnectTransport = async () => {
  client.reconnectNow()
}

// App lifecycle — direct IPC (not WS RPC) since it restarts the server itself
;(api as ElectronAPI).relaunchApp = () => ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.APP_RELAUNCH)
;(api as ElectronAPI).removeWorkspace = (workspaceId: string) => ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.WORKSPACE_REMOVE, workspaceId)
;(api as ElectronAPI).invokeOnServer = (
  url: string,
  token: string,
  channel: string,
  connection: { allowInsecureTls?: boolean },
  ...args: any[]
) => ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.SERVER_INVOKE_ON_SERVER, url, token, channel, connection, ...args)
;(api as ElectronAPI).invokeWorkspaceApi = (route: WorkspaceRoute, method: string, ...args: any[]) =>
  getWorkspaceMethod(route, method, 'invoke')(...args)
;(api as ElectronAPI).onWorkspaceApiEvent = (route: WorkspaceRoute, method: string, callback: (...args: any[]) => void) =>
  getWorkspaceMethod(route, method, 'listener')(callback)
;(api as ElectronAPI).transferSessionToWorkspace = (sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) =>
  ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.SESSION_TRANSFER_TO_REMOTE_WORKSPACE, sessionId, targetWorkspaceId, sessionIndex, sessionCount)
;(api as ElectronAPI).onTransferProgress = (cb: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void) => {
  const handler = (_e: any, progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => cb(progress)
  ipcRenderer.on('transfer:progress', handler)
  return () => { ipcRenderer.removeListener('transfer:progress', handler) }
}

// System warnings — expose env-based flags set during main process startup
// (preload-only: reads env var directly, no IPC round-trip needed)
;(api as ElectronAPI).getSystemWarnings = async () => ({
  vcredistMissing: process.env.MORTISE_VCREDIST_MISSING === '1',
  downloadUrl: process.env.MORTISE_VCREDIST_URL,
  workspaceRuntimeDegraded: process.env.MORTISE_WORKSPACE_RUNTIME_DEGRADED === '1',
  workspaceRuntimeDegradedReason: process.env.MORTISE_WORKSPACE_RUNTIME_DEGRADED_REASON,
})

// This flag is the only renderer-side source of Test Host authority. The main
// process rejects this environment combination in packaged/production builds.
if (__MORTISE_UI_VALIDATION_BUILD__ && process.env.MORTISE_UI_TEST_HOST === '1' && process.env.NODE_ENV !== 'production') {
  ;(api as ElectronAPI).uiValidationTestHost = Object.freeze({ schemaVersion: 1, enabled: true })
}

// i18n: sync language changes to main process (for native menus/dialogs)
;(api as ElectronAPI).changeLanguage = (lang: string) => ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.I18N_CHANGE_LANGUAGE, lang)

// webUtils.getPathForFile: returns the absolute OS path of a File object obtained
// from <input type="file"> or OS drag-drop. Returns null for Files fabricated from
// Blobs (clipboard paste, web-drag) — those are content-only, no filesystem path.
;(api as ElectronAPI).getFilePath = (file: File) => {
  try {
    return webUtils.getPathForFile(file) || null
  } catch {
    return null
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)

function assertThinClientRoute(route: WorkspaceRoute, serverUrl: string, workspaceId?: string): void {
  if (!workspaceId || route.workspaceId !== workspaceId || (route.serverId !== serverUrl && route.serverId !== 'local')) {
    throw new Error('Workspace route is not available in thin-client mode')
  }
}
