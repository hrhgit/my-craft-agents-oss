import { describe, expect, it } from 'bun:test'
import type { DockTabProtection, PanelStackEntry } from '@/atoms/panel-stack'
import { resolveKeyboardCloseTarget } from '../window-close-target'

const unprotected: DockTabProtection = {
  pinned: false,
  dirty: false,
  running: false,
  awaitingInput: false,
}

const panelStack: PanelStackEntry[] = [{
  id: 'conversation',
  route: 'allSessions/session/session-1',
  proportion: 1,
  panelType: 'session',
  laneId: 'main',
}]

describe('keyboard close target', () => {
  it('targets the selected dock tab instead of the last legacy panel', () => {
    expect(resolveKeyboardCloseTarget({
      activeDockTabId: 'dock:content:files',
      activeDockTabProtection: unprotected,
      focusedPanelId: 'conversation',
      panelStack,
    })).toEqual({ kind: 'dock-tab', tabId: 'dock:content:files' })
  })

  it.each(['dirty', 'running', 'pinned', 'awaitingInput'] as const)(
    'blocks the shortcut when the dock tab is %s',
    protection => {
      expect(resolveKeyboardCloseTarget({
        activeDockTabId: 'dock:content:files',
        activeDockTabProtection: { ...unprotected, [protection]: true },
        focusedPanelId: 'conversation',
        panelStack,
      })).toEqual({ kind: 'blocked-dock-tab', tabId: 'dock:content:files' })
    },
  )

  it('retains the legacy panel and window fallbacks when no dock owns focus', () => {
    expect(resolveKeyboardCloseTarget({
      activeDockTabId: null,
      activeDockTabProtection: unprotected,
      focusedPanelId: 'conversation',
      panelStack,
    })).toEqual({ kind: 'panel', panelId: 'conversation' })

    expect(resolveKeyboardCloseTarget({
      activeDockTabId: null,
      activeDockTabProtection: unprotected,
      focusedPanelId: null,
      panelStack: [],
    })).toEqual({ kind: 'window' })
  })
})
