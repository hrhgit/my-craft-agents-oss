import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { atomicWriteFile } from '@mortise/shared/utils'
import { BackendSnapshotStore } from '@mortise/shared/storage'
import type { BackendType } from '@mortise/shared/protocol'
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
  backendType?: BackendType
  snapshotRoot?: string
  snapshotStore?: BackendSnapshotStore
  /** Explicit legacy collection path retained for focused tests and migration tooling. */
  storagePath?: string
  authorizeContentRef?: (ref: ContentRef) => boolean
  onChanged?: (layout: AppLayout) => void
  persistSnapshot?: (storagePath: string, contents: string) => Promise<void>
}

export interface LayoutPersistenceState {
  pendingRevisions: number
  writing: boolean
  failed: boolean
  highWaterRevisions: number
}

export class LayoutCoordinator {
  readonly storagePath: string
  readonly backendType: BackendType
  private readonly layouts: Map<string, AppLayout>
  private readonly legacyLayouts: Map<string, AppLayout>
  private readonly snapshotStore: BackendSnapshotStore | undefined
  private readonly collectionMode: boolean
  private changedHandler: ((layout: AppLayout) => void) | undefined
  private needsPersistAfterLoad = false
  private requestedPersistRevision = 0
  private durablePersistRevision = 0
  private highWaterRevisions = 0
  private persistenceLoop: Promise<void> | undefined
  private persistenceError: Error | undefined

  constructor(private readonly options: LayoutCoordinatorOptions = {}) {
    const configDirectory = process.env.MORTISE_CONFIG_DIR || join(homedir(), '.mortise')
    this.backendType = options.backendType ?? 'electron'
    this.collectionMode = options.storagePath !== undefined
    this.storagePath = options.storagePath ?? options.snapshotRoot ?? join(configDirectory, 'backend-snapshots')
    this.snapshotStore = this.collectionMode
      ? undefined
      : options.snapshotStore ?? new BackendSnapshotStore(this.storagePath)
    this.layouts = this.collectionMode ? this.loadCollectionFromDisk(this.storagePath) : new Map()
    this.legacyLayouts = !this.collectionMode && this.backendType === 'electron'
      ? this.loadCollectionFromDisk(join(configDirectory, 'app-layout.v1.json'))
      : new Map()
    this.changedHandler = options.onChanged
    if (this.needsPersistAfterLoad) this.requestPersist()
  }

  setChangedHandler(handler: (layout: AppLayout) => void): void {
    this.changedHandler = handler
  }

  getSnapshot(workspaceId = ''): AppLayout {
    return structuredClone(this.requireLayout(workspaceId))
  }

  saveSnapshot(input: unknown, expectedRevision?: number): AppLayout {
    assertInputWorkspaceRefs(input)
    const sanitized = sanitizeAppLayout(input)
    assertSingleWorkspaceLayout(sanitized)
    const current = this.requireLayout(sanitized.workspaceId)
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new Error(`Layout revision conflict: expected ${expectedRevision}, current ${current.revision}`)
    }
    this.assertAuthorized(sanitized)
    const saved = { ...sanitized, revision: Math.max(current.revision, sanitized.revision) + 1 }
    this.layouts.set(saved.workspaceId, saved)
    this.requestPersist()
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
    const view = sanitizeWindowView(input)
    assertSingleWorkspaceLayout(view)
    const current = this.requireLayout(view.workspaceId)
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
    this.requestPersist()
    this.changedHandler?.(structuredClone(saved))
    return structuredClone(saved)
  }

  detachGroup(workspaceId: string, groupId: string, windowId: string, bounds?: LayoutWindow['bounds']): AppLayout {
    const current = this.requireLayout(workspaceId)
    const next = detachPanelGroup(current, groupId, windowId, bounds)
    if (next === current) throw new Error(`Panel group cannot be detached: ${groupId}`)
    this.layouts.set(workspaceId, next)
    this.requestPersist()
    this.changedHandler?.(structuredClone(next))
    return structuredClone(next)
  }

  detachTab(workspaceId: string, tabId: string, windowId: string, bounds?: LayoutWindow['bounds']): AppLayout {
    const current = this.requireLayout(workspaceId)
    const next = detachContentTab(current, tabId, windowId, bounds)
    if (next === current) throw new Error(`Content tab cannot be detached: ${tabId}`)
    this.layouts.set(workspaceId, next)
    this.requestPersist()
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
    this.requestPersist()
    this.changedHandler?.(structuredClone(next))
    return structuredClone(next)
  }

  private loadCollectionFromDisk(storagePath: string): Map<string, AppLayout> {
    const layouts = new Map<string, AppLayout>()
    if (!existsSync(storagePath)) return layouts
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(storagePath, 'utf8'))
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

  private requireLayout(workspaceId: string): AppLayout {
    const existing = this.layouts.get(workspaceId)
    if (existing) return existing
    const persisted = this.snapshotStore?.read(
      { kind: 'layout', workspaceId, backendType: this.backendType },
      isLayoutCandidate,
    )
    if (persisted) {
      try {
        const sanitized = sanitizeAppLayout(persisted)
        const restored = restoreLayoutForStartup(sanitized)
        assertSingleWorkspaceLayout(restored)
        if (restored.workspaceId !== workspaceId) throw new Error('Layout workspace mismatch')
        this.assertAuthorized(restored)
        this.layouts.set(workspaceId, restored)
        if (Object.values(sanitized.windows).some(window => window.kind === 'auxiliary')) {
          this.requestPersist()
        }
        return restored
      } catch {
        // A corrupt or unauthorized snapshot is isolated to its Workspace.
      }
    }
    const legacy = this.legacyLayouts.get(workspaceId)
    if (legacy) {
      this.layouts.set(workspaceId, legacy)
      this.requestPersist()
      return legacy
    }
    const created = createDefaultAppLayout({ workspaceId })
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

  getPersistenceState(): LayoutPersistenceState {
    return {
      pendingRevisions: Math.max(0, this.requestedPersistRevision - this.durablePersistRevision),
      writing: this.persistenceLoop !== undefined,
      failed: this.persistenceError !== undefined,
      highWaterRevisions: this.highWaterRevisions,
    }
  }

  async flush(): Promise<void> {
    while (this.persistenceLoop) await this.persistenceLoop
    if (this.persistenceError) throw this.persistenceError
    if (this.durablePersistRevision < this.requestedPersistRevision) {
      this.ensurePersistenceLoop()
      return this.flush()
    }
  }

  private requestPersist(): void {
    this.requestedPersistRevision += 1
    this.highWaterRevisions = Math.max(
      this.highWaterRevisions,
      this.requestedPersistRevision - this.durablePersistRevision,
    )
    if (this.persistenceError) this.persistenceError = undefined
    this.ensurePersistenceLoop()
  }

  private ensurePersistenceLoop(): void {
    if (this.persistenceLoop || this.persistenceError) return
    this.persistenceLoop = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.drainPersistence())
      .catch(error => {
        this.persistenceError = error instanceof Error ? error : new Error(String(error))
      })
      .finally(() => {
        this.persistenceLoop = undefined
        if (!this.persistenceError && this.durablePersistRevision < this.requestedPersistRevision) {
          this.ensurePersistenceLoop()
        }
      })
  }

  private async drainPersistence(): Promise<void> {
    while (this.durablePersistRevision < this.requestedPersistRevision) {
      const targetRevision = this.requestedPersistRevision
      if (this.collectionMode) {
        const payload = {
          version: 1,
          layouts: Object.fromEntries(this.layouts),
        }
        const contents = `${JSON.stringify(payload, null, 2)}\n`
        await (this.options.persistSnapshot ?? atomicWriteFile)(this.storagePath, contents)
      } else if (this.snapshotStore) {
        await Promise.all([...this.layouts.entries()].map(([workspaceId, layout]) =>
          this.snapshotStore!.write(
            { kind: 'layout', workspaceId, backendType: this.backendType },
            layout,
            isLayoutCandidate,
          )))
      }
      this.durablePersistRevision = targetRevision
    }
  }
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

function isPersistedLayoutCollection(value: unknown): value is { version: 1; layouts: Record<string, unknown> } {
  return typeof value === 'object'
    && value !== null
    && 'layouts' in value
    && typeof (value as { layouts?: unknown }).layouts === 'object'
    && (value as { layouts?: unknown }).layouts !== null
}

function isLayoutCandidate(value: unknown): value is AppLayout {
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
