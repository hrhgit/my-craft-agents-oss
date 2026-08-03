import { describe, expect, it } from 'bun:test'
import { playgroundReadyStates } from '../playground-ready-state'

describe('playground validation ready state', () => {
  it('publishes a ready app and only validation-owned empty state', () => {
    const states = playgroundReadyStates()

    expect(states.find(state => state.scope === 'app')).toMatchObject({
      phase: 'ready',
      detail: { entry: 'playground', hydrated: true },
    })
    expect(states.find(state => state.scope === 'workspace')).toMatchObject({
      phase: 'ready',
      detail: { selected: false },
    })
    expect(states.find(state => state.scope === 'sessions')).toMatchObject({
      phase: 'ready',
      detail: { count: 0 },
    })
    expect(states.some(state => state.scope === 'session')).toBe(false)
  })
})
