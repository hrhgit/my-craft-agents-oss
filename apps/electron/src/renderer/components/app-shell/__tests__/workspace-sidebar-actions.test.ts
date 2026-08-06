import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appShellSource = readFileSync(join(__dirname, '../AppShell.tsx'), 'utf8')
const menuSource = readFileSync(join(__dirname, '../SidebarMenu.tsx'), 'utf8')

describe('workspace sidebar actions', () => {
  it('shows the new-session shortcut and overflow menu for active workspaces too', () => {
    expect(appShellSource).toContain("label: t('sidebar.newSession')")
    expect(appShellSource).toContain('menuContent: (')
    expect(appShellSource).not.toContain('contextMenu: item.isActive ? undefined')
  })

  it('offers edit, file-manager, and remove actions', () => {
    expect(menuSource).toContain("t('workspace.editWorkspace')")
    expect(menuSource).toContain("t('workspace.openInFileManager')")
    expect(menuSource).toContain("t('workspace.removeWorkspace')")
    expect(appShellSource).toContain('workspaceNavigation.openEdit(workspaceId)')
    expect(appShellSource).not.toContain("handleSettingsClick('workspace')")
  })

  it('opens the folder through the trusted Workspace route', () => {
    expect(appShellSource).toContain("'openWorkspaceFolder'")
    expect(appShellSource).not.toContain('endpoint.rootPath')
  })
})
