import type { ExtensionBridgeEvent } from '@mortise/shared/agent/backend/types'
import type {
  ExtensionFrontendChannelScope,
  ExtensionFrontendMessageV2,
} from '@mortise/shared/protocol'
import type { ExtensionUIBackend, ExtensionUIChannel, ExtensionUIChannelSnapshot } from '@mortise/extension-ui'

type ChannelKey = string
type Listener = (snapshot: ExtensionUIChannelSnapshot<unknown>) => void
type StoredSnapshot = ExtensionUIChannelSnapshot<unknown> & { sessionBootstrap?: boolean }

function keyOf(extensionId: string, channelId: string, scope: ExtensionFrontendChannelScope, runtimeId?: string, sessionId?: string, workspaceId?: string): ChannelKey {
  return [extensionId, channelId, scope, runtimeId ?? '', sessionId ?? '', workspaceId ?? ''].join('\0')
}

export class FrontendChannelStore {
  private readonly snapshots = new Map<ChannelKey, StoredSnapshot>()
  private readonly listeners = new Map<ChannelKey, Set<Listener>>()
  private readonly subscriptions = new Set<() => void>()

  apply(event: ExtensionBridgeEvent): void {
    if (event.type === 'extension_frontend_state') {
      const state = event.state
      if (state.schemaVersion !== 2) return
      const keys = [
        keyOf(event.extensionId, state.channelId, state.scope, event.runtimeId, event.sessionId, event.workspaceId),
        // A renderer can mount before the Pi runtime identity is known. Keep a
        // route-only alias so the first snapshot is still observable; exact
        // runtime keys remain authoritative once supplied by the host.
        keyOf(event.extensionId, state.channelId, state.scope, undefined, event.sessionId, event.workspaceId),
      ]
      if (state.scope !== 'session' || state.sessionBootstrap) {
        // Workspace/global frontends (notably settings pages) can mount
        // without a session route. Mirror the latest runtime snapshot into a
        // route-independent key while keeping session keys authoritative.
        keys.push(keyOf(event.extensionId, state.channelId, state.scope, event.runtimeId, undefined, event.workspaceId))
        keys.push(keyOf(event.extensionId, state.channelId, state.scope, undefined, undefined, event.workspaceId))
      }
      for (const key of keys) {
        const current = this.snapshots.get(key)
        if (current && state.revision <= current.revision) continue
        const snapshot = { revision: state.revision, state: state.state, sessionBootstrap: state.sessionBootstrap }
        this.snapshots.set(key, snapshot)
        for (const listener of this.listeners.get(key) ?? []) listener(snapshot)
      }
    } else if (event.type === 'extension_contributions_runtime_reset') {
      for (const key of this.snapshots.keys()) {
        const [extensionId, , , runtimeId, sessionId, workspaceId] = key.split('\0')
        if (extensionId !== event.extensionId || sessionId !== event.sessionId) continue
        if (event.workspaceId !== undefined && workspaceId !== event.workspaceId) continue
        if (runtimeId === event.runtimeId || runtimeId === '') this.snapshots.delete(key)
      }
    }
  }

  subscribe(key: ChannelKey, listener: Listener): () => void {
    const listeners = this.listeners.get(key) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(key, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(key)
    }
  }

  get(key: ChannelKey): ExtensionUIChannelSnapshot<unknown> | undefined {
    return this.snapshots.get(key)
  }

  getSessionBootstrap(workspaceId?: string): import('@mortise/shared/protocol').ExtensionSessionBootstrapV1 | undefined {
    if (!workspaceId) return undefined
    const bootstrap: import('@mortise/shared/protocol').ExtensionSessionBootstrapV1 = {}
    for (const [key, snapshot] of this.snapshots) {
      if (!snapshot.sessionBootstrap) continue
      const [extensionId, channelId, , runtimeId, sessionId, routedWorkspaceId] = key.split('\0')
      if (runtimeId || sessionId || routedWorkspaceId !== workspaceId) continue
      ;(bootstrap[extensionId] ??= {})[channelId] = snapshot.state
    }
    return Object.keys(bootstrap).length > 0 ? bootstrap : undefined
  }

  clear(): void {
    this.snapshots.clear()
  }
}

export const extensionFrontendChannelStore = new FrontendChannelStore()
let hostSubscription: (() => void) | undefined
const restoreInFlight = new Map<string, Promise<void>>()

function ensureSubscription(): void {
  if (hostSubscription || typeof window === 'undefined') return
  hostSubscription = window.electronAPI?.onExtensionEvent?.((event) => extensionFrontendChannelStore.apply(event))
}

export async function restoreExtensionFrontendStates(
  store: FrontendChannelStore,
  load: () => Promise<Array<Extract<ExtensionBridgeEvent, { type: 'extension_frontend_state' }>>>,
): Promise<void> {
  for (const event of await load()) store.apply(event)
}

function ensureStateRestore(sessionId?: string, workspaceId?: string): void {
  if ((!sessionId && !workspaceId) || typeof window === 'undefined' || typeof window.electronAPI?.getExtensionFrontendStates !== 'function') return
  const routeKey = sessionId || `workspace:${workspaceId}`
  if (restoreInFlight.has(routeKey)) return
  const restore = restoreExtensionFrontendStates(
    extensionFrontendChannelStore,
    () => window.electronAPI.getExtensionFrontendStates(sessionId ?? ''),
  ).catch((error) => {
    console.warn(`Failed to restore extension frontend states for ${routeKey}:`, error)
  }).finally(() => {
    if (restoreInFlight.get(routeKey) === restore) restoreInFlight.delete(routeKey)
  })
  restoreInFlight.set(routeKey, restore)
}

export function getExtensionSessionBootstrap(workspaceId?: string): import('@mortise/shared/protocol').ExtensionSessionBootstrapV1 | undefined {
  return extensionFrontendChannelStore.getSessionBootstrap(workspaceId)
}

export function createExtensionUIBackend(options: {
  extensionId: string
  scope: ExtensionFrontendChannelScope
  runtimeId?: string
  workspaceId?: string
  sessionId?: string
}): ExtensionUIBackend {
  ensureSubscription()
  ensureStateRestore(options.sessionId, options.workspaceId)
  return {
    channel<TState = unknown, TMessage = unknown>(channelId: string, channelOptions?: { scope?: ExtensionFrontendChannelScope }): ExtensionUIChannel<TState, TMessage> {
      const scope = channelOptions?.scope ?? options.scope
      const key = keyOf(options.extensionId, channelId, scope, options.runtimeId, options.sessionId, options.workspaceId)
      return {
        getSnapshot: () => extensionFrontendChannelStore.get(key) as ExtensionUIChannelSnapshot<TState> | undefined,
        subscribe: (listener) => extensionFrontendChannelStore.subscribe(key, listener as Listener),
        send: (message) => {
          const request: ExtensionFrontendMessageV2 = {
            schemaVersion: 2,
            extensionId: options.extensionId,
            channelId,
            scope,
            message,
            route: { workspaceId: options.workspaceId, sessionId: options.sessionId },
            runtimeId: options.runtimeId,
          }
          if (typeof window.electronAPI?.sendExtensionFrontendMessage !== 'function') return Promise.resolve(undefined)
          return window.electronAPI.sendExtensionFrontendMessage(options.sessionId ?? '', request)
        },
      }
    },
  }
}
