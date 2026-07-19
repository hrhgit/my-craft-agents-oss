import { describe, expect, it } from 'bun:test'

const appShellSource = await Bun.file(new URL('../AppShell.tsx', import.meta.url)).text()
const rootSurfaceSource = await Bun.file(new URL('../RootSurfaceContainer.tsx', import.meta.url)).text()
const pageNavigationSource = await Bun.file(new URL('../PageNavigationSurface.tsx', import.meta.url)).text()
const topBarSource = await Bun.file(new URL('../TopBar.tsx', import.meta.url)).text()
const unifiedDockSource = await Bun.file(new URL('../UnifiedDockWorkspace.tsx', import.meta.url)).text()
const workbenchSource = await Bun.file(new URL('../../right-workbench/RightWorkbench.tsx', import.meta.url)).text()

describe('universal dock production ownership', () => {
  it('does not retain the fixed right-workbench runtime branch', () => {
    expect(appShellSource).not.toContain('resolveUnifiedDockWorkspaceEnabled')
    expect(appShellSource).not.toContain('<RightWorkbench')
    expect(appShellSource).not.toContain('rightWorkbenchWidth')
    expect(workbenchSource).not.toContain('data-mortise-semantic-id="workbench.right"')
  })

  it('uses one root content surface and keeps page navigation out of the shell', () => {
    expect(appShellSource).toContain('<UnifiedDockWorkspace')
    expect(appShellSource).toContain('<PageNavigationSurface')
    expect(rootSurfaceSource).toContain('Page-owned navigation lives inside the root content surface.')
    expect(rootSurfaceSource).toContain('{contentSlot}')
    expect(rootSurfaceSource).not.toContain('navigatorSlot')
    expect(rootSurfaceSource).not.toContain('navigatorWidth')
    expect(pageNavigationSource).toContain('data-page-region="navigation"')
    expect(pageNavigationSource).toContain('data-page-region="content"')
    expect(unifiedDockSource).toContain('isWorkspacePanelRoute(tab.ref.resourceId)')
    expect(unifiedDockSource).not.toContain('compactDockViewIntent !== null')
  })

  it('keeps the top-bar control bound only to canvas layout behavior', () => {
    expect(topBarSource).toContain("const panelControlLabel = t('workbench.toggleCanvasLayout')")
    expect(topBarSource).toContain('isCompact && isWorkspaceCanvasActive')
    expect(topBarSource).not.toContain("t('workbench.toggle')")
    expect(topBarSource).not.toContain('isWorkbenchOpen')
    expect(topBarSource).not.toContain('isCanvasLayoutControl')
  })
})
