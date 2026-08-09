import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeDockTabIdAtom,
  activeDockTabProtectionAtom,
  acknowledgeDockTabCloseRequestAtom,
  compactDockViewIntentAtom,
  dockTabCloseRequestAtom,
  dockTabProtectionsAtom,
  enterCompactDockDetailAtom,
  exitCompactDockDetailAtom,
  focusedPanelIdAtom,
  generateEmptyDockPageTabId,
  isEmptyDockPageTabId,
  panelStackAtom,
  reconcilePanelStackAtom,
  requestDockTabCloseAtom,
  resetCompactDockViewIntentAtom,
  type PanelStackEntry,
} from '../panel-stack'

function getStack(store: ReturnType<typeof createStore>): PanelStackEntry[] {
  return store.get(panelStackAtom)
}

describe('panel stack single-lane behavior', () => {
  it('keeps compact drill-in intent independent from the active dock tab', () => {
    const store = createStore()
    expect(store.get(compactDockViewIntentAtom)).toBeNull()

    store.set(enterCompactDockDetailAtom)
    store.set(activeDockTabIdAtom, 'dock:content:files')
    expect(store.get(compactDockViewIntentAtom)).toBe('detail')

    store.set(exitCompactDockDetailAtom)
    store.set(activeDockTabIdAtom, 'session-panel')
    expect(store.get(compactDockViewIntentAtom)).toBe('navigator')

    store.set(activeDockTabIdAtom, 'dock:content:files')
    expect(store.get(compactDockViewIntentAtom)).toBe('navigator')

    store.set(resetCompactDockViewIntentAtom)
    expect(store.get(compactDockViewIntentAtom)).toBeNull()
  })

  it('keeps tab protection as lifecycle state instead of navigation policy', () => {
    const store = createStore()
    store.set(activeDockTabIdAtom, 'conversation')
    store.set(dockTabProtectionsAtom, {
      conversation: { pinned: false, dirty: false, running: true, awaitingInput: false },
    })

    expect(store.get(activeDockTabProtectionAtom).running).toBe(true)
  })

  it('generates stable identities for empty dock pages', () => {
    const emptyTabId = generateEmptyDockPageTabId()
    expect(isEmptyDockPageTabId(emptyTabId)).toBe(true)
    expect(generateEmptyDockPageTabId()).not.toBe(emptyTabId)
    expect(isEmptyDockPageTabId('panel-1')).toBe(false)
  })

  it('delivers and acknowledges ordered dock close requests', () => {
    const store = createStore()
    store.set(requestDockTabCloseAtom, 'dock:content:files')
    const first = store.get(dockTabCloseRequestAtom)
    expect(first).toMatchObject({ tabId: 'dock:content:files' })

    store.set(requestDockTabCloseAtom, 'conversation')
    const second = store.get(dockTabCloseRequestAtom)
    expect(second?.requestId).toBeGreaterThan(first?.requestId ?? 0)
    store.set(acknowledgeDockTabCloseRequestAtom, first!.requestId)
    expect(store.get(dockTabCloseRequestAtom)).toEqual(second)
    store.set(acknowledgeDockTabCloseRequestAtom, second!.requestId)
    expect(store.get(dockTabCloseRequestAtom)).toBeNull()
  })

  it('reconcile focuses by focusedIndex first when duplicate routes exist', () => {
    const store = createStore()
    const changed = store.set(reconcilePanelStackAtom, {
      entries: [
        { route: 'allSessions/session/s1', proportion: 0.5 },
        { route: 'allSessions/session/s1', proportion: 0.5 },
      ],
      focusedIndex: 1,
    })

    expect(changed).toBe(true)
    const stack = getStack(store)
    expect(stack).toHaveLength(2)
    expect(store.get(focusedPanelIdAtom)).toBe(stack[1].id)
  })

  it('remaps focus after dropping legacy management panels', () => {
    const store = createStore()
    store.set(reconcilePanelStackAtom, {
      entries: [
        { route: 'settings/ai', proportion: 0.2 },
        { route: 'allSessions/session/s1', proportion: 0.4 },
        { route: 'allSessions/session/s2', proportion: 0.4 },
      ],
      focusedIndex: 1,
    })

    const stack = getStack(store)
    expect(stack.map(panel => panel.route)).toEqual([
      'allSessions/session/s1',
      'allSessions/session/s2',
    ])
    expect(store.get(focusedPanelIdAtom)).toBe(stack[0].id)
  })

  it('reconcile no-op keeps focused index target with duplicate routes', () => {
    const store = createStore()
    const entries = [
      { route: 'allSessions/session/s1' as const, proportion: 0.5 },
      { route: 'allSessions/session/s1' as const, proportion: 0.5 },
    ]
    store.set(reconcilePanelStackAtom, { entries, focusedIndex: 1 })
    const secondId = getStack(store)[1].id

    expect(store.set(reconcilePanelStackAtom, { entries, focusedIndex: 1 })).toBe(false)
    expect(store.get(focusedPanelIdAtom)).toBe(secondId)
  })

  it('keeps a session panel identity across unchanged reconciliation', () => {
    const store = createStore()
    const entries = [{ route: 'allSessions/session/s1' as const, proportion: 1 }]
    store.set(reconcilePanelStackAtom, { entries, focusedIndex: 0 })
    const initialPanel = getStack(store)[0]

    expect(store.set(reconcilePanelStackAtom, { entries, focusedIndex: 0 })).toBe(false)
    expect(getStack(store)[0]).toBe(initialPanel)
    expect(store.get(focusedPanelIdAtom)).toBe(initialPanel.id)
  })
})
