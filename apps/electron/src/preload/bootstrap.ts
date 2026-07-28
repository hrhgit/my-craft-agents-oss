/**
 * WS-mode preload — replaces the full IPC preload (index.ts).
 *
 * Normal mode (local server):
 *   Creates a RoutedClient that routes LOCAL_ONLY channels to the local
 *   Electron server and REMOTE_ELIGIBLE channels to the active Workspace's
 *   primary location. Explicit location routes remain live concurrently.
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
import 'electron-log/preload'
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
import { WsRpcClient, type TransportConnectionState } from '@mortise/server-core/transport'
import { RoutedClient } from '../transport/routed-client'
import { buildClientApi, type ChannelMapEntry } from '../transport/build-api'
import { CHANNEL_MAP } from '../transport/channel-map'
import { buildWorkspaceClientApi, evictWorkspaceApiCache, resolveWorkspaceApiMethod } from '../transport/workspace-api'
import { workspaceRouteKey } from '../transport/workspace-runtime-registry'
import { WorkspaceRuntimeGenerationTracker, WorkspaceRuntimeUpdateQueue } from '../transport/workspace-runtime-generation'
import { WorkspaceRuntimeTopologyState } from '../transport/workspace-runtime-topology'
import { WorkspaceTransferSingleFlight } from '../transport/workspace-transfer-single-flight'
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
import type { WorkspaceInfo, WorkspaceLocationInfo } from '@mortise/core/types'
import {
  RPC_CHANNELS,
  parseWorkspaceTransferEndpointCommitResultV1,
  parseWorkspaceTransferEndpointAccessResultV1,
  parseWorkspaceTransferEndpointCompleteResultV1,
  parseWorkspaceTransferEndpointExportInfoV1,
  parseWorkspaceTransferEndpointImportOpenResultV1,
  parseWorkspaceTransferEndpointReadResultV1,
  parseWorkspaceTransferEndpointWriteResultV1,
  parseWorkspaceTransferJournalV2,
  parseWorkspaceTransferRequestV1,
  parseWorkspaceTransferResultV1,
  type WorkspaceTopologyChangedV1,
  type WorkspaceTransferRequestV1,
  type WorkspaceTransferResultV1,
} from '@mortise/shared/protocol'
import type { ElectronAPI } from '../shared/types'
import type { ResolvedWorkspaceRoute, WorkspaceRoute } from '../shared/app-layout'
import { PRELOAD_LOCAL_CHANNELS } from '../shared/ipc-channels'
import { publishElectronPlatformCapabilities } from '../shared/platform-capabilities'
import type { UiValidationRendererStateBatch } from '../shared/ui-validation-state-bridge'
import type { WorkspaceLocationRuntimeConfig } from '../shared/workspace-runtime-config'
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
let orchestrateWorkspaceTransfer: ((request: WorkspaceTransferRequestV1) => Promise<WorkspaceTransferResultV1>) | undefined
const workspaceTransferSingleFlight = new WorkspaceTransferSingleFlight()

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
      assertThinClientRoute(route, workspaceId)
      return wsClient.invoke(channel, ...args)
    },
    on: (route, channel, callback) => {
      assertThinClientRoute(route, workspaceId)
      return wsClient.on(channel, callback)
    },
    isChannelAvailable: (route, channel) => {
      try {
        assertThinClientRoute(route, workspaceId)
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

  const initialWorkspaceClient = localWorkspaceClient ?? localClient
  const routedClient = new RoutedClient(localClient, initialWorkspaceClient, {
    localWorkspaceClient,
  })
  localClient.connect()
  localWorkspaceClient?.connect()
  client = routedClient

  const topologyState = new WorkspaceRuntimeTopologyState()
  const runtimeGenerations = new WorkspaceRuntimeGenerationTracker()
  const topologyUpdates = new WorkspaceRuntimeUpdateQueue()
  const runtimeUpdates = new Map<string, Promise<unknown>>()
  const runtimeLeases = new Map<string, { generation: string; release: () => void }>()

  const queueRuntimeUpdate = <Result>(key: string, update: () => Promise<Result>): Promise<Result> => {
    const previous = runtimeUpdates.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(update).finally(() => {
      if (runtimeUpdates.get(key) === pending) runtimeUpdates.delete(key)
    })
    runtimeUpdates.set(key, pending)
    return pending
  }

  const readWorkspaceTopology = async (requestedWorkspaceId: string): Promise<WorkspaceInfo> => {
    return await localClient.invoke(
      RPC_CHANNELS.workspaces.GET_TOPOLOGY,
      requestedWorkspaceId,
    ) as WorkspaceInfo
  }

  const loadWorkspaceTopology = async (requestedWorkspaceId: string): Promise<WorkspaceInfo> => {
    return topologyState.set(await readWorkspaceTopology(requestedWorkspaceId))
  }

  const resolveRuntimeConfig = async (
    workspace: WorkspaceInfo,
    location: WorkspaceLocationInfo,
  ): Promise<WorkspaceLocationRuntimeConfig> => {
    if (location.endpoint.kind === 'local') {
      return {
        kind: 'local',
        workspaceId: workspace.id,
        locationId: location.id,
      }
    }
    const config = await ipcRenderer.invoke(
      PRELOAD_LOCAL_CHANNELS.WORKSPACE_RESOLVE_LOCATION_RUNTIME,
      workspace.id,
      location.id,
    ) as WorkspaceLocationRuntimeConfig
    if (
      config.kind !== 'remote'
      || config.workspaceId !== workspace.id
      || config.locationId !== location.id
      || config.url !== location.endpoint.url
      || config.remoteWorkspaceId !== location.endpoint.remoteWorkspaceId
      || !config.token
    ) {
      throw new Error(`Host returned an invalid runtime for ${workspace.id}::${location.id}`)
    }
    return config
  }

  const installWorkspaceRuntime = async (
    workspace: WorkspaceInfo,
    locationId: string,
    mode: 'register' | 'replace',
  ): Promise<ResolvedWorkspaceRoute> => {
    const location = workspace.locations.find(candidate => candidate.id === locationId)
    if (!location) throw new Error(`Workspace location is not authorized: ${workspace.id}::${locationId}`)
    const route = topologyState.resolveRoute({
      workspaceId: workspace.id,
      locationId,
    })
    const key = workspaceRouteKey(route)
    const config = await resolveRuntimeConfig(workspace, location)
    const generation = config.kind === 'remote'
      ? runtimeGenerations.forRemote(workspace.id, location.id, config)
      : runtimeGenerations.forLocal(workspace.id, location.id)
    if (runtimeLeases.get(key)?.generation === generation && routedClient.hasWorkspaceRuntime(route)) {
      return route
    }

    const runtimeUrl = config.kind === 'remote'
      ? config.url
      : localWorkspaceServerUrl ?? `ws://127.0.0.1:${wsPort}`
    const runtimeToken = config.kind === 'remote'
      ? config.token
      : localWorkspaceServerUrl ? localWorkspaceServerToken : wsToken
    const targetWorkspaceId = config.kind === 'remote' ? config.remoteWorkspaceId : workspace.id
    const runtime = new WsRpcClient(runtimeUrl, {
      token: runtimeToken,
      workspaceId: targetWorkspaceId,
      webContentsId,
      autoReconnect: true,
      mode: config.kind === 'remote' || localWorkspaceServerUrl ? 'remote' : 'local',
      clientCapabilities: [...LOCAL_CLIENT_CAPABILITIES],
      ...(config.kind === 'remote'
        ? { tlsRejectUnauthorized: shouldRejectUnauthorizedTls(config) }
        : {}),
    })

    try {
      runtime.connect()
      const registration = {
        route,
        client: runtime,
        targetWorkspaceId: config.kind === 'remote' ? config.remoteWorkspaceId : undefined,
        generation,
        dispose: () => runtime.destroy(),
      }
      const release = mode === 'replace'
        ? routedClient.replaceWorkspaceRuntime(registration)
        : routedClient.registerWorkspaceRuntime(registration)
      const previous = runtimeLeases.get(key)
      runtimeLeases.set(key, { generation, release })
      previous?.release()
      return route
    } catch (error) {
      runtime.destroy()
      throw error
    }
  }

  const updateWorkspaceRuntime = (
    workspace: WorkspaceInfo,
    locationId: string,
    mode: 'register' | 'replace',
  ): Promise<ResolvedWorkspaceRoute> => {
    const route = topologyState.resolveRoute({ workspaceId: workspace.id, locationId })
    return queueRuntimeUpdate(workspaceRouteKey(route), () => installWorkspaceRuntime(workspace, locationId, mode))
  }

  const removeWorkspaceRuntime = (route: ResolvedWorkspaceRoute): Promise<void> => {
    const key = workspaceRouteKey(route)
    return queueRuntimeUpdate(key, async () => {
      runtimeLeases.get(key)?.release()
      runtimeLeases.delete(key)
      routedClient.removeWorkspaceRuntime(route)
    })
  }

  const reconcileWorkspaceRuntimes = (
    workspace: WorkspaceInfo,
    changedLocationIds: readonly string[] = [],
  ): Promise<void> => topologyUpdates.run(workspace.id, async () => {
    const locations = new Set(workspace.locations.map(location => location.id))
    const registered = routedClient.getRegisteredWorkspaceRoutes()
      .filter(route => route.workspaceId === workspace.id)

    for (const route of registered) {
      if (!locations.has(route.locationId)) await removeWorkspaceRuntime(route)
    }

    const changed = new Set(changedLocationIds)
    for (const route of registered) {
      if (locations.has(route.locationId) && changed.has(route.locationId)) {
        await updateWorkspaceRuntime(workspace, route.locationId, 'replace')
      }
    }

    const primaryRoute = await updateWorkspaceRuntime(
      workspace,
      workspace.primaryLocationId,
      routedClient.hasWorkspaceRuntime(topologyState.resolveRoute({
        workspaceId: workspace.id,
        locationId: workspace.primaryLocationId,
      })) ? 'replace' : 'register',
    )
    const activeWorkspaceId = await localClient.invoke(RPC_CHANNELS.window.GET_WORKSPACE) as string | null
    if (activeWorkspaceId === workspace.id) routedClient.activateWorkspaceRuntime(primaryRoute)
  })

  const ensureWorkspaceRuntime = async (route: WorkspaceRoute): Promise<ResolvedWorkspaceRoute> => {
    let workspace = topologyState.get(route.workspaceId)
    if (!workspace) workspace = await loadWorkspaceTopology(route.workspaceId)
    const resolved = topologyState.resolveRoute(route)
    if (!routedClient.hasWorkspaceRuntime(resolved)) {
      await updateWorkspaceRuntime(workspace, resolved.locationId, 'register')
    }
    return resolved
  }

  routedClient.setWorkspaceSwitchHandler((result) => {
    const ready = (async () => {
      const workspace = await loadWorkspaceTopology(result.workspaceId)
      await reconcileWorkspaceRuntimes(workspace)
      routedClient.activateWorkspaceRuntime(topologyState.resolveRoute({
        workspaceId: workspace.id,
        locationId: workspace.primaryLocationId,
      }))
    })()
    routedClient.setWorkspaceReady(ready)
    return ready
  })

  localClient.on(
    RPC_CHANNELS.workspaces.TOPOLOGY_CHANGED,
    (change: WorkspaceTopologyChangedV1) => {
      void (async () => {
        const decision = topologyState.apply(change)
        if (decision.status === 'ignored') return
        const workspace = decision.status === 'resync'
          ? await loadWorkspaceTopology(decision.workspaceId)
          : decision.workspace
        const changedLocationIds = decision.status === 'applied'
          ? decision.changedLocationIds
          : workspace.locations.map(location => location.id)
        evictWorkspaceApiCache(workspaceApis, workspace.id)
        const ready = reconcileWorkspaceRuntimes(workspace, changedLocationIds)
        routedClient.setWorkspaceReady(ready)
        await ready
      })().catch(error => {
        console.error(`[WorkspaceRuntime] Failed to apply topology change for ${change.workspaceId}:`, error)
      })
    },
  )

  const initialWorkspaceReady = (async () => {
    const workspace = await loadWorkspaceTopology(workspaceId)
    await reconcileWorkspaceRuntimes(workspace)
  })()
  routedClient.setWorkspaceReady(initialWorkspaceReady)

  workspaceApiTransport = {
    invoke: async (route, channel, ...args) => {
      const resolved = await ensureWorkspaceRuntime(route)
      return routedClient.invokeForWorkspace(resolved, channel, ...args)
    },
    on: (route, channel, callback) => {
      let disposed = false
      let unsubscribe: (() => void) | undefined
      void ensureWorkspaceRuntime(route).then((resolved) => {
        if (!disposed) unsubscribe = routedClient.onForWorkspace(resolved, channel, callback)
      }).catch(error => {
        console.error(`[WorkspaceAPI] Failed to subscribe ${channel}:`, error)
      })
      return () => {
        disposed = true
        unsubscribe?.()
      }
    },
    isChannelAvailable: (route, channel) => {
      try {
        return routedClient.isChannelAvailableForWorkspace(topologyState.resolveRoute(route), channel)
      } catch {
        return false
      }
    },
  }

  orchestrateWorkspaceTransfer = async (requestValue) => {
    const request = parseWorkspaceTransferRequestV1(requestValue)
    return workspaceTransferSingleFlight.run(request, async (): Promise<WorkspaceTransferResultV1> => {
    const hostLeaseToken = await ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.WORKSPACE_TRANSFER_LEASE_ACQUIRE, request) as string
    try {
    const journalValue = await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_GET, request)
    let journal = journalValue ? parseWorkspaceTransferJournalV2(journalValue) : null
    const priorValue = await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_GET, request)
    let prior = priorValue ? parseWorkspaceTransferResultV1(priorValue) : null
    if (prior && !(journal?.phase === 'completed' && journal.cleanupPending)) {
      return { ...prior, status: 'duplicate' }
    }
    const workspace = topologyState.get(request.workspaceId) ?? await loadWorkspaceTopology(request.workspaceId)
    if (workspace.revision !== request.expectedRevision && !journal) throw new Error(`Workspace revision is ${workspace.revision}, expected ${request.expectedRevision}`)
    if (journal?.phase === 'source-resolved') {
      prior = parseWorkspaceTransferResultV1(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_RECORD, request, {
        schemaVersion: 1,
        operationId: request.operationId,
        status: 'applied',
        workspaceId: request.workspaceId,
        sourceLocationId: request.source.locationId,
        destinationLocationId: request.destination.locationId,
        revision: request.expectedRevision,
        mode: request.mode,
        sha256: journal.sha256,
        bytes: journal.bytes,
        sourceRemoved: journal.sourceRemoved!,
      }))
      journal = parseWorkspaceTransferJournalV2(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_GET, request))
    }
    const sourceLocation = workspace.locations.find(location => location.id === request.source.locationId)
    const destinationLocation = workspace.locations.find(location => location.id === request.destination.locationId)
    if (!sourceLocation || !destinationLocation) throw new Error('Workspace transfer location is not available')
    const sourceRoute = topologyState.resolveRoute({ workspaceId: request.workspaceId, locationId: sourceLocation.id })
    const destinationRoute = topologyState.resolveRoute({ workspaceId: request.workspaceId, locationId: destinationLocation.id })
    await ensureWorkspaceRuntime(sourceRoute)
    await ensureWorkspaceRuntime(destinationRoute)
    const sourceInvoke = (channel: string, ...args: unknown[]) => routedClient.invokeForWorkspace(sourceRoute, channel, ...args)
    const destinationInvoke = (channel: string, ...args: unknown[]) => routedClient.invokeForWorkspace(destinationRoute, channel, ...args)
    const endpointRef = (location: WorkspaceLocationInfo) => location.endpoint.kind === 'local' ? location.id : undefined
    if (prior) {
      if (sourceLocation.endpoint.kind === 'local' && destinationLocation.endpoint.kind === 'local') {
        return parseWorkspaceTransferResultV1(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER, request))
      }
      try {
        if (journal?.phase !== 'completed' || !journal.cleanupPending || !journal.destinationCleanupToken) {
          throw new Error('Workspace transfer cleanup journal is incomplete')
        }
        const cleanups: Promise<unknown>[] = [destinationInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_CLEANUP, {
          schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
          locationId: endpointRef(destinationLocation), relativePath: request.destination.relativePath,
          expectedBytes: prior.bytes, expectedSha256: prior.sha256,
          cleanupToken: journal.destinationCleanupToken,
        })]
        if (journal.sourceCleanupToken) {
          cleanups.push(sourceInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_CLEANUP, {
            schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
            locationId: endpointRef(sourceLocation), relativePath: request.source.relativePath,
            cleanupToken: journal.sourceCleanupToken,
          }))
        }
        await Promise.all(cleanups)
        parseWorkspaceTransferJournalV2(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_CLEANUP_COMPLETE, request))
      } catch {}
      return { ...prior, status: 'duplicate' }
    }
    const sourceAccess = parseWorkspaceTransferEndpointAccessResultV1(await sourceInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_ACCESS, {
      schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId, locationId: endpointRef(sourceLocation),
    }))
    const destinationAccess = parseWorkspaceTransferEndpointAccessResultV1(await destinationInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_ACCESS, {
      schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId, locationId: endpointRef(destinationLocation),
    }))
    assertTransferEndpointAccess(sourceLocation.id, sourceAccess, 'read', request.mode === 'move')
    assertTransferEndpointAccess(destinationLocation.id, destinationAccess, 'write')
    if (sourceLocation.endpoint.kind === 'local' && destinationLocation.endpoint.kind === 'local') {
      return parseWorkspaceTransferResultV1(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER, request))
    }

    let sourceOpened = false
    let destinationOpened = false
    try {
      const sourceInfo = parseWorkspaceTransferEndpointExportInfoV1(await sourceInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_OPEN, {
        schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
        locationId: endpointRef(sourceLocation), relativePath: request.source.relativePath,
      }))
      sourceOpened = sourceInfo.status === 'opened'
      if (request.expectedSha256 && request.expectedSha256 !== sourceInfo.sha256) throw new Error('Workspace transfer source checksum mismatch')
      if (sourceInfo.status === 'source-conflict') {
        parseWorkspaceTransferJournalV2(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_SOURCE_RESOLVED, request, {
          sourceRemoved: false,
          sourceConflict: sourceInfo.sourceConflict,
          sourceCleanupToken: sourceInfo.cleanupToken,
        }))
        throw new Error('Workspace transfer source resolution conflicted')
      }
      if (sourceInfo.status === 'already-removed') {
        if (
          request.mode !== 'move'
          || !journal
          || journal.phase !== 'destination-published'
          || journal.bytes !== sourceInfo.bytes
          || journal.sha256 !== sourceInfo.sha256
        ) {
          throw new Error('Workspace transfer source was already removed without a published journal')
        }
        const result: WorkspaceTransferResultV1 = {
          schemaVersion: 1, operationId: request.operationId, status: 'applied', workspaceId: request.workspaceId,
          sourceLocationId: request.source.locationId, destinationLocationId: request.destination.locationId,
          revision: request.expectedRevision, mode: request.mode, sha256: sourceInfo.sha256, bytes: sourceInfo.bytes,
          sourceRemoved: true,
        }
        parseWorkspaceTransferJournalV2(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_SOURCE_RESOLVED, request, {
          sourceRemoved: true,
          sourceCleanupToken: sourceInfo.cleanupToken,
        }))
        const destinationReplay = parseWorkspaceTransferEndpointImportOpenResultV1(await destinationInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN, {
          schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
          locationId: endpointRef(destinationLocation), relativePath: request.destination.relativePath,
          expectedBytes: sourceInfo.bytes, expectedSha256: sourceInfo.sha256,
        }))
        if (destinationReplay.status !== 'already-published' || !destinationReplay.cleanupToken) throw new Error('Workspace transfer destination replay is not published')
        const recorded = parseWorkspaceTransferResultV1(await localClient.invoke(
          RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_RECORD,
          request,
          result,
          { destinationCleanupToken: destinationReplay.cleanupToken, sourceCleanupToken: sourceInfo.cleanupToken },
        ))
        try {
          await Promise.all([
            destinationInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_CLEANUP, {
              schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
              locationId: endpointRef(destinationLocation), relativePath: request.destination.relativePath,
              expectedBytes: sourceInfo.bytes, expectedSha256: sourceInfo.sha256,
              cleanupToken: destinationReplay.cleanupToken,
            }),
            sourceInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_CLEANUP, {
              schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
              locationId: endpointRef(sourceLocation), relativePath: request.source.relativePath,
              cleanupToken: sourceInfo.cleanupToken,
            }),
          ])
          parseWorkspaceTransferJournalV2(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_CLEANUP_COMPLETE, request))
        } catch {}
        return recorded
      }
      const prepared = parseWorkspaceTransferJournalV2(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_PREPARE, request, {
        bytes: sourceInfo.bytes,
        sha256: sourceInfo.sha256,
      }))
      if (prepared.phase === 'completed' && prepared.result) return { ...prepared.result, status: 'duplicate' }
      if (prepared.phase === 'aborted') throw new Error(`Workspace transfer was aborted: ${request.operationId}`)
      if (prepared.phase === 'source-conflict') throw new Error('Workspace transfer source resolution conflicted')
      const importOpen = parseWorkspaceTransferEndpointImportOpenResultV1(await destinationInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN, {
        schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
        locationId: endpointRef(destinationLocation), relativePath: request.destination.relativePath,
        expectedBytes: sourceInfo.bytes, expectedSha256: sourceInfo.sha256,
      }))
      destinationOpened = importOpen.status === 'opened'
      let destinationCleanupToken = importOpen.cleanupToken
      let offset = 0
      while (importOpen.status === 'opened' && offset < sourceInfo.bytes) {
        const chunk = parseWorkspaceTransferEndpointReadResultV1(await sourceInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_READ, {
          schemaVersion: 1, operationId: request.operationId, offset, maxBytes: 256 * 1024,
        }))
        if (chunk.offset !== offset || chunk.bytes.byteLength === 0) throw new Error('Workspace transfer endpoint returned an invalid chunk')
        const write = parseWorkspaceTransferEndpointWriteResultV1(await destinationInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE, {
          schemaVersion: 1, operationId: request.operationId, offset, bytes: chunk.bytes,
        }))
        offset += chunk.bytes.byteLength
        if (write.offset !== offset) throw new Error('Workspace transfer endpoint acknowledged an invalid write offset')
      }
      if (importOpen.status === 'opened') {
        const committed = parseWorkspaceTransferEndpointCommitResultV1(await destinationInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_COMMIT, {
          schemaVersion: 1, operationId: request.operationId, bytes: sourceInfo.bytes, sha256: sourceInfo.sha256,
        }))
        if (committed.bytes !== sourceInfo.bytes || committed.sha256 !== sourceInfo.sha256) {
          throw new Error('Workspace transfer endpoint committed unexpected content')
        }
        if (destinationCleanupToken && destinationCleanupToken !== committed.cleanupToken) throw new Error('Workspace transfer destination cleanup token changed')
        destinationCleanupToken = committed.cleanupToken
      }
      destinationOpened = false
      if (!destinationCleanupToken) throw new Error('Workspace transfer destination did not return a cleanup token')
      parseWorkspaceTransferJournalV2(await localClient.invoke(
        RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_PUBLISHED,
        request,
        { destinationCleanupToken },
      ))
      const completed = parseWorkspaceTransferEndpointCompleteResultV1(await sourceInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_COMPLETE, {
        schemaVersion: 1, operationId: request.operationId, removeIfUnchanged: request.mode === 'move',
      }))
      if (completed.sourceConflict) throw new Error('Workspace transfer source resolution conflicted')
      sourceOpened = false
      parseWorkspaceTransferJournalV2(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_SOURCE_RESOLVED, request, {
        sourceRemoved: completed.sourceRemoved,
        ...(completed.sourceConflict ? { sourceConflict: completed.sourceConflict } : {}),
        ...(completed.cleanupToken ? { sourceCleanupToken: completed.cleanupToken } : {}),
      }))
      const result: WorkspaceTransferResultV1 = {
        schemaVersion: 1, operationId: request.operationId, status: 'applied', workspaceId: request.workspaceId,
        sourceLocationId: request.source.locationId, destinationLocationId: request.destination.locationId,
        revision: request.expectedRevision, mode: request.mode, sha256: sourceInfo.sha256, bytes: sourceInfo.bytes,
        sourceRemoved: completed.sourceRemoved,
      }
      const recorded = parseWorkspaceTransferResultV1(await localClient.invoke(
        RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_RECORD,
        request,
        result,
        {
          destinationCleanupToken,
          ...(completed.cleanupToken ? { sourceCleanupToken: completed.cleanupToken } : {}),
        },
      ))
      try {
        const cleanups: Promise<unknown>[] = [destinationInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_CLEANUP, {
          schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
          locationId: endpointRef(destinationLocation), relativePath: request.destination.relativePath,
          expectedBytes: sourceInfo.bytes, expectedSha256: sourceInfo.sha256,
          cleanupToken: destinationCleanupToken,
        })]
        if (completed.cleanupToken) {
          cleanups.push(sourceInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_CLEANUP, {
            schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
            locationId: endpointRef(sourceLocation), relativePath: request.source.relativePath,
            cleanupToken: completed.cleanupToken,
          }))
        } else if (recorded.sourceRemoved || completed.sourceConflict) {
          throw new Error('Workspace transfer source did not return a cleanup token')
        }
        await Promise.all(cleanups)
        parseWorkspaceTransferJournalV2(await localClient.invoke(RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_CLEANUP_COMPLETE, request))
      } catch {}
      return recorded
    } catch (error) {
      await Promise.allSettled([
        sourceOpened
          ? sourceInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_ABORT, { schemaVersion: 1, operationId: request.operationId })
          : Promise.resolve(),
        destinationOpened
          ? destinationInvoke(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_ABORT, { schemaVersion: 1, operationId: request.operationId })
          : Promise.resolve(),
      ])
      throw error
    }
    } finally {
      await ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.WORKSPACE_TRANSFER_LEASE_RELEASE, request, hostLeaseToken)
    }
    })
  }

  void initialWorkspaceReady.then(async () => {
    const pending = await localClient.invoke(
      RPC_CHANNELS.workspaces.TRANSFER_JOURNAL_LIST_PENDING_CLEANUP,
      workspaceId,
    ) as unknown[]
    for (const requestValue of pending) {
      await orchestrateWorkspaceTransfer!(parseWorkspaceTransferRequestV1(requestValue)).catch(error => {
        console.error('[WorkspaceTransfer] Failed to recover pending cleanup:', error)
      })
    }
  }).catch(error => {
    console.error('[WorkspaceTransfer] Failed to list pending cleanup:', error)
  })
}

function assertTransferEndpointAccess(
  locationId: string,
  access: { availability: 'available'; permissions: { read: boolean; write: boolean } },
  required: 'read' | 'write',
  requireSourceWrite = false,
): void {
  if (access.availability !== 'available' || !access.permissions[required]) {
    throw new Error(`Workspace transfer location ${locationId} does not grant ${required} access`)
  }
  if (requireSourceWrite && !access.permissions.write) {
    throw new Error(`Workspace move source ${locationId} does not grant write access`)
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
publishElectronPlatformCapabilities(api)
function getWorkspaceApi(route: WorkspaceRoute): ElectronAPI {
  const key = `${encodeURIComponent(route.workspaceId)}::${encodeURIComponent(route.locationId ?? '@primary')}`
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
;(api as ElectronAPI).setWorkspaceRemoteCredential = (input) =>
  ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.WORKSPACE_SET_REMOTE_CREDENTIAL, input)
;(api as ElectronAPI).deleteWorkspaceRemoteCredential = (input) =>
  ipcRenderer.invoke(PRELOAD_LOCAL_CHANNELS.WORKSPACE_DELETE_REMOTE_CREDENTIAL, input)
;(api as ElectronAPI).invokeWorkspaceApi = (route: WorkspaceRoute, method: string, ...args: any[]) =>
  getWorkspaceMethod(route, method, 'invoke')(...args)
;(api as ElectronAPI).onWorkspaceApiEvent = (route: WorkspaceRoute, method: string, callback: (...args: any[]) => void) =>
  getWorkspaceMethod(route, method, 'listener')(callback)
;(api as ElectronAPI).workspaceTransfer = (request: WorkspaceTransferRequestV1) => {
  if (orchestrateWorkspaceTransfer) return orchestrateWorkspaceTransfer(request)
  return client.invoke(RPC_CHANNELS.workspaces.TRANSFER, request).then(parseWorkspaceTransferResultV1)
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

function assertThinClientRoute(route: WorkspaceRoute, workspaceId?: string): void {
  if (!workspaceId || route.workspaceId !== workspaceId) {
    throw new Error('Workspace route is not available in thin-client mode')
  }
}
