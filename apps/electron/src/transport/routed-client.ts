/**
 * RoutedClient — client-side channel router.
 *
 * Keeps the embedded host client separate from concurrent location runtimes,
 * with one registered location selected as the active Workspace client.
 *
 * - LOCAL_ONLY channels always route to localClient
 * - Everything else routes to workspaceClient
 * - On Workspace or primary-location change, workspaceClient is swapped and REMOTE_ELIGIBLE
 *   listeners are re-subscribed transparently (make-before-break)
 */

import type { WsRpcClient, TransportConnectionState } from '@mortise/server-core/transport'
import type { RpcClient } from '@mortise/server-core/transport'
import { isLocalOnly, RPC_CHANNELS } from '@mortise/shared/protocol'
import type { ResolvedWorkspaceRoute } from '../shared/app-layout'
import { WorkspaceRuntimeRegistry, type WorkspaceRuntimeRegistration } from './workspace-runtime-registry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListenerEntry {
  callback: (...args: any[]) => void
  unsub: () => void
}

/** Returned by the enhanced SWITCH_WORKSPACE handler. */
export interface WorkspaceSwitchResult {
  workspaceId: string
}

export type WorkspaceSwitchHandler = (result: WorkspaceSwitchResult) => void | Promise<void>

export interface RoutedClientOptions {
  localWorkspaceClient?: WsRpcClient
}

// ---------------------------------------------------------------------------
// RoutedClient
// ---------------------------------------------------------------------------

export class RoutedClient implements RpcClient {
  private readonly workspaceRuntimes = new WorkspaceRuntimeRegistry()
  private workspaceClient: WsRpcClient

  /** REMOTE_ELIGIBLE listener registry — survives workspace switches. */
  private remoteListeners = new Map<string, Set<ListenerEntry>>()

  /** Capability handlers — re-registered on workspace switch. */
  private capabilities = new Map<string, (...args: any[]) => Promise<any> | any>()

  /** Connection state listeners (delegates to workspaceClient). */
  private connectionStateListeners = new Set<(state: TransportConnectionState) => void>()
  private connectionStateUnsub: (() => void) | null = null

  private workspaceSwitchHandler: WorkspaceSwitchHandler | null = null
  private workspaceReady: Promise<void> = Promise.resolve()

  /** Client used for local workspace-owned channels; may be a child-process server. */
  private readonly localWorkspaceClient: WsRpcClient

  /**
   * Workspace ID mapping — translates local workspace IDs to remote ones.
   * When set, REMOTE_ELIGIBLE invoke() calls replace the local ID in
   * arguments with the remote ID so the server can resolve the workspace.
   */
  private workspaceIdMapping: { localId: string; remoteId: string } | null = null

  constructor(
    private readonly localClient: WsRpcClient,
    initialWorkspaceClient: WsRpcClient,
    options?: RoutedClientOptions,
  ) {
    this.localWorkspaceClient = options?.localWorkspaceClient ?? localClient
    this.workspaceClient = initialWorkspaceClient
    this.bindConnectionState()
  }

  setWorkspaceSwitchHandler(handler: WorkspaceSwitchHandler): void {
    this.workspaceSwitchHandler = handler
  }

  setWorkspaceReady(ready: Promise<void>): void {
    this.workspaceReady = ready
  }

  /** Register a long-lived runtime used by explicitly routed content tabs. */
  registerWorkspaceRuntime(registration: WorkspaceRuntimeRegistration): () => void {
    this.registerCapabilitiesOnWorkspaceRuntime(registration)
    return this.workspaceRuntimes.register(registration)
  }

  replaceWorkspaceRuntime(registration: WorkspaceRuntimeRegistration): () => void {
    this.registerCapabilitiesOnWorkspaceRuntime(registration)
    return this.workspaceRuntimes.replace(registration)
  }

  removeWorkspaceRuntime(route: ResolvedWorkspaceRoute): void {
    this.workspaceRuntimes.remove(route)
  }

  getRegisteredWorkspaceRoutes(): ResolvedWorkspaceRoute[] {
    return this.workspaceRuntimes.getRegisteredRoutes()
  }

  /** Invoke against a tab's trusted route without changing the active navigation workspace. */
  invokeForWorkspace(route: ResolvedWorkspaceRoute, channel: string, ...args: unknown[]): Promise<unknown> {
    return this.workspaceRuntimes.invoke(route, channel, ...args)
  }

  /** Subscribe to one workspace runtime without rebinding other tab subscriptions. */
  onForWorkspace(route: ResolvedWorkspaceRoute, channel: string, callback: (...args: any[]) => void): () => void {
    return this.workspaceRuntimes.on(route, channel, callback)
  }

  isChannelAvailableForWorkspace(route: ResolvedWorkspaceRoute, channel: string): boolean {
    return this.workspaceRuntimes.isChannelAvailable(route, channel)
  }

  hasWorkspaceRuntime(route: ResolvedWorkspaceRoute): boolean {
    return this.workspaceRuntimes.has(route)
  }

  /** Make one registered location the active Workspace transport. */
  activateWorkspaceRuntime(route: ResolvedWorkspaceRoute): void {
    const registration = this.workspaceRuntimes.get(route)
    if (!registration) {
      throw new Error(`Workspace runtime is not registered: ${route.workspaceId}::${route.locationId}`)
    }
    if (registration.targetWorkspaceId && registration.targetWorkspaceId !== route.workspaceId) {
      this.setWorkspaceMapping(route.workspaceId, registration.targetWorkspaceId)
    } else {
      this.clearWorkspaceMapping()
    }
    if (this.workspaceClient !== registration.client) {
      this.swapWorkspaceClient(registration.client)
    }
  }

  /**
   * Set workspace ID mapping for remote workspaces.
   * When a remote workspace is active, RPC calls pass the local workspace ID
   * as arguments, but the remote server only knows its own workspace IDs.
   * This mapping translates local → remote in invoke() arguments.
   */
  setWorkspaceMapping(localId: string, remoteId: string): void {
    this.workspaceIdMapping = { localId, remoteId }
  }

  /** Clear workspace ID mapping (when switching to a local workspace). */
  clearWorkspaceMapping(): void {
    this.workspaceIdMapping = null
  }

  // -------------------------------------------------------------------------
  // RpcClient interface
  // -------------------------------------------------------------------------

  async invoke(channel: string, ...args: any[]): Promise<any> {
    return this.invokeWithOptions(channel, args)
  }

  async invokeWithOptions(
    channel: string,
    args: any[],
    options?: { timeoutMs?: number },
  ): Promise<any> {
    const isLocal = isLocalOnly(channel)
    if (!isLocal) await this.workspaceReady
    const target = isLocal ? this.localClient : this.workspaceClient

    // Translate local workspace IDs → remote workspace IDs for remote-routed calls.
    // RPC handlers receive workspaceId as a method argument (not from connection context).
    // When routing to a remote server, the renderer's local workspace ID must be replaced
    // with the server's workspace ID so the handler can resolve the workspace.
    // Handles both top-level string args (e.g., getSkills(workspaceId)) and
    // object args with a workspaceId property (e.g., automation commands).
    const translatedArgs = (!isLocal && this.workspaceIdMapping)
      ? args.map(arg => {
          if (arg === this.workspaceIdMapping!.localId) return this.workspaceIdMapping!.remoteId
          if (arg && typeof arg === 'object' && 'workspaceId' in arg && arg.workspaceId === this.workspaceIdMapping!.localId) {
            return { ...arg, workspaceId: this.workspaceIdMapping!.remoteId }
          }
          return arg
        })
      : args

    const result = typeof target.invokeWithOptions === 'function'
      ? await target.invokeWithOptions(channel, translatedArgs, options)
      : await target.invoke(channel, ...translatedArgs)

    // Intercept SWITCH_WORKSPACE response to swap workspace client. Wait for
    // the workspace transport to adopt the new context before the renderer
    // starts issuing workspace-scoped requests.
    if (channel === RPC_CHANNELS.window.SWITCH_WORKSPACE) {
      await this.handleWorkspaceSwitch(result as WorkspaceSwitchResult)
    }

    return result
  }

  on(channel: string, callback: (...args: any[]) => void): () => void {
    if (isLocalOnly(channel)) {
      return this.localClient.on(channel, callback)
    }

    // REMOTE_ELIGIBLE — subscribe on workspaceClient and track for re-subscription
    const unsub = this.workspaceClient.on(channel, callback)

    let set = this.remoteListeners.get(channel)
    if (!set) {
      set = new Set()
      this.remoteListeners.set(channel, set)
    }
    const entry: ListenerEntry = { callback, unsub }
    set.add(entry)

    return () => {
      entry.unsub()
      set!.delete(entry)
      if (set!.size === 0) this.remoteListeners.delete(channel)
    }
  }

  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void {
    this.capabilities.set(channel, handler)
    // Register on every currently known client. Either the local GUI bridge,
    // the local workspace server, or a remote workspace server may invoke one.
    const clients = new Set([this.localClient, this.localWorkspaceClient, this.workspaceClient])
    for (const client of clients) {
      client.handleCapability(channel, handler)
    }
  }

  // -------------------------------------------------------------------------
  // Extended interface (used by bootstrap / build-api)
  // -------------------------------------------------------------------------

  isChannelAvailable(channel: string): boolean {
    const target = isLocalOnly(channel) ? this.localClient : this.workspaceClient
    return target.isChannelAvailable(channel)
  }

  getConnectionState(): TransportConnectionState {
    return this.workspaceClient.getConnectionState()
  }

  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void {
    this.connectionStateListeners.add(callback)
    callback(this.getConnectionState())
    return () => { this.connectionStateListeners.delete(callback) }
  }

  reconnectNow(): void {
    this.workspaceClient.reconnectNow()
  }

  // -------------------------------------------------------------------------
  // Workspace switch
  // -------------------------------------------------------------------------

  private async handleWorkspaceSwitch(result: WorkspaceSwitchResult): Promise<void> {
    if (!result) return
    await this.workspaceSwitchHandler?.(result)
  }

  private swapWorkspaceClient(newClient: WsRpcClient): void {
    const old = this.workspaceClient
    this.workspaceClient = newClient

    // Re-register capabilities on new client
    for (const [channel, handler] of this.capabilities) {
      newClient.handleCapability(channel, handler)
    }

    // Re-subscribe REMOTE_ELIGIBLE listeners (make-before-break:
    // subscribe on new first, then unsubscribe from old)
    for (const [channel, entries] of this.remoteListeners) {
      for (const entry of entries) {
        const oldUnsub = entry.unsub
        entry.unsub = newClient.on(channel, entry.callback)
        oldUnsub()
      }
    }

    // Rebind connection state delegation
    this.bindConnectionState()

    // Destroy old client unless it is one of the long-lived local clients.
    if (
      old !== this.localClient
      && old !== this.localWorkspaceClient
      && old !== newClient
      && !this.workspaceRuntimes.ownsClient(old)
    ) {
      old.destroy()
    }

    // Emit synthetic stale reconnect once the new client connects.
    // Workspace switches create a brand-new client (not a reconnect), so
    // __transport:reconnected never fires naturally. This triggers the App's
    // stale recovery logic to refresh sessions that changed while no client
    // was watching this workspace.
    if (newClient !== this.localClient) {
      // `let` + optional-chaining: onConnectionStateChanged can fire its
      // callback synchronously when the new client is already connected, which
      // would put `unsub` in the TDZ if declared `const`.
      let unsub: (() => void) | undefined
      unsub = newClient.onConnectionStateChanged((state) => {
        if (state.status === 'connected') {
          unsub?.()
          newClient.emitReconnected(true)
        }
      })
    }
  }

  private bindConnectionState(): void {
    this.connectionStateUnsub?.()
    this.connectionStateUnsub = this.workspaceClient.onConnectionStateChanged((state) => {
      const snapshot = { ...state }
      for (const cb of this.connectionStateListeners) {
        try { cb(snapshot) } catch { /* listener errors must not break transport */ }
      }
    })
  }

  private registerCapabilitiesOnWorkspaceRuntime(registration: WorkspaceRuntimeRegistration): void {
    for (const [channel, handler] of this.capabilities) {
      registration.client.handleCapability(channel, handler)
    }
  }
}
