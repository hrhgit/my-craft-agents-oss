import {
  RPC_CHANNELS,
  parseWorkspaceRemotePrimaryCommandV1,
  parseWorkspaceRemotePrimaryResultV1,
  parseWorkspaceV2,
  redactWorkspaceInfo,
  type WorkspaceRemotePrimaryCommandV1,
  type WorkspaceRemotePrimaryResultV1,
} from '@mortise/shared/protocol'
import { getCredentialManager } from '@mortise/shared/credentials'
import { getDefaultWorkspaceTopologyStore, initializeWorkspace } from '@mortise/shared/workspaces'
import type { Workspace } from '@mortise/core/types'
import type { RpcServer, WsRpcClient } from '@mortise/server-core/transport'
import type { HandlerDeps } from './handler-deps'
import { shouldRejectUnauthorizedTls, type RemoteTlsPolicy } from '../../shared/remote-tls'

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.remote.TEST_CONNECTION,
  RPC_CHANNELS.workspaces.REMOTE_PRIMARY_COMMAND,
  RPC_CHANNELS.window.OPEN_WORKSPACE,
  RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW,
  RPC_CHANNELS.window.OPEN_CHILD_SESSION_WINDOW,
  RPC_CHANNELS.window.CLOSE,
  RPC_CHANNELS.window.CONFIRM_CLOSE,
  RPC_CHANNELS.window.CANCEL_CLOSE,
  RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS,
] as const

/**
 * Connect to a remote server and wait for handshake.
 * When workspaceId is provided, the handshake is scoped to that workspace so
 * workspace-context RPC handlers (for example sessions:export) can resolve it.
 * Returns the connected client or null + error message.
 */
export interface RemoteConnectionOptions extends RemoteTlsPolicy {
  workspaceId?: string
}

export async function connectToRemote(url: string, token: string, options: RemoteConnectionOptions = {}) {
  const { WsRpcClient } = await import('@mortise/server-core/transport')
  const client = new WsRpcClient(url, {
    token,
    workspaceId: options.workspaceId,
    autoReconnect: false,
    tlsRejectUnauthorized: shouldRejectUnauthorizedTls(options),
  })

  const connected = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000)
    const unsub = client.onConnectionStateChanged((state) => {
      if (state.status === 'connected') {
        clearTimeout(timeout)
        unsub()
        resolve(true)
      } else if (state.status === 'failed') {
        clearTimeout(timeout)
        unsub()
        resolve(false)
      }
    })
    client.connect()
  })

  if (!connected) {
    const error = client.getConnectionState().lastError?.message ?? 'Connection failed'
    client.destroy()
    return { client: null, error }
  }

  return { client, error: null }
}

export function registerWorkspaceGuiHandlers(server: RpcServer, deps: HandlerDeps): void {
  const windowManager = deps.windowManager
  const topologyStore = getDefaultWorkspaceTopologyStore()
  const remotePrimaryOperations = new Map<string, {
    command: WorkspaceRemotePrimaryCommandV1
    result: Promise<WorkspaceRemotePrimaryResultV1>
  }>()

  const runRemotePrimaryCommand = async (
    command: WorkspaceRemotePrimaryCommandV1,
  ): Promise<WorkspaceRemotePrimaryResultV1> => {
    const persistedTopology = topologyStore.get(command.workspaceId)
    if (persistedTopology) {
      const workspace = persistedTopology
      requireMatchingRemoteWorkspace(workspace, command)
      return remotePrimaryResult(command, workspace, remoteWorkspaceId(workspace), 'duplicate', {
        status: 'unknown', reason: 'not-observed',
      }, unavailablePermissions())
    }

    const token = await getCredentialManager().getWorkspaceRemoteBearer(command.workspaceId, command.server.credentialRef)
    if (!token) throw new Error(`Remote Workspace credential is unavailable for ${command.workspaceId}::${command.locationId}`)
    const { client, error } = await connectToRemote(command.server.url, token, command.server)
    if (!client) throw new Error(error ?? 'Remote Workspace connection failed')

    try {
      const remoteWorkspace = command.operation === 'connect-existing'
        ? await requireRemoteWorkspace(client, command.remoteWorkspaceId)
        : await client.invoke(RPC_CHANNELS.server.CREATE_WORKSPACE, command.remoteRootName) as { id: string; locations?: Array<{ id: string; rootName?: string }> }
      const remoteId = command.operation === 'connect-existing'
        ? command.remoteWorkspaceId
        : requireRemoteWorkspaceId(remoteWorkspace)
      requireRemoteRootName(remoteWorkspace, command.remoteRootName)

      const workspace = createRemotePrimaryWorkspace(command, remoteId)
      initializeWorkspace(workspace, {
        topologyStore,
        operationId: command.operationId,
      })
      return remotePrimaryResult(
        command,
        workspace,
        remoteId,
        'applied',
        { status: 'available', observedAt: Date.now() },
        remotePermissions(client),
      )
    } finally {
      client.destroy()
    }
  }

  server.handle(RPC_CHANNELS.workspaces.REMOTE_PRIMARY_COMMAND, async (_ctx, commandValue: unknown) => {
    const command = parseWorkspaceRemotePrimaryCommandV1(commandValue)
    const existing = remotePrimaryOperations.get(command.operationId)
    if (existing) {
      assertSameOperation(existing.command, command, 'remote-primary')
      return parseWorkspaceRemotePrimaryResultV1({ ...await existing.result, status: 'duplicate' })
    }

    const result = runRemotePrimaryCommand(command)
    remotePrimaryOperations.set(command.operationId, { command, result })
    try {
      const resolved = await result
      trimOperationMap(remotePrimaryOperations)
      return resolved
    } catch (error) {
      if (remotePrimaryOperations.get(command.operationId)?.result === result) {
        remotePrimaryOperations.delete(command.operationId)
      }
      throw error
    }
  })

  // Test connection to a remote Mortise Agent Server.
  // Pure discovery — returns list of existing workspaces or needsWorkspace flag.
  // Workspace creation is handled by the host-owned remote-primary command.
  server.handle(RPC_CHANNELS.remote.TEST_CONNECTION, async (_ctx, url: string, token: string, allowInsecureTls = false) => {
    const { client, error } = await connectToRemote(url, token, { allowInsecureTls })
    if (!client) return { ok: false, error }

    // Read server version from handshake_ack (null for old servers)
    const serverVersion = client.getServerVersion() ?? undefined

    try {
      console.log(`[TEST_CONNECTION] invoking ${RPC_CHANNELS.server.GET_WORKSPACES} on remote server...`)
      const remoteWorkspaces = await client.invoke(RPC_CHANNELS.server.GET_WORKSPACES) as Array<{
        id: string
        name: string
        primaryLocationId: string
        locations: Array<{ id: string; rootName: string }>
      }>
      const workspaces = remoteWorkspaces.map(workspace => {
        const primary = workspace.locations.find(location => location.id === workspace.primaryLocationId)
        if (!primary?.rootName) throw new Error(`Remote Workspace has no verified primary root name: ${workspace.id}`)
        return { id: workspace.id, name: workspace.name, rootName: primary.rootName }
      })
      console.log(`[TEST_CONNECTION] remote returned ${workspaces?.length ?? 'null'} workspaces:`, JSON.stringify(workspaces?.map(w => ({ id: w.id, name: w.name }))))

      if (workspaces.length === 0) {
        console.log('[TEST_CONNECTION] → returning needsWorkspace=true')
        return { ok: true, needsWorkspace: true, serverVersion }
      }

      const result = {
        ok: true,
        serverVersion,
        remoteWorkspaces: workspaces,
        // Convenience: auto-select if exactly one
        remoteWorkspaceId: workspaces.length === 1 ? workspaces[0].id : undefined,
        remoteWorkspaceName: workspaces.length === 1 ? workspaces[0].name : undefined,
        remoteWorkspaceRootName: workspaces.length === 1 ? workspaces[0].rootName : undefined,
      }
      console.log(`[TEST_CONNECTION] → returning ${workspaces.length} workspaces`)
      return result
    } catch (err) {
      console.error('[TEST_CONNECTION] error:', err)
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
    } finally {
      client.destroy()
    }
  })

  // Open workspace in new window (or focus existing)
  server.handle(RPC_CHANNELS.window.OPEN_WORKSPACE, async (_ctx, workspaceId: string) => {
    if (!windowManager) return
    windowManager.focusOrCreateWindow(workspaceId)
  })

  // Open a session in a new window
  server.handle(RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW, async (_ctx, workspaceId: string, sessionId: string) => {
    if (!windowManager) return
    const session = await deps.sessionManager.getSession(sessionId)
    if (!session || session.workspaceId !== workspaceId) {
      throw new Error(`Session is not available in the Pi-first UI: ${sessionId}`)
    }
    windowManager.createChildSessionWindow(sessionId, {
      workspaceId,
    })
  })

  // Open a pi child session in a new independent window.
  // Desktop-only: the CLI has no windowing infrastructure. The workspace is
  // resolved from the calling window so the renderer initialises with the
  // correct workspace context (session list, transport routing, etc.).
  server.handle(
    RPC_CHANNELS.window.OPEN_CHILD_SESSION_WINDOW,
    async (ctx, sessionId: string, options?: { title?: string; width?: number; height?: number }) => {
      if (!windowManager) return
      const workspaceId = windowManager.getWorkspaceForWindow(ctx.webContentsId!) ?? ''
      windowManager.createChildSessionWindow(sessionId, {
        ...options,
        workspaceId,
        parentWebContentsId: ctx.webContentsId ?? undefined,
      })
    },
  )

  // Close the calling window (triggers close event which may be intercepted)
  server.handle(RPC_CHANNELS.window.CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.closeWindow(ctx.webContentsId!)
  })

  // Confirm close - force close the window (bypasses interception).
  server.handle(RPC_CHANNELS.window.CONFIRM_CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.forceCloseWindow(ctx.webContentsId!)
  })

  // Cancel close - renderer handled the request (closed a modal/panel).
  server.handle(RPC_CHANNELS.window.CANCEL_CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.cancelPendingClose(ctx.webContentsId!)
  })

  // Show/hide macOS traffic light buttons (for fullscreen overlays)
  server.handle(RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS, (ctx, visible: boolean) => {
    if (!windowManager) return
    windowManager.setTrafficLightsVisible(ctx.webContentsId!, visible)
  })
}

function createRemotePrimaryWorkspace(
  command: WorkspaceRemotePrimaryCommandV1,
  remoteWorkspaceId: string,
): Workspace {
  const name = command.displayName.source === 'custom'
    ? command.displayName.name
    : command.remoteRootName
  return parseWorkspaceV2({
    schemaVersion: 2,
    id: command.workspaceId,
    revision: 0,
    name,
    nameSource: command.displayName.source,
    slug: workspaceSlug(name),
    primaryLocationId: command.locationId,
    locations: [{
      id: command.locationId,
      name: command.remoteRootName,
      rootName: command.remoteRootName,
      endpoint: {
        kind: 'remote',
        url: command.server.url,
        remoteWorkspaceId,
        credentialRef: command.server.credentialRef,
        ...(command.server.allowInsecureTls === undefined
          ? {}
          : { allowInsecureTls: command.server.allowInsecureTls }),
      },
    }],
    createdAt: Date.now(),
  })
}

function requireMatchingRemoteWorkspace(
  workspace: Workspace,
  command: WorkspaceRemotePrimaryCommandV1,
): Workspace {
  const primary = workspace.locations.find(location => location.id === workspace.primaryLocationId)
  const expectedName = command.displayName.source === 'custom' ? command.displayName.name : command.remoteRootName
  if (
    workspace.id !== command.workspaceId
    || workspace.primaryLocationId !== command.locationId
    || workspace.name !== expectedName
    || workspace.nameSource !== command.displayName.source
    || !primary
    || primary.endpoint.kind !== 'remote'
    || primary.endpoint.url !== command.server.url
    || primary.endpoint.credentialRef !== command.server.credentialRef
    || primary.endpoint.allowInsecureTls !== command.server.allowInsecureTls
    || primary.rootName !== command.remoteRootName
    || (command.operation === 'connect-existing' && primary.endpoint.remoteWorkspaceId !== command.remoteWorkspaceId)
  ) {
    throw new Error(`Workspace identity is already owned by a different topology: ${command.workspaceId}`)
  }
  return workspace
}

function remoteWorkspaceId(workspace: Workspace): string {
  const primary = workspace.locations.find(location => location.id === workspace.primaryLocationId)
  if (!primary || primary.endpoint.kind !== 'remote') {
    throw new Error(`Workspace does not have a remote primary location: ${workspace.id}`)
  }
  return primary.endpoint.remoteWorkspaceId
}

async function requireRemoteWorkspace(client: WsRpcClient, workspaceId: string): Promise<unknown> {
  const workspaces = await client.invoke(RPC_CHANNELS.server.GET_WORKSPACES) as Array<{ id?: unknown }>
  const workspace = workspaces.find(candidate => candidate.id === workspaceId)
  if (!workspace) throw new Error(`Remote Workspace not found: ${workspaceId}`)
  return workspace
}

function requireRemoteWorkspaceId(value: unknown): string {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
    throw new Error('Remote Workspace creation returned an invalid identity')
  }
  return (value as { id: string }).id
}

function requireRemoteRootName(value: unknown, expectedRootName: string): void {
  if (!value || typeof value !== 'object') throw new Error('Remote Workspace discovery returned an invalid result')
  const workspace = value as {
    primaryLocationId?: unknown
    locations?: Array<{ id?: unknown; rootName?: unknown }>
  }
  const primary = workspace.locations?.find(location => location.id === workspace.primaryLocationId)
  if (!primary || primary.rootName !== expectedRootName) {
    throw new Error(`Remote Workspace root does not match the verified root name: ${expectedRootName}`)
  }
}

function remotePrimaryResult(
  command: WorkspaceRemotePrimaryCommandV1,
  workspace: Workspace,
  remoteId: string,
  status: 'applied' | 'duplicate',
  availability: { status: 'available'; observedAt: number } | { status: 'unknown'; reason: 'not-observed' },
  permissions: { read: boolean; write: boolean; search: boolean; runCommands: boolean },
): WorkspaceRemotePrimaryResultV1 {
  return parseWorkspaceRemotePrimaryResultV1({
    schemaVersion: 1,
    operationId: command.operationId,
    status,
    workspaceId: workspace.id,
    locationId: workspace.primaryLocationId,
    remoteWorkspaceId: remoteId,
    workspace: redactWorkspaceInfo(workspace, [{
      schemaVersion: 1,
      locationId: workspace.primaryLocationId,
      availability,
      permissions,
    }]),
  })
}

function remotePermissions(client: Pick<WsRpcClient, 'isChannelAvailable'>) {
  return {
    read: client.isChannelAvailable(RPC_CHANNELS.fs.LIST_WORKSPACE_DIRECTORY),
    write: client.isChannelAvailable(RPC_CHANNELS.fs.WRITE_WORKSPACE_TEXT),
    search: client.isChannelAvailable(RPC_CHANNELS.fs.SEARCH_WORKSPACE),
    runCommands: client.isChannelAvailable(RPC_CHANNELS.sessions.SEND_MESSAGE),
  }
}

function unavailablePermissions() {
  return { read: false, write: false, search: false, runCommands: false }
}

function workspaceSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'
}

function assertSameOperation(existing: unknown, incoming: unknown, kind: string): void {
  if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
    throw new Error(`Workspace ${kind} operation identity was reused`)
  }
}

function trimOperationMap<Value>(operations: Map<string, Value>): void {
  if (operations.size > 1_024) operations.delete(operations.keys().next().value!)
}
