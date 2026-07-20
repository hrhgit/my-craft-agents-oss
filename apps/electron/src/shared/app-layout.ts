import {
  captureLayoutGeometryPlacement,
  mergeRedockedGroupGeometry,
  mergeRedockedTabGeometry,
  type LayoutGeometryPlacement,
} from './layout-geometry'

/**
 * Mortise-owned layout domain model.
 *
 * Geometry adapters (FlexLayout today) may store their own serializable tree in
 * `geometry`, but content identity and lifecycle never depend on that format.
 */

export const APP_LAYOUT_VERSION = 1 as const
export const PRIMARY_LAYOUT_WINDOW_ID = 'primary'

export type ContentKind =
  | 'conversation'
  | 'file'
  | 'browser'
  | 'tool'
  | 'extension'
  | 'navigation'

export interface WorkspaceRoute {
  serverId: string
  workspaceId: string
}

export interface ContentRef extends WorkspaceRoute {
  kind: ContentKind
  sessionId?: string
  resourceId?: string
}

export interface ContentProtection {
  pinned: boolean
  dirty: boolean
  running: boolean
  awaitingInput: boolean
}

export interface ContentTab {
  id: string
  title: string
  ref: ContentRef
  groupId: string
  protection: ContentProtection
  instancePolicy: 'singleton' | 'multiple'
  allowDetach: boolean
  minWidth?: number
  minHeight?: number
}

export interface PanelGroup {
  id: string
  windowId: string
  tabIds: string[]
  activeTabId: string | null
  defaultLocation?: 'main' | 'right' | 'left' | 'bottom'
}

export interface LayoutWindow {
  id: string
  kind: 'primary' | 'auxiliary'
  groupIds: string[]
  sourceGroupId?: string
  sourceIndex?: number
  sourceTabIndex?: number
  sourceTabId?: string
  /** Last known auxiliary leaf that carried the originally detached tab. */
  sourceAuxiliaryGroupId?: string
  sourceAuxiliaryIndex?: number
  sourceBeforeTabId?: string
  sourceAfterTabId?: string
  sourceBeforeGroupId?: string
  sourceAfterGroupId?: string
  /** Adapter-local return anchor captured at detach time, never a full geometry snapshot. */
  sourceGeometryPlacement?: LayoutGeometryPlacement
  bounds?: { x: number; y: number; width: number; height: number }
  /** Window-local geometry. Primary geometry remains in AppLayout.geometry for v1 compatibility. */
  geometry?: unknown
}

export interface AppLayout {
  version: typeof APP_LAYOUT_VERSION
  workspaceId: string
  revision: number
  geometry: unknown
  tabs: Record<string, ContentTab>
  groups: Record<string, PanelGroup>
  windows: Record<string, LayoutWindow>
  focusedTabId: string | null
}

export interface CreateDefaultLayoutOptions extends WorkspaceRoute {
  sessionId?: string
  route?: string
}

const DEFAULT_PROTECTION: ContentProtection = {
  pinned: false,
  dirty: false,
  running: false,
  awaitingInput: false,
}

export function createDefaultAppLayout(options: CreateDefaultLayoutOptions): AppLayout {
  const mainTabId = 'content:main'
  const mainGroupId = 'group:main'

  return {
    version: APP_LAYOUT_VERSION,
    workspaceId: options.workspaceId,
    revision: 0,
    geometry: null,
    tabs: {
      [mainTabId]: {
        id: mainTabId,
        title: 'Conversation',
        groupId: mainGroupId,
        ref: {
          kind: 'conversation',
          serverId: options.serverId,
          workspaceId: options.workspaceId,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.route ? { resourceId: options.route } : {}),
        },
        protection: { ...DEFAULT_PROTECTION },
        instancePolicy: 'multiple',
        allowDetach: true,
      },
    },
    groups: {
      [mainGroupId]: {
        id: mainGroupId,
        windowId: PRIMARY_LAYOUT_WINDOW_ID,
        tabIds: [mainTabId],
        activeTabId: mainTabId,
        defaultLocation: 'main',
      },
    },
    windows: {
      [PRIMARY_LAYOUT_WINDOW_ID]: {
        id: PRIMARY_LAYOUT_WINDOW_ID,
        kind: 'primary',
        groupIds: [mainGroupId],
      },
    },
    focusedTabId: mainTabId,
  }
}

/** Focus an empty/new conversation without discarding the workspace's saved dock layout. */
export function focusConversationRoute(layout: AppLayout, route: string): AppLayout {
  const primary = layout.windows[PRIMARY_LAYOUT_WINDOW_ID]
  if (!primary) return layout

  const primaryTabIds = primary.groupIds.flatMap(groupId => layout.groups[groupId]?.tabIds ?? [])
  const focused = layout.focusedTabId ? layout.tabs[layout.focusedTabId] : undefined
  const primaryTabs = primaryTabIds.map(tabId => layout.tabs[tabId]).filter(Boolean)
  const existingRoute = primaryTabs.find(tab => (
    tab.ref.kind === 'conversation' && tab.ref.resourceId === route
  ))
  const conversation = existingRoute
    ?? (focused?.ref.kind === 'conversation' && primaryTabIds.includes(focused.id) && canReplaceContentTab(focused)
      ? focused
      : primaryTabs.find(tab => tab.ref.kind === 'conversation' && canReplaceContentTab(tab)))

  if (conversation) {
    const group = layout.groups[conversation.groupId]
    return {
      ...layout,
      tabs: {
        ...layout.tabs,
        [conversation.id]: {
          ...conversation,
          title: 'Conversation',
          ref: {
            kind: 'conversation',
            serverId: conversation.ref.serverId,
            workspaceId: conversation.ref.workspaceId,
            resourceId: route,
          },
        },
      },
      groups: group ? {
        ...layout.groups,
        [group.id]: { ...group, activeTabId: conversation.id },
      } : layout.groups,
      focusedTabId: conversation.id,
    }
  }

  const groupId = primary.groupIds[0]
  const group = groupId ? layout.groups[groupId] : undefined
  if (!group) return layout
  let tabId = 'content:new-conversation'
  let suffix = 1
  while (layout.tabs[tabId]) tabId = `content:new-conversation-${suffix++}`
  const serverId = primaryTabIds.map(id => layout.tabs[id]?.ref.serverId).find(Boolean) ?? 'local'
  const tab: ContentTab = {
    id: tabId,
    title: 'Conversation',
    ref: {
      kind: 'conversation',
      serverId,
      workspaceId: layout.workspaceId,
      resourceId: route,
    },
    groupId,
    protection: { ...DEFAULT_PROTECTION },
    instancePolicy: 'multiple',
    allowDetach: true,
  }
  return {
    ...layout,
    tabs: { ...layout.tabs, [tabId]: tab },
    groups: {
      ...layout.groups,
      [groupId]: { ...group, tabIds: [...group.tabIds, tabId], activeTabId: tabId },
    },
    focusedTabId: tabId,
  }
}

export function canReplaceContentTab(tab: ContentTab | undefined): boolean {
  if (!tab) return false
  const { pinned, dirty, running, awaitingInput } = tab.protection
  return !pinned && !dirty && !running && !awaitingInput
}

export function openContentTab(
  layout: AppLayout,
  nextTab: ContentTab,
  options: { replaceTabId?: string | null; forceNew?: boolean } = {},
): AppLayout {
  if (layout.workspaceId !== nextTab.ref.workspaceId) return layout
  const sameId = layout.tabs[nextTab.id]
  if (sameId) return focusTab(layout, sameId.id)
  const existing = findSingleton(layout, nextTab)
  if (existing) return focusTab(layout, existing.id)

  const replaceTarget = options.replaceTabId ? layout.tabs[options.replaceTabId] : undefined
  if (!options.forceNew && canReplaceContentTab(replaceTarget)) {
    return replaceContentTab(layout, replaceTarget!.id, nextTab)
  }

  const groupId = layout.groups[nextTab.groupId]
    ? nextTab.groupId
    : replaceTarget?.groupId ?? firstPrimaryGroupId(layout)
  if (!groupId) return layout

  const group = layout.groups[groupId]
  const normalized = { ...nextTab, groupId }
  return bump(layout, {
    tabs: { ...layout.tabs, [normalized.id]: normalized },
    groups: {
      ...layout.groups,
      [groupId]: {
        ...group,
        tabIds: [...group.tabIds.filter(id => id !== normalized.id), normalized.id],
        activeTabId: normalized.id,
      },
    },
    focusedTabId: normalized.id,
  })
}

export function moveContentTab(
  layout: AppLayout,
  tabId: string,
  targetGroupId: string,
  targetIndex = -1,
): AppLayout {
  const tab = layout.tabs[tabId]
  const source = tab ? layout.groups[tab.groupId] : undefined
  const target = layout.groups[targetGroupId]
  if (!tab || !source || !target) return layout

  if (source.id === target.id) {
    const tabIds = source.tabIds.filter(id => id !== tabId)
    const insertAt = targetIndex < 0 ? tabIds.length : Math.min(Math.max(targetIndex, 0), tabIds.length)
    tabIds.splice(insertAt, 0, tabId)
    if (tabIds.every((id, index) => id === source.tabIds[index]) && source.activeTabId === tabId) return layout
    return bump(layout, {
      groups: { ...layout.groups, [source.id]: { ...source, tabIds, activeTabId: tabId } },
      focusedTabId: tabId,
    })
  }

  const sourceWindow = layout.windows[source.windowId]
  if (
    sourceWindow?.kind === 'primary'
    && sourceWindow.groupIds.length === 1
    && target.windowId !== source.windowId
  ) return layout

  const sourceIds = source.tabIds.filter(id => id !== tabId)
  const targetIds = target.tabIds.filter(id => id !== tabId)
  const insertAt = targetIndex < 0 ? targetIds.length : Math.min(Math.max(targetIndex, 0), targetIds.length)
  targetIds.splice(insertAt, 0, tabId)

  const groups = {
    ...layout.groups,
    [source.id]: {
      ...source,
      tabIds: sourceIds,
      activeTabId: source.activeTabId === tabId ? sourceIds[0] ?? null : source.activeTabId,
    },
    [target.id]: { ...target, tabIds: targetIds, activeTabId: tabId },
  }
  const windows = { ...layout.windows }
  if (sourceIds.length === 0 && !isDetachedTabSource(layout, source.id)) {
    delete groups[source.id]
    const owner = windows[source.windowId]
    if (owner) {
      const groupIds = owner.groupIds.filter(id => id !== source.id)
      if (owner.kind === 'auxiliary' && groupIds.length === 0) delete windows[owner.id]
      else windows[owner.id] = { ...owner, groupIds }
    }
  }

  return bump(layout, {
    tabs: { ...layout.tabs, [tabId]: { ...tab, groupId: targetGroupId } },
    groups,
    windows,
    focusedTabId: tabId,
  })
}

export function detachPanelGroup(
  layout: AppLayout,
  groupId: string,
  auxiliaryWindowId: string,
  bounds?: LayoutWindow['bounds'],
): AppLayout {
  const group = layout.groups[groupId]
  const primary = layout.windows[PRIMARY_LAYOUT_WINDOW_ID]
  if (!group || !primary || group.windowId !== PRIMARY_LAYOUT_WINDOW_ID || primary.groupIds.length <= 1) return layout
  if (layout.windows[auxiliaryWindowId]) return layout
  if (group.tabIds.some(tabId => layout.tabs[tabId]?.allowDetach === false)) return layout
  // A detached tab retains this group as its redock target. Moving the target
  // to another window would give the same group two window owners on redock.
  if (isDetachedTabSource(layout, groupId)) return layout

  const virtualPrimaryOrder = virtualPrimaryGroupOrder(layout, primary)
  const currentSourceIndex = virtualPrimaryOrder.indexOf(groupId)
  if (currentSourceIndex < 0) return layout
  const sourceIndex = currentSourceIndex
  const sourceBeforeGroupId = virtualPrimaryOrder[sourceIndex - 1]
  const sourceAfterGroupId = virtualPrimaryOrder[sourceIndex + 1]
  const sourceGeometryPlacement = captureLayoutGeometryPlacement(layout.geometry, groupId)
  return bump(layout, {
    groups: { ...layout.groups, [groupId]: { ...group, windowId: auxiliaryWindowId } },
    windows: {
      ...layout.windows,
      [PRIMARY_LAYOUT_WINDOW_ID]: {
        ...primary,
        groupIds: primary.groupIds.filter(id => id !== groupId),
      },
      [auxiliaryWindowId]: {
        id: auxiliaryWindowId,
        kind: 'auxiliary',
        groupIds: [groupId],
        sourceGroupId: groupId,
        sourceIndex,
        ...(sourceBeforeGroupId ? { sourceBeforeGroupId } : {}),
        ...(sourceAfterGroupId ? { sourceAfterGroupId } : {}),
        ...(sourceGeometryPlacement ? { sourceGeometryPlacement } : {}),
        ...(bounds ? { bounds } : {}),
      },
    },
  })
}

export function detachContentTab(
  layout: AppLayout,
  tabId: string,
  auxiliaryWindowId: string,
  bounds?: LayoutWindow['bounds'],
): AppLayout {
  const tab = layout.tabs[tabId]
  const source = tab ? layout.groups[tab.groupId] : undefined
  const primary = layout.windows[PRIMARY_LAYOUT_WINDOW_ID]
  if (!tab || !source || !primary || !tab.allowDetach || source.windowId !== PRIMARY_LAYOUT_WINDOW_ID) return layout
  if (layout.windows[auxiliaryWindowId]) return layout

  const currentSourceTabIndex = source.tabIds.indexOf(tabId)
  if (currentSourceTabIndex < 0 || !primary.groupIds.includes(source.id)) return layout
  const virtualSourceOrder = virtualSourceTabOrder(layout, source)
  const virtualSourceTabIndex = virtualSourceOrder.indexOf(tabId)
  const sourceTabIndex = virtualSourceTabIndex >= 0
    ? virtualSourceTabIndex
    : stableDetachedTabIndex(layout, source.id, currentSourceTabIndex)
  const sourceBeforeTabId = virtualSourceOrder[sourceTabIndex - 1]
  const sourceAfterTabId = virtualSourceOrder[sourceTabIndex + 1]
  const sourceGeometryPlacement = captureLayoutGeometryPlacement(layout.geometry, source.id)

  const detachedGroupId = `detached:${auxiliaryWindowId}`
  if (layout.groups[detachedGroupId]) return layout

  const sourceTabIds = source.tabIds.filter(id => id !== tabId)
  const nextSourceActiveTabId = source.activeTabId === tabId
    ? sourceTabIds[Math.min(currentSourceTabIndex, sourceTabIds.length - 1)] ?? null
    : source.activeTabId

  return bump(layout, {
    tabs: {
      ...layout.tabs,
      [tabId]: { ...tab, groupId: detachedGroupId },
    },
    groups: {
      ...layout.groups,
      [source.id]: {
        ...source,
        tabIds: sourceTabIds,
        activeTabId: nextSourceActiveTabId,
      },
      [detachedGroupId]: {
        id: detachedGroupId,
        windowId: auxiliaryWindowId,
        tabIds: [tabId],
        activeTabId: tabId,
        ...(source.defaultLocation ? { defaultLocation: source.defaultLocation } : {}),
      },
    },
    windows: {
      ...layout.windows,
      [auxiliaryWindowId]: {
        id: auxiliaryWindowId,
        kind: 'auxiliary',
        groupIds: [detachedGroupId],
        sourceGroupId: source.id,
        sourceIndex: primary.groupIds.indexOf(source.id),
        sourceTabIndex,
        sourceTabId: tabId,
        sourceAuxiliaryGroupId: detachedGroupId,
        sourceAuxiliaryIndex: 0,
        ...(sourceBeforeTabId ? { sourceBeforeTabId } : {}),
        ...(sourceAfterTabId ? { sourceAfterTabId } : {}),
        ...(sourceGeometryPlacement ? { sourceGeometryPlacement } : {}),
        ...(bounds ? { bounds } : {}),
      },
    },
    focusedTabId: tabId,
  })
}

export function redockLayoutWindow(layout: AppLayout, windowId: string): AppLayout {
  const auxiliary = layout.windows[windowId]
  const primary = layout.windows[PRIMARY_LAYOUT_WINDOW_ID]
  if (!auxiliary || auxiliary.kind !== 'auxiliary' || !primary) return layout

  if (auxiliary.sourceGroupId && auxiliary.sourceTabIndex !== undefined) {
    const source = layout.groups[auxiliary.sourceGroupId]
    if (source) {
      const returningSourceGroupId = auxiliary.sourceTabId
        ? auxiliary.groupIds.find(groupId => layout.groups[groupId]?.tabIds.includes(auxiliary.sourceTabId!))
        : undefined
      const anchoredReturningSourceGroupId = returningSourceGroupId
        ?? (auxiliary.sourceAuxiliaryGroupId && auxiliary.groupIds.includes(auxiliary.sourceAuxiliaryGroupId)
          ? auxiliary.sourceAuxiliaryGroupId
          : undefined)
      const returningTabIds = anchoredReturningSourceGroupId
        ? layout.groups[anchoredReturningSourceGroupId]?.tabIds ?? []
        : []
      const auxiliaryTabIds = auxiliary.groupIds.flatMap(groupId => layout.groups[groupId]?.tabIds ?? [])
      const sourceTabIds = source.tabIds.filter(tabId => !auxiliaryTabIds.includes(tabId))
      const insertAt = redockTabIndex(layout, auxiliary, sourceTabIds.length)
      sourceTabIds.splice(insertAt, 0, ...returningTabIds)

      const tabs = { ...layout.tabs }
      for (const tabId of returningTabIds) {
        const tab = tabs[tabId]
        if (tab) tabs[tabId] = { ...tab, groupId: source.id }
      }

      const groups = { ...layout.groups }
      groups[source.id] = {
        ...source,
        windowId: PRIMARY_LAYOUT_WINDOW_ID,
        tabIds: sourceTabIds,
        activeTabId: auxiliary.sourceTabId && returningTabIds.includes(auxiliary.sourceTabId)
          ? auxiliary.sourceTabId
          : returningTabIds[0] ?? source.activeTabId,
      }
      for (const groupId of auxiliary.groupIds) {
        if (groupId === anchoredReturningSourceGroupId && groupId !== source.id) {
          delete groups[groupId]
          continue
        }
        const group = groups[groupId]
        if (group) groups[groupId] = { ...group, windowId: PRIMARY_LAYOUT_WINDOW_ID }
      }

      const windows = { ...layout.windows }
      delete windows[windowId]
      const sourceIsPrimary = source.windowId === PRIMARY_LAYOUT_WINDOW_ID
      const returningGroupSequence = auxiliary.groupIds.flatMap(groupId =>
        groupId === anchoredReturningSourceGroupId
          ? [source.id]
          : groups[groupId] ? [groupId] : [])
      if (!returningGroupSequence.includes(source.id)) {
        const sourceInsertAt = Math.min(
          Math.max(auxiliary.sourceAuxiliaryIndex ?? 0, 0),
          returningGroupSequence.length,
        )
        returningGroupSequence.splice(sourceInsertAt, 0, source.id)
      }
      const primaryWithoutReturning = primary.groupIds.filter(groupId =>
        groupId !== source.id && !auxiliary.groupIds.includes(groupId))
      const currentSourceIndex = primary.groupIds.indexOf(source.id)
      const sequenceInsertAt = currentSourceIndex >= 0
        ? Math.min(currentSourceIndex, primaryWithoutReturning.length)
        : Math.min(Math.max(auxiliary.sourceIndex ?? primaryWithoutReturning.length, 0), primaryWithoutReturning.length)
      const primaryGroupIds = sourceIsPrimary
        ? insertManyAtIndex(primaryWithoutReturning, returningGroupSequence, sequenceInsertAt)
        : primaryWithoutReturning
      const mergeGeometry = (primaryGeometry: unknown) => mergeRedockedTabGeometry({
        primaryGeometry,
        auxiliaryGeometry: auxiliary.geometry,
        sourceGroupId: source.id,
        sourceTabIds,
        returningSourceGroupId: anchoredReturningSourceGroupId,
        sourceAuxiliaryIndex: auxiliary.sourceAuxiliaryIndex ?? 0,
        auxiliaryGroupIds: auxiliary.groupIds,
        returningTabIds,
        groups,
        tabs,
        placement: auxiliary.sourceGeometryPlacement,
      })
      windows[PRIMARY_LAYOUT_WINDOW_ID] = {
        ...primary,
        groupIds: primaryGroupIds,
        ...(primary.geometry !== undefined ? { geometry: mergeGeometry(primary.geometry) } : {}),
      }

      return bump(layout, {
        geometry: mergeGeometry(layout.geometry),
        tabs,
        groups,
        windows,
        focusedTabId: auxiliary.sourceTabId && tabs[auxiliary.sourceTabId]
          ? auxiliary.sourceTabId
          : returningTabIds[0] ?? layout.focusedTabId,
      })
    }
  }

  const groupIds = [...primary.groupIds]
  const insertAt = redockGroupIndex(layout, auxiliary, groupIds.length)
  groupIds.splice(insertAt, 0, ...auxiliary.groupIds.filter(id => !groupIds.includes(id)))

  const groups = { ...layout.groups }
  for (const groupId of auxiliary.groupIds) {
    const group = groups[groupId]
    if (group) groups[groupId] = { ...group, windowId: PRIMARY_LAYOUT_WINDOW_ID }
  }
  const windows = { ...layout.windows }
  delete windows[windowId]
  const mergeGeometry = (primaryGeometry: unknown) => mergeRedockedGroupGeometry({
    primaryGeometry,
    auxiliaryGeometry: auxiliary.geometry,
    groupIds: auxiliary.groupIds,
    groups,
    tabs: layout.tabs,
    placement: auxiliary.sourceGeometryPlacement,
  })
  windows[PRIMARY_LAYOUT_WINDOW_ID] = {
    ...primary,
    groupIds,
    ...(primary.geometry !== undefined ? { geometry: mergeGeometry(primary.geometry) } : {}),
  }
  return bump(layout, {
    geometry: mergeGeometry(layout.geometry),
    groups,
    windows,
  })
}

export function restoreLayoutForStartup(layout: AppLayout): AppLayout {
  let restored = layout
  for (const window of Object.values(layout.windows)) {
    if (window.kind === 'auxiliary') restored = redockLayoutWindow(restored, window.id)
  }
  return sanitizeAppLayout(restored)
}

export function sanitizeAppLayout(input: unknown): AppLayout {
  if (!isRecord(input) || input.version !== APP_LAYOUT_VERSION) {
    return createDefaultAppLayout({ serverId: 'local', workspaceId: '' })
  }

  const rawTabs = isRecord(input.tabs) ? input.tabs : {}
  const rawGroups = isRecord(input.groups) ? input.groups : {}
  const tabs: Record<string, ContentTab> = {}
  const groups: Record<string, PanelGroup> = {}
  const groupTabOrder = new Map<string, string[]>()
  const groupActiveTabs = new Map<string, string | null>()

  for (const [id, value] of Object.entries(rawTabs)) {
    const tab = sanitizeTab(id, value)
    if (tab) tabs[id] = tab
  }
  for (const [id, value] of Object.entries(rawGroups)) {
    if (!isRecord(value)) continue
    const tabIds = uniqueStrings(value.tabIds).filter(tabId => !!tabs[tabId])
    const activeTabId = typeof value.activeTabId === 'string' && tabIds.includes(value.activeTabId)
      ? value.activeTabId
      : null
    groupTabOrder.set(id, tabIds)
    groupActiveTabs.set(id, activeTabId)
    groups[id] = {
      id,
      windowId: stringValue(value.windowId, PRIMARY_LAYOUT_WINDOW_ID),
      tabIds: [],
      activeTabId: null,
      ...(isDefaultLocation(value.defaultLocation) ? { defaultLocation: value.defaultLocation } : {}),
    }
  }

  for (const tab of Object.values(tabs)) {
    if (!groups[tab.groupId]) delete tabs[tab.id]
  }

  const declaredWorkspaceId = stringValue(input.workspaceId, '')
  const firstWorkspaceId = Object.values(tabs)[0]?.ref.workspaceId ?? ''
  const workspaceId = declaredWorkspaceId || firstWorkspaceId
  const defaultServerId = Object.values(tabs)[0]?.ref.serverId ?? 'local'
  for (const tab of Object.values(tabs)) {
    if (tab.ref.workspaceId !== workspaceId) delete tabs[tab.id]
  }

  // The tab's declared group is authoritative. This repairs snapshots where
  // an adapter duplicated an id across tabsets or left tab.groupId stale.
  const claimedTabs = new Set<string>()
  for (const group of Object.values(groups)) {
    const preferredOrder = groupTabOrder.get(group.id) ?? []
    group.tabIds = preferredOrder.filter(tabId => {
      const tab = tabs[tabId]
      if (!tab || tab.groupId !== group.id || claimedTabs.has(tabId)) return false
      claimedTabs.add(tabId)
      return true
    })
  }
  for (const tab of Object.values(tabs)) {
    if (claimedTabs.has(tab.id)) continue
    const group = groups[tab.groupId]
    if (!group) {
      delete tabs[tab.id]
      continue
    }
    group.tabIds.push(tab.id)
    claimedTabs.add(tab.id)
  }
  for (const group of Object.values(groups)) {
    const preferredActive = groupActiveTabs.get(group.id)
    group.activeTabId = preferredActive && group.tabIds.includes(preferredActive)
      ? preferredActive
      : group.tabIds[0] ?? null
  }

  const rawWindows = isRecord(input.windows) ? input.windows : {}
  const claimedGroups = new Set<string>()
  const windows: Record<string, LayoutWindow> = {
    [PRIMARY_LAYOUT_WINDOW_ID]: {
      id: PRIMARY_LAYOUT_WINDOW_ID,
      kind: 'primary',
      groupIds: [],
    },
  }
  const rawWindowEntries = Object.entries(rawWindows).sort(([left], [right]) =>
    left === PRIMARY_LAYOUT_WINDOW_ID ? -1 : right === PRIMARY_LAYOUT_WINDOW_ID ? 1 : 0
  )
  for (const [windowId, value] of rawWindowEntries) {
    if (!isRecord(value) || !Array.isArray(value.groupIds)) continue
    const groupIds = uniqueStrings(value.groupIds).filter(groupId => !!groups[groupId] && !claimedGroups.has(groupId))
    for (const groupId of groupIds) claimedGroups.add(groupId)
    if (windowId === PRIMARY_LAYOUT_WINDOW_ID) {
      windows[PRIMARY_LAYOUT_WINDOW_ID].groupIds = groupIds
      continue
    }
    if (value.kind !== 'auxiliary' || groupIds.length === 0) continue
    windows[windowId] = {
      id: windowId,
      kind: 'auxiliary',
      groupIds,
      ...(typeof value.sourceGroupId === 'string' && groups[value.sourceGroupId]
        ? { sourceGroupId: value.sourceGroupId }
        : {}),
      ...(typeof value.sourceIndex === 'number' && Number.isInteger(value.sourceIndex)
        ? { sourceIndex: Math.max(0, value.sourceIndex) }
        : {}),
      ...(typeof value.sourceTabIndex === 'number' && Number.isInteger(value.sourceTabIndex)
        ? { sourceTabIndex: Math.max(0, value.sourceTabIndex) }
        : {}),
      ...(typeof value.sourceTabId === 'string' ? { sourceTabId: value.sourceTabId } : {}),
      ...(typeof value.sourceAuxiliaryGroupId === 'string'
        ? { sourceAuxiliaryGroupId: value.sourceAuxiliaryGroupId }
        : {}),
      ...(typeof value.sourceAuxiliaryIndex === 'number' && Number.isInteger(value.sourceAuxiliaryIndex)
        ? { sourceAuxiliaryIndex: Math.max(0, value.sourceAuxiliaryIndex) }
        : {}),
      ...(typeof value.sourceBeforeTabId === 'string' ? { sourceBeforeTabId: value.sourceBeforeTabId } : {}),
      ...(typeof value.sourceAfterTabId === 'string' ? { sourceAfterTabId: value.sourceAfterTabId } : {}),
      ...(typeof value.sourceBeforeGroupId === 'string' ? { sourceBeforeGroupId: value.sourceBeforeGroupId } : {}),
      ...(typeof value.sourceAfterGroupId === 'string' ? { sourceAfterGroupId: value.sourceAfterGroupId } : {}),
      ...(sanitizeGeometryPlacement(value.sourceGeometryPlacement) ? {
        sourceGeometryPlacement: sanitizeGeometryPlacement(value.sourceGeometryPlacement)!,
      } : {}),
      ...(isBounds(value.bounds) ? { bounds: value.bounds } : {}),
      ...(value.geometry !== undefined ? { geometry: sanitizeGeometry(value.geometry) } : {}),
    }
  }

  for (const group of Object.values(groups)) {
    if (!claimedGroups.has(group.id)) {
      windows[PRIMARY_LAYOUT_WINDOW_ID].groupIds.push(group.id)
      claimedGroups.add(group.id)
    }
  }
  for (const window of Object.values(windows)) {
    for (const groupId of window.groupIds) groups[groupId] = { ...groups[groupId], windowId: window.id }
  }

  // Empty tabsets are adapter debris unless they are the explicit redock
  // target for a detached tab. Keeping only those targets prevents an
  // unbounded collection of empty split groups while preserving detach of the
  // last tab in a group.
  const redockTargets = new Set(Object.values(windows).flatMap(window =>
    window.kind === 'auxiliary'
      && window.sourceTabIndex !== undefined
      && window.sourceGroupId
      ? [window.sourceGroupId]
      : []
  ))
  for (const group of Object.values(groups)) {
    if (group.tabIds.length > 0 || redockTargets.has(group.id)) continue
    delete groups[group.id]
    for (const window of Object.values(windows)) {
      window.groupIds = window.groupIds.filter(groupId => groupId !== group.id)
    }
  }
  for (const window of Object.values(windows)) {
    if (window.kind === 'auxiliary' && window.groupIds.length === 0) delete windows[window.id]
  }

  // A primary window may legitimately be empty while detached content still
  // lives in an auxiliary window. Preserve that intermediate state so startup
  // restoration can redock the surviving groups instead of replacing them.
  if (Object.keys(tabs).length === 0) {
    return createDefaultAppLayout({ serverId: defaultServerId, workspaceId })
  }

  return {
    version: APP_LAYOUT_VERSION,
    workspaceId,
    revision: finiteInteger(input.revision, 0),
    geometry: sanitizeGeometry(input.geometry),
    tabs,
    groups,
    windows,
    focusedTabId: typeof input.focusedTabId === 'string' && tabs[input.focusedTabId]
      ? input.focusedTabId
      : Object.keys(tabs)[0] ?? null,
  }
}

export function assertSingleWorkspaceLayout(layout: AppLayout, expectedWorkspaceId = layout.workspaceId): void {
  if (layout.workspaceId !== expectedWorkspaceId) {
    throw new Error(`Layout workspace mismatch: expected ${expectedWorkspaceId}, received ${layout.workspaceId}`)
  }
  for (const tab of Object.values(layout.tabs)) {
    if (tab.ref.workspaceId !== expectedWorkspaceId) {
      throw new Error(`Layout cannot mix workspaces: tab ${tab.id} belongs to ${tab.ref.workspaceId}`)
    }
  }
}

function replaceContentTab(layout: AppLayout, tabId: string, nextTab: ContentTab): AppLayout {
  const previous = layout.tabs[tabId]
  if (!previous) return layout
  const group = layout.groups[previous.groupId]
  if (!group) return layout

  const tabs = { ...layout.tabs }
  delete tabs[tabId]
  tabs[nextTab.id] = { ...nextTab, groupId: group.id }
  return bump(layout, {
    tabs,
    groups: {
      ...layout.groups,
      [group.id]: {
        ...group,
        tabIds: group.tabIds.map(id => id === tabId ? nextTab.id : id),
        activeTabId: group.activeTabId === tabId ? nextTab.id : group.activeTabId,
      },
    },
    focusedTabId: layout.focusedTabId === tabId ? nextTab.id : layout.focusedTabId,
  })
}

function focusTab(layout: AppLayout, tabId: string): AppLayout {
  const tab = layout.tabs[tabId]
  const group = tab ? layout.groups[tab.groupId] : undefined
  if (!tab || !group || (layout.focusedTabId === tabId && group.activeTabId === tabId)) return layout
  return bump(layout, {
    groups: { ...layout.groups, [group.id]: { ...group, activeTabId: tabId } },
    focusedTabId: tabId,
  })
}

function findSingleton(layout: AppLayout, tab: ContentTab): ContentTab | undefined {
  if (tab.instancePolicy !== 'singleton') return undefined
  return Object.values(layout.tabs).find(candidate =>
    candidate.instancePolicy === 'singleton'
    && candidate.ref.kind === tab.ref.kind
    && candidate.ref.serverId === tab.ref.serverId
    && candidate.ref.workspaceId === tab.ref.workspaceId
    && candidate.ref.sessionId === tab.ref.sessionId
    && candidate.ref.resourceId === tab.ref.resourceId
  )
}

function bump(layout: AppLayout, patch: Partial<AppLayout>): AppLayout {
  return { ...layout, ...patch, revision: layout.revision + 1 }
}

function firstPrimaryGroupId(layout: AppLayout): string | undefined {
  return layout.windows[PRIMARY_LAYOUT_WINDOW_ID]?.groupIds[0]
}

function insertAtIndex(values: string[], value: string, index = values.length): string[] {
  const next = values.filter(candidate => candidate !== value)
  next.splice(Math.min(Math.max(index, 0), next.length), 0, value)
  return next
}

function insertManyAtIndex(values: string[], inserted: string[], index = values.length): string[] {
  const uniqueInserted = [...new Set(inserted)]
  const next = values.filter(candidate => !uniqueInserted.includes(candidate))
  next.splice(Math.min(Math.max(index, 0), next.length), 0, ...uniqueInserted)
  return next
}

function isDetachedTabSource(layout: AppLayout, groupId: string): boolean {
  return Object.values(layout.windows).some(window =>
    window.kind === 'auxiliary'
    && window.sourceGroupId === groupId
    && window.sourceTabIndex !== undefined
  )
}

function stableDetachedTabIndex(layout: AppLayout, sourceGroupId: string, currentIndex: number): number {
  let stableIndex = currentIndex
  const occupied = Object.values(layout.windows)
    .filter(window => window.kind === 'auxiliary' && window.sourceGroupId === sourceGroupId)
    .flatMap(window => window.sourceTabIndex === undefined ? [] : [window.sourceTabIndex])
    .sort((a, b) => a - b)
  for (const index of occupied) {
    if (index <= stableIndex) stableIndex += 1
  }
  return stableIndex
}

function virtualSourceTabOrder(layout: AppLayout, source: PanelGroup): string[] {
  const virtual = [...source.tabIds]
  const detached = Object.values(layout.windows)
    .filter(window =>
      window.kind === 'auxiliary'
      && window.sourceGroupId === source.id
      && window.sourceTabIndex !== undefined
      && window.sourceTabId
    )
    .sort((left, right) => left.sourceTabIndex! - right.sourceTabIndex!)
  for (const window of detached) {
    if (!window.sourceTabId || virtual.includes(window.sourceTabId)) continue
    virtual.splice(Math.min(Math.max(window.sourceTabIndex ?? virtual.length, 0), virtual.length), 0, window.sourceTabId)
  }
  return virtual
}

function redockTabIndex(layout: AppLayout, returning: LayoutWindow, sourceLength: number): number {
  const source = returning.sourceGroupId ? layout.groups[returning.sourceGroupId] : undefined
  if (source) {
    if (returning.sourceAfterTabId) {
      const afterIndex = source.tabIds.indexOf(returning.sourceAfterTabId)
      if (afterIndex >= 0) return afterIndex
    }
    if (returning.sourceBeforeTabId) {
      const beforeIndex = source.tabIds.indexOf(returning.sourceBeforeTabId)
      if (beforeIndex >= 0) return Math.min(beforeIndex + 1, sourceLength)
    }
  }
  const stableIndex = returning.sourceTabIndex ?? sourceLength
  const detachedBefore = Object.values(layout.windows).filter(window =>
    window.id !== returning.id
    && window.kind === 'auxiliary'
    && window.sourceGroupId === returning.sourceGroupId
    && window.sourceTabIndex !== undefined
    && window.sourceTabIndex < stableIndex
  ).length
  return Math.min(Math.max(stableIndex - detachedBefore, 0), sourceLength)
}

function isDetachedGroupWindow(window: LayoutWindow): boolean {
  return window.kind === 'auxiliary'
    && window.sourceTabIndex === undefined
    && window.sourceGroupId !== undefined
    && window.groupIds.includes(window.sourceGroupId)
}

function virtualPrimaryGroupOrder(layout: AppLayout, primary: LayoutWindow): string[] {
  const virtual = [...primary.groupIds]
  const detached = Object.values(layout.windows)
    .filter(isDetachedGroupWindow)
    .sort((left, right) => (left.sourceIndex ?? 0) - (right.sourceIndex ?? 0))
  for (const window of detached) {
    if (!window.sourceGroupId || virtual.includes(window.sourceGroupId)) continue
    virtual.splice(Math.min(Math.max(window.sourceIndex ?? virtual.length, 0), virtual.length), 0, window.sourceGroupId)
  }
  return virtual
}

function redockGroupIndex(layout: AppLayout, returning: LayoutWindow, primaryLength: number): number {
  const primary = layout.windows[PRIMARY_LAYOUT_WINDOW_ID]
  if (primary) {
    if (returning.sourceAfterGroupId) {
      const afterIndex = primary.groupIds.indexOf(returning.sourceAfterGroupId)
      if (afterIndex >= 0) return afterIndex
    }
    if (returning.sourceBeforeGroupId) {
      const beforeIndex = primary.groupIds.indexOf(returning.sourceBeforeGroupId)
      if (beforeIndex >= 0) return Math.min(beforeIndex + 1, primaryLength)
    }
  }
  const stableIndex = returning.sourceIndex ?? primaryLength
  const detachedBefore = Object.values(layout.windows).filter(window =>
    window.id !== returning.id
    && isDetachedGroupWindow(window)
    && window.sourceIndex !== undefined
    && window.sourceIndex < stableIndex
  ).length
  return Math.min(Math.max(stableIndex - detachedBefore, 0), primaryLength)
}

function sanitizeTab(id: string, value: unknown): ContentTab | null {
  if (!isRecord(value) || !isRecord(value.ref)) return null
  const kind = value.ref.kind
  if (!isContentKind(kind)) return null
  const serverId = stringValue(value.ref.serverId, '')
  const workspaceId = stringValue(value.ref.workspaceId, '')
  if (!serverId) return null

  // Sources was retired as a navigation surface. Persisted tabs used its
  // route as the resource id, so remove them here before the layout is
  // reconstructed rather than restoring an unroutable blank panel.
  if (kind === 'navigation' && isRetiredNavigationRoute(value.ref.resourceId)) return null

  const resourceId = typeof value.ref.resourceId === 'string'
    ? sanitizeResourceId(kind, value.ref.resourceId)
    : undefined
  const protection = isRecord(value.protection) ? value.protection : {}
  return {
    id,
    title: stringValue(value.title, 'Untitled').slice(0, 200),
    groupId: stringValue(value.groupId, ''),
    ref: {
      kind,
      serverId,
      workspaceId,
      ...(typeof value.ref.sessionId === 'string' ? { sessionId: value.ref.sessionId } : {}),
      ...(resourceId ? { resourceId } : {}),
    },
    protection: {
      pinned: protection.pinned === true,
      dirty: protection.dirty === true,
      running: protection.running === true,
      awaitingInput: protection.awaitingInput === true,
    },
    instancePolicy: value.instancePolicy === 'singleton' ? 'singleton' : 'multiple',
    allowDetach: value.allowDetach !== false,
    ...(finitePositive(value.minWidth) ? { minWidth: value.minWidth as number } : {}),
    ...(finitePositive(value.minHeight) ? { minHeight: value.minHeight as number } : {}),
  }
}

function sanitizeResourceId(kind: ContentKind, value: string): string | undefined {
  const trimmed = value.trim().slice(0, 2048)
  if (!trimmed) return undefined
  if (kind === 'browser' && /^(?:https?|file):\/\//i.test(trimmed)) return undefined
  return trimmed
}

function isRetiredNavigationRoute(value: unknown): boolean {
  return typeof value === 'string' && (value === 'sources' || value.startsWith('sources/'))
}

function sanitizeGeometry(value: unknown): unknown {
  if (value == null) return null
  try {
    const serialized = JSON.stringify(value)
    if (serialized.length > 2_000_000) return null
    return JSON.parse(serialized)
  } catch {
    return null
  }
}

function sanitizeGeometryPlacement(value: unknown): LayoutGeometryPlacement | undefined {
  if (!isRecord(value) || !Array.isArray(value.parentPath)) return undefined
  const parentPath = value.parentPath.filter((part): part is number =>
    typeof part === 'number' && Number.isInteger(part) && part >= 0).slice(0, 64)
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) return undefined
  return {
    parentPath,
    index: value.index,
    ...(Array.isArray(value.parentChain) ? {
      parentChain: value.parentChain.flatMap((segment: unknown) => {
        if (!isRecord(segment) || typeof segment.index !== 'number' || !Number.isInteger(segment.index) || segment.index < 0) {
          return []
        }
        return [{
          index: segment.index,
          ...(typeof segment.id === 'string' ? { id: segment.id.slice(0, 512) } : {}),
          ...(typeof segment.weight === 'number' && Number.isFinite(segment.weight) && segment.weight > 0
            ? { weight: segment.weight }
            : {}),
        }]
      }).slice(0, 64),
    } : {}),
    ...(typeof value.parentId === 'string' ? { parentId: value.parentId.slice(0, 512) } : {}),
    ...(typeof value.beforeGroupId === 'string' ? { beforeGroupId: value.beforeGroupId.slice(0, 512) } : {}),
    ...(typeof value.afterGroupId === 'string' ? { afterGroupId: value.afterGroupId.slice(0, 512) } : {}),
    ...(typeof value.weight === 'number' && Number.isFinite(value.weight) && value.weight > 0
      ? { weight: value.weight }
      : {}),
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
}

function finiteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isDefaultLocation(value: unknown): value is NonNullable<PanelGroup['defaultLocation']> {
  return value === 'main' || value === 'right' || value === 'left' || value === 'bottom'
}

function isBounds(value: unknown): value is NonNullable<LayoutWindow['bounds']> {
  return isRecord(value)
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && finitePositive(value.width)
    && finitePositive(value.height)
}

function isContentKind(value: unknown): value is ContentKind {
  return value === 'conversation'
    || value === 'file'
    || value === 'browser'
    || value === 'tool'
    || value === 'extension'
    || value === 'navigation'
}
