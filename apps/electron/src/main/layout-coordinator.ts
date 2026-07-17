import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  assertSingleWorkspaceLayout,
  createDefaultAppLayout,
  detachContentTab,
  detachPanelGroup,
  redockLayoutWindow,
  restoreLayoutForStartup,
  sanitizeAppLayout,
  type AppLayout,
  type ContentRef,
  type LayoutWindow,
} from '../shared/app-layout'

export interface LayoutCoordinatorOptions {
  storagePath?: string
  authorizeContentRef?: (ref: ContentRef) => boolean
  resolveServerId?: (workspaceId: string) => string | undefined
  onChanged?: (layout: AppLayout) => void
}

export class LayoutCoordinator {
  readonly storagePath: string
  private readonly layouts: Map<string, AppLayout>
  private changedHandler: ((layout: AppLayout) => void) | undefined
  private needsPersistAfterLoad = false

  constructor(private readonly options: LayoutCoordinatorOptions = {}) {
    this.storagePath = options.storagePath
      ?? join(process.env.CRAFT_CONFIG_DIR || join(homedir(), '.craft-agent'), 'app-layout.v1.json')
    this.layouts = this.loadFromDisk()
    this.changedHandler = options.onChanged
    if (this.needsPersistAfterLoad) this.persist()
  }

  setChangedHandler(handler: (layout: AppLayout) => void): void {
    this.changedHandler = handler
  }

  getSnapshot(workspaceId = '', serverId?: string): AppLayout {
    const configuredServerId = this.options.resolveServerId?.(workspaceId)
    if (configuredServerId && serverId && configuredServerId !== serverId) {
      throw new Error(`Layout server mismatch for workspace ${workspaceId}`)
    }
    const trustedServerId = configuredServerId ?? serverId
    const current = this.requireLayout(workspaceId, trustedServerId ?? 'local')
    if (!trustedServerId || layoutUsesServer(current, trustedServerId)) return structuredClone(current)

    const rebound = rebindLayoutServer(current, trustedServerId)
    this.assertAuthorized(rebound)
    this.layouts.set(workspaceId, rebound)
    this.persist()
    this.changedHandler?.(structuredClone(rebound))
    return structuredClone(rebound)
  }

  saveSnapshot(input: unknown, expectedRevision?: number): AppLayout {
    assertInputWorkspaceRefs(input)
    const sanitized = this.normalizeTrustedServer(sanitizeAppLayout(input))
    assertSingleWorkspaceLayout(sanitized)
    const current = this.requireLayout(sanitized.workspaceId, firstServerId(sanitized))
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new Error(`Layout revision conflict: expected ${expectedRevision}, current ${current.revision}`)
    }
    this.assertAuthorized(sanitized)
    const saved = { ...sanitized, revision: Math.max(current.revision, sanitized.revision) + 1 }
    this.layouts.set(saved.workspaceId, saved)
    this.persist()
    this.changedHandler?.(structuredClone(saved))
    return structuredClone(saved)
  }

  /**
   * Merge one renderer window's local layout view into the workspace snapshot.
   * The renderer serializes its visible model as a primary window; the trusted
   * caller window id determines which canonical window is replaced.
   */
  saveWindowSnapshot(layoutWindowId: string, input: unknown, expectedRevision?: number): AppLayout {
    assertInputWorkspaceRefs(input)
    const view = this.normalizeTrustedServer(sanitizeWindowView(input))
    assertSingleWorkspaceLayout(view)
    const current = this.requireLayout(view.workspaceId, firstServerId(view))
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new Error(`Layout revision conflict: expected ${expectedRevision}, current ${current.revision}`)
    }
    if (!current.windows[layoutWindowId]) {
      throw new Error(`Layout window is not registered: ${layoutWindowId}`)
    }
    this.assertAuthorized(view)

    const merged = mergeWindowView(current, layoutWindowId, view)
    assertSingleWorkspaceLayout(merged)
    this.assertAuthorized(merged)
    const saved = { ...merged, revision: Math.max(current.revision, view.revision) + 1 }
    this.layouts.set(saved.workspaceId, saved)
    this.persist()
    this.changedHandler?.(structuredClone(saved))
    return structuredClone(saved)
  }

  detachGroup(workspaceId: string, groupId: string, windowId: string, bounds?: LayoutWindow['bounds']): AppLayout {
    const current = this.requireLayout(workspaceId)
    const next = detachPanelGroup(current, groupId, windowId, bounds)
    if (next === current) throw new Error(`Panel group cannot be detached: ${groupId}`)
    this.layouts.set(workspaceId, next)
    this.persist()
    this.changedHandler?.(structuredClone(next))
    return structuredClone(next)
  }

  detachTab(workspaceId: string, tabId: string, windowId: string, bounds?: LayoutWindow['bounds']): AppLayout {
    const current = this.requireLayout(workspaceId)
    const next = detachContentTab(current, tabId, windowId, bounds)
    if (next === current) throw new Error(`Content tab cannot be detached: ${tabId}`)
    this.layouts.set(workspaceId, next)
    this.persist()
    this.changedHandler?.(structuredClone(next))
    return structuredClone(next)
  }

  redockWindow(windowId: string, workspaceId?: string): AppLayout | null {
    const entry = workspaceId
      ? [workspaceId, this.requireLayout(workspaceId)] as const
      : [...this.layouts.entries()].find(([, layout]) => Boolean(layout.windows[windowId]))
    if (!entry) return null
    const [ownerWorkspaceId, current] = entry
    const next = redockLayoutWindow(current, windowId)
    if (next === current) return structuredClone(current)
    this.layouts.set(ownerWorkspaceId, next)
    this.persist()
    this.changedHandler?.(structuredClone(next))
    return structuredClone(next)
  }

  private loadFromDisk(): Map<string, AppLayout> {
    const layouts = new Map<string, AppLayout>()
    if (!existsSync(this.storagePath)) return layouts
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.storagePath, 'utf8'))
    } catch {
      return layouts
    }

    const candidates = isPersistedLayoutCollection(parsed)
      ? Object.entries(parsed.layouts)
      : [[undefined, parsed] as const]
    for (const [persistedWorkspaceId, candidate] of candidates) {
      try {
        if (!isLayoutCandidate(candidate)) {
          this.needsPersistAfterLoad = true
          continue
        }
        const sanitized = sanitizeAppLayout(candidate)
        if (Object.values(sanitized.windows).some(window => window.kind === 'auxiliary')) {
          this.needsPersistAfterLoad = true
        }
        let restored = restoreLayoutForStartup(sanitized)
        assertSingleWorkspaceLayout(restored)
        if (persistedWorkspaceId !== undefined && restored.workspaceId !== persistedWorkspaceId) {
          this.needsPersistAfterLoad = true
          continue
        }
        const configuredServerId = this.options.resolveServerId?.(restored.workspaceId)
        if (configuredServerId && !layoutUsesServer(restored, configuredServerId)) {
          restored = rebindLayoutServer(restored, configuredServerId)
          this.needsPersistAfterLoad = true
        }
        this.assertAuthorized(restored)
        layouts.set(restored.workspaceId, restored)
      } catch {
        // One deleted, unauthorized, or corrupt workspace must not prevent the
        // remaining independent workspace layouts from being recovered.
        this.needsPersistAfterLoad = true
      }
    }
    return layouts
  }

  private requireLayout(workspaceId: string, serverId = 'local'): AppLayout {
    const existing = this.layouts.get(workspaceId)
    if (existing) return existing
    const created = createDefaultAppLayout({ serverId, workspaceId })
    this.layouts.set(workspaceId, created)
    return created
  }

  private assertAuthorized(layout: AppLayout): void {
    if (!this.options.authorizeContentRef) return
    for (const tab of Object.values(layout.tabs)) {
      if (!this.options.authorizeContentRef(tab.ref)) {
        throw new Error(`Unauthorized content route for tab ${tab.id}`)
      }
    }
  }

  private normalizeTrustedServer(layout: AppLayout): AppLayout {
    const configuredServerId = this.options.resolveServerId?.(layout.workspaceId)
    return configuredServerId && !layoutUsesServer(layout, configuredServerId)
      ? rebindLayoutServer(layout, configuredServerId)
      : layout
  }

  private persist(): void {
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const tempPath = `${this.storagePath}.${process.pid}.tmp`
    const payload = {
      version: 1,
      layouts: Object.fromEntries(this.layouts),
    }
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tempPath, this.storagePath)
  }
}

function firstServerId(layout: AppLayout): string {
  return Object.values(layout.tabs)[0]?.ref.serverId ?? 'local'
}

function sanitizeWindowView(input: unknown): AppLayout {
  const sanitized = sanitizeAppLayout(input)
  if (!isRecord(input) || !isRecord(input.tabs) || Object.keys(input.tabs).length > 0) return sanitized

  // An empty window is a valid local view after its last tab is closed. The
  // full-layout sanitizer intentionally creates a default tab for an empty
  // application, so preserve the explicit empty-window meaning here.
  return {
    ...sanitized,
    tabs: {},
    groups: {},
    windows: {
      primary: { id: 'primary', kind: 'primary', groupIds: [] },
    },
    focusedTabId: null,
  }
}

function mergeWindowView(current: AppLayout, layoutWindowId: string, view: AppLayout): AppLayout {
  if (current.workspaceId !== view.workspaceId) {
    throw new Error(`Layout workspace mismatch: expected ${current.workspaceId}, received ${view.workspaceId}`)
  }
  const target = current.windows[layoutWindowId]
  if (!target) throw new Error(`Layout window is not registered: ${layoutWindowId}`)

  const incomingGroupIds = view.windows.primary?.groupIds ?? []
  const incomingGroupIdSet = new Set(incomingGroupIds)
  const protectedSourceGroupIds = new Set(Object.values(current.windows).flatMap(window =>
    window.id !== layoutWindowId
      && window.kind === 'auxiliary'
      && window.sourceTabIndex !== undefined
      && window.sourceGroupId
      && target.groupIds.includes(window.sourceGroupId)
      && !incomingGroupIdSet.has(window.sourceGroupId)
      ? [window.sourceGroupId]
      : []
  ))
  const replacedGroupIds = new Set(target.groupIds.filter(groupId => !protectedSourceGroupIds.has(groupId)))

  const groups = Object.fromEntries(Object.entries(current.groups).filter(([groupId]) => !replacedGroupIds.has(groupId)))
  const tabs = Object.fromEntries(Object.entries(current.tabs).filter(([, tab]) => !replacedGroupIds.has(tab.groupId)))

  for (const groupId of incomingGroupIds) {
    const group = view.groups[groupId]
    if (!group) continue
    if (groups[groupId] && !protectedSourceGroupIds.has(groupId)) {
      throw new Error(`Layout group id is already owned by another window: ${groupId}`)
    }
    const tabIds: string[] = []
    for (const tabId of group.tabIds) {
      const tab = view.tabs[tabId]
      if (!tab) continue
      if (tabs[tabId] && tabs[tabId].groupId !== groupId) {
        throw new Error(`Layout tab id is already owned by another window: ${tabId}`)
      }
      tabs[tabId] = { ...tab, groupId }
      tabIds.push(tabId)
    }
    groups[groupId] = {
      ...group,
      windowId: layoutWindowId,
      tabIds,
      activeTabId: group.activeTabId && tabIds.includes(group.activeTabId)
        ? group.activeTabId
        : tabIds[0] ?? null,
    }
  }

  const groupIds = [
    ...incomingGroupIds.filter(groupId => Boolean(groups[groupId])),
    ...target.groupIds.filter(groupId => protectedSourceGroupIds.has(groupId)),
  ]
  let updatedTarget = target
  if (target.kind === 'auxiliary' && target.sourceTabIndex !== undefined) {
    const sourceTabGroupIndex = target.sourceTabId
      ? groupIds.findIndex(groupId => groups[groupId]?.tabIds.includes(target.sourceTabId!))
      : -1
    const anchoredGroupIndex = sourceTabGroupIndex >= 0
      ? sourceTabGroupIndex
      : target.sourceAuxiliaryGroupId
        ? groupIds.indexOf(target.sourceAuxiliaryGroupId)
        : -1
    if (anchoredGroupIndex >= 0) {
      updatedTarget = {
        ...target,
        sourceAuxiliaryGroupId: groupIds[anchoredGroupIndex],
        sourceAuxiliaryIndex: anchoredGroupIndex,
      }
    }
  }
  const windows = {
    ...current.windows,
    [layoutWindowId]: {
      ...updatedTarget,
      groupIds,
      geometry: view.geometry,
    },
  }
  const preferredFocusedTabId = layoutWindowId === 'primary'
    ? view.focusedTabId
    : current.focusedTabId
  const focusedTabId = preferredFocusedTabId && tabs[preferredFocusedTabId]
    ? preferredFocusedTabId
    : Object.keys(tabs)[0] ?? null

  return {
    ...current,
    geometry: layoutWindowId === 'primary' ? view.geometry : current.geometry,
    tabs,
    groups,
    windows,
    focusedTabId,
  }
}

function layoutUsesServer(layout: AppLayout, serverId: string): boolean {
  return Object.values(layout.tabs).every(tab => tab.ref.serverId === serverId)
}

function rebindLayoutServer(layout: AppLayout, serverId: string): AppLayout {
  const tabs = Object.fromEntries(Object.entries(layout.tabs).map(([tabId, tab]) => [
    tabId,
    { ...tab, ref: { ...tab.ref, serverId } },
  ]))
  const windows = Object.fromEntries(Object.entries(layout.windows).map(([windowId, window]) => [
    windowId,
    window.geometry === undefined ? window : { ...window, geometry: rewriteServerIds(window.geometry, serverId) },
  ]))
  return {
    ...layout,
    revision: layout.revision + 1,
    geometry: rewriteServerIds(layout.geometry, serverId),
    tabs,
    windows,
  }
}

function rewriteServerIds(value: unknown, serverId: string): unknown {
  if (Array.isArray(value)) return value.map(item => rewriteServerIds(item, serverId))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === 'serverId' && typeof item === 'string' ? serverId : rewriteServerIds(item, serverId),
  ]))
}

function isPersistedLayoutCollection(value: unknown): value is { version: 1; layouts: Record<string, unknown> } {
  return typeof value === 'object'
    && value !== null
    && 'layouts' in value
    && typeof (value as { layouts?: unknown }).layouts === 'object'
    && (value as { layouts?: unknown }).layouts !== null
}

function isLayoutCandidate(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.version === 1
    && typeof value.workspaceId === 'string'
    && isRecord(value.tabs)
    && isRecord(value.groups)
    && isRecord(value.windows)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertInputWorkspaceRefs(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  const candidate = value as { workspaceId?: unknown; tabs?: unknown }
  if (typeof candidate.workspaceId !== 'string' || typeof candidate.tabs !== 'object' || candidate.tabs === null) return
  for (const [tabId, rawTab] of Object.entries(candidate.tabs as Record<string, unknown>)) {
    if (typeof rawTab !== 'object' || rawTab === null) continue
    const ref = (rawTab as { ref?: unknown }).ref
    if (typeof ref !== 'object' || ref === null) continue
    const tabWorkspaceId = (ref as { workspaceId?: unknown }).workspaceId
    if (tabWorkspaceId !== candidate.workspaceId) {
      throw new Error(`Layout cannot mix workspaces: tab ${tabId} belongs to ${String(tabWorkspaceId)}`)
    }
  }
}
