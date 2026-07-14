import { describe, expect, it } from 'bun:test'
import { expectedRendererRoute, parseStateCondition, semanticReadyAppGate } from '../test-host-state'

describe('test host state predicates', () => {
  it('maps public waits to scoped state predicates', () => {
    expect(parseStateCondition({ kind: 'app-phase', phase: 'ready' }, 12)).toEqual({
      kind: 'state', predicate: { scope: 'app', phase: 'ready', windowId: '12' },
    })
    expect(parseStateCondition({ kind: 'session-state', sessionId: 's1', state: 'busy' }, 12)).toEqual({
      kind: 'state', predicate: { scope: 'session', phase: 'busy', entityId: 's1', windowId: '12' },
    })
  })

  it('retains route fields for settled route waits', () => {
    expect(parseStateCondition({ kind: 'route', route: { surface: 'settings', section: 'ai' } }, 3)).toEqual({
      kind: 'state', predicate: { scope: 'route', phase: 'ready', windowId: '3', detail: { surface: 'settings', section: 'ai' } },
    })
    expect(expectedRendererRoute({ route: 'settings/preferences' })).toBe('settings/preferences')
    expect(expectedRendererRoute({ route: 'craftagents://settings/preferences' })).toBe('settings/preferences')
    expect(expectedRendererRoute({ route: 'craftagents://workspace/w1/settings/preferences' })).toBe('settings/preferences')
  })

  it('gates semantic snapshots on the selected renderer app state', () => {
    expect(semanticReadyAppGate(27)).toEqual({ scope: 'app', phase: 'ready', windowId: '27' })
  })
})
