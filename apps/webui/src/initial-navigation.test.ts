import { describe, expect, it } from 'bun:test'
import { resolveInitialWebUiSearch } from './initial-navigation'

describe('WebUI initial navigation', () => {
  it('opens an unsaved conversation for an ordinary root startup', () => {
    expect(resolveInitialWebUiSearch(''))
      .toBe('?route=allSessions%2Fnew%2Fdefault')
    expect(resolveInitialWebUiSearch('?workspace=ws-a'))
      .toBe('?workspace=ws-a&route=allSessions%2Fnew%2Fdefault')
  })

  it('preserves explicit conversation, layout, and scenario targets', () => {
    expect(resolveInitialWebUiSearch('?route=allSessions%2Fsession%2Fs1'))
      .toBe('?route=allSessions%2Fsession%2Fs1')
    expect(resolveInitialWebUiSearch('?panels=allSessions%3A1'))
      .toBe('?panels=allSessions%3A1')
    expect(resolveInitialWebUiSearch('?sessionId=s1')).toBe('?sessionId=s1')
    expect(resolveInitialWebUiSearch('?__mortiseUiScenarioHost=1'))
      .toBe('?__mortiseUiScenarioHost=1')
  })
})
