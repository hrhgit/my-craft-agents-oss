import { describe, expect, it } from 'bun:test'
import type { ExtensionBridgeEvent } from '@mortise/shared/agent/backend/types'
import { ExtensionFrontendStateCache } from './extension-frontend-state-cache'

function stateEvent(options: {
  revision: number
  state: unknown
  runtimeId?: string
  sessionId?: string
  sessionBootstrap?: boolean
}): Extract<ExtensionBridgeEvent, { type: 'extension_frontend_state' }> {
  return {
    type: 'extension_frontend_state',
    extensionId: 'ask-user',
    runtimeId: options.runtimeId ?? 'runtime-1',
    sessionId: options.sessionId ?? 'session-1',
    workspaceId: 'workspace-1',
    backendType: 'electron',
    state: {
      schemaVersion: 2,
      channelId: 'ask-user.request',
      scope: 'session',
      revision: options.revision,
      state: options.state,
      ...(options.sessionBootstrap ? { sessionBootstrap: true } : {}),
    },
  }
}

describe('ExtensionFrontendStateCache', () => {
  it('restores a state that was published before any renderer subscribed', () => {
    const cache = new ExtensionFrontendStateCache()
    const event = stateEvent({ revision: 2, state: { request: { requestId: 'ask-1' } } })

    cache.apply(event)

    expect(cache.get('session-1')).toEqual([event])
  })

  it('rejects stale revisions from the same runtime', () => {
    const cache = new ExtensionFrontendStateCache()
    cache.apply(stateEvent({ revision: 2, state: { request: { requestId: 'new' } } }))
    cache.apply(stateEvent({ revision: 1, state: { request: { requestId: 'old' } } }))

    expect(cache.get('session-1')[0]?.state).toMatchObject({
      revision: 2,
      state: { request: { requestId: 'new' } },
    })
  })

  it('accepts a lower revision from a replacement runtime', () => {
    const cache = new ExtensionFrontendStateCache()
    cache.apply(stateEvent({ revision: 8, state: { request: null }, runtimeId: 'runtime-1' }))
    cache.apply(stateEvent({ revision: 1, state: { request: { requestId: 'ask-2' } }, runtimeId: 'runtime-2' }))

    expect(cache.get('session-1')[0]).toMatchObject({
      runtimeId: 'runtime-2',
      state: { revision: 1, state: { request: { requestId: 'ask-2' } } },
    })
  })

  it('clears only the reset runtime and session', () => {
    const cache = new ExtensionFrontendStateCache()
    cache.apply(stateEvent({ revision: 1, state: { request: {} } }))
    cache.apply(stateEvent({ revision: 1, state: { request: {} }, sessionId: 'session-2' }))
    cache.apply({
      type: 'extension_contributions_runtime_reset',
      extensionId: 'ask-user',
      runtimeId: 'runtime-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      backendType: 'electron',
    })

    expect(cache.get('session-1')).toEqual([])
    expect(cache.get('session-2')).toHaveLength(1)
  })

  it('restores bootstrap snapshots by Workspace even when the warm runtime has no public Session', () => {
    const cache = new ExtensionFrontendStateCache()
    const event = stateEvent({
      revision: 1,
      state: { mode: 'ask' },
      sessionId: 'warm-runtime-session',
      sessionBootstrap: true,
    })
    cache.apply(event)

    expect(cache.getWorkspace('workspace-1')).toEqual([event])
  })
})
