import { describe, expect, it } from 'bun:test'
import type { NavigationState } from '../../../shared/types'
import { resolveNavigatorWidth } from '../nav-helpers'

describe('resolveNavigatorWidth', () => {
  const configuredWidth = 300

  it('hides only the desktop session-list navigator', () => {
    const sessionStates: NavigationState[] = [
      { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null },
      {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: { type: 'session', sessionId: 'session-1' },
      },
    ]

    for (const state of sessionStates) {
      expect(resolveNavigatorWidth(state, false, configuredWidth)).toBe(0)
    }
  })

  it('keeps desktop management-module navigators visible', () => {
    const managementStates: NavigationState[] = [
      { navigator: 'sources', details: null },
      { navigator: 'skills', details: null },
      { navigator: 'automations', details: null },
      { navigator: 'settings', subpage: null },
    ]

    for (const state of managementStates) {
      expect(resolveNavigatorWidth(state, false, configuredWidth)).toBe(configuredWidth)
    }
  })

  it('keeps the compact navigator full width for every module', () => {
    const state: NavigationState = {
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      details: null,
    }

    expect(resolveNavigatorWidth(state, true, configuredWidth)).toBe(configuredWidth)
  })
})
