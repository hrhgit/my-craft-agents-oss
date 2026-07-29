import { describe, expect, it, mock } from 'bun:test'
import { WorkspaceRuntimeRegistry } from '../workspace-runtime-registry'

function client(label: unknown) {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const destroy = mock(() => {})
  return {
    calls,
    destroy,
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args })
      return label
    },
    on: (channel: string, callback: (...args: any[]) => void) => {
      const callbacks = listeners.get(channel) ?? new Set()
      callbacks.add(callback)
      listeners.set(channel, callbacks)
      return () => { callbacks.delete(callback) }
    },
    emit: (channel: string, ...args: any[]) => {
      for (const callback of listeners.get(channel) ?? []) callback(...args)
    },
    handleCapability: () => {},
    isChannelAvailable: () => true,
    getConnectionState: () => ({ status: 'connected' }),
    getServerVersion: () => 'test',
  }
}

describe('WorkspaceRuntimeRegistry', () => {
  it('keeps multiple location runtimes in one Workspace live concurrently', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const a = client('a')
    const b = client('b')
    registry.register({ route: { workspaceId: 'workspace', locationId: 'local' }, client: a as any })
    registry.register({ route: { workspaceId: 'workspace', locationId: 'remote' }, client: b as any })

    expect(await registry.invoke({ workspaceId: 'workspace', locationId: 'local' }, 'sessions:get', 'workspace')).toBe('a')
    expect(await registry.invoke({ workspaceId: 'workspace', locationId: 'remote' }, 'sessions:get', 'workspace')).toBe('b')
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
  })

  it('translates local workspace IDs only for the selected runtime', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const remote = client('remote')
    registry.register({
      route: { workspaceId: 'local-alias', locationId: 'primary' },
      targetWorkspaceId: 'remote-id',
      client: remote as any,
    })

    await registry.invoke(
      { workspaceId: 'local-alias', locationId: 'primary' },
      'automations:test',
      'local-alias',
      { workspaceId: 'local-alias', id: 'task' },
    )
    expect(remote.calls[0].args).toEqual(['remote-id', { workspaceId: 'remote-id', id: 'task' }])
  })

  it('recursively restores logical Workspace identity in results and events', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const remote = client({
      workspaceId: 'remote-id',
      remoteWorkspaceId: 'remote-id',
      nested: [{ workspaceId: 'remote-id' }, { workspaceId: 'other-id' }],
      opaque: 'remote-id',
    })
    const route = { workspaceId: 'local-alias', locationId: 'primary' }
    registry.register({ route, targetWorkspaceId: 'remote-id', client: remote as any })

    expect(await registry.invoke(route, 'sessions:get')).toEqual({
      workspaceId: 'local-alias',
      remoteWorkspaceId: 'remote-id',
      nested: [{ workspaceId: 'local-alias' }, { workspaceId: 'other-id' }],
      opaque: 'remote-id',
    })

    const callback = mock(() => {})
    registry.on(route, 'sessions:event', callback)
    remote.emit('sessions:event', {
      workspaceId: 'remote-id',
      detail: { workspaceId: 'remote-id', remoteWorkspaceId: 'remote-id' },
    })
    expect(callback).toHaveBeenCalledWith({
      workspaceId: 'local-alias',
      detail: { workspaceId: 'local-alias', remoteWorkspaceId: 'remote-id' },
    })
  })

  it('rejects unregistered routes and local-only channels', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const local = client('local')
    registry.register({ route: { workspaceId: 'a', locationId: 'primary' }, client: local as any })

    expect(registry.invoke({ workspaceId: 'b', locationId: 'primary' }, 'sessions:get')).rejects.toThrow('not registered')
    expect(registry.invoke({ workspaceId: 'a', locationId: 'primary' }, 'window:close')).rejects.toThrow('local-only')
  })

  it('returns typed availability, connection, version, channel, and permission failures without fallback', async () => {
    const route = { workspaceId: 'workspace', locationId: 'remote' }
    const fallbackRoute = { workspaceId: 'workspace', locationId: 'local' }

    const assertFailure = async (
      configure: (remote: ReturnType<typeof client>) => void,
      registration: Record<string, unknown>,
      channel: string,
      code: string,
    ) => {
      const registry = new WorkspaceRuntimeRegistry()
      const fallback = client('fallback')
      const remote = client('remote')
      configure(remote)
      registry.register({ route: fallbackRoute, client: fallback as any })
      registry.register({ route, client: remote as any, targetWorkspaceId: 'remote-workspace', ...registration })

      expect(registry.invoke(route, channel, 'workspace')).rejects.toMatchObject({ code })
      expect(fallback.calls).toHaveLength(0)
      expect(remote.calls).toHaveLength(0)
    }

    await assertFailure(
      () => {},
      { availability: { status: 'unavailable', reason: 'offline' } },
      'files:read',
      'TARGET_UNAVAILABLE',
    )
    await assertFailure(
      remote => { remote.getConnectionState = () => ({ status: 'disconnected' }) },
      {},
      'files:read',
      'TARGET_UNAVAILABLE',
    )
    await assertFailure(
      remote => { remote.getServerVersion = () => null as any },
      {},
      'files:read',
      'LOCATION_VERSION_UNSUPPORTED',
    )
    await assertFailure(
      remote => { remote.isChannelAvailable = () => false },
      {},
      'files:read',
      'UNSUPPORTED',
    )
    await assertFailure(
      () => {},
      { permissions: { read: false, write: true, search: true, runCommands: true } },
      'files:read',
      'LOCATION_PERMISSION_DENIED',
    )
    await assertFailure(
      () => {},
      { permissions: { read: true, write: true, search: true, runCommands: false } },
      'sessions:create',
      'LOCATION_PERMISSION_DENIED',
    )
  })

  it('uses leases so one tab cannot dispose a runtime still used by another tab', () => {
    const registry = new WorkspaceRuntimeRegistry()
    const shared = client('shared')
    const registration = { route: { workspaceId: 'a', locationId: 'primary' }, client: shared as any }
    const releaseA = registry.register(registration)
    const releaseB = registry.register(registration)
    releaseA()
    expect(registry.has(registration.route)).toBe(true)
    releaseB()
    expect(registry.has(registration.route)).toBe(false)
  })

  it('replaces a generation, migrates listeners, and disposes the old client', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const route = { workspaceId: 'workspace-a', locationId: 'remote' }
    const unrelatedRoute = { workspaceId: 'workspace-a', locationId: 'local' }
    const oldClient = client('old')
    const newClient = client('new')
    const unrelatedClient = client('unrelated')
    registry.register({ route: unrelatedRoute, client: unrelatedClient as any })
    const releaseOld = registry.register({
      route,
      client: oldClient as any,
      generation: 'generation-1',
      dispose: oldClient.destroy,
    })
    const callback = mock(() => {})
    const unsubscribe = registry.on(route, 'sessions:event', callback)

    const releaseNew = registry.replace({
      route,
      client: newClient as any,
      generation: 'generation-2',
      dispose: newClient.destroy,
    })

    oldClient.emit('sessions:event', 'old')
    newClient.emit('sessions:event', 'new')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('new')
    expect(await registry.invoke(route, 'sessions:get')).toBe('new')
    expect(await registry.invoke(unrelatedRoute, 'sessions:get')).toBe('unrelated')
    expect(oldClient.destroy).toHaveBeenCalledTimes(1)

    releaseOld()
    expect(registry.has(route)).toBe(true)
    unsubscribe()
    newClient.emit('sessions:event', 'after-unsubscribe')
    expect(callback).toHaveBeenCalledTimes(1)
    releaseNew()
    expect(registry.has(route)).toBe(false)
    expect(newClient.destroy).toHaveBeenCalledTimes(1)
  })

  it('uses the replacement runtime identity when rebinding listeners', () => {
    const registry = new WorkspaceRuntimeRegistry()
    const route = { workspaceId: 'logical-id', locationId: 'remote' }
    const oldClient = client('old')
    const newClient = client('new')
    registry.register({ route, targetWorkspaceId: 'remote-old', client: oldClient as any, generation: 'old' })
    const callback = mock(() => {})
    registry.on(route, 'sessions:event', callback)

    registry.replace({ route, targetWorkspaceId: 'remote-new', client: newClient as any, generation: 'new' })
    newClient.emit('sessions:event', { workspaceId: 'remote-new', remoteWorkspaceId: 'remote-new' })

    expect(callback).toHaveBeenCalledWith({
      workspaceId: 'logical-id',
      remoteWorkspaceId: 'remote-new',
    })
  })

})
