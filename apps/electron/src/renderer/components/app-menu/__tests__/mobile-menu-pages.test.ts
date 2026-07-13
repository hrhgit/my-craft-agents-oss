import { describe, expect, it } from 'bun:test'
import { buildMobileMenuPages } from '../mobile-menu-pages'

describe('buildMobileMenuPages', () => {
  it('exposes workspaces as a first-class compact menu page', () => {
    const pages = buildMobileMenuPages({ hasNewWindow: false, isDebugMode: false })
    const root = pages.find(page => page.id === 'root')
    const workspaces = pages.find(page => page.id === 'workspaces')

    expect(root?.rows.some(row => row.id === 'workspaces' && row.action.kind === 'navigate')).toBe(true)
    expect(workspaces).toEqual({ id: 'workspaces', titleKey: 'workspace.workspaces', rows: [] })
  })
})
