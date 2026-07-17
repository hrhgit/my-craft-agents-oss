import {
  isDockTabProtected,
  type DockTabProtection,
  type PanelStackEntry,
} from '@/atoms/panel-stack'

export type KeyboardCloseTarget =
  | { kind: 'blocked-dock-tab'; tabId: string }
  | { kind: 'dock-tab'; tabId: string }
  | { kind: 'panel'; panelId: string }
  | { kind: 'window' }

export function resolveKeyboardCloseTarget({
  activeDockTabId,
  activeDockTabProtection,
  focusedPanelId,
  panelStack,
}: {
  activeDockTabId: string | null
  activeDockTabProtection: DockTabProtection
  focusedPanelId: string | null
  panelStack: PanelStackEntry[]
}): KeyboardCloseTarget {
  if (activeDockTabId) {
    return isDockTabProtected(activeDockTabProtection)
      ? { kind: 'blocked-dock-tab', tabId: activeDockTabId }
      : { kind: 'dock-tab', tabId: activeDockTabId }
  }

  const panel = focusedPanelId
    ? panelStack.find(candidate => candidate.id === focusedPanelId)
    : panelStack[panelStack.length - 1]
  return panel ? { kind: 'panel', panelId: panel.id } : { kind: 'window' }
}
