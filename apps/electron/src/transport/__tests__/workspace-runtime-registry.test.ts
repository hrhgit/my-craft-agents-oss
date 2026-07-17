import { describe, expect, it, mock } from 'bun:test'
import { WorkspaceRuntimeRegistry } from '../workspace-runtime-registry'

function client(label: string) {
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
  it('keeps multiple workspace runtimes live and routes by the full trusted key', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const a = client('a')
    const b = client('b')
    registry.register({ route: { serverId: 'local', workspaceId: 'a' }, client: a as any })
    registry.register({ route: { serverId: 'remote.example', workspaceId: 'b' }, client: b as any })

    expect(await registry.invoke({ serverId: 'local', workspaceId: 'a' }, 'sessions:get', 'a')).toBe('a')
    expect(await registry.invoke({ serverId: 'remote.example', workspaceId: 'b' }, 'sessions:get', 'b')).toBe('b')
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
  })

  it('translates local workspace IDs only for the selected runtime', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const remote = client('remote')
    registry.register({
      route: { serverId: 'remote.example', workspaceId: 'local-alias' },
      targetWorkspaceId: 'remote-id',
      client: remote as any,
    })

    await registry.invoke(
      { serverId: 'remote.example', workspaceId: 'local-alias' },
      'automations:test',
      'local-alias',
      { workspaceId: 'local-alias', id: 'task' },
    )
    expect(remote.calls[0].args).toEqual(['remote-id', { workspaceId: 'remote-id', id: 'task' }])
  })

  it('rejects unregistered routes and local-only channels', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const local = client('local')
    registry.register({ route: { serverId: 'local', workspaceId: 'a' }, client: local as any })

    expect(registry.invoke({ serverId: 'local', workspaceId: 'b' }, 'sessions:get')).rejects.toThrow('not registered')
    expect(registry.invoke({ serverId: 'local', workspaceId: 'a' }, 'window:close')).rejects.toThrow('local-only')
  })

  it('uses leases so one tab cannot dispose a runtime still used by another tab', () => {
    const registry = new WorkspaceRuntimeRegistry()
    const shared = client('shared')
    const registration = { route: { serverId: 'local', workspaceId: 'a' }, client: shared as any }
    const releaseA = registry.register(registration)
    const releaseB = registry.register(registration)
    releaseA()
    expect(registry.has(registration.route)).toBe(true)
    releaseB()
    expect(registry.has(registration.route)).toBe(false)
  })

  it('replaces a generation, migrates listeners, and disposes the old client', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const route = { serverId: 'wss://remote.example', workspaceId: 'workspace-a' }
    const oldClient = client('old')
    const newClient = client('new')
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

  it('atomically moves listeners to a new trusted route without exposing the old route', async () => {
    const registry = new WorkspaceRuntimeRegistry()
    const oldRoute = { serverId: 'wss://old.example.test', workspaceId: 'workspace-a' }
    const newRoute = { serverId: 'wss://new.example.test', workspaceId: 'workspace-a' }
    const oldClient = client('old')
    const newClient = client('new')
    const releaseOld = registry.register({
      route: oldRoute,
      client: oldClient as any,
      generation: 'generation-1',
      dispose: oldClient.destroy,
    })
    const callback = mock(() => {})
    const unsubscribe = registry.on(oldRoute, 'sessions:event', callback)

    const releaseNew = registry.move(oldRoute, {
      route: newRoute,
      client: newClient as any,
      generation: 'generation-2',
      dispose: newClient.destroy,
    })

    expect(registry.has(oldRoute)).toBe(false)
    expect(registry.has(newRoute)).toBe(true)
    await expect(registry.invoke(oldRoute, 'sessions:get')).rejects.toThrow('not registered')
    expect(await registry.invoke(newRoute, 'sessions:get')).toBe('new')
    oldClient.emit('sessions:event', 'old')
    newClient.emit('sessions:event', 'new')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith('new')
    expect(oldClient.destroy).toHaveBeenCalledTimes(1)

    releaseOld()
    expect(registry.has(newRoute)).toBe(true)
    unsubscribe()
    releaseNew()
    expect(registry.has(newRoute)).toBe(false)
  })

  it('treats a stale move as idempotent when the next generation already won the race', () => {
    const registry = new WorkspaceRuntimeRegistry()
    const staleRoute = { serverId: 'wss://old.example.test', workspaceId: 'workspace-a' }
    const nextRoute = { serverId: 'wss://new.example.test', workspaceId: 'workspace-a' }
    const winner = client('winner')
    const redundant = client('redundant')
    const releaseWinner = registry.register({
      route: nextRoute,
      client: winner as any,
      generation: 'generation-2',
      dispose: winner.destroy,
    })

    const releaseRedundant = registry.move(staleRoute, {
      route: nextRoute,
      client: redundant as any,
      generation: 'generation-2',
      dispose: redundant.destroy,
    })

    expect(redundant.destroy).toHaveBeenCalledTimes(1)
    releaseWinner()
    expect(registry.has(nextRoute)).toBe(true)
    releaseRedundant()
    expect(registry.has(nextRoute)).toBe(false)
    expect(winner.destroy).toHaveBeenCalledTimes(1)
  })
})
