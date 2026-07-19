import { describe, expect, it } from 'bun:test'
import {
  applyWindowRendererRuntimeQuery,
  buildInitialWindowRendererQuery,
  resolveWindowLayoutRuntime,
} from '../window-renderer-query'

describe('window renderer query', () => {
  it('keeps the complete auxiliary identity available for load recovery', () => {
    const query = buildInitialWindowRendererQuery({
      workspaceId: 'workspace-a',
      focused: true,
      layoutWindowId: 'auxiliary-1',
    })

    expect(query).toEqual({
      workspaceId: 'workspace-a',
      focused: 'true',
      layoutWindowId: 'auxiliary-1',
    })
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual(query)
  })

  it('preserves restored navigation while reapplying child-window runtime state', () => {
    const query = applyWindowRendererRuntimeQuery({
      workspaceId: 'workspace-a',
      route: 'allSessions/session/release-readiness',
      focused: 'true',
      layoutWindowId: 'child-1',
    }, {
      mortiseTestMode: true,
      layoutReadOnly: true,
    })

    expect(query).toEqual({
      workspaceId: 'workspace-a',
      route: 'allSessions/session/release-readiness',
      focused: 'true',
      layoutWindowId: 'child-1',
      mortiseTestMode: '1',
      layoutReadOnly: '1',
    })
  })

  it('passes the initial session through URLSearchParams encoding', () => {
    const query = buildInitialWindowRendererQuery({
      workspaceId: 'workspace-a',
      initialSessionId: 'release-readiness',
    })
    const search = new URLSearchParams(query).toString()

    expect(search).toContain('sessionId=release-readiness')
    expect(new URLSearchParams(search).get('sessionId')).toBe('release-readiness')
  })

  it('gives child sessions an isolated standalone layout instead of the primary model', () => {
    expect(resolveWindowLayoutRuntime({
      role: 'child-session',
      workspaceHasPrimary: true,
      webContentsId: 42,
    })).toEqual({
      mode: 'standalone',
      layoutReadOnly: true,
      layoutWindowId: 'standalone:42',
    })
  })

  it('keeps an additional same-workspace main window from impersonating the primary writer', () => {
    expect(resolveWindowLayoutRuntime({
      role: 'main',
      workspaceHasPrimary: true,
      webContentsId: 43,
    })).toEqual({
      mode: 'standalone',
      layoutReadOnly: true,
      layoutWindowId: 'standalone:43',
    })
    expect(resolveWindowLayoutRuntime({
      role: 'main',
      workspaceHasPrimary: false,
      webContentsId: 44,
    })).toEqual({ mode: 'coordinated', layoutReadOnly: false })
  })
})
