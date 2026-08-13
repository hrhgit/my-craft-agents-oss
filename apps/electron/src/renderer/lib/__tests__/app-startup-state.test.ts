import { describe, expect, it } from 'bun:test'
import { resolveAppStartupState } from '../app-startup-state'

describe('app startup state', () => {
  it('opens the app shell only when the window owns a workspace', () => {
    expect(resolveAppStartupState('workspace-a')).toBe('ready')
    expect(resolveAppStartupState('')).toBe('workspace-picker')
    expect(resolveAppStartupState(null)).toBe('workspace-picker')
  })
})
