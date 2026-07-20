import { describe, expect, it } from 'bun:test'
import {
  isPageSurfaceRoute,
  isWorkspacePanelRoute,
  resolveVisibleRoute,
  shouldEncodePanelStack,
} from '../navigation-surface'

describe('navigation surface ownership', () => {
  it('keeps management routes out of the workspace dock', () => {
    for (const route of [
      'settings/ai',
      'skills/skill/review',
      'skills/skill/review',
      'automations/automation/nightly',
    ]) {
      expect(isPageSurfaceRoute(route)).toBe(true)
      expect(isWorkspacePanelRoute(route)).toBe(false)
    }
  })

  it('keeps conversation routes in the workspace dock', () => {
    expect(isWorkspacePanelRoute('allSessions/session/s1')).toBe(true)
    expect(isPageSurfaceRoute('allSessions/session/s1')).toBe(false)
  })

  it('shows a page surface without replacing the focused dock route', () => {
    expect(resolveVisibleRoute('settings/app', 'allSessions/session/s1'))
      .toBe('settings/app')
    expect(resolveVisibleRoute(null, 'allSessions/session/s1'))
      .toBe('allSessions/session/s1')
  })

  it('serializes a single hidden dock panel while a page surface is open', () => {
    expect(shouldEncodePanelStack(1, 'settings/app')).toBe(true)
    expect(shouldEncodePanelStack(1, null)).toBe(false)
    expect(shouldEncodePanelStack(2, null)).toBe(true)
  })
})
