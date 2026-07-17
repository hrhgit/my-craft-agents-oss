import { describe, expect, it } from 'bun:test'
import { resolveInitialWindowTarget } from '../initial-window-target'

describe('initial window target', () => {
  const workspaces = [{ id: 'workspace-a' }, { id: 'workspace-b' }]
  const sessions = [
    { id: 'verify-search-child', workspaceId: 'workspace-b' },
    { id: 'release-readiness', workspaceId: 'workspace-b' },
    { id: 'fallback-session', workspaceId: 'workspace-a' },
  ]

  it('honors the configured workspace and session instead of list order', () => {
    expect(resolveInitialWindowTarget({
      workspaces,
      sessions,
      activeWorkspaceId: 'workspace-b',
      activeSessionId: 'release-readiness',
    })).toEqual({
      workspaceId: 'workspace-b',
      initialSessionId: 'release-readiness',
    })
  })

  it('does not route a session into a workspace that does not own it', () => {
    expect(resolveInitialWindowTarget({
      workspaces,
      sessions,
      activeWorkspaceId: 'workspace-a',
      activeSessionId: 'release-readiness',
    })).toEqual({ workspaceId: 'workspace-a' })
  })

  it('falls back to the first workspace when the configured workspace is stale', () => {
    expect(resolveInitialWindowTarget({
      workspaces,
      sessions,
      activeWorkspaceId: 'deleted-workspace',
      activeSessionId: 'fallback-session',
    })).toEqual({
      workspaceId: 'workspace-a',
      initialSessionId: 'fallback-session',
    })
  })

  it('returns no target when there are no workspaces', () => {
    expect(resolveInitialWindowTarget({
      workspaces: [],
      sessions,
      activeWorkspaceId: 'workspace-a',
      activeSessionId: 'fallback-session',
    })).toBeNull()
  })
})
