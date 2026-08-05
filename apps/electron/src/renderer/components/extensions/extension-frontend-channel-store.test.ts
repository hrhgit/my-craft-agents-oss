import { describe, expect, it } from 'bun:test'
import { FrontendChannelStore } from './extension-frontend-channel-store'

const stateEvent = (revision: number, state: unknown) => ({
  type: 'extension_frontend_state' as const,
  extensionId: 'lab',
  runtimeId: 'runtime-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  backendType: 'electron' as const,
  state: { schemaVersion: 2 as const, channelId: 'counter', scope: 'session' as const, revision, state },
})

describe('FrontendChannelStore', () => {
  it('rejects stale revisions and publishes a runtime-agnostic route snapshot', () => {
    const store = new FrontendChannelStore()
    const key = ['lab', 'counter', 'session', '', 'session-1', 'workspace-1'].join('\0')
    const seen: number[] = []
    store.subscribe(key, (snapshot) => seen.push(snapshot.revision))
    store.apply(stateEvent(2, { count: 2 }))
    store.apply(stateEvent(1, { count: 1 }))
    expect(store.get(key)).toEqual({ revision: 2, state: { count: 2 } })
    expect(seen).toEqual([2])
  })

  it('clears exact and route-only snapshots when a runtime resets', () => {
    const store = new FrontendChannelStore()
    const exact = ['lab', 'counter', 'session', 'runtime-1', 'session-1', 'workspace-1'].join('\0')
    const routeOnly = ['lab', 'counter', 'session', '', 'session-1', 'workspace-1'].join('\0')
    store.apply(stateEvent(1, { count: 1 }))
    store.apply({
      type: 'extension_contributions_runtime_reset',
      extensionId: 'lab',
      runtimeId: 'runtime-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      backendType: 'electron',
    })
    expect(store.get(exact)).toBeUndefined()
    expect(store.get(routeOnly)).toBeUndefined()
  })
})
