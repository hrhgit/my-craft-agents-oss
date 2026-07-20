import { describe, expect, it } from 'bun:test'
import { buildRouteFromNavigationState, parseRouteToNavigationState } from '../route-parser'
import { routes } from '../routes'

describe('new conversation routes', () => {
  it('round-trips a workspace draft without manufacturing a session id', () => {
    const route = routes.view.newConversation('draft-a')
    const state = parseRouteToNavigationState(route)

    expect(state).toEqual({
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      details: { type: 'new', draftId: 'draft-a' },
    })
    expect(buildRouteFromNavigationState(state!)).toBe(route)
  })

  it('encodes draft ids as one route segment', () => {
    expect(routes.view.newConversation('panel / one')).toBe('allSessions/new/panel%20%2F%20one')
    expect(parseRouteToNavigationState('allSessions/new/panel%20%2F%20one')).toMatchObject({
      details: { type: 'new', draftId: 'panel / one' },
    })
  })

  it('rejects malformed encoded draft ids without throwing', () => {
    expect(parseRouteToNavigationState('allSessions/new/%')).toBeNull()
  })
})
