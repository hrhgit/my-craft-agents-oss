import { describe, expect, it } from 'bun:test'
import { buildSemanticHistoryKey, canRunInitialRestore, resolveWorkspaceSwitchSearch, shouldNavigateToInitialDefault } from '../navigation-history'

describe('buildSemanticHistoryKey', () => {
  it('changes when focused panel index changes even if routes are identical', () => {
    const panelRoutes = ['allSessions/session/s1', 'allSessions/session/s1']

    const keyA = buildSemanticHistoryKey({
      workspaceSlug: 'ws',
      panelRoutes,
      focusedPanelIndex: 0,
    })

    const keyB = buildSemanticHistoryKey({
      workspaceSlug: 'ws',
      panelRoutes,
      focusedPanelIndex: 1,
    })

    expect(keyA).not.toBe(keyB)
  })

  it('stays stable for identical semantic inputs', () => {
    const input = {
      workspaceSlug: 'ws',
      panelRoutes: ['allSessions/session/s1', 'sources/source/github'],
      focusedPanelIndex: 1,
    }

    const keyA = buildSemanticHistoryKey(input)
    const keyB = buildSemanticHistoryKey(input)

    expect(keyA).toBe(keyB)
  })
})

describe('canRunInitialRestore', () => {
  it('returns false until session metadata is ready', () => {
    expect(canRunInitialRestore({
      isReady: true,
      isSessionsReady: false,
      workspaceId: 'ws-1',
      initialRouteRestored: false,
    })).toBe(false)
  })

  it('returns true only when all restore conditions are satisfied', () => {
    expect(canRunInitialRestore({
      isReady: true,
      isSessionsReady: true,
      workspaceId: 'ws-1',
      initialRouteRestored: false,
    })).toBe(true)

    expect(canRunInitialRestore({
      isReady: true,
      isSessionsReady: true,
      workspaceId: 'ws-1',
      initialRouteRestored: true,
    })).toBe(false)
  })
})

describe('shouldNavigateToInitialDefault', () => {
  it('does not replace coordinator-owned auxiliary content with a default conversation', () => {
    expect(shouldNavigateToInitialDefault(new URLSearchParams({
      layoutWindowId: 'aux:detached-browser',
      focused: 'true',
    }))).toBe(false)
  })

  it('keeps the normal empty-window fallback and honors explicit navigation', () => {
    expect(shouldNavigateToInitialDefault(new URLSearchParams())).toBe(true)
    expect(shouldNavigateToInitialDefault(new URLSearchParams({
      layoutWindowId: 'standalone:5',
      layoutReadOnly: '1',
    }))).toBe(true)
    expect(shouldNavigateToInitialDefault(new URLSearchParams({ route: 'sources' }))).toBe(false)
  })
})

describe('resolveWorkspaceSwitchSearch', () => {
  it('opens all sessions for an explicit workspace-list switch', () => {
    expect(resolveWorkspaceSwitchSearch({
      destination: 'allSessions',
      savedSearch: '?ws=target&route=sources',
      workspaceSlug: 'target',
    })).toBe('?ws=target&route=allSessions')
  })

  it('opens a requested session for a one-click cross-workspace switch', () => {
    expect(resolveWorkspaceSwitchSearch({
      destination: { sessionId: 'session-2' },
      savedSearch: '?ws=target&route=settings',
      workspaceSlug: 'target',
    })).toBe('?ws=target&route=allSessions%2Fsession%2Fsession-2')
  })

  it('preserves saved navigation for history-driven workspace restoration', () => {
    expect(resolveWorkspaceSwitchSearch({
      destination: 'restore',
      savedSearch: '?ws=target&route=sources%2Fsource%2Fgithub',
      workspaceSlug: 'target',
    })).toBe('?ws=target&route=sources%2Fsource%2Fgithub')
  })

  it('defaults to all sessions when no saved navigation exists', () => {
    expect(resolveWorkspaceSwitchSearch({
      destination: null,
      savedSearch: '',
      workspaceSlug: 'fresh',
    })).toBe('?ws=fresh&route=allSessions')
  })
})
