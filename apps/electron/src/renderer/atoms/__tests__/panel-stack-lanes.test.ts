import { describe, it, expect } from 'bun:test'
import { createStore } from 'jotai'
import {
  activeDockTabIdAtom,
  activeDockTabProtectionAtom,
  activeDockTabTypeAtom,
  acknowledgeDockTabCloseRequestAtom,
  dockTabCloseRequestAtom,
  dockTabProtectionsAtom,
  compactDockViewIntentAtom,
  emptyDockPageSessionRequestAtom,
  enterCompactDockDetailAtom,
  exitCompactDockDetailAtom,
  generateEmptyDockPageTabId,
  isEmptyDockPageTabId,
  panelStackAtom,
  focusedPanelIdAtom,
  pushPanelAtom,
  reconcilePanelStackAtom,
  resetCompactDockViewIntentAtom,
  requestDockTabCloseAtom,
  shouldReplaceActiveTabWithSession,
  updateFocusedPanelRouteAtom,
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

    // Returning to a list must not be undone just because a workspace tab
    // remains active in the preserved dock model.
    store.set(activeDockTabIdAtom, 'dock:content:files')
    expect(store.get(compactDockViewIntentAtom)).toBe('navigator')

    store.set(resetCompactDockViewIntentAtom)
    expect(store.get(compactDockViewIntentAtom)).toBeNull()
  })

  it('only replaces the selected tab when that tab is a session', () => {
    const store = createStore()

    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    const sessionTabId = getStack(store)[0].id
    expect(store.get(activeDockTabTypeAtom)).toBe('session')
    expect(shouldReplaceActiveTabWithSession(store.get(activeDockTabTypeAtom))).toBe(true)

    store.set(activeDockTabIdAtom, sessionTabId)
    store.set(dockTabProtectionsAtom, {
      [sessionTabId]: { pinned: false, dirty: false, running: true, awaitingInput: false },
    })
    expect(store.get(activeDockTabProtectionAtom).running).toBe(true)
    expect(shouldReplaceActiveTabWithSession(
      store.get(activeDockTabTypeAtom),
      store.get(activeDockTabProtectionAtom),
    )).toBe(false)

    store.set(activeDockTabIdAtom, 'dock:content:files')
    expect(store.get(activeDockTabTypeAtom)).toBe('other')
    expect(shouldReplaceActiveTabWithSession(store.get(activeDockTabTypeAtom))).toBe(false)

    store.set(activeDockTabIdAtom, 'dock:content:files')
    store.set(pushPanelAtom, { route: 'sources/source/github' })
    expect(getStack(store)).toHaveLength(1)
    expect(store.get(activeDockTabTypeAtom)).toBe('other')
    expect(shouldReplaceActiveTabWithSession(store.get(activeDockTabTypeAtom))).toBe(false)
  })

  it('targets a session selection request at the active empty dock page', () => {
    const store = createStore()
    const emptyTabId = generateEmptyDockPageTabId()

    store.set(emptyDockPageSessionRequestAtom, {
      tabId: emptyTabId,
      sessionId: 's1',
    })

    expect(store.get(emptyDockPageSessionRequestAtom)).toEqual({
      tabId: emptyTabId,
      sessionId: 's1',
    })
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

  it('keeps management routes out of the workspace panel stack', () => {
    const store = createStore()

    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'sources/source/github' })
    store.set(pushPanelAtom, { route: 'settings' })

    const stack = getStack(store)
    expect(stack).toHaveLength(1)
    expect(stack[0].route).toBe('allSessions/session/s1')
    expect(stack.every((p) => p.laneId === 'main')).toBe(true)
  })

  it('implicit navigation updates sessions but rejects management routes', () => {
    const store = createStore()

    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })

    const secondPanel = getStack(store).find((p) => p.route === 'allSessions/session/s2')
    expect(secondPanel).toBeDefined()
    store.set(focusedPanelIdAtom, secondPanel!.id)

    store.set(updateFocusedPanelRouteAtom, 'settings/ai')
    expect(getStack(store).map(panel => panel.route)).toEqual([
      'allSessions/session/s1',
      'allSessions/session/s2',
    ])

    store.set(updateFocusedPanelRouteAtom, 'allSessions/session/s3')

    const stack = getStack(store)
    expect(stack).toHaveLength(2)
    expect(stack.some((p) => p.route === 'allSessions/session/s3')).toBe(true)
    expect(stack.some((p) => p.route === 'allSessions/session/s1')).toBe(true)
  })

  it('pushPanel afterIndex inserts immediately after the given panel', () => {
    const store = createStore()

    store.set(pushPanelAtom, { route: 'allSessions/session/s1' })
    store.set(pushPanelAtom, { route: 'allSessions/session/s2' })

    store.set(pushPanelAtom, { route: 'allSessions/session/s3', afterIndex: 0 })

    const stack = getStack(store)
    expect(stack).toHaveLength(3)
    expect(stack[0].route).toBe('allSessions/session/s1')
    expect(stack[1].route).toBe('allSessions/session/s3')
    expect(stack[2].route).toBe('allSessions/session/s2')
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
    const focusedId = store.get(focusedPanelIdAtom)
    expect(focusedId).toBe(stack[1].id)
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

    store.set(reconcilePanelStackAtom, {
      entries: [
        { route: 'allSessions/session/s1', proportion: 0.5 },
        { route: 'allSessions/session/s1', proportion: 0.5 },
      ],
      focusedIndex: 1,
    })

    const stack = getStack(store)
    const firstId = stack[0].id
    const secondId = stack[1].id
    expect(firstId).not.toBe(secondId)

    const changed = store.set(reconcilePanelStackAtom, {
      entries: [
        { route: 'allSessions/session/s1', proportion: 0.5 },
        { route: 'allSessions/session/s1', proportion: 0.5 },
      ],
      focusedIndex: 1,
    })

    expect(changed).toBe(false)
    expect(store.get(focusedPanelIdAtom)).toBe(secondId)
  })

  it('keeps a single session panel identity across unchanged UI-state reconciliation', () => {
    const store = createStore()

    store.set(reconcilePanelStackAtom, {
      entries: [{ route: 'allSessions/session/s1', proportion: 1 }],
      focusedIndex: 0,
    })
    const initialPanel = getStack(store)[0]

    // Opening an in-place UI such as search can cause URL state to be read
    // again, but it must not replace the panel that owns ChatPage.
    const changed = store.set(reconcilePanelStackAtom, {
      entries: [{ route: 'allSessions/session/s1', proportion: 1 }],
      focusedIndex: 0,
    })

    expect(changed).toBe(false)
    expect(getStack(store)[0]).toBe(initialPanel)
    expect(store.get(focusedPanelIdAtom)).toBe(initialPanel.id)
  })
})
