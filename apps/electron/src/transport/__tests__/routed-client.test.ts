import { describe, expect, it, mock } from 'bun:test'
import type { TransportConnectionState, WsRpcClient } from '@mortise/server-core/transport'
import { isLocalOnly, RPC_CHANNELS } from '@mortise/shared/protocol'
import { RoutedClient } from '../routed-client'

function stubClient(overrides?: Partial<WsRpcClient>): WsRpcClient {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const invoke = overrides?.invoke ?? mock(async () => undefined)
  const invokeWithOptions = overrides?.invokeWithOptions
    ?? mock(async (channel: string, args: any[]) => invoke(channel, ...args))
  const passthrough = { ...(overrides as Record<string, unknown> | undefined) }
  delete passthrough.invoke
  delete passthrough.invokeWithOptions
  return {
    connect: mock(() => {}),
    destroy: mock(() => {}),
    invoke,
    invokeWithOptions,
    on: mock((channel: string, callback: (...args: any[]) => void) => {
      const callbacks = listeners.get(channel) ?? new Set()
      callbacks.add(callback)
      listeners.set(channel, callbacks)
      return () => { callbacks.delete(callback) }
    }),
    handleCapability: mock(() => {}),
    isChannelAvailable: mock(() => true),
    getConnectionState: mock((): TransportConnectionState => ({
      mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now(),
    })),
    onConnectionStateChanged: mock((callback: (state: TransportConnectionState) => void) => {
      callback({ mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now() })
      return () => {}
    }),
    reconnectNow: mock(() => {}),
    emitReconnected: mock(() => {}),
    ...passthrough,
  } as any
}

const LOCAL_CHANNEL = RPC_CHANNELS.window.GET_WORKSPACE
const REMOTE_CHANNEL = RPC_CHANNELS.sessions.GET
const SWITCH_CHANNEL = RPC_CHANNELS.window.SWITCH_WORKSPACE

describe('RoutedClient', () => {
  it('routes local-only and Workspace channels to their current authorities', async () => {
    const local = stubClient({ invoke: mock(async () => 'local') })
    const workspace = stubClient({ invoke: mock(async () => 'workspace') })
    const routed = new RoutedClient(local, workspace)

    expect(await routed.invoke(LOCAL_CHANNEL)).toBe('local')
    expect(await routed.invoke(REMOTE_CHANNEL)).toBe('workspace')
    expect(local.invoke).toHaveBeenCalledWith(LOCAL_CHANNEL)
    expect(workspace.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
  })

  it('passes timeout options to the selected Workspace runtime', async () => {
    const workspace = stubClient({ invokeWithOptions: mock(async () => 'ok') })
    const routed = new RoutedClient(stubClient(), workspace)

    expect(await routed.invokeWithOptions(REMOTE_CHANNEL, ['session'], { timeoutMs: 4321 })).toBe('ok')
    expect(workspace.invokeWithOptions).toHaveBeenCalledWith(REMOTE_CHANNEL, ['session'], { timeoutMs: 4321 })
  })

  it('holds Workspace calls at the topology readiness boundary', async () => {
    const workspace = stubClient({ invoke: mock(async () => 'ready') })
    const routed = new RoutedClient(stubClient(), workspace)
    let release: (() => void) | undefined
    routed.setWorkspaceReady(new Promise<void>(resolve => { release = resolve }))

    const pending = routed.invoke(REMOTE_CHANNEL)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(workspace.invoke).not.toHaveBeenCalled()
    release!()
    expect(await pending).toBe('ready')
  })

  it('switches the active location without changing Workspace identity or disposing either runtime', async () => {
    const local = stubClient({ invoke: mock(async () => ({ workspaceId: 'workspace-a' })) })
    const initial = stubClient()
    const primary = stubClient({ invoke: mock(async () => 'primary') })
    const attached = stubClient({ invoke: mock(async () => 'attached') })
    const routed = new RoutedClient(local, initial)
    const primaryRoute = { workspaceId: 'workspace-a', locationId: 'primary' }
    const attachedRoute = { workspaceId: 'workspace-a', locationId: 'attached' }
    routed.registerWorkspaceRuntime({ route: primaryRoute, client: primary, generation: 'primary-1' })
    routed.registerWorkspaceRuntime({ route: attachedRoute, client: attached, generation: 'attached-1' })
    routed.setWorkspaceSwitchHandler(() => routed.activateWorkspaceRuntime(primaryRoute))

    await routed.invoke(SWITCH_CHANNEL, 'workspace-a')
    expect(await routed.invoke(REMOTE_CHANNEL)).toBe('primary')

    routed.activateWorkspaceRuntime(attachedRoute)
    expect(await routed.invoke(REMOTE_CHANNEL)).toBe('attached')
    expect(primary.destroy).not.toHaveBeenCalled()
    expect(attached.destroy).not.toHaveBeenCalled()
  })

  it('translates Workspace identity only for the active remote location', async () => {
    const local = stubClient()
    const initial = stubClient()
    const remote = stubClient({ invoke: mock(async () => 'remote') })
    const routed = new RoutedClient(local, initial)
    const route = { workspaceId: 'workspace-a', locationId: 'remote' }
    routed.registerWorkspaceRuntime({
      route,
      client: remote,
      targetWorkspaceId: 'remote-workspace-a',
      generation: 'remote-1',
    })

    routed.activateWorkspaceRuntime(route)
    await routed.invoke(REMOTE_CHANNEL, 'workspace-a', { workspaceId: 'workspace-a' })
    expect(remote.invoke).toHaveBeenCalledWith(
      REMOTE_CHANNEL,
      'remote-workspace-a',
      { workspaceId: 'remote-workspace-a' },
    )
  })

  it('migrates global listeners and capabilities when the primary location changes', () => {
    const initial = stubClient()
    const next = stubClient()
    const routed = new RoutedClient(stubClient(), initial)
    const route = { workspaceId: 'workspace-a', locationId: 'next' }
    routed.registerWorkspaceRuntime({ route, client: next, generation: 'next-1' })
    const callback = mock(() => {})
    const capability = mock(() => undefined)
    routed.on(REMOTE_CHANNEL, callback)
    routed.handleCapability('test:capability', capability)

    routed.activateWorkspaceRuntime(route)

    expect(next.on).toHaveBeenCalledWith(REMOTE_CHANNEL, callback)
    expect(next.handleCapability).toHaveBeenCalledWith('test:capability', capability)
  })

  it('keeps location-scoped listeners independent from active-runtime changes', () => {
    const routed = new RoutedClient(stubClient(), stubClient())
    const first = stubClient()
    const second = stubClient()
    const firstRoute = { workspaceId: 'workspace-a', locationId: 'one' }
    const secondRoute = { workspaceId: 'workspace-a', locationId: 'two' }
    routed.registerWorkspaceRuntime({ route: firstRoute, client: first, generation: 'one-1' })
    routed.registerWorkspaceRuntime({ route: secondRoute, client: second, generation: 'two-1' })
    const callback = mock(() => {})

    routed.onForWorkspace(firstRoute, REMOTE_CHANNEL, callback)
    routed.activateWorkspaceRuntime(secondRoute)

    expect(first.on).toHaveBeenCalledTimes(1)
    expect((first.on as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe(REMOTE_CHANNEL)
    expect(second.on).not.toHaveBeenCalled()
  })

  it('delegates connection state and reconnect to the active runtime', () => {
    const expected: TransportConnectionState = {
      mode: 'remote', status: 'reconnecting', url: 'wss://remote', attempt: 2, updatedAt: Date.now(),
    }
    const workspace = stubClient({ getConnectionState: mock(() => expected) })
    const routed = new RoutedClient(stubClient(), workspace)

    expect(routed.getConnectionState()).toEqual(expected)
    routed.reconnectNow()
    expect(workspace.reconnectNow).toHaveBeenCalled()
  })
})

describe('isLocalOnly consistency', () => {
  it('classifies the routing boundary', () => {
    expect(isLocalOnly(LOCAL_CHANNEL)).toBe(true)
    expect(isLocalOnly(REMOTE_CHANNEL)).toBe(false)
  })
})
