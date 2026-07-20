import { describe, expect, it } from 'bun:test'
import { deriveRendererValidationStates, extensionValidationScopedState } from '../state-bridge'

describe('deriveRendererValidationStates', () => {
  it('reports real route and processing session state', () => {
    const states = deriveRendererValidationStates({
      appState: 'ready', sessionsLoaded: true, sessionLoadError: null, splashHidden: true,
      workspaceId: 'w1', workspaceTransitioning: false,
      transport: { mode: 'local', status: 'connected', url: 'ws://localhost', attempt: 0, updatedAt: 1 },
    }, {
      route: 'allSessions/session/s1', focusedSessionId: 's1',
      sessions: [{ id: 's1', workspaceId: 'w1', isProcessing: true, hasUnread: false }],
    })
    expect(states.find(state => state.scope === 'app')?.phase).toBe('ready')
    expect(states.find(state => state.scope === 'sessions')?.phase).toBe('busy')
    expect(states.find(state => state.scope === 'session')?.phase).toBe('busy')
    expect(states.find(state => state.scope === 'route')?.detail).toMatchObject({ surface: 'chat', sessionId: 's1' })
  })

  it('surfaces transport and session load errors', () => {
    const states = deriveRendererValidationStates({
      appState: 'ready', sessionsLoaded: false, sessionLoadError: 'load failed', splashHidden: false,
      workspaceId: 'w1', workspaceTransitioning: false,
      transport: { mode: 'remote', status: 'failed', url: 'wss://example.test', attempt: 2, updatedAt: 1, lastError: { kind: 'network', message: 'offline' } },
    }, { route: null, focusedSessionId: null, sessions: [] })
    expect(states.find(state => state.scope === 'app')).toMatchObject({ phase: 'error', error: { code: 'SESSION_LOAD_FAILED' } })
    expect(states.find(state => state.scope === 'transport')).toMatchObject({ phase: 'error', error: { message: 'offline' } })
  })

  it('keeps app and route loading until the splash no longer blocks physical input', () => {
    const states = deriveRendererValidationStates({
      appState: 'ready', sessionsLoaded: true, sessionLoadError: null, splashHidden: false,
      workspaceId: 'w1', workspaceTransitioning: false,
      transport: { mode: 'local', status: 'connected', url: 'ws://localhost', attempt: 0, updatedAt: 1 },
    }, { route: 'allSessions', focusedSessionId: null, sessions: [] })
    expect(states.find(state => state.scope === 'app')).toMatchObject({ phase: 'loading', detail: { splashHidden: false } })
    expect(states.find(state => state.scope === 'route')?.phase).toBe('loading')
  })

  it('does not expose removed Sources routes as a supported surface', () => {
    const states = deriveRendererValidationStates({
      appState: 'ready', sessionsLoaded: true, sessionLoadError: null, splashHidden: true,
      workspaceId: 'w1', workspaceTransitioning: false,
      transport: { mode: 'local', status: 'connected', url: 'ws://localhost', attempt: 0, updatedAt: 1 },
    }, { route: 'sources/source/legacy', focusedSessionId: null, sessions: [] })

    expect(states.find(state => state.scope === 'route')?.detail).toMatchObject({ surface: 'unknown' })
  })

  it('publishes extension readiness as a stable scoped state', () => {
    const state = extensionValidationScopedState({
      extensionId: 'build', commandOwnerExtensionId: 'build', sessionId: 's1', runtimeId: 'r1', revision: 1,
      definition: {
        schemaVersion: 1, id: 'panel', contributionId: 'build-panel', verificationLevel: 'semantic',
        readyWhen: ['loaded'], signals: [{ id: 'loaded', label: 'Loaded', status: 'busy' }],
      },
    })
    expect(state).toMatchObject({ scope: 'extension', phase: 'busy', detail: { extensionId: 'build', definitionId: 'panel', waitingFor: ['loaded'] } })
    expect(state.entityId).toMatch(/^extension:[a-f0-9]{16}$/)
  })

  it('publishes the workspace picker as a settled typed route without a workspace identity', () => {
    const states = deriveRendererValidationStates({
      appState: 'workspace-picker',
      workspaceId: null,
      workspaceTransitioning: false,
      sessionsLoaded: false,
      splashHidden: false,
      sessionLoadError: null,
      transport: { mode: 'local', status: 'idle', attempt: 0, url: '', updatedAt: 1 },
    }, { route: null, focusedSessionId: null, sessions: [] })

    expect(states.find(state => state.scope === 'workspace')).toMatchObject({ phase: 'ready', detail: { selected: false } })
    expect(states.find(state => state.scope === 'route')).toMatchObject({
      phase: 'ready',
      detail: { route: 'workspace-picker', surface: 'workspace-picker' },
    })
  })
})
