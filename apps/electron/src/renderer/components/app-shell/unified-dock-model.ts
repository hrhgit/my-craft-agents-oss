import {
  getPanelTypeFromRoute,
  isDockTabProtected,
  UNPROTECTED_DOCK_TAB,
  type DockTabProtection,
  type PanelStackEntry,
} from '@/atoms/panel-stack'
import { Actions, DockLocation, Model, TabNode, TabSetNode, type Action } from 'flexlayout-react'

export interface CanvasFocusTarget {
  tabsetId: string
  tabId: string | null
}

export interface Point {
  x: number
  y: number
}

export interface Bounds extends Point {
  width: number
  height: number
}

export type ScreenPoint = Point

export function resolveInitialWorkspaceContentDockLocation(
  preferredGroup: 'active' | 'adjacent' | undefined,
  hasExplicitTarget: boolean,
): DockLocation {
  return hasExplicitTarget || preferredGroup !== 'adjacent'
    ? DockLocation.CENTER
    : DockLocation.RIGHT
}

export function flexLayoutTabButtonId(tabId: string): string {
  return `flexlayout-tabbutton-${tabId.replace(/\s/g, '_')}`
}

export function resolveFlexLayoutTabId(elementId: string, tabIds: string[]): string | undefined {
  return tabIds.find(tabId => flexLayoutTabButtonId(tabId) === elementId)
}

export function isPointOutsideBounds(point: Point, bounds: Bounds): boolean {
  return point.x < bounds.x
    || point.y < bounds.y
    || point.x >= bounds.x + bounds.width
    || point.y >= bounds.y + bounds.height
}

export function matchSavedPanelEntry(
  tabId: string,
  route: string | undefined,
  entries: PanelStackEntry[],
  claimedPanelIds: Set<string>,
): PanelStackEntry | undefined {
  const exact = entries.find(entry => entry.id === tabId && !claimedPanelIds.has(entry.id))
  if (exact) return exact
  if (!route) return undefined
  return entries.find(entry => entry.route === route && !claimedPanelIds.has(entry.id))
}

export function countCanvasPanelGroups(model: Model): number {
  return canvasPanelGroups(model).length
}

export function retargetWorkspaceTabs(model: Model, workspaceId: string, serverId: string): number {
  const tabs: TabNode[] = []
  model.visitNodes(node => {
    if (node instanceof TabNode) tabs.push(node)
  })

  let updated = 0
  for (const tab of tabs) {
    const config = tab.getConfig() as Record<string, unknown>
    if (config.workspaceId !== workspaceId || config.serverId === serverId) continue
    model.doAction(Actions.updateNodeAttributes(tab.getId(), {
      config: { ...config, serverId },
    }))
    updated++
  }
  return updated
}

export function resolveDockTabCloseAction(
  model: Model,
  tabId: string,
  protections: Record<string, DockTabProtection>,
): Action | undefined {
  const node = model.getNodeById(tabId)
  if (!(node instanceof TabNode)) return undefined
  if (isDockTabProtected(protections[tabId] ?? UNPROTECTED_DOCK_TAB)) return undefined

  const parent = node.getParent()
  if (
    parent instanceof TabSetNode
    && parent.getChildren().length === 1
    && countCanvasPanelGroups(model) > 1
  ) {
    return Actions.deleteTabset(parent.getId())
  }
  return Actions.deleteTab(tabId)
}

export function resolveDockTabProtection({
  persisted,
  dynamic,
  pinned,
  sessionRunning,
}: {
  persisted?: DockTabProtection
  dynamic?: Partial<DockTabProtection>
  pinned: boolean
  sessionRunning?: boolean
}): DockTabProtection {
  return {
    pinned: dynamic?.pinned ?? persisted?.pinned ?? pinned,
    dirty: dynamic?.dirty ?? persisted?.dirty ?? false,
    running: dynamic?.running ?? sessionRunning ?? persisted?.running ?? false,
    awaitingInput: dynamic?.awaitingInput ?? persisted?.awaitingInput ?? false,
  }
}

export function resolveCanvasFocusTarget(model: Model): CanvasFocusTarget | undefined {
  const groups = canvasPanelGroups(model)
  if (groups.length === 0) return undefined

  const activeGroup = model.getActiveTabset()
  const orderedGroups = activeGroup && groups.includes(activeGroup)
    ? [activeGroup, ...groups.filter(group => group !== activeGroup)]
    : groups

  for (const group of orderedGroups) {
    const selected = group.getSelectedNode()
    if (selected instanceof TabNode && isConversationTab(selected)) {
      return { tabsetId: group.getId(), tabId: selected.getId() }
    }
    const conversation = group.getChildren().find(
      child => child instanceof TabNode && isConversationTab(child),
    )
    if (conversation instanceof TabNode) {
      return { tabsetId: group.getId(), tabId: conversation.getId() }
    }
  }

  const fallbackGroup = activeGroup && groups.includes(activeGroup) ? activeGroup : groups[0]
  const selected = fallbackGroup.getSelectedNode()
  const fallbackTab = selected instanceof TabNode
    ? selected
    : fallbackGroup.getChildren().find(child => child instanceof TabNode)
  return {
    tabsetId: fallbackGroup.getId(),
    tabId: fallbackTab instanceof TabNode ? fallbackTab.getId() : null,
  }
}

function canvasPanelGroups(model: Model): TabSetNode[] {
  const groups: TabSetNode[] = []
  model.visitNodes(node => {
    if (
      node instanceof TabSetNode
      && node.getChildren().some(child => child instanceof TabNode)
    ) groups.push(node)
  })
  return groups
}

function isConversationTab(node: TabNode): boolean {
  const config = node.getConfig() as {
    contentKind?: string
    route?: PanelStackEntry['route']
  } | undefined
  return config?.contentKind === 'conversation'
    || (config?.route !== undefined && getPanelTypeFromRoute(config.route) === 'session')
}
