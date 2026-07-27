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
  }
}

describe('WorkspaceRuntimeRegistry', () => {
  it('keeps multiple location runtimes in one Workspace live concurrently', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const a = client('a')
    const b = client('b')
    registry.register({ route: { serverId: 'local', workspaceId: 'workspace', locationId: 'local' }, client: a as any })
    registry.register({ route: { serverId: 'remote.example', workspaceId: 'workspace', locationId: 'remote' }, client: b as any })

    expect(await registry.invoke({ serverId: 'ignored', workspaceId: 'workspace', locationId: 'local' }, 'sessions:get', 'workspace')).toBe('a')
    expect(await registry.invoke({ serverId: 'also-ignored', workspaceId: 'workspace', locationId: 'remote' }, 'sessions:get', 'workspace')).toBe('b')
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
  })

  it('translates local workspace IDs only for the selected runtime', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const remote = client('remote')
    registry.register({
      route: { serverId: 'remote.example', workspaceId: 'local-alias', locationId: 'primary' },
      targetWorkspaceId: 'remote-id',
      client: remote as any,
    })

    await registry.invoke(
      { serverId: 'remote.example', workspaceId: 'local-alias', locationId: 'primary' },
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
    const route = { serverId: 'remote.example', workspaceId: 'local-alias', locationId: 'primary' }
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
    registry.register({ route: { serverId: 'local', workspaceId: 'a', locationId: 'primary' }, client: local as any })

    expect(registry.invoke({ serverId: 'local', workspaceId: 'b', locationId: 'primary' }, 'sessions:get')).rejects.toThrow('not registered')
    expect(registry.invoke({ serverId: 'local', workspaceId: 'a', locationId: 'primary' }, 'window:close')).rejects.toThrow('local-only')
  })

  it('uses leases so one tab cannot dispose a runtime still used by another tab', () => {
    const registry = new WorkspaceRuntimeRegistry()
    const shared = client('shared')
    const registration = { route: { serverId: 'local', workspaceId: 'a', locationId: 'primary' }, client: shared as any }
    const releaseA = registry.register(registration)
    const releaseB = registry.register(registration)
    releaseA()
    expect(registry.has(registration.route)).toBe(true)
    releaseB()
    expect(registry.has(registration.route)).toBe(false)
  })

  it('replaces a generation, migrates listeners, and disposes the old client', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const route = { serverId: 'wss://remote.example', workspaceId: 'workspace-a', locationId: 'remote' }
    const unrelatedRoute = { serverId: 'local', workspaceId: 'workspace-a', locationId: 'local' }
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
    const route = { serverId: 'remote.example', workspaceId: 'logical-id', locationId: 'remote' }
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
