/**
 * Panel Stack State
 *
 * Single-lane panel model for side-by-side content panels.
 */

import { atom } from 'jotai'
import { parseRouteToNavigationState } from '../../shared/route-parser'
import type { ViewRoute } from '../../shared/routes'

let nextPanelId = 0
export function generatePanelId(): string {
  return `panel-${++nextPanelId}-${Date.now()}`
}

let nextEmptyDockPageId = 0
export const EMPTY_DOCK_PAGE_TAB_ID_PREFIX = 'dock:content-picker:'

export function generateEmptyDockPageTabId(): string {
  return `${EMPTY_DOCK_PAGE_TAB_ID_PREFIX}${Date.now()}-${++nextEmptyDockPageId}`
}

export function isEmptyDockPageTabId(tabId: string | null | undefined): tabId is string {
  return typeof tabId === 'string' && tabId.startsWith(EMPTY_DOCK_PAGE_TAB_ID_PREFIX)
}

export type PanelType = 'session' | 'settings' | 'skills' | 'other'
export type OpenIntent = 'implicit' | 'explicit'

export interface PanelStackEntry {
  id: string
  route: ViewRoute
  proportion: number
  panelType: PanelType
  laneId: 'main'
}

export const panelStackAtom = atom<PanelStackEntry[]>([])
export const focusedPanelIdAtom = atom<string | null>(null)
// The dock tracks the actual selected tab separately from the focused content
// panel so a selected tool tab cannot be mistaken for the last chat panel.
export const activeDockTabIdAtom = atom<string | null>(null)

// Compact navigation is an explicit, transient view intent. `null` follows the
// focused route, while the two concrete values let a user enter workspace
// content or return to the navigator without changing or closing dock tabs.
export type CompactDockViewIntent = 'navigator' | 'detail' | null
export const compactDockViewIntentAtom = atom<CompactDockViewIntent>(null)
export const enterCompactDockDetailAtom = atom(null, (_get, set) => {
  set(compactDockViewIntentAtom, 'detail')
})
export const exitCompactDockDetailAtom = atom(null, (_get, set) => {
  set(compactDockViewIntentAtom, 'navigator')
})
export const resetCompactDockViewIntentAtom = atom(null, (_get, set) => {
  set(compactDockViewIntentAtom, null)
})
let nextDockTabCloseRequestId = 0

export interface DockTabCloseRequest {
  requestId: number
  tabId: string
}

export const dockTabCloseRequestAtom = atom<DockTabCloseRequest | null>(null)
export const requestDockTabCloseAtom = atom(null, (_get, set, tabId: string) => {
  set(dockTabCloseRequestAtom, {
    requestId: ++nextDockTabCloseRequestId,
    tabId,
  })
})
export const acknowledgeDockTabCloseRequestAtom = atom(null, (get, set, requestId: number) => {
  if (get(dockTabCloseRequestAtom)?.requestId === requestId) {
    set(dockTabCloseRequestAtom, null)
  }
})
export const emptyDockPageSessionRequestAtom = atom<{
  tabId: string
  sessionId: string
} | null>(null)

export interface DockTabProtection {
  pinned: boolean
  dirty: boolean
  running: boolean
  awaitingInput: boolean
}

export const UNPROTECTED_DOCK_TAB: DockTabProtection = {
  pinned: false,
  dirty: false,
  running: false,
  awaitingInput: false,
}

export const dockTabProtectionsAtom = atom<Record<string, DockTabProtection>>({})
export const activeDockTabProtectionAtom = atom((get) => {
  const activeId = get(activeDockTabIdAtom)
  return activeId ? get(dockTabProtectionsAtom)[activeId] ?? UNPROTECTED_DOCK_TAB : UNPROTECTED_DOCK_TAB
})

export function isDockTabProtected(protection: DockTabProtection): boolean {
  return protection.pinned || protection.dirty || protection.running || protection.awaitingInput
}

export const activeDockTabTypeAtom = atom<PanelType>((get) => {
  const stack = get(panelStackAtom)
  const activeId = get(activeDockTabIdAtom)
  if (activeId) return stack.find(entry => entry.id === activeId)?.panelType ?? 'other'

  const focusedId = get(focusedPanelIdAtom)
  return (stack.find(entry => entry.id === focusedId) ?? stack[0])?.panelType ?? 'other'
})

export function shouldReplaceActiveTabWithSession(
  activeTabType: PanelType,
  protection: DockTabProtection = UNPROTECTED_DOCK_TAB,
): boolean {
  return activeTabType === 'session'
    && !isDockTabProtected(protection)
}

export const panelCountAtom = atom((get) => get(panelStackAtom).length)

export const focusedPanelIndexAtom = atom((get) => {
  const stack = get(panelStackAtom)
  const focusedId = get(focusedPanelIdAtom)
  if (!focusedId) return 0
  const idx = stack.findIndex(p => p.id === focusedId)
  return idx === -1 ? 0 : idx
})

export const focusedPanelRouteAtom = atom((get) => {
  const stack = get(panelStackAtom)
  const idx = get(focusedPanelIndexAtom)
  return stack[idx]?.route ?? null
})

export function getPanelTypeFromRoute(route: ViewRoute): PanelType {
  const navState = parseRouteToNavigationState(route)
  if (!navState) return 'other'

  switch (navState.navigator) {
    case 'sessions':
      return 'session'
    case 'settings':
      return 'settings'
    case 'skills':
      return 'skills'
    default:
      return 'other'
  }
}

export function createPanelStackEntry(route: ViewRoute, proportion: number, id?: string): PanelStackEntry {
  const panelType = getPanelTypeFromRoute(route)
  return {
    id: id ?? generatePanelId(),
    route,
    proportion,
    panelType,
    laneId: 'main',
  }
}

function normalizeProportions(stack: PanelStackEntry[]): PanelStackEntry[] {
  if (stack.length === 0) return stack
  const total = stack.reduce((sum, p) => sum + p.proportion, 0)
  if (total <= 0) {
    const equal = 1 / stack.length
    return stack.map(p => ({ ...p, proportion: equal }))
  }
  return stack.map(p => ({ ...p, proportion: p.proportion / total }))
}

export function parseSessionIdFromRoute(route: ViewRoute): string | null {
  const segments = route.split('/')
  const idx = segments.indexOf('session')
  if (idx >= 0 && idx + 1 < segments.length) {
    return segments[idx + 1]
  }
  return null
}

export const focusedSessionIdAtom = atom((get) => {
  const route = get(focusedPanelRouteAtom)
  if (!route) return null
  return parseSessionIdFromRoute(route)
})

export const pushPanelAtom = atom(
  null,
  (get, set, { route, afterIndex }: {
    route: ViewRoute
    afterIndex?: number
    intent?: OpenIntent
  }) => {
    if (getPanelTypeFromRoute(route) !== 'session') return
    const stack = get(panelStackAtom)
    let insertAt = stack.length
    if (afterIndex !== undefined && afterIndex >= 0 && afterIndex < stack.length) {
      insertAt = afterIndex + 1
    }

    const newEntry = createPanelStackEntry(route, 0)
    const newStack = [
      ...stack.slice(0, insertAt),
      newEntry,
      ...stack.slice(insertAt),
    ]

    const normalized = normalizeProportions(newStack)
    set(panelStackAtom, normalized)
    set(focusedPanelIdAtom, newEntry.id)
  }
)

export const closePanelAtom = atom(
  null,
  (get, set, id: string) => {
    const stack = get(panelStackAtom)
    const idx = stack.findIndex(p => p.id === id)
    if (idx === -1) return
    const remaining = [...stack.slice(0, idx), ...stack.slice(idx + 1)]

    set(panelStackAtom, normalizeProportions(remaining))

    if (get(focusedPanelIdAtom) === id) {
      const newIdx = Math.min(idx, remaining.length - 1)
      set(focusedPanelIdAtom, remaining[newIdx]?.id ?? null)
    }
  }
)

export const reconcilePanelStackAtom = atom(
  null,
  (get, set, { entries, focusedIndex }: {
    entries: { route: ViewRoute; proportion: number }[]
    focusedIndex?: number
  }): boolean => {
    const workspaceEntries = entries.filter(entry => getPanelTypeFromRoute(entry.route) === 'session')
    if (workspaceEntries.length === 0) return false

    const current = get(panelStackAtom)
    const used = new Set<string>()

    const originalFocusIndex = Math.min(focusedIndex ?? 0, entries.length - 1)
    const originalFocusEntry = entries[originalFocusIndex]
    const mappedFocusIndex = originalFocusEntry
      ? workspaceEntries.indexOf(originalFocusEntry)
      : -1
    const requestedFocusIndex = mappedFocusIndex >= 0
      ? mappedFocusIndex
      : Math.min(originalFocusIndex, workspaceEntries.length - 1)
    const requestedFocusRoute = workspaceEntries[requestedFocusIndex]?.route ?? workspaceEntries[0].route

    const newStack = workspaceEntries.map((target, i) => {
      const positional = current[i]

      if (positional && positional.route === target.route && !used.has(positional.id)) {
        used.add(positional.id)
        const updated = createPanelStackEntry(target.route, target.proportion, positional.id)
        return { ...updated, proportion: target.proportion }
      }

      const any = current.find(c => c.route === target.route && !used.has(c.id))
      if (any) {
        used.add(any.id)
        const updated = createPanelStackEntry(target.route, target.proportion, any.id)
        return { ...updated, proportion: target.proportion }
      }

      if (positional && !used.has(positional.id)) {
        used.add(positional.id)
        const updated = createPanelStackEntry(target.route, target.proportion, positional.id)
        return { ...updated, proportion: target.proportion }
      }

      return createPanelStackEntry(target.route, target.proportion)
    })

    const normalized = normalizeProportions(newStack)

    if (
      normalized.length === current.length &&
      normalized.every((p, i) =>
        p.id === current[i].id &&
        p.route === current[i].route &&
        p.laneId === current[i].laneId &&
        p.panelType === current[i].panelType &&
        Math.abs(p.proportion - current[i].proportion) < 0.001
      )
    ) {
      const targetFocusId =
        normalized[Math.min(requestedFocusIndex, normalized.length - 1)]?.id ??
        normalized.find((p) => p.route === requestedFocusRoute)?.id ??
        null
      if (get(focusedPanelIdAtom) !== targetFocusId) {
        set(focusedPanelIdAtom, targetFocusId)
      }
      return false
    }

    set(panelStackAtom, normalized)

    const focusId =
      normalized[Math.min(requestedFocusIndex, normalized.length - 1)]?.id ??
      normalized.find((p) => p.route === requestedFocusRoute)?.id ??
      null
    set(focusedPanelIdAtom, focusId)

    return true
  }
)

export const resizePanelsAtom = atom(
  null,
  (get, set, { leftIndex, rightIndex, leftProportion, rightProportion }: {
    leftIndex: number
    rightIndex: number
    leftProportion: number
    rightProportion: number
  }) => {
    const stack = get(panelStackAtom)
    if (leftIndex < 0 || rightIndex >= stack.length) return
    const newStack = stack.map((p, i) => {
      if (i === leftIndex) return { ...p, proportion: leftProportion }
      if (i === rightIndex) return { ...p, proportion: rightProportion }
      return p
    })
    set(panelStackAtom, newStack)
  }
)

export const updateFocusedPanelRouteAtom = atom(
  null,
  (get, set, route: ViewRoute) => {
    if (getPanelTypeFromRoute(route) !== 'session') return
    const stack = get(panelStackAtom)

    if (stack.length === 0) {
      const newEntry = createPanelStackEntry(route, 1)
      set(panelStackAtom, [newEntry])
      set(focusedPanelIdAtom, newEntry.id)
      return
    }

    const focusedId = get(focusedPanelIdAtom)
    const focused = stack.find(p => p.id === focusedId) ?? stack[0]

    const updated = stack.map((p) =>
      p.id === focused.id
        ? { ...createPanelStackEntry(route, p.proportion, p.id), proportion: p.proportion }
        : p
    )

    set(panelStackAtom, updated)
    set(focusedPanelIdAtom, focused.id)
  }
)

export const focusNextPanelAtom = atom(
  null,
  (get, set) => {
    const stack = get(panelStackAtom)
    if (stack.length <= 1) return
    const currentIdx = get(focusedPanelIndexAtom)
    const nextIdx = (currentIdx + 1) % stack.length
    set(focusedPanelIdAtom, stack[nextIdx].id)
  }
)

export const focusPrevPanelAtom = atom(
  null,
  (get, set) => {
    const stack = get(panelStackAtom)
    if (stack.length <= 1) return
    const currentIdx = get(focusedPanelIndexAtom)
    const prevIdx = (currentIdx - 1 + stack.length) % stack.length
    set(focusedPanelIdAtom, stack[prevIdx].id)
  }
)
