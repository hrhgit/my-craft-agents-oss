export interface LayoutGeometryPlacement {
  parentId?: string
  parentPath: number[]
  parentChain?: Array<{ id?: string; index: number; weight?: number }>
  index: number
  beforeGroupId?: string
  afterGroupId?: string
  weight?: number
}

interface GeometryNode {
  type?: string
  id?: string
  weight?: number
  children?: GeometryNode[]
  [key: string]: unknown
}

interface FlexLayoutGeometry {
  layout: GeometryNode
  [key: string]: unknown
}

export interface GeometryContentTab {
  id: string
  title: string
  groupId: string
  ref: {
    kind: string
    serverId: string
    workspaceId: string
    sessionId?: string
    resourceId?: string
  }
  protection: { pinned: boolean; dirty: boolean; running: boolean; awaitingInput: boolean }
  instancePolicy: 'singleton' | 'multiple'
  allowDetach: boolean
  minWidth?: number
  minHeight?: number
}

export function captureLayoutGeometryPlacement(
  geometry: unknown,
  groupId: string,
): LayoutGeometryPlacement | undefined {
  const flex = asFlexLayoutGeometry(geometry)
  if (!flex) return undefined

  let found: LayoutGeometryPlacement | undefined
  visitRows(flex.layout, [], (row, path) => {
    if (found) return
    const index = row.children?.findIndex(child => child.type === 'tabset' && child.id === groupId) ?? -1
    if (index < 0) return
    const child = row.children![index]
    found = {
      parentPath: path,
      parentChain: geometryParentChain(flex.layout, path),
      index,
      ...(row.id ? { parentId: row.id } : {}),
      ...(nearestGroupId(row.children![index - 1], 'last') ? {
        beforeGroupId: nearestGroupId(row.children![index - 1], 'last'),
      } : {}),
      ...(nearestGroupId(row.children![index + 1], 'first') ? {
        afterGroupId: nearestGroupId(row.children![index + 1], 'first'),
      } : {}),
      ...(typeof child.weight === 'number' ? { weight: child.weight } : {}),
    }
  })
  return found
}

export function mergeRedockedTabGeometry(args: {
  primaryGeometry: unknown
  auxiliaryGeometry: unknown
  sourceGroupId: string
  sourceTabIds: string[]
  returningSourceGroupId?: string
  sourceAuxiliaryIndex: number
  auxiliaryGroupIds: string[]
  returningTabIds: string[]
  groups: Record<string, { id: string; tabIds: string[]; activeTabId: string | null }>
  tabs: Record<string, GeometryContentTab>
  placement?: LayoutGeometryPlacement
}): unknown {
  const primary = cloneFlexLayoutGeometry(args.primaryGeometry)
  if (!primary) return args.primaryGeometry
  const auxiliary = asFlexLayoutGeometry(args.auxiliaryGeometry)
  const sourceFound = findGroup(primary.layout, args.sourceGroupId)
  const placement = sourceFound
    ? placementForFoundGroup(primary.layout, sourceFound)
    : args.placement
  const slotWeight = sourceFound?.node.weight ?? placement?.weight
  const returningSet = new Set(args.returningTabIds)
  const source = sourceFound
    ? structuredClone(sourceFound.node)
    : createGroupNode(args.sourceGroupId, args.sourceTabIds
        .filter(tabId => !returningSet.has(tabId))
        .flatMap(tabId => {
          const node = createTabNode(args.tabs[tabId])
          return node ? [node] : []
        }))
  source.id = args.sourceGroupId
  source.children ??= []
  source.children = source.children.filter(child => !child.id || !returningSet.has(child.id))

  const auxiliarySource = auxiliary && args.returningSourceGroupId
    ? findGroup(auxiliary.layout, args.returningSourceGroupId)?.node
    : undefined
  const returning = new Map<string, GeometryNode>()
  if (auxiliarySource) collectTabs(auxiliarySource, returningSet, returning)
  mergeTabsIntoSource(source, args.sourceTabIds, args.returningTabIds, returning, args.tabs)
  if (typeof auxiliarySource?.weight === 'number') source.weight = auxiliarySource.weight

  const auxiliaryGroupSet = new Set(args.auxiliaryGroupIds)
  const extractedRoot = auxiliary
    ? extractAuxiliaryRoot(auxiliary.layout, auxiliaryGroupSet, args.returningSourceGroupId, source)
    : null
  const root = extractedRoot ?? { type: 'row', children: [] }
  root.children ??= []
  if (!args.returningSourceGroupId) {
    insertGroupAtTraversalIndex(root, source, args.sourceAuxiliaryIndex)
  }
  const presentGroupIds = new Set<string>()
  collectGroupIds(root, presentGroupIds)
  for (const groupId of args.auxiliaryGroupIds) {
    if (groupId === args.returningSourceGroupId || presentGroupIds.has(groupId)) continue
    const group = args.groups[groupId]
    if (!group) continue
    root.children.push(createGroupNode(groupId, group.tabIds.flatMap(tabId => {
      const node = createTabNode(args.tabs[tabId])
      return node ? [node] : []
    }), group.activeTabId))
  }
  if (!containsGroupId(root, args.sourceGroupId)) {
    insertGroupAtTraversalIndex(root, source, args.sourceAuxiliaryIndex)
  }

  removeGroups(primary.layout, new Set([args.sourceGroupId, ...args.auxiliaryGroupIds]))
  graftAuxiliaryRoot(primary.layout, root, placement, slotWeight)
  return primary
}

export function mergeRedockedGroupGeometry(args: {
  primaryGeometry: unknown
  auxiliaryGeometry: unknown
  groupIds: string[]
  groups: Record<string, { id: string; tabIds: string[]; activeTabId: string | null }>
  tabs: Record<string, GeometryContentTab>
  placement?: LayoutGeometryPlacement
}): unknown {
  const primary = cloneFlexLayoutGeometry(args.primaryGeometry)
  if (!primary) return args.primaryGeometry
  const groupIds = new Set(args.groupIds)
  const existing = args.groupIds.map(groupId => findGroup(primary.layout, groupId)).find(Boolean)
  const placement = existing
    ? placementForFoundGroup(primary.layout, existing!)
    : args.placement
  removeGroups(primary.layout, groupIds)

  const auxiliary = asFlexLayoutGeometry(args.auxiliaryGeometry)
  const nodes = auxiliary
    ? extractGroupNodes(auxiliary.layout, groupIds)
    : []
  const returningNodes = nodes.length > 0
    ? nodes
    : args.groupIds.flatMap(groupId => {
        const group = args.groups[groupId]
        if (!group) return []
        return [createGroupNode(groupId, group.tabIds.flatMap(tabId => {
          const node = createTabNode(args.tabs[tabId])
          return node ? [node] : []
        }), group.activeTabId)]
      })
  if (returningNodes.length === 0) return primary
  if (typeof placement?.weight === 'number' && returningNodes.length === 1) {
    returningNodes[0].weight = placement.weight
  }
  insertGeometryNodes(primary.layout, returningNodes, placement)
  return primary
}

function asFlexLayoutGeometry(value: unknown): FlexLayoutGeometry | null {
  if (!isRecord(value) || !isRecord(value.layout) || value.layout.type !== 'row') return null
  return value as FlexLayoutGeometry
}

function cloneFlexLayoutGeometry(value: unknown): FlexLayoutGeometry | null {
  const geometry = asFlexLayoutGeometry(value)
  return geometry ? structuredClone(geometry) : null
}

function visitRows(
  row: GeometryNode,
  path: number[],
  visitor: (row: GeometryNode, path: number[]) => void,
): void {
  visitor(row, path)
  for (let index = 0; index < (row.children?.length ?? 0); index += 1) {
    const child = row.children![index]
    if (child.type === 'row') visitRows(child, [...path, index], visitor)
  }
}

function nearestGroupId(node: GeometryNode | undefined, edge: 'first' | 'last'): string | undefined {
  if (!node) return undefined
  if (node.type === 'tabset') return node.id
  const children = edge === 'first' ? node.children : [...(node.children ?? [])].reverse()
  for (const child of children ?? []) {
    const id = nearestGroupId(child, edge)
    if (id) return id
  }
  return undefined
}

function findGroup(
  row: GeometryNode,
  groupId: string,
): { node: GeometryNode; parent: GeometryNode; index: number; path: number[] } | undefined {
  let found: { node: GeometryNode; parent: GeometryNode; index: number; path: number[] } | undefined
  visitRows(row, [], (parent, path) => {
    if (found) return
    const index = parent.children?.findIndex(child => child.type === 'tabset' && child.id === groupId) ?? -1
    if (index >= 0) found = { node: parent.children![index], parent, index, path }
  })
  return found
}

function placementForFoundGroup(root: GeometryNode, found: {
  node: GeometryNode
  parent: GeometryNode
  index: number
  path: number[]
}): LayoutGeometryPlacement {
  return {
    parentPath: found.path,
    parentChain: geometryParentChain(root, found.path),
    index: found.index,
    ...(found.parent.id ? { parentId: found.parent.id } : {}),
    ...(typeof found.node.weight === 'number' ? { weight: found.node.weight } : {}),
  }
}

function mergeTabsIntoSource(
  source: GeometryNode,
  canonicalTabIds: string[],
  returningTabIds: string[],
  returning: Map<string, GeometryNode>,
  tabs: Record<string, GeometryContentTab>,
): void {
  source.children ??= []
  for (const tabId of returningTabIds) {
    const tabNode = returning.get(tabId) ?? createTabNode(tabs[tabId])
    if (!tabNode) continue
    const canonicalIndex = canonicalTabIds.indexOf(tabId)
    const afterId = canonicalTabIds.slice(canonicalIndex + 1).find(id =>
      source.children!.some(child => child.id === id))
    const beforeId = canonicalTabIds.slice(0, Math.max(canonicalIndex, 0)).reverse().find(id =>
      source.children!.some(child => child.id === id))
    const insertAt = afterId
      ? source.children.findIndex(child => child.id === afterId)
      : beforeId
        ? source.children.findIndex(child => child.id === beforeId) + 1
        : Math.min(Math.max(canonicalIndex, 0), source.children.length)
    source.children.splice(insertAt, 0, tabNode)
  }
  const activeIndex = source.children.findIndex(child => child.id === returningTabIds[0])
  if (activeIndex >= 0) source.selected = activeIndex
}

function extractAuxiliaryRoot(
  root: GeometryNode,
  groupIds: Set<string>,
  returningSourceGroupId: string | undefined,
  sourceReplacement: GeometryNode,
): GeometryNode | null {
  const prune = (node: GeometryNode): GeometryNode | null => {
    if (node.type === 'tabset') {
      if (!node.id || !groupIds.has(node.id)) return null
      return node.id === returningSourceGroupId
        ? structuredClone(sourceReplacement)
        : structuredClone(node)
    }
    if (node.type !== 'row') return null
    const children = (node.children ?? []).flatMap(child => {
      const kept = prune(child)
      return kept ? [kept] : []
    })
    if (children.length === 0) return null
    return { ...structuredClone(node), children }
  }
  return prune(root)
}

function collectGroupIds(node: GeometryNode, result: Set<string>): void {
  if (node.type === 'tabset' && node.id) result.add(node.id)
  for (const child of node.children ?? []) collectGroupIds(child, result)
}

function containsGroupId(node: GeometryNode, groupId: string): boolean {
  if (node.type === 'tabset') return node.id === groupId
  return node.children?.some(child => containsGroupId(child, groupId)) ?? false
}

function insertGroupAtTraversalIndex(root: GeometryNode, group: GeometryNode, requestedIndex: number): void {
  const groups: Array<{ parent: GeometryNode; index: number }> = []
  const collect = (row: GeometryNode) => {
    for (let index = 0; index < (row.children?.length ?? 0); index += 1) {
      const child = row.children![index]
      if (child.type === 'tabset') groups.push({ parent: row, index })
      else if (child.type === 'row') collect(child)
    }
  }
  collect(root)
  const insertionIndex = Math.min(Math.max(requestedIndex, 0), groups.length)
  const anchor = groups[insertionIndex] ?? groups[groups.length - 1]
  if (!anchor) {
    root.children ??= []
    root.children.push(group)
    return
  }
  anchor.parent.children ??= []
  anchor.parent.children.splice(
    insertionIndex < groups.length ? anchor.index : anchor.index + 1,
    0,
    group,
  )
}

function graftAuxiliaryRoot(
  primaryRoot: GeometryNode,
  auxiliaryRoot: GeometryNode,
  placement: LayoutGeometryPlacement | undefined,
  slotWeight: number | undefined,
): void {
  const target = resolveInsertionParent(primaryRoot, placement)
  const children = structuredClone(auxiliaryRoot.children ?? [])
  if (children.length === 0) return
  const targetDepth = findRowDepth(primaryRoot, target.parent) ?? placement?.parentPath.length ?? 0
  const needsOrientationWrapper = targetDepth % 2 === 1
    && (children.length > 1 || children[0]?.type === 'row')
  let inserted: GeometryNode[]
  if (needsOrientationWrapper) {
    inserted = [{
      type: 'row',
      children,
      ...(typeof slotWeight === 'number' ? { weight: slotWeight } : {}),
    }]
  } else {
    scaleNodesToSlotWeight(children, slotWeight)
    inserted = children
  }
  target.parent.children ??= []
  target.parent.children.splice(target.index, 0, ...inserted)
}

function findRowDepth(root: GeometryNode, target: GeometryNode, depth = 0): number | undefined {
  if (root === target) return depth
  for (const child of root.children ?? []) {
    if (child.type !== 'row') continue
    const found = findRowDepth(child, target, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function scaleNodesToSlotWeight(nodes: GeometryNode[], slotWeight: number | undefined): void {
  if (typeof slotWeight !== 'number' || nodes.length === 0) return
  const weights = nodes.map(node => typeof node.weight === 'number' && node.weight > 0
    ? node.weight
    : 100 / nodes.length)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  for (let index = 0; index < nodes.length; index += 1) {
    nodes[index].weight = slotWeight * weights[index] / total
  }
}

function resolveInsertionParent(
  root: GeometryNode,
  placement?: LayoutGeometryPlacement,
): { parent: GeometryNode; index: number } {
  if (placement?.afterGroupId) {
    const after = findGroup(root, placement.afterGroupId)
    if (after) return { parent: after.parent, index: after.index }
  }
  if (placement?.beforeGroupId) {
    const before = findGroup(root, placement.beforeGroupId)
    if (before) return { parent: before.parent, index: before.index + 1 }
  }
  if (placement?.parentId) {
    let matching: GeometryNode | undefined
    visitRows(root, [], row => {
      if (!matching && row.id === placement.parentId) matching = row
    })
    if (matching) return {
      parent: matching,
      index: Math.min(Math.max(placement.index, 0), matching.children?.length ?? 0),
    }
  }
  if (placement?.parentChain?.length) {
    let parent = root
    for (const segment of placement.parentChain) {
      parent.children ??= []
      let child = segment.id
        ? parent.children.find(candidate => candidate.type === 'row' && candidate.id === segment.id)
        : parent.children[segment.index]?.type === 'row'
          ? parent.children[segment.index]
          : undefined
      if (!child) {
        child = {
          type: 'row',
          children: [],
          ...(segment.id ? { id: segment.id } : {}),
          ...(typeof segment.weight === 'number' ? { weight: segment.weight } : {}),
        }
        parent.children.splice(Math.min(Math.max(segment.index, 0), parent.children.length), 0, child)
      }
      parent = child
    }
    return {
      parent,
      index: Math.min(Math.max(placement.index, 0), parent.children?.length ?? 0),
    }
  }
  let parent = root
  for (const index of placement?.parentPath ?? []) {
    const child = parent.children?.[index]
    if (!child || child.type !== 'row') {
      parent = root
      break
    }
    parent = child
  }
  return {
    parent,
    index: Math.min(Math.max(placement?.index ?? parent.children?.length ?? 0, 0), parent.children?.length ?? 0),
  }
}

function geometryParentChain(
  root: GeometryNode,
  path: number[],
): Array<{ id?: string; index: number; weight?: number }> {
  const chain: Array<{ id?: string; index: number; weight?: number }> = []
  let parent = root
  for (const index of path) {
    const child = parent.children?.[index]
    if (!child || child.type !== 'row') break
    chain.push({
      index,
      ...(child.id ? { id: child.id } : {}),
      ...(typeof child.weight === 'number' ? { weight: child.weight } : {}),
    })
    parent = child
  }
  return chain
}

function insertGeometryNodes(
  root: GeometryNode,
  nodes: GeometryNode[],
  placement?: LayoutGeometryPlacement,
): void {
  const target = resolveInsertionParent(root, placement)
  target.parent.children ??= []
  target.parent.children.splice(target.index, 0, ...nodes)
}

function collectTabs(node: GeometryNode, ids: Set<string>, result: Map<string, GeometryNode>): void {
  if (node.type === 'tab' && node.id && ids.has(node.id)) result.set(node.id, structuredClone(node))
  for (const child of node.children ?? []) collectTabs(child, ids, result)
}

function removeTabs(node: GeometryNode, ids: Set<string>): void {
  if (node.type === 'tabset' && node.children) {
    node.children = node.children.filter(child => !child.id || !ids.has(child.id))
  }
  for (const child of node.children ?? []) removeTabs(child, ids)
}

function removeGroups(row: GeometryNode, ids: Set<string>): void {
  if (!row.children) return
  row.children = row.children.filter(child => child.type !== 'tabset' || !child.id || !ids.has(child.id))
  for (const child of row.children) if (child.type === 'row') removeGroups(child, ids)
  row.children = row.children.filter(child => child.type !== 'row' || (child.children?.length ?? 0) > 0)
}

function extractGroupNodes(root: GeometryNode, ids: Set<string>): GeometryNode[] {
  const prune = (node: GeometryNode): GeometryNode | null => {
    if (node.type === 'tabset') return node.id && ids.has(node.id) ? structuredClone(node) : null
    if (node.type !== 'row') return null
    const children = (node.children ?? []).flatMap(child => {
      const kept = prune(child)
      return kept ? [kept] : []
    })
    if (children.length === 0) return null
    return { ...structuredClone(node), children }
  }
  return (root.children ?? []).flatMap(child => {
    const kept = prune(child)
    return kept ? [kept] : []
  })
}

function createGroupNode(groupId: string, children: GeometryNode[], activeTabId?: string | null): GeometryNode {
  const selected = activeTabId ? children.findIndex(child => child.id === activeTabId) : -1
  return {
    type: 'tabset',
    id: groupId,
    children,
    ...(selected >= 0 ? { selected } : {}),
  }
}

function createTabNode(tab: GeometryContentTab | undefined): GeometryNode | null {
  if (!tab) return null
  const workspaceContent = ['file', 'browser', 'extension'].includes(tab.ref.kind)
  return {
    type: 'tab',
    id: tab.id,
    name: tab.title,
    component: 'mortise-content',
    config: {
      ...(workspaceContent ? {} : { route: tab.ref.resourceId }),
      serverId: tab.ref.serverId,
      workspaceId: tab.ref.workspaceId,
      contentKind: tab.ref.kind,
      resourceId: tab.ref.resourceId,
      sessionId: tab.ref.sessionId,
      source: workspaceContent ? 'workspace-content' : 'panel',
      instancePolicy: tab.instancePolicy,
      protection: tab.protection,
      allowDetach: tab.allowDetach,
    },
    enablePopout: false,
    enableDrag: true,
    enableClose: !Object.values(tab.protection).some(Boolean),
    minWidth: tab.minWidth ?? 280,
    minHeight: tab.minHeight ?? 220,
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
