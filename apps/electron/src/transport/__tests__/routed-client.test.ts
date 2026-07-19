/**
 * RoutedClient tests — channel routing, workspace switch, listener re-subscription.
 */

import { describe, it, expect, mock } from 'bun:test'
import { RoutedClient } from '../routed-client'
import type { WsRpcClient, TransportConnectionState } from '@mortise/server-core/transport'

// ---------------------------------------------------------------------------
// Minimal WsRpcClient stub
// ---------------------------------------------------------------------------

function stubClient(overrides?: Partial<WsRpcClient>): WsRpcClient {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const capabilities = new Map<string, (...args: any[]) => any>()
  const invoke = overrides?.invoke ?? mock(async () => undefined)
  const invokeWithOptions = overrides?.invokeWithOptions ?? mock(async (channel: string, args: any[]) => invoke(channel, ...args))
  const passthroughOverrides = { ...(overrides as Record<string, unknown> | undefined) }
  delete passthroughOverrides.invoke
  delete passthroughOverrides.invokeWithOptions

  return {
    connect: mock(() => {}),
    destroy: mock(() => {}),
    invoke,
    invokeWithOptions,
    on: mock((channel: string, cb: (...args: any[]) => void) => {
      let set = listeners.get(channel)
      if (!set) { set = new Set(); listeners.set(channel, set) }
      set.add(cb)
      return () => { set!.delete(cb) }
    }),
    handleCapability: mock((channel: string, handler: (...args: any[]) => any) => {
      capabilities.set(channel, handler)
    }),
    isChannelAvailable: mock(() => true),
    getConnectionState: mock((): TransportConnectionState => ({
      mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now(),
    })),
    onConnectionStateChanged: mock((cb: (state: TransportConnectionState) => void) => {
      cb({ mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now() })
      return () => {}
    }),
    reconnectNow: mock(() => {}),
    emitReconnected: mock((isStale: boolean) => {
      const set = listeners.get('__transport:reconnected')
      if (!set) return
      for (const cb of set) {
        try { cb(isStale) } catch { /* listener errors must not break transport */ }
      }
    }),
    // expose internals for assertions
    _listeners: listeners,
    _capabilities: capabilities,
    ...passthroughOverrides,
  } as any
}

// Use real channel constants — RoutedClient routes based on isLocalOnly()
import { isLocalOnly, RPC_CHANNELS } from '@mortise/shared/protocol'

const LOCAL_CHANNEL = RPC_CHANNELS.window.GET_WORKSPACE   // LOCAL_ONLY
const REMOTE_CHANNEL = RPC_CHANNELS.sessions.GET           // REMOTE_ELIGIBLE
const SWITCH_CHANNEL = RPC_CHANNELS.window.SWITCH_WORKSPACE

describe('RoutedClient', () => {
  describe('routing', () => {
    it('routes LOCAL_ONLY invokes to localClient', async () => {
      const local = stubClient({ invoke: mock(async () => 'local-result') })
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const result = await routed.invoke(LOCAL_CHANNEL)
      expect(result).toBe('local-result')
      expect(local.invoke).toHaveBeenCalledWith(LOCAL_CHANNEL)
      expect(workspace.invoke).not.toHaveBeenCalled()
    })

    it('routes REMOTE_ELIGIBLE invokes to workspaceClient', async () => {
      const local = stubClient()
      const workspace = stubClient({ invoke: mock(async () => 'ws-result') })
      const routed = new RoutedClient(local, workspace)

      const result = await routed.invoke(REMOTE_CHANNEL)
      expect(result).toBe('ws-result')
      expect(workspace.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
      expect(local.invoke).not.toHaveBeenCalled()
    })

    it('passes timeout options through to invokeWithOptions when available', async () => {
      const local = stubClient()
      const workspace = stubClient({ invokeWithOptions: mock(async () => 'ws-result') })
      const routed = new RoutedClient(local, workspace)

      const result = await routed.invokeWithOptions(REMOTE_CHANNEL, ['session-1'], { timeoutMs: 4321 })

      expect(result).toBe('ws-result')
      expect(workspace.invokeWithOptions).toHaveBeenCalledWith(REMOTE_CHANNEL, ['session-1'], { timeoutMs: 4321 })
      expect(workspace.invoke).not.toHaveBeenCalled()
    })

    it('routes LOCAL_ONLY listeners to localClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      routed.on(LOCAL_CHANNEL, cb)

      expect(local.on).toHaveBeenCalledWith(LOCAL_CHANNEL, cb)
      expect(workspace.on).not.toHaveBeenCalledWith(LOCAL_CHANNEL, expect.any(Function))
    })

    it('routes REMOTE_ELIGIBLE listeners to workspaceClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      routed.on(REMOTE_CHANNEL, cb)

      expect(workspace.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)
    })
  })

  describe('workspace switch', () => {
    // SWITCH_WORKSPACE is LOCAL_ONLY — the switch result mock goes on localClient
    it('swaps workspaceClient when SWITCH_WORKSPACE returns remoteServer', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: { url: 'wss://remote:9001', token: 'tok', remoteWorkspaceId: 'rw-1' },
        })),
      })
      const workspace = stubClient()

      const newRemote = stubClient()
      const routed = new RoutedClient(local, workspace)
      routed.setClientFactory(() => newRemote)

      await routed.invoke(SWITCH_CHANNEL)

      // New client should have been connected
      expect(newRemote.connect).toHaveBeenCalled()
      // Old workspace client should have been destroyed (it's not the local client)
      expect(workspace.destroy).toHaveBeenCalled()
    })

    it('builds the replacement from the latest switch config and destroys the old remote client', async () => {
      const latestRemoteServer = {
        url: 'wss://new.example.test:9443',
        token: 'new-token',
        remoteWorkspaceId: 'remote-workspace-2',
        allowInsecureTls: true,
      }
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'workspace-2',
          remoteServer: latestRemoteServer,
        })),
      })
      const oldRemote = stubClient()
      const newRemote = stubClient()
      const factory = mock(() => newRemote)
      const routed = new RoutedClient(local, oldRemote)
      routed.setClientFactory(factory)

      await routed.invoke(SWITCH_CHANNEL, 'workspace-2')

      expect(factory).toHaveBeenCalledWith(latestRemoteServer)
      expect(newRemote.connect).toHaveBeenCalledTimes(1)
      expect(oldRemote.destroy).toHaveBeenCalledTimes(1)
      await routed.invoke(REMOTE_CHANNEL)
      expect(newRemote.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
    })

    it('rolls back a synchronous replacement connect failure without changing workspace mapping', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'workspace-new',
          remoteServer: {
            url: 'wss://new.example.test',
            token: 'new-token',
            remoteWorkspaceId: 'remote-new',
          },
        })),
      })
      const oldRemote = stubClient({ invoke: mock(async () => 'old-runtime') })
      const connectError = new Error('connect failed synchronously')
      const newRemote = stubClient({ connect: mock(() => { throw connectError }) })
      const routed = new RoutedClient(local, oldRemote)
      routed.setWorkspaceMapping('workspace-old', 'remote-old')
      routed.setClientFactory(() => newRemote)

      await expect(routed.invoke(SWITCH_CHANNEL, 'workspace-new')).rejects.toBe(connectError)

      expect(newRemote.destroy).toHaveBeenCalledTimes(1)
      expect(oldRemote.destroy).not.toHaveBeenCalled()
      expect(await routed.invoke(REMOTE_CHANNEL, 'workspace-old')).toBe('old-runtime')
      expect(oldRemote.invoke).toHaveBeenLastCalledWith(REMOTE_CHANNEL, 'remote-old')
    })

    it('refreshes scoped workspace runtimes after the active client has swapped', async () => {
      const latestRemoteServer = {
        url: 'wss://same.example.test',
        token: 'rotated-token',
        remoteWorkspaceId: 'remote-workspace',
        allowInsecureTls: true,
      }
      const local = stubClient({
        invoke: mock(async () => ({ workspaceId: 'workspace-2', remoteServer: latestRemoteServer })),
      })
      const oldRemote = stubClient()
      const newRemote = stubClient({ invoke: mock(async () => 'new-runtime') })
      const routed = new RoutedClient(local, oldRemote)
      routed.setClientFactory(() => newRemote)
      const switchHandler = mock(async (result) => {
        expect(result.remoteServer).toEqual(latestRemoteServer)
        expect(await routed.invoke(REMOTE_CHANNEL)).toBe('new-runtime')
      })
      routed.setWorkspaceSwitchHandler(switchHandler)

      await routed.invoke(SWITCH_CHANNEL, 'workspace-2')

      expect(switchHandler).toHaveBeenCalledTimes(1)
      expect(oldRemote.destroy).toHaveBeenCalledTimes(1)
    })

    it('reverts to localClient when switching to local workspace', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-local',
          remoteServer: null,
        })),
      })
      const remoteWs = stubClient()

      const routed = new RoutedClient(local, remoteWs)
      await routed.invoke(SWITCH_CHANNEL)

      // Remote client should be destroyed
      expect(remoteWs.destroy).toHaveBeenCalled()
      // Subsequent REMOTE_ELIGIBLE calls should go to localClient
      await routed.invoke(REMOTE_CHANNEL)
      expect(local.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
    })

    it('uses localWorkspaceClient when switching back to a local workspace', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-local',
          remoteServer: null,
        })),
      })
      const localWorkspace = stubClient()
      const remoteWs = stubClient()

      const routed = new RoutedClient(local, remoteWs, {
        localWorkspaceClient: localWorkspace,
      })

      await routed.invoke(SWITCH_CHANNEL)

      expect(remoteWs.destroy).toHaveBeenCalled()
      expect(localWorkspace.destroy).not.toHaveBeenCalled()

      await routed.invoke(REMOTE_CHANNEL)
      expect(localWorkspace.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
      expect(local.invoke).not.toHaveBeenCalledWith(REMOTE_CHANNEL)
    })

    it('updates a separate local workspace transport on local-to-local switch', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: null,
        })),
      })
      const localWorkspace = stubClient()
      const routed = new RoutedClient(local, localWorkspace, {
        localWorkspaceClient: localWorkspace,
      })

      await routed.invoke(SWITCH_CHANNEL, 'ws-2')

      expect(localWorkspace.invoke).toHaveBeenCalledWith(SWITCH_CHANNEL, 'ws-2')
    })

    it('waits for local workspace transport context before completing the switch', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: null,
        })),
      })
      let finishWorkspaceSwitch: (() => void) | undefined
      const localWorkspace = stubClient({
        invoke: mock(() => new Promise<void>((resolve) => {
          finishWorkspaceSwitch = resolve
        })),
      })
      const routed = new RoutedClient(local, localWorkspace, {
        localWorkspaceClient: localWorkspace,
      })
      let completed = false

      const switching = routed.invoke(SWITCH_CHANNEL, 'ws-2').then(() => {
        completed = true
      })
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(completed).toBe(false)
      expect(finishWorkspaceSwitch).toBeDefined()
      finishWorkspaceSwitch!()
      await switching
      expect(completed).toBe(true)
    })

    it('does not repeat the switch when GUI and workspace transport are shared', async () => {
      const localInvoke = mock(async () => ({
        workspaceId: 'ws-2',
        remoteServer: null,
      }))
      const local = stubClient({ invoke: localInvoke })
      const routed = new RoutedClient(local, local)

      await routed.invoke(SWITCH_CHANNEL, 'ws-2')

      expect(localInvoke).toHaveBeenCalledTimes(1)
    })

    it('re-subscribes REMOTE_ELIGIBLE listeners on swap (make-before-break)', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: { url: 'wss://remote:9001', token: 'tok', remoteWorkspaceId: 'rw-1' },
        })),
      })
      const workspace = stubClient()

      const newRemote = stubClient()
      const routed = new RoutedClient(local, workspace)
      routed.setClientFactory(() => newRemote)

      // Subscribe a listener before switch
      const cb = mock(() => {})
      routed.on(REMOTE_CHANNEL, cb)
      expect(workspace.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)

      // Trigger switch
      await routed.invoke(SWITCH_CHANNEL)

      // Listener should be re-subscribed on the new client
      expect(newRemote.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)
    })

    it('re-registers capabilities on swap', async () => {
      const local = stubClient({
        invoke: mock(async () => ({
          workspaceId: 'ws-2',
          remoteServer: { url: 'wss://remote:9001', token: 'tok', remoteWorkspaceId: 'rw-1' },
        })),
      })
      const workspace = stubClient()

      const newRemote = stubClient()
      const routed = new RoutedClient(local, workspace)
      routed.setClientFactory(() => newRemote)

      const handler = mock(async () => 'capability-result')
      routed.handleCapability('test:capability', handler)

      await routed.invoke(SWITCH_CHANNEL)

      expect(newRemote.handleCapability).toHaveBeenCalledWith('test:capability', handler)
    })
  })

  describe('connection state', () => {
    it('delegates getConnectionState to workspaceClient', () => {
      const expectedState: TransportConnectionState = {
        mode: 'remote', status: 'reconnecting', url: 'wss://remote:9001',
        attempt: 2, updatedAt: Date.now(),
      }
      const local = stubClient()
      const workspace = stubClient({ getConnectionState: mock(() => expectedState) })
      const routed = new RoutedClient(local, workspace)

      expect(routed.getConnectionState()).toEqual(expectedState)
    })

    it('notifies connection state listeners on change', () => {
      let capturedCb: ((state: TransportConnectionState) => void) | null = null
      const workspace = stubClient({
        onConnectionStateChanged: mock((cb: (state: TransportConnectionState) => void) => {
          capturedCb = cb
          // Initial callback
          cb({ mode: 'remote', status: 'connected', url: 'wss://remote', attempt: 0, updatedAt: Date.now() })
          return () => {}
        }),
      })
      const local = stubClient()
      const routed = new RoutedClient(local, workspace)

      const listener = mock(() => {})
      routed.onConnectionStateChanged(listener)

      // Should have received initial state
      expect(listener).toHaveBeenCalled()

      // Simulate a state change via the captured workspace client callback
      capturedCb!({ mode: 'remote', status: 'reconnecting', url: 'wss://remote', attempt: 1, updatedAt: Date.now() })

      // 1: initial from onConnectionStateChanged → callback(getConnectionState())
      // 2: the simulated change forwarded through connectionStateListeners
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('delegates reconnectNow to workspaceClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      routed.reconnectNow()
      expect(workspace.reconnectNow).toHaveBeenCalled()
    })
  })

  describe('cleanup', () => {
    it('unsubscribes listeners when cleanup function is called', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      const unsub = routed.on(REMOTE_CHANNEL, cb)

      // Should be tracked
      unsub()

      // After cleanup, switching workspace should not attempt to re-subscribe this listener
      // (no error thrown = success)
    })
  })
})

describe('isLocalOnly consistency', () => {
  it('correctly classifies window channels as LOCAL_ONLY', () => {
    expect(isLocalOnly(LOCAL_CHANNEL)).toBe(true)
  })

  it('correctly classifies session channels as REMOTE_ELIGIBLE', () => {
    expect(isLocalOnly(REMOTE_CHANNEL)).toBe(false)
  })
})
