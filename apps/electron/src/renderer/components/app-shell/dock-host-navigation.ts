import { Actions, Model, TabNode, TabSetNode } from 'flexlayout-react'
import type { BrowserHostDockNavigationCommand } from '../../../shared/types'

function tabsetsWithContent(model: Model): TabSetNode[] {
  const tabsets: TabSetNode[] = []
  model.visitNodes(node => {
    if (node instanceof TabSetNode && node.getSelectedNode() instanceof TabNode) {
      tabsets.push(node)
    }
  })
  return tabsets
}

function focusSelectedTab(tabset: TabSetNode, document: Document): boolean {
  const selected = tabset.getSelectedNode()
  if (!(selected instanceof TabNode)) return false
  const button = document.getElementById(`flexlayout-tabbutton-${selected.getId().replace(/\s/g, '_')}`)
  if (!button) return false
  button.focus()
  return true
}

export function handleBrowserHostDockNavigation(
  model: Model,
  command: BrowserHostDockNavigationCommand,
  document: Document,
): boolean {
  const tabsets = tabsetsWithContent(model)
  if (tabsets.length === 0) return false
  const active = model.getActiveTabset()
  const currentIndex = active ? tabsets.indexOf(active) : -1
  const resolvedIndex = currentIndex >= 0 ? currentIndex : 0

  if (command === 'focus-active-tab') {
    return focusSelectedTab(tabsets[resolvedIndex]!, document)
  }

  if (tabsets.length < 2 || model.getMaximizedTabset()) return false
  const delta = command === 'focus-next-group' ? 1 : -1
  const target = tabsets[(resolvedIndex + delta + tabsets.length) % tabsets.length]!
  const focused = focusSelectedTab(target, document)
  if (focused) model.doAction(Actions.setActiveTabset(target.getId()))
  return focused
}
