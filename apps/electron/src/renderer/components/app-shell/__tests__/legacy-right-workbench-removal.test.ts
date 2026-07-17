import { describe, expect, it } from 'bun:test'

const appShellSource = await Bun.file(new URL('../AppShell.tsx', import.meta.url)).text()
const panelStackSource = await Bun.file(new URL('../PanelStackContainer.tsx', import.meta.url)).text()
const topBarSource = await Bun.file(new URL('../TopBar.tsx', import.meta.url)).text()
const unifiedDockSource = await Bun.file(new URL('../UnifiedDockWorkspace.tsx', import.meta.url)).text()
const workbenchSource = await Bun.file(new URL('../../right-workbench/RightWorkbench.tsx', import.meta.url)).text()

describe('universal dock production ownership', () => {
  it('does not retain the fixed right-workbench runtime branch', () => {
    expect(appShellSource).not.toContain('resolveUnifiedDockWorkspaceEnabled')
    expect(appShellSource).not.toContain('<RightWorkbench')
    expect(appShellSource).not.toContain('rightWorkbenchWidth')
    expect(workbenchSource).not.toContain('data-craft-semantic-id="workbench.right"')
  })

  it('uses the universal dock for desktop and compact content', () => {
    expect(appShellSource).toContain('<UnifiedDockWorkspace')
    expect(panelStackSource).toContain('Universal tab/group workspace shared by desktop and compact detail views.')
    expect(panelStackSource).toContain('{unifiedDockSlot ? (')
    expect(unifiedDockSource).not.toContain('compactDockViewIntent !== null')
  })

  it('keeps the top-bar control bound only to canvas layout behavior', () => {
    expect(topBarSource).toContain("const panelControlLabel = t('workbench.toggleCanvasLayout')")
    expect(topBarSource).not.toContain("t('workbench.toggle')")
    expect(topBarSource).not.toContain('isWorkbenchOpen')
    expect(topBarSource).not.toContain('isCanvasLayoutControl')
  })
})
