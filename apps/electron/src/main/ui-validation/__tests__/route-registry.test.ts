import { describe, expect, it, mock } from 'bun:test'

mock.module('electron', () => ({ clipboard: { writeText() {} } }))
const { resolveUiValidationRoute } = await import('../route-registry')

describe('UI validation route registry', () => {
  it('builds existing typed routes with route-specific ready state', () => {
    expect(resolveUiValidationRoute({ route: { surface: 'chat', sessionId: 's1' } }, '7')).toEqual({
      route: { surface: 'chat', sessionId: 's1' },
      deepLinkRoute: 'allSessions/session/s1',
      dependencies: [
        { scope: 'app', phase: 'ready', windowId: '7' },
        { scope: 'transport', phase: 'ready', windowId: '7' },
        { scope: 'workspace', phase: 'ready', windowId: '7' },
        { scope: 'sessions', phase: 'ready', windowId: '7' },
        { scope: 'session', phase: 'ready', entityId: 's1', windowId: '7' },
      ],
      ready: { scope: 'route', phase: 'ready', windowId: '7', detail: { surface: 'chat', sessionId: 's1' } },
    })
    expect(resolveUiValidationRoute({ surface: 'settings', section: 'extensions' }).deepLinkRoute).toBe('settings/extensions')
    expect(resolveUiValidationRoute({ surface: 'settings', section: 'extensions' }).dependencies).toEqual([
      { scope: 'app', phase: 'ready' },
      { scope: 'transport', phase: 'ready' },
      { scope: 'workspace', phase: 'ready' },
    ])
    expect(resolveUiValidationRoute({ surface: 'workspace-picker' }, '9')).toEqual({
      route: { surface: 'workspace-picker' },
      dependencies: [
        { scope: 'app', phase: 'ready', windowId: '9' },
        { scope: 'transport', phase: 'ready', windowId: '9' },
      ],
      ready: { scope: 'workspace', phase: 'ready', windowId: '9', detail: { selected: false } },
    })
  })

  it('rejects unknown routes and parameters', () => {
    expect(() => resolveUiValidationRoute({ surface: 'settings', section: 'not-real' })).toThrow('Unknown settings section')
    expect(() => resolveUiValidationRoute({ surface: 'chat', selector: '#private' })).toThrow('Unsupported route parameter')
    expect(() => resolveUiValidationRoute({ surface: 'workspace-picker', workspaceId: 'not-allowed' })).toThrow('Unsupported route parameter')
  })
})
