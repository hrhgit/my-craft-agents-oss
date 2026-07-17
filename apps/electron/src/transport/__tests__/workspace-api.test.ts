import { describe, expect, it, mock } from 'bun:test'
import { buildWorkspaceClientApi, evictWorkspaceApiCache, resolveWorkspaceApiMethod } from '../workspace-api'

const route = { serverId: 'remote.example', workspaceId: 'workspace-a' }

describe('workspace client API', () => {
  it('routes invoke methods through the trusted workspace route', async () => {
    const invoke = mock(async () => 'ok')
    const api = buildWorkspaceClientApi({
      invoke,
      on: () => () => {},
    }, route, {
      getSessions: { type: 'invoke', channel: 'sessions:get' },
    })

    expect(await api.getSessions() as any).toBe('ok')
    expect(invoke).toHaveBeenCalledWith(route, 'sessions:get')
  })

  it('keeps listener cleanup scoped to the selected runtime', () => {
    const cleanup = mock(() => {})
    const on = mock(() => cleanup)
    const api = buildWorkspaceClientApi({
      invoke: async () => undefined,
      on,
    }, route, {
      onSessionEvent: { type: 'listener', channel: 'sessions:event' },
    })
    const callback = mock(() => {})

    const unsubscribe = api.onSessionEvent(callback)
    expect(on).toHaveBeenCalledWith(route, 'sessions:event', callback)
    unsubscribe()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('resolves top-level and namespaced methods without exposing unknown keys', () => {
    const api = buildWorkspaceClientApi({
      invoke: async () => undefined,
      on: () => () => {},
    }, route, {
      getSessions: { type: 'invoke', channel: 'sessions:get' },
      'browserPane.create': { type: 'invoke', channel: 'browser-pane:create' },
    })

    expect(resolveWorkspaceApiMethod(api, 'getSessions')).toBeFunction()
    expect(resolveWorkspaceApiMethod(api, 'browserPane.create')).toBeFunction()
    expect(resolveWorkspaceApiMethod(api, 'missing')).toBeNull()
  })

  it('rejects local-only channels before they reach any scoped runtime', async () => {
    const invoke = mock(async () => undefined)
    const api = buildWorkspaceClientApi({
      invoke,
      on: () => () => {},
    }, route, {
      closeWindow: { type: 'invoke', channel: 'window:close' },
    })

    expect(api.closeWindow()).rejects.toThrow('local-only')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('evicts only historical server routes for the refreshed workspace', () => {
    const cache = new Map([
      ['wss%3A%2F%2Fold.example::workspace-a', 'old-a'],
      ['wss%3A%2F%2Fnew.example::workspace-a', 'new-a'],
      ['wss%3A%2F%2Fold.example::workspace-b', 'old-b'],
    ])

    evictWorkspaceApiCache(cache, 'workspace-a', 'wss://new.example')

    expect([...cache.entries()]).toEqual([
      ['wss%3A%2F%2Fnew.example::workspace-a', 'new-a'],
      ['wss%3A%2F%2Fold.example::workspace-b', 'old-b'],
    ])
  })
})
