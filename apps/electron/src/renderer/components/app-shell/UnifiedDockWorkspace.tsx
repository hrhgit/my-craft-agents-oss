import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  Actions,
  DockLocation,
  Layout,
  Model,
  TabNode,
  TabSetNode,
  type Action,
  type IJsonModel,
  type IJsonTabSetNode,
} from 'flexlayout-react'
import {
  Maximize2,
  Minimize2,
  PictureInPicture2,
  Plus,
  Puzzle,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import 'flexlayout-react/style/combined.css'
import './unified-dock-workspace.css'
import {
  appendCompactDockBackControl,
  appendSelectedTabDetachControl,
  customizeDockTab,
} from './unified-dock-tab-chrome'
import { actionEntersCompactDockDetail } from './compact-dock-navigation'
import { handleBrowserHostDockNavigation } from './dock-host-navigation'
import {
  createNativeViewDragOcclusionController,
  resolveNativeViewDockDragTarget,
} from './native-view-drag-occlusion'
import {
  createCoordinatedLayoutSaveQueue,
  recoverCoordinatedLayoutRetryFailure,
  runAuthoritativeLayoutMutation,
  saveCoordinatedWindowLayout,
  shouldApplyCoordinatorRevision,
} from './coordinated-layout-client'
import {
  countCanvasPanelGroups,
  isPointOutsideBounds,
  matchSavedPanelEntry,
  resolveCanvasFocusTarget,
  resolveDockTabCloseAction,
  resolveDockTabProtection,
  resolveFlexLayoutTabId,
  resolveInitialWorkspaceContentDockLocation,
  retargetWorkspaceTabs,
  type Point,
  type ScreenPoint,
} from './unified-dock-model'
import {
  acknowledgeDockTabCloseRequestAtom,
  activeDockTabIdAtom,
  createPanelStackEntry,
  dockTabProtectionsAtom,
  dockTabCloseRequestAtom,
  emptyDockPageSessionRequestAtom,
  enterCompactDockDetailAtom,
  exitCompactDockDetailAtom,
  focusedPanelIdAtom,
  generateEmptyDockPageTabId,
  getPanelTypeFromRoute,
  panelStackAtom,
  parseSessionIdFromRoute,
  UNPROTECTED_DOCK_TAB,
  type DockTabProtection,
  type PanelStackEntry,
} from '@/atoms/panel-stack'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { parseRouteToNavigationState } from '../../../shared/route-parser'
import { routes } from '../../../shared/routes'
import { isWorkspacePanelRoute } from '@/contexts/navigation-surface'
import { AppShellProvider, useAppShellContext } from '@/context/AppShellContext'
import { WorkspaceElectronApiProvider } from '@/context/WorkspaceElectronApiContext'
import { MainContentPanel } from './MainContentPanel'
import {
  WorkbenchToolContent,
  WorkbenchToolPicker,
  usePersistedWorkbenchTool,
  useWorkbenchTools,
  type WorkbenchTool,
} from '@/components/right-workbench/RightWorkbench'
import { createDockGeometryStorage } from '@/lib/dock-geometry-storage'
import { createNewConversationDraftId } from '@/lib/new-conversation'
import { createInitialConversationRouteConsumer, resolveLivePanelRoute } from './initial-conversation-route'
import {
  isWorkspaceLayoutTransitioning,
  registerWorkspaceLayoutFlusher,
  waitForRendererCommit,
  type WorkspaceTransitionState,
} from '@/lib/workspace-transition'
import { flushWindowCloseState, registerWindowCloseFlusher } from '@/lib/window-close-flush'
import {
  APP_LAYOUT_VERSION,
  PRIMARY_LAYOUT_WINDOW_ID,
  createDefaultAppLayout,
  focusConversationRoute,
  type AppLayout,
  type ContentKind,
  type ContentTab,
  type PanelGroup,
} from '../../../shared/app-layout'

const MAIN_TABSET_ID = 'dock:main'
const CONTENT_COMPONENT = 'mortise-content'

interface DockTabConfig {
  route?: string
  serverId?: string
  workspaceId?: string
  contentKind?: ContentKind
  resourceId?: string
  sessionId?: string
  source?: 'panel' | 'workspace-content' | 'content-picker'
  instancePolicy?: 'singleton' | 'multiple'
  protection?: DockTabProtection
  allowDetach?: boolean
}

interface DragPosition {
  client: Point
  screen: ScreenPoint
}

interface PendingLayoutSave {
  handle: ReturnType<typeof setTimeout> | null
  scope: string
}

interface UnifiedDockWorkspaceProps {
  activeWorkspaceId: string | null
  workspaceTransition: WorkspaceTransitionState | null
  serverId: string
  sessionId?: string | null
  isLeadingChromeHidden: boolean
  canvasLayoutToggleRequest: number
  onCanvasLayoutFocusChange: (focused: boolean) => void
}

export function UnifiedDockWorkspace({
  activeWorkspaceId,
  workspaceTransition,
  serverId,
  sessionId,
  isLeadingChromeHidden,
  canvasLayoutToggleRequest,
  onCanvasLayoutFocusChange,
}: UnifiedDockWorkspaceProps) {
  const { t } = useTranslation()
  const { isCompactMode } = useAppShellContext()
  const store = useStore()
  const panelStack = useAtomValue(panelStackAtom)
  const focusedPanelId = useAtomValue(focusedPanelIdAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const emptyPageSessionRequest = useAtomValue(emptyDockPageSessionRequestAtom)
  const dockTabCloseRequest = useAtomValue(dockTabCloseRequestAtom)
  const setPanelStack = useSetAtom(panelStackAtom)
  const setFocusedPanelId = useSetAtom(focusedPanelIdAtom)
  const setActiveDockTabId = useSetAtom(activeDockTabIdAtom)
  const enterCompactDockDetail = useSetAtom(enterCompactDockDetailAtom)
  const exitCompactDockDetail = useSetAtom(exitCompactDockDetailAtom)
  const setDockTabProtections = useSetAtom(dockTabProtectionsAtom)
  const setEmptyPageSessionRequest = useSetAtom(emptyDockPageSessionRequestAtom)
  const acknowledgeDockTabCloseRequest = useSetAtom(acknowledgeDockTabCloseRequestAtom)
  const workbenchTools = useWorkbenchTools(sessionId, activeWorkspaceId, { syncBrowserRegistry: true })
  const layoutWindowId = React.useMemo(
    () => new URLSearchParams(window.location.search).get('layoutWindowId') ?? PRIMARY_LAYOUT_WINDOW_ID,
    [],
  )
  const layoutReadOnly = React.useMemo(
    () => new URLSearchParams(window.location.search).get('layoutReadOnly') === '1',
    [],
  )
  const workspaceLayoutTransitioning = isWorkspaceLayoutTransitioning(
    workspaceTransition,
    activeWorkspaceId,
  )
  const geometryStorageScope = `${activeWorkspaceId ?? 'no-workspace'}:${layoutWindowId}`
  const geometryStorage = React.useMemo(
    () => createDockGeometryStorage<IJsonModel | null>(geometryStorageScope, layoutWindowId),
    [geometryStorageScope, layoutWindowId],
  )
  const syncingFromAtoms = React.useRef(false)
  const dockRootRef = React.useRef<HTMLDivElement>(null)
  const initialPanelStack = React.useRef(panelStack)
  const savedGeometry = React.useRef(geometryStorage.read(null))
  const geometryRestored = React.useRef(savedGeometry.current == null || initialPanelStack.current.length > 0)
  const pendingRestoredModel = React.useRef<Model | null>(null)
  const initialConversationRoute = React.useRef(createInitialConversationRouteConsumer(window.location.search))

  const [model, setModel] = React.useState(() => {
    const fallback = createDockModel(initialPanelStack.current, serverId, activeWorkspaceId)
    const saved = savedGeometry.current
    if (!saved) return fallback
    if (initialPanelStack.current.length === 0) return fallback
    try {
      return Model.fromJson(sanitizeSavedGeometry(saved, initialPanelStack.current, serverId, activeWorkspaceId))
    } catch (error) {
      console.warn('[UnifiedDockWorkspace] Failed to restore layout geometry:', error)
      return fallback
    }
  })
  const coordinatorRevision = React.useRef<number | null>(null)
  const coordinatorReady = React.useRef(false)
  const coordinatorScope = JSON.stringify([activeWorkspaceId ?? '', serverId, layoutWindowId])
  const coordinatorScopeRef = React.useRef(coordinatorScope)
  const layoutSaveQueue = React.useRef(createCoordinatedLayoutSaveQueue())
  const saveTimer = React.useRef<PendingLayoutSave | null>(null)
  const suppressedModelFingerprint = React.useRef<string | null>(null)
  const handledCanvasLayoutToggleRequest = React.useRef(canvasLayoutToggleRequest)
  const draggedTab = React.useRef<{ tabId: string; position: DragPosition } | null>(null)
  const nativeViewDragOcclusion = React.useRef<ReturnType<typeof createNativeViewDragOcclusionController> | null>(null)
  if (!nativeViewDragOcclusion.current) {
    nativeViewDragOcclusion.current = createNativeViewDragOcclusionController()
  }
  const detachingTabIds = React.useRef(new Set<string>())
  const [dynamicProtections, setDynamicProtections] = React.useState<Record<string, Partial<DockTabProtection>>>({})
  const clearPendingLayoutSave = React.useCallback((scope?: string): boolean => {
    const pending = saveTimer.current
    if (!pending || (scope !== undefined && pending.scope !== scope)) return false
    if (pending.handle !== null) clearTimeout(pending.handle)
    saveTimer.current = null
    return true
  }, [])

  const applyCoordinatorSnapshot = React.useCallback((snapshot: AppLayout) => {
    if (workspaceLayoutTransitioning) return
    if (snapshot.workspaceId !== (activeWorkspaceId ?? '')) return
    if (!shouldApplyCoordinatorRevision(coordinatorRevision.current, snapshot.revision)) return
    const currentPanelStack = store.get(panelStackAtom)
    const currentFocusedPanelId = store.get(focusedPanelIdAtom)
    const currentActiveDockTabId = store.get(activeDockTabIdAtom)
    const focusedRoute = initialConversationRoute.current.consume()
      ?? resolveLivePanelRoute(currentPanelStack, currentActiveDockTabId, currentFocusedPanelId)
    const focusedState = focusedRoute ? parseRouteToNavigationState(focusedRoute) : null
    const effectiveSnapshot = focusedState?.navigator === 'sessions' && focusedState.details?.type === 'new'
      ? focusConversationRoute(snapshot, focusedRoute!)
      : snapshot
    coordinatorRevision.current = effectiveSnapshot.revision
    coordinatorReady.current = true
    const nextEntries = panelEntriesForWindow(effectiveSnapshot, layoutWindowId)
    if (
      layoutWindowId === PRIMARY_LAYOUT_WINDOW_ID
      && snapshot.geometry == null
      && nextEntries.length === 0
      && currentPanelStack.length > 0
    ) {
      const protections = buildDockTabProtections(model, sessionMetaMap, dynamicProtections)
      const seed = buildAppLayoutSnapshot(
        model,
        sessionMetaMap,
        serverId,
        activeWorkspaceId ?? '',
        effectiveSnapshot.revision,
        protections,
      )
      const seedScope = coordinatorScope
      void layoutSaveQueue.current.enqueue(async () => {
        const expectedRevision = coordinatorScopeRef.current === seedScope
          ? coordinatorRevision.current ?? effectiveSnapshot.revision
          : effectiveSnapshot.revision
        const saved = await window.electronAPI.saveAppLayout(
          { ...seed, revision: expectedRevision },
          expectedRevision,
        )
        if (
          coordinatorScopeRef.current === seedScope
          && shouldApplyCoordinatorRevision(coordinatorRevision.current, saved.revision)
        ) coordinatorRevision.current = saved.revision
        return saved
      })
        .catch(error => console.warn('[UnifiedDockWorkspace] Failed to seed coordinated layout:', error))
      return
    }
    const panelEntriesEqual = nextEntries.length === currentPanelStack.length
      && nextEntries.every((entry, index) => entry.id === currentPanelStack[index]?.id && entry.route === currentPanelStack[index]?.route)
    if (!panelEntriesEqual) setPanelStack(nextEntries)
    const panelIds = nextEntries.map(entry => entry.id)
    const focusedId = effectiveSnapshot.focusedTabId && panelIds.includes(effectiveSnapshot.focusedTabId)
      ? effectiveSnapshot.focusedTabId
      : panelIds[0] ?? null
    setFocusedPanelId(focusedId)
    const nextModel = createDockModelFromSnapshot(effectiveSnapshot, layoutWindowId)
    const nextFingerprint = dockModelFingerprint(nextModel)
    if (dockModelFingerprint(model) === nextFingerprint) return

    syncingFromAtoms.current = true
    suppressedModelFingerprint.current = nextFingerprint
    onCanvasLayoutFocusChange(Boolean(nextModel.getMaximizedTabset()))
    setModel(nextModel)
    queueMicrotask(() => { syncingFromAtoms.current = false })
  }, [activeWorkspaceId, coordinatorScope, dynamicProtections, layoutWindowId, model, onCanvasLayoutFocusChange, serverId, sessionMetaMap, setFocusedPanelId, setPanelStack, store, workspaceLayoutTransitioning])
  const applyCoordinatorSnapshotRef = React.useRef(applyCoordinatorSnapshot)
  React.useLayoutEffect(() => {
    applyCoordinatorSnapshotRef.current = applyCoordinatorSnapshot
  }, [applyCoordinatorSnapshot])

  React.useLayoutEffect(() => {
    const previousScope = coordinatorScopeRef.current
    if (previousScope !== coordinatorScope) clearPendingLayoutSave(previousScope)
    coordinatorScopeRef.current = coordinatorScope
    coordinatorRevision.current = null
    coordinatorReady.current = false
  }, [clearPendingLayoutSave, coordinatorScope])

  React.useEffect(() => {
    if (layoutReadOnly || workspaceLayoutTransitioning) return
    if (!window.electronAPI.isChannelAvailable('layout:get')) return
    let cancelled = false
    void window.electronAPI.getAppLayout(activeWorkspaceId ?? '', serverId).then(snapshot => {
      if (cancelled) return
      applyCoordinatorSnapshotRef.current(snapshot)
    }).catch(error => {
      console.warn('[UnifiedDockWorkspace] Layout coordinator unavailable:', error)
    })
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, layoutReadOnly, serverId, workspaceLayoutTransitioning])

  React.useEffect(() => {
    if (layoutReadOnly) return
    if (!window.electronAPI.isChannelAvailable('layout:changed')) return
    return window.electronAPI.onAppLayoutChanged(snapshot => {
      if (
        !workspaceLayoutTransitioning
        && snapshot.workspaceId === (activeWorkspaceId ?? '')
      ) applyCoordinatorSnapshotRef.current(snapshot)
    })
  }, [activeWorkspaceId, layoutReadOnly, workspaceLayoutTransitioning])

  const openToolTab = React.useCallback((tool: WorkbenchTool, targetTabsetId?: string) => {
    enterCompactDockDetail()
    const tabId = toolTabId(tool, activeWorkspaceId)
    const existing = model.getNodeById(tabId)
    if (existing instanceof TabNode) {
      model.doAction(Actions.selectTab(tabId))
    } else {
      const targetId = targetTabsetId
        ?? model.getActiveTabset()?.getId()
        ?? model.getFirstTabSet()?.getId()
        ?? MAIN_TABSET_ID
      const preferredGroup = tool.extension?.contribution.workspaceContent?.preferredGroup ?? 'active'
      const location = resolveInitialWorkspaceContentDockLocation(preferredGroup, Boolean(targetTabsetId))
      model.doAction(Actions.addTab(
        toJsonToolTab(tool, tabId, serverId, activeWorkspaceId, sessionId),
        targetId,
        location,
        -1,
        true,
      ))
    }
  }, [activeWorkspaceId, enterCompactDockDetail, model, serverId, sessionId])

  const openToolPickerTab = React.useCallback((targetTabsetId?: string) => {
    enterCompactDockDetail()
    const tabId = generateEmptyDockPageTabId()
    const targetId = targetTabsetId
      ?? model.getActiveTabset()?.getId()
      ?? model.getFirstTabSet()?.getId()
      ?? MAIN_TABSET_ID
    model.doAction(Actions.addTab(
      toJsonToolPickerTab(tabId, t('workbench.emptyPage'), activeWorkspaceId),
      targetId,
      targetTabsetId ? DockLocation.CENTER : DockLocation.RIGHT,
      -1,
      true,
    ))
  }, [activeWorkspaceId, enterCompactDockDetail, model, t])

  const replaceEmptyPageWithRoute = React.useCallback((tabId: string, route: PanelStackEntry['route']): boolean => {
    enterCompactDockDetail()
    const node = model.getNodeById(tabId)
    const config = node instanceof TabNode ? node.getConfig() as DockTabConfig : undefined
    if (!(node instanceof TabNode) || config?.source !== 'content-picker') return false
    const parent = node.getParent()
    if (!(parent instanceof TabSetNode)) return false

    const entry = createPanelStackEntry(route, 1)
    const index = parent.getChildren().indexOf(node)
    model.doAction(Actions.deleteTab(tabId))
    model.doAction(Actions.addTab(
      toJsonTab(entry, resolvePanelTitle(entry, sessionMetaMap, t), serverId, activeWorkspaceId),
      parent.getId(),
      DockLocation.CENTER,
      index,
      true,
    ))
    setActiveDockTabId(entry.id)
    return true
  }, [activeWorkspaceId, enterCompactDockDetail, model, serverId, sessionMetaMap, setActiveDockTabId, t])

  const replaceEmptyPageWithSession = React.useCallback((tabId: string, sessionId: string): boolean => (
    replaceEmptyPageWithRoute(tabId, routes.view.allSessions(sessionId) as PanelStackEntry['route'])
  ), [replaceEmptyPageWithRoute])

  React.useEffect(() => {
    if (!emptyPageSessionRequest) return
    replaceEmptyPageWithSession(emptyPageSessionRequest.tabId, emptyPageSessionRequest.sessionId)
    setEmptyPageSessionRequest(null)
  }, [emptyPageSessionRequest, replaceEmptyPageWithSession, setEmptyPageSessionRequest])

  // A remote reconnect may keep the workspace ID while changing its server URL.
  // Retarget every workspace-owned tab before its scoped API is used again.
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    retargetWorkspaceTabs(model, activeWorkspaceId, serverId)
  }, [activeWorkspaceId, model, serverId])

  React.useEffect(() => {
    if (workspaceLayoutTransitioning) return
    if (!geometryRestored.current && panelStack.length > 0 && savedGeometry.current) {
      try {
        const restored = Model.fromJson(sanitizeSavedGeometry(
          savedGeometry.current,
          panelStack,
          serverId,
          activeWorkspaceId,
        ), model)
        geometryRestored.current = true
        pendingRestoredModel.current = restored
        setModel(restored)
        return
      } catch (error) {
        console.warn('[UnifiedDockWorkspace] Failed to restore deferred layout geometry:', error)
        geometryRestored.current = true
      }
    }
    if (pendingRestoredModel.current === model) pendingRestoredModel.current = null
    syncingFromAtoms.current = true
    const panelIds = new Set(panelStack.map(entry => entry.id))
    const modelTabs = getPanelContentNodes(model)

    for (const node of modelTabs) {
      if (!panelIds.has(node.getId())) model.doAction(Actions.deleteTab(node.getId()))
    }

    const activeTabsetId = model.getActiveTabset()?.getId()
      ?? model.getFirstTabSet()?.getId()
      ?? MAIN_TABSET_ID
    for (const entry of panelStack) {
      const title = resolvePanelTitle(entry, sessionMetaMap, t)
      const existing = model.getNodeById(entry.id)
      if (!existing) {
        model.doAction(Actions.addTab(toJsonTab(entry, title, serverId, activeWorkspaceId), activeTabsetId, DockLocation.CENTER, -1, entry.id === focusedPanelId))
        continue
      }
      if (existing instanceof TabNode) {
        const config = existing.getConfig() as DockTabConfig
        const tabWorkspaceId = activeWorkspaceId || ''
        const normalizedTab = toJsonTab(entry, title, serverId, activeWorkspaceId)
        const normalizedConfig = {
          ...config,
          ...normalizedTab.config,
        } as DockTabConfig
        if (
          existing.getName() !== title
          || config.route !== normalizedConfig.route
          || config.serverId !== normalizedConfig.serverId
          || config.workspaceId !== tabWorkspaceId
          || config.contentKind !== normalizedConfig.contentKind
          || config.resourceId !== normalizedConfig.resourceId
          || config.source !== normalizedConfig.source
          || config.instancePolicy !== normalizedConfig.instancePolicy
        ) {
          model.doAction(Actions.updateNodeAttributes(entry.id, {
            name: title,
            config: normalizedConfig,
          }))
        }
      }
    }
    if (focusedPanelId && model.getNodeById(focusedPanelId)) {
      const node = model.getNodeById(focusedPanelId)
      if (node instanceof TabNode && !node.isSelected()) model.doAction(Actions.selectTab(focusedPanelId))
    }
    const activeNode = model.getActiveTabset()?.getSelectedNode()
    setActiveDockTabId(activeNode instanceof TabNode ? activeNode.getId() : null)
    syncingFromAtoms.current = false
  }, [activeWorkspaceId, focusedPanelId, model, panelStack, serverId, sessionMetaMap, setActiveDockTabId, t, workspaceLayoutTransitioning])

  React.useEffect(() => () => setActiveDockTabId(null), [setActiveDockTabId])

  React.useEffect(() => {
    if (pendingRestoredModel.current && pendingRestoredModel.current !== model) return
    if (handledCanvasLayoutToggleRequest.current === canvasLayoutToggleRequest) return
    handledCanvasLayoutToggleRequest.current = canvasLayoutToggleRequest

    const maximized = model.getMaximizedTabset()
    if (maximized) {
      model.doAction(Actions.maximizeToggle(maximized.getId()))
      onCanvasLayoutFocusChange(false)
      return
    }

    if (countCanvasPanelGroups(model) <= 1) {
      openToolPickerTab()
      return
    }

    const target = resolveCanvasFocusTarget(model)
    if (!target) return
    if (target.tabId) model.doAction(Actions.selectTab(target.tabId))
    model.doAction(Actions.maximizeToggle(target.tabsetId))
    onCanvasLayoutFocusChange(true)
  }, [canvasLayoutToggleRequest, model, onCanvasLayoutFocusChange, openToolPickerTab])

  React.useEffect(() => {
    onCanvasLayoutFocusChange(Boolean(model.getMaximizedTabset()))
  }, [model, onCanvasLayoutFocusChange])

  React.useEffect(() => window.electronAPI.browserPane.onHostDockNavigation(command => {
    handleBrowserHostDockNavigation(model, command, document)
  }), [model])

  React.useEffect(() => {
    const root = dockRootRef.current
    if (!root) return
    let disposed = false
    const apply = () => {
      if (!disposed) applyDockSemanticAttributes(root, model)
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'role'],
    })
    void waitForRendererCommit().then(() => {
      apply()
    })
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [model])

  const publishDockProtections = React.useCallback((targetModel: Model) => {
    const protections = buildDockTabProtections(targetModel, sessionMetaMap, dynamicProtections)
    setDockTabProtections(protections)
    for (const node of getContentNodes(targetModel)) {
      const protection = protections[node.getId()] ?? UNPROTECTED_DOCK_TAB
      const closeAllowed = !isProtectedContent(protection)
      const config = node.getConfig() as DockTabConfig
      if (
        node.isEnableClose() !== closeAllowed
        || !dockTabProtectionsEqual(config.protection, protection)
      ) {
        targetModel.doAction(Actions.updateNodeAttributes(node.getId(), {
          config: { ...config, protection },
          enableClose: closeAllowed,
        }))
      }
    }
    return protections
  }, [dynamicProtections, sessionMetaMap, setDockTabProtections])

  React.useEffect(() => {
    publishDockProtections(model)
  }, [model, publishDockProtections])

  React.useEffect(() => () => setDockTabProtections({}), [setDockTabProtections])

  const handleProtectionChange = React.useCallback((tabId: string, protection: { dirty: boolean }) => {
    setDynamicProtections(previous => {
      const current = previous[tabId]
      if (current?.dirty === protection.dirty) return previous
      return { ...previous, [tabId]: { ...current, dirty: protection.dirty } }
    })
  }, [])

  React.useEffect(() => {
    if (!dockTabCloseRequest) return
    if (!layoutReadOnly) {
      const protections = buildDockTabProtections(model, sessionMetaMap, dynamicProtections)
      const action = resolveDockTabCloseAction(model, dockTabCloseRequest.tabId, protections)
      if (action) model.doAction(action)
    }
    acknowledgeDockTabCloseRequest(dockTabCloseRequest.requestId)
  }, [
    acknowledgeDockTabCloseRequest,
    dockTabCloseRequest,
    dynamicProtections,
    layoutReadOnly,
    model,
    sessionMetaMap,
  ])

  const persistWindowModel = React.useCallback(async (changedModel: Model): Promise<AppLayout> => {
    const protections = buildDockTabProtections(changedModel, sessionMetaMap, dynamicProtections)
    const capturedRevision = coordinatorRevision.current ?? 0
    const capturedSnapshot = buildAppLayoutSnapshot(
      changedModel,
      sessionMetaMap,
      serverId,
      activeWorkspaceId ?? '',
      capturedRevision,
      protections,
    )
    const saveScope = coordinatorScope
    return layoutSaveQueue.current.enqueue(async () => {
      const expectedRevision = coordinatorScopeRef.current === saveScope
        ? coordinatorRevision.current ?? 0
        : capturedSnapshot.revision
      const saved = await saveCoordinatedWindowLayout({
        snapshot: { ...capturedSnapshot, revision: expectedRevision },
        expectedRevision,
        save: (next, revision) => window.electronAPI.saveAppLayout(next, revision),
        loadLatest: async () => {
          const latest = await window.electronAPI.getAppLayout(activeWorkspaceId ?? '', serverId)
          if (
            coordinatorScopeRef.current === saveScope
            && shouldApplyCoordinatorRevision(coordinatorRevision.current, latest.revision)
          ) coordinatorRevision.current = latest.revision
          return latest
        },
        onRetryFailure: (latest, retryError, firstError) => {
          recoverCoordinatedLayoutRetryFailure({
            currentScope: coordinatorScopeRef.current,
            saveScope,
            latest,
            clearPendingSave: () => { clearPendingLayoutSave(saveScope) },
            applyLatest: snapshot => applyCoordinatorSnapshotRef.current(snapshot),
          })
          console.warn('[UnifiedDockWorkspace] Failed to persist coordinated layout:', retryError, firstError)
        },
      })
      if (
        coordinatorScopeRef.current === saveScope
        && shouldApplyCoordinatorRevision(coordinatorRevision.current, saved.revision)
      ) coordinatorRevision.current = saved.revision
      return saved
    })
  }, [activeWorkspaceId, clearPendingLayoutSave, coordinatorScope, dynamicProtections, serverId, sessionMetaMap])

  const flushLayout = React.useCallback(async (force: boolean) => {
    const hadPendingSave = clearPendingLayoutSave(coordinatorScope)
    const saveAvailable = !layoutReadOnly && window.electronAPI.isChannelAvailable('layout:save')
    if (saveAvailable && (force || hadPendingSave)) await persistWindowModel(model)
    await layoutSaveQueue.current.flush()
  }, [clearPendingLayoutSave, coordinatorScope, layoutReadOnly, model, persistWindowModel])

  const flushPendingLayout = React.useCallback(
    () => flushLayout(false),
    [flushLayout],
  )

  const flushLayoutBeforeWorkspaceTransition = React.useCallback(
    () => flushLayout(true),
    [flushLayout],
  )

  React.useEffect(() => {
    if (layoutReadOnly || !activeWorkspaceId) return
    return registerWorkspaceLayoutFlusher(
      activeWorkspaceId,
      flushLayoutBeforeWorkspaceTransition,
    )
  }, [activeWorkspaceId, flushLayoutBeforeWorkspaceTransition, layoutReadOnly])

  React.useEffect(() => {
    const unregister = registerWindowCloseFlusher(flushPendingLayout)
    return () => {
      unregister()
      void flushPendingLayout().catch(error => {
        console.warn('[UnifiedDockWorkspace] Failed to flush coordinated layout:', error)
      })
    }
  }, [flushPendingLayout])

  const reconcileRegistryFromModel = React.useCallback((changedModel: Model) => {
    const nodes = getPanelContentNodes(changedModel)
    const byId = new Map(panelStack.map(entry => [entry.id, entry]))
    const next = nodes.flatMap(node => {
      const existing = byId.get(node.getId())
      const route = (node.getConfig() as DockTabConfig).route
      if (!route) return []
      if (existing) return [{ ...existing, route: route as PanelStackEntry['route'] }]
      return [{
        id: node.getId(),
        route: route as PanelStackEntry['route'],
        proportion: 1,
        panelType: getPanelTypeFromRoute(route as PanelStackEntry['route']),
        laneId: 'main' as const,
      }]
    })
    const same = next.length === panelStack.length && next.every((entry, index) => entry.id === panelStack[index]?.id && entry.route === panelStack[index]?.route)
    if (!same) setPanelStack(next)

    const activeNode = changedModel.getActiveTabset()?.getSelectedNode()
    setActiveDockTabId(activeNode instanceof TabNode ? activeNode.getId() : null)
    if (
      activeNode instanceof TabNode
      && activeNode.getComponent() === CONTENT_COMPONENT
      && !isWorkspaceContentNode(activeNode)
    ) {
      setFocusedPanelId(activeNode.getId())
    }
  }, [panelStack, setActiveDockTabId, setFocusedPanelId, setPanelStack])

  const handleModelChange = React.useCallback((changedModel: Model) => {
    queueMicrotask(() => applyDockSemanticAttributes(dockRootRef.current, changedModel))
    if (workspaceLayoutTransitioning) {
      publishDockProtections(changedModel)
      return
    }
    const fingerprint = dockModelFingerprint(changedModel)
    if (suppressedModelFingerprint.current === fingerprint) {
      suppressedModelFingerprint.current = null
      publishDockProtections(changedModel)
      return
    }
    geometryStorage.write(changedModel.toJson())
    if (!syncingFromAtoms.current) {
      onCanvasLayoutFocusChange(Boolean(changedModel.getMaximizedTabset()))
      reconcileRegistryFromModel(changedModel)
    }
    publishDockProtections(changedModel)

    if (!layoutReadOnly && coordinatorReady.current && window.electronAPI.isChannelAvailable('layout:save')) {
      clearPendingLayoutSave()
      const pending: PendingLayoutSave = {
        scope: coordinatorScope,
        handle: null,
      }
      pending.handle = setTimeout(() => {
        if (saveTimer.current !== pending) return
        saveTimer.current = null
        if (coordinatorScopeRef.current !== pending.scope) return
        void persistWindowModel(changedModel).catch(() => {
          // Window-local geometry remains available as a renderer fallback.
        })
      }, 120)
      saveTimer.current = pending
    }
  }, [clearPendingLayoutSave, coordinatorScope, geometryStorage, layoutReadOnly, onCanvasLayoutFocusChange, persistWindowModel, publishDockProtections, reconcileRegistryFromModel, workspaceLayoutTransitioning])

  const handleAction = React.useCallback((action: Action) => {
    if (actionEntersCompactDockDetail(model, action)) enterCompactDockDetail()
    if (action.type === Actions.POPOUT_TAB || action.type === Actions.POPOUT_TABSET) return undefined
    if ((layoutReadOnly || workspaceLayoutTransitioning) && (
      action.type === Actions.ADD_TAB
      || action.type === Actions.DELETE_TAB
      || action.type === Actions.DELETE_TABSET
      || action.type === Actions.MOVE_NODE
    )) return undefined
    if (action.type === Actions.DELETE_TAB) {
      const tabId = typeof action.data.node === 'string' ? action.data.node : null
      if (!tabId) return undefined
      const protections = buildDockTabProtections(model, sessionMetaMap, dynamicProtections)
      return resolveDockTabCloseAction(model, tabId, protections)
    }
    if (action.type === Actions.DELETE_TABSET) {
      const tabsetId = typeof action.data.node === 'string' ? action.data.node : null
      const tabset = tabsetId ? model.getNodeById(tabsetId) : undefined
      if (tabset instanceof TabSetNode) {
        const protections = buildDockTabProtections(model, sessionMetaMap, dynamicProtections)
        const containsProtectedTab = tabset.getChildren().some(child =>
          child instanceof TabNode && isProtectedContent(protections[child.getId()] ?? UNPROTECTED_DOCK_TAB))
        if (containsProtectedTab) return undefined
      }
    }
    return action
  }, [dynamicProtections, enterCompactDockDetail, layoutReadOnly, model, sessionMetaMap, workspaceLayoutTransitioning])

  const detachTab = React.useCallback(async (tabId: string, point?: ScreenPoint) => {
    if (
      layoutReadOnly
      ||
      workspaceLayoutTransitioning
      ||
      layoutWindowId !== PRIMARY_LAYOUT_WINDOW_ID
      || detachingTabIds.current.has(tabId)
      || !window.electronAPI.isChannelAvailable('layout:detachTab')
    ) return

    const node = model.getNodeById(tabId)
    const config = node instanceof TabNode ? node.getConfig() as DockTabConfig : undefined
    if (!(node instanceof TabNode) || config?.source === 'content-picker') return

    detachingTabIds.current.add(tabId)
    try {
      await flushWindowCloseState()
      clearPendingLayoutSave(coordinatorScope)
      await persistWindowModel(model)
      await runAuthoritativeLayoutMutation(
        () => window.electronAPI.detachLayoutTab(tabId, point ? detachedWindowBounds(point) : undefined),
        snapshot => applyCoordinatorSnapshotRef.current(snapshot),
      )
    } catch (error) {
      console.warn('[UnifiedDockWorkspace] Failed to detach tab:', error)
    } finally {
      detachingTabIds.current.delete(tabId)
    }
  }, [clearPendingLayoutSave, coordinatorScope, layoutReadOnly, layoutWindowId, model, persistWindowModel, workspaceLayoutTransitioning])

  const detachTabset = React.useCallback(async (node: TabSetNode) => {
    if (layoutReadOnly || workspaceLayoutTransitioning || layoutWindowId !== PRIMARY_LAYOUT_WINDOW_ID) return
    try {
      await flushWindowCloseState()
      clearPendingLayoutSave(coordinatorScope)
      await persistWindowModel(model)
      await runAuthoritativeLayoutMutation(
        () => window.electronAPI.detachLayoutGroup(node.getId()),
        snapshot => applyCoordinatorSnapshotRef.current(snapshot),
      )
    } catch (error) {
      console.warn('[UnifiedDockWorkspace] Failed to detach panel group:', error)
    }
  }, [clearPendingLayoutSave, coordinatorScope, layoutReadOnly, layoutWindowId, model, persistWindowModel, workspaceLayoutTransitioning])

  React.useEffect(() => {
    const controller = nativeViewDragOcclusion.current
    return () => controller?.dispose()
  }, [])

  const handleTabDragStartCapture = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    draggedTab.current = null
    const dragTarget = event.target instanceof Element
      ? resolveNativeViewDockDragTarget(
          event.target,
          getContentNodes(model).map(node => node.getId()),
        )
      : null
    if (!dragTarget) return
    nativeViewDragOcclusion.current?.begin(event.nativeEvent)
    if (dragTarget.kind !== 'tab' || layoutReadOnly || layoutWindowId !== PRIMARY_LAYOUT_WINDOW_ID) return
    const position = readDragPosition(event)
    if (!position) return
    draggedTab.current = { tabId: dragTarget.tabId, position }
  }, [layoutReadOnly, layoutWindowId, model])

  const handleTabDragCapture = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!draggedTab.current) return
    const position = readDragPosition(event)
    if (!position) return
    draggedTab.current.position = position
  }, [])

  const handleTabDragEndCapture = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    nativeViewDragOcclusion.current?.finish()
    const current = draggedTab.current
    draggedTab.current = null
    if (!current) return
    const position = readDragPosition(event) ?? current.position
    const canvasBounds = event.currentTarget.getBoundingClientRect()
    if (!isPointOutsideBounds(position.client, canvasBounds)) return
    void detachTab(current.tabId, position.screen)
  }, [detachTab])

  const handleDockDropCapture = React.useCallback(() => {
    nativeViewDragOcclusion.current?.finish()
  }, [])

  const factory = React.useCallback((node: TabNode) => {
    const config = node.getConfig() as DockTabConfig
    if (config.source === 'content-picker') {
      return (
        <DockEmptyPage
          tabId={node.getId()}
          tools={workbenchTools}
          onSelect={openToolTab}
          onOpenRoute={replaceEmptyPageWithRoute}
        />
      )
    }
    if (config.source === 'workspace-content') {
      const parent = node.getParent()
      const targetTabsetId = parent instanceof TabSetNode ? parent.getId() : undefined
      return (
        <DockedToolPanel
          tabId={node.getId()}
          resourceId={config.resourceId}
          title={node.getName()}
          sessionId={config.sessionId ?? sessionId}
          serverId={config.serverId || serverId}
          workspaceId={config.workspaceId || activeWorkspaceId || ''}
          onProtectionChange={handleProtectionChange}
          onOpenTool={tool => openToolTab(tool, targetTabsetId)}
        />
      )
    }
    return (
      <DockedContentPanel
        route={config.route}
        serverId={config.serverId || serverId}
        workspaceId={config.workspaceId}
        activeWorkspaceId={activeWorkspaceId}
        isLeadingChromeHidden={isLeadingChromeHidden}
        focused={node.getId() === focusedPanelId}
      />
    )
  }, [activeWorkspaceId, focusedPanelId, handleProtectionChange, isLeadingChromeHidden, openToolTab, replaceEmptyPageWithRoute, serverId, sessionId, workbenchTools])

  return (
    <div
      ref={dockRootRef}
      data-mortise-semantic-id="workspace.unified-dock"
      className="mortise-unified-dock flexlayout__theme_alpha_light h-full min-w-0 overflow-hidden"
      onDragStartCapture={handleTabDragStartCapture}
      onDragCapture={handleTabDragCapture}
      onDragEndCapture={handleTabDragEndCapture}
      onDropCapture={handleDockDropCapture}
    >
      <Layout
        model={model}
        factory={factory}
        keyMap={{
          focusTabToggle: 'F6',
          focusNextTabset: 'Ctrl+]',
          focusPreviousTabset: 'Ctrl+[',
        }}
        onAction={handleAction}
        supportsPopout={false}
        onModelChange={handleModelChange}
        icons={{
          close: <X className="size-3.5" />,
          maximize: <Maximize2 className="size-3.5" />,
          restore: <Minimize2 className="size-3.5" />,
        }}
        onRenderTab={customizeDockTab}
        onRenderTabSet={(node, renderValues) => {
          if (!(node instanceof TabSetNode)) return
          appendCompactDockBackControl(node, renderValues, {
            enabled: Boolean(isCompactMode),
            label: t('common.backToList'),
            onBack: exitCompactDockDetail,
          })
          if (layoutReadOnly) return
          appendSelectedTabDetachControl(node, renderValues, {
            enabled: layoutWindowId === PRIMARY_LAYOUT_WINDOW_ID
              && window.electronAPI.isChannelAvailable('layout:detachTab'),
            label: t('workbench.detachTab'),
            canDetach: selected => (selected.getConfig() as DockTabConfig).source !== 'content-picker',
            onDetach: tabId => void detachTab(tabId),
          })
          renderValues.buttons.push(
            <button
              key="new-session-tab"
              type="button"
              className="flexlayout__tab_toolbar_button"
              data-mortise-semantic-id={`workspace.new-tab.${node.getId()}`}
              title={t('workbench.emptyPage')}
              aria-label={t('workbench.emptyPage')}
              onClick={event => {
                event.stopPropagation()
                openToolPickerTab(node.getId())
              }}
            >
              <Plus className="size-3.5" />
            </button>,
          )
          if (
            layoutWindowId !== PRIMARY_LAYOUT_WINDOW_ID
            || getTabSetNodes(model).length <= 1
            || !window.electronAPI.isChannelAvailable('layout:detachGroup')
          ) return
          renderValues.buttons.push(
            <button
              key="detach"
              type="button"
              className="flexlayout__tab_toolbar_button"
              data-mortise-semantic-id={`workspace.detach-group.${node.getId()}`}
              title={t('workbench.detachPanelGroup')}
              aria-label={t('workbench.detachPanelGroup')}
              onClick={event => {
                event.stopPropagation()
                void detachTabset(node)
              }}
            >
              <PictureInPicture2 className="size-3.5" />
            </button>,
          )
        }}
      />
    </div>
  )
}

function DockEmptyPage({
  tabId,
  tools,
  onSelect,
  onOpenRoute,
}: {
  tabId: string
  tools: WorkbenchTool[]
  onSelect: (tool: WorkbenchTool) => void
  onOpenRoute: (tabId: string, route: PanelStackEntry['route']) => boolean
}) {
  const { t } = useTranslation()
  const openNewConversation = React.useCallback(() => {
    onOpenRoute(
      tabId,
      routes.view.newConversation(createNewConversationDraftId()) as PanelStackEntry['route'],
    )
  }, [onOpenRoute, tabId])

  return (
    <WorkbenchToolPicker
      tools={tools}
      onSelect={onSelect}
      label={t('workbench.emptyPage')}
      semanticId="workspace.empty-page"
      semanticScope={tabId}
      onCreateSession={openNewConversation}
    />
  )
}

function DockedToolPanel({
  tabId,
  resourceId,
  title,
  sessionId,
  serverId,
  workspaceId,
  onProtectionChange,
  onOpenTool,
}: {
  tabId: string
  resourceId?: string
  title: string
  sessionId?: string | null
  serverId: string
  workspaceId: string
  onProtectionChange: (tabId: string, protection: { dirty: boolean }) => void
  onOpenTool: (tool: WorkbenchTool) => void
}) {
  const tool = usePersistedWorkbenchTool({ resourceId, sessionId, workspaceId })
  if (tool) {
    return (
      <WorkspaceElectronApiProvider route={{ serverId, workspaceId }}>
        <div data-mortise-semantic-id={`workspace.content.${tool.id}`} className="h-full min-h-0 bg-background">
          <WorkbenchToolContent
            tool={tool}
            sessionId={sessionId}
            workspaceId={workspaceId}
            onProtectionChange={protection => onProtectionChange(tabId, protection)}
            onOpenTool={onOpenTool}
          />
        </div>
      </WorkspaceElectronApiProvider>
    )
  }
  return (
    <div className="flex h-full items-center justify-center bg-background text-muted-foreground" aria-label={title}>
      <Puzzle className="size-5 opacity-50" />
    </div>
  )
}

function DockedContentPanel({
  route,
  serverId,
  workspaceId,
  activeWorkspaceId,
  isLeadingChromeHidden,
  focused,
}: {
  route?: string
  serverId: string
  workspaceId?: string
  activeWorkspaceId: string | null
  isLeadingChromeHidden: boolean
  focused: boolean
}) {
  const navState = route ? parseRouteToNavigationState(route) : null
  const tabWorkspaceId = workspaceId || activeWorkspaceId || ''
  return (
    <WorkspaceElectronApiProvider route={{ serverId, workspaceId: tabWorkspaceId }}>
      <DockedContentRuntime
        navState={navState}
        workspaceId={tabWorkspaceId}
        activeWorkspaceId={activeWorkspaceId}
        isLeadingChromeHidden={isLeadingChromeHidden}
        focused={focused}
      />
    </WorkspaceElectronApiProvider>
  )
}

function DockedContentRuntime({
  navState,
  workspaceId,
  activeWorkspaceId,
  isLeadingChromeHidden,
  focused,
}: {
  navState: ReturnType<typeof parseRouteToNavigationState>
  workspaceId: string
  activeWorkspaceId: string | null
  isLeadingChromeHidden: boolean
  focused: boolean
}) {
  const parentContext = useAppShellContext()
  const isCrossWorkspace = !!workspaceId && !!activeWorkspaceId && workspaceId !== activeWorkspaceId
  const context = React.useMemo(() => ({
      ...parentContext,
      panelHeaderTrailingAction: null,
      leadingAction: undefined,
      isFocusedPanel: focused,
  }), [focused, parentContext])

  if (isCrossWorkspace) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-center">
        <div className="max-w-sm">
          <h2 className="text-sm font-medium text-foreground">This tab belongs to another workspace</h2>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Switch workspaces to open it. A window layout cannot mix workspace-owned content.
          </p>
        </div>
      </div>
    )
  }

  return (
    <AppShellProvider value={context}>
      <MainContentPanel
        navStateOverride={navState}
        isLeadingChromeHidden={isLeadingChromeHidden}
        className="rounded-none shadow-none"
      />
    </AppShellProvider>
  )
}

function createDockModel(entries: PanelStackEntry[], serverId: string, workspaceId: string | null): Model {
  return Model.fromJson({
    global: {
      enableEdgeDock: true,
      enableEdgeDockIndicators: true,
      tabEnableDrag: true,
      tabEnableClose: true,
      tabEnablePopout: false,
      tabEnablePopoutIcon: false,
      tabEnableRename: false,
      tabEnableRenderOnDemand: true,
      tabSetEnableDivide: true,
      tabSetEnableDrag: true,
      tabSetEnableDrop: true,
      tabSetEnableMaximize: true,
      tabSetMinWidth: 280,
      tabSetMinHeight: 220,
    },
    borders: [],
    layout: {
      type: 'row',
      id: 'dock:root',
      children: [{
        type: 'tabset',
        id: MAIN_TABSET_ID,
        active: true,
        enableDeleteWhenEmpty: false,
        children: entries.map(entry => toJsonTab(entry, entry.route, serverId, workspaceId)),
      }],
    },
  })
}

function createDockModelFromSnapshot(snapshot: AppLayout, windowId: string): Model {
  const windowGeometry = windowId === PRIMARY_LAYOUT_WINDOW_ID
    ? snapshot.geometry
    : snapshot.windows[windowId]?.geometry
  if (windowGeometry && typeof windowGeometry === 'object') {
    try {
      return Model.fromJson(sanitizeSavedGeometry(
        windowGeometry as IJsonModel,
        panelEntriesForWindow(snapshot, windowId),
        snapshot.tabs[snapshot.focusedTabId ?? '']?.ref.serverId ?? 'local',
        snapshot.tabs[snapshot.focusedTabId ?? '']?.ref.workspaceId ?? '',
        new Set(contentTabIdsForWindow(snapshot, windowId)),
        snapshot.tabs,
      ))
    } catch (error) {
      console.warn('[UnifiedDockWorkspace] Failed to restore coordinated geometry:', error)
    }
  }
  const layoutWindow = snapshot.windows[windowId] ?? snapshot.windows[PRIMARY_LAYOUT_WINDOW_ID]
  const rootGroups = layoutWindow.groupIds
    .map(groupId => snapshot.groups[groupId])
    .filter((group): group is PanelGroup => !!group)
    .map(group => ({
      ...group,
      tabIds: group.tabIds.filter(tabId => snapshot.tabs[tabId]?.ref.resourceId !== 'workspace-content-picker'),
    }))
    .filter(group => group.tabIds.length > 0)

  const modelJson: IJsonModel = {
    global: {
      enableEdgeDock: true,
      enableEdgeDockIndicators: true,
      tabEnableDrag: true,
      tabEnableClose: true,
      tabEnablePopout: false,
      tabEnablePopoutIcon: false,
      tabEnableRename: false,
      tabEnableRenderOnDemand: true,
      tabSetEnableDivide: true,
      tabSetEnableDrag: true,
      tabSetEnableDrop: true,
      tabSetEnableMaximize: true,
      tabSetMinWidth: 280,
      tabSetMinHeight: 220,
    },
    borders: [],
    layout: {
      type: 'row',
      id: 'dock:root',
      children: rootGroups.length > 0
        ? rootGroups.map((group, index) => ({
            type: 'tabset',
            id: group.id,
            active: group.tabIds.includes(snapshot.focusedTabId ?? ''),
            selected: group.activeTabId ? Math.max(0, group.tabIds.indexOf(group.activeTabId)) : 0,
            enableDeleteWhenEmpty: index !== 0,
            weight: 100 / rootGroups.length,
            children: group.tabIds.flatMap(tabId => {
              const tab = snapshot.tabs[tabId]
              return tab ? [jsonTabFromContent(tab)] : []
            }),
          }))
        : [{ type: 'tabset', id: MAIN_TABSET_ID, enableDeleteWhenEmpty: false, children: [] }],
    },
  }
  return Model.fromJson(modelJson)
}

function jsonTabFromContent(tab: ContentTab) {
  const source = isWorkspaceContentKind(tab.ref.kind) ? 'workspace-content' : 'panel'
  return {
    type: 'tab',
    id: tab.id,
    name: tab.title,
    component: CONTENT_COMPONENT,
    config: {
      route: source === 'panel' ? tab.ref.resourceId : undefined,
      serverId: tab.ref.serverId,
      workspaceId: tab.ref.workspaceId,
      contentKind: tab.ref.kind,
      resourceId: tab.ref.resourceId,
      sessionId: tab.ref.sessionId,
      source,
      instancePolicy: tab.instancePolicy,
      protection: tab.protection,
      allowDetach: tab.allowDetach,
    },
    enablePopout: false,
    enableDrag: true,
    enableClose: !isProtectedContent(tab.protection),
    minWidth: tab.minWidth ?? 280,
    minHeight: tab.minHeight ?? 220,
  }
}

function panelEntriesForWindow(snapshot: AppLayout, windowId: string): PanelStackEntry[] {
  const layoutWindow = snapshot.windows[windowId] ?? snapshot.windows[PRIMARY_LAYOUT_WINDOW_ID]
  const tabs = layoutWindow.groupIds.flatMap(groupId => snapshot.groups[groupId]?.tabIds ?? [])
    .map(tabId => snapshot.tabs[tabId])
    .filter((tab): tab is ContentTab => Boolean(
      tab
      && tab.ref.resourceId
      && isWorkspacePanelRoute(tab.ref.resourceId)
    ))
  const proportion = tabs.length > 0 ? 1 / tabs.length : 1
  return tabs.map(tab => ({
    id: tab.id,
    route: tab.ref.resourceId as PanelStackEntry['route'],
    proportion,
    panelType: getPanelTypeFromRoute(tab.ref.resourceId as PanelStackEntry['route']),
    laneId: 'main',
  }))
}

function contentTabIdsForWindow(snapshot: AppLayout, windowId: string): string[] {
  const layoutWindow = snapshot.windows[windowId] ?? snapshot.windows[PRIMARY_LAYOUT_WINDOW_ID]
  return layoutWindow.groupIds.flatMap(groupId => snapshot.groups[groupId]?.tabIds ?? [])
    .filter(tabId => snapshot.tabs[tabId]?.ref.resourceId !== 'workspace-content-picker')
}

function sanitizeSavedGeometry(
  saved: IJsonModel,
  entries: PanelStackEntry[],
  serverId: string,
  workspaceId: string | null,
  allowedTabIds?: Set<string>,
  canonicalTabs?: Record<string, ContentTab>,
): IJsonModel {
  const claimedPanelIds = new Set<string>()
  const next = structuredClone(saved)
  next.global = {
    ...next.global,
    tabEnablePopout: false,
    tabEnablePopoutIcon: false,
    tabEnableRenderOnDemand: true,
  }
  delete next.subLayouts
  delete next.popouts
  next.borders = []

  const isValidTab = (tab: any): boolean => {
    if (typeof tab?.id !== 'string') return false
    const config = tab.config as DockTabConfig | undefined
    const entry = matchSavedPanelEntry(tab.id, config?.route, entries, claimedPanelIds)
    if (entry) {
      if (allowedTabIds && !allowedTabIds.has(entry.id)) return false
      claimedPanelIds.add(entry.id)
      const canonical = canonicalTabs?.[entry.id]
      if (canonical) {
        Object.assign(tab, jsonTabFromContent(canonical))
      } else {
        const normalized = toJsonTab(
          entry,
          typeof tab.name === 'string' ? tab.name : entry.route,
          serverId,
          workspaceId,
        )
        normalized.config = { ...config, ...normalized.config }
        Object.assign(tab, normalized)
      }
      return true
    }
    const validWorkspaceContent = tab.component === CONTENT_COMPONENT
      && config?.source === 'workspace-content'
      && isWorkspaceContentKind(config.contentKind)
      && typeof config.resourceId === 'string'
      && config.workspaceId === (workspaceId ?? '')
      && (!allowedTabIds || allowedTabIds.has(tab.id))
    if (!validWorkspaceContent) return false
    const canonical = canonicalTabs?.[tab.id]
    if (canonical) Object.assign(tab, jsonTabFromContent(canonical))
    return true
  }

  const cleanRow = (row: IJsonModel['layout']): void => {
    if (!row.children) return
    for (const child of row.children) {
      if (child.type === 'row') cleanRow(child)
      else if (child.children) child.children = child.children.filter(isValidTab)
    }
    row.children = row.children.filter(child => (child.children?.length ?? 0) > 0)
  }
  cleanRow(next.layout)

  const present = new Set<string>()
  const collect = (row: IJsonModel['layout']): void => {
    for (const child of row.children ?? []) {
      if (child.type === 'row') collect(child)
      else for (const tab of child.children ?? []) if (typeof tab.id === 'string') present.add(tab.id)
    }
  }
  collect(next.layout)
  let firstTabset: IJsonTabSetNode | null = null
  const findFirst = (row: IJsonModel['layout']): void => {
    for (const child of row.children ?? []) {
      if (child.type === 'row') findFirst(child)
      else {
        const tabset = child as IJsonTabSetNode
        if (!firstTabset) {
          firstTabset = tabset
          tabset.enableDeleteWhenEmpty = false
        } else {
          tabset.enableDeleteWhenEmpty = true
        }
      }
    }
  }
  findFirst(next.layout)
  const resolvedFirstTabset = firstTabset as IJsonTabSetNode | null
  if (!resolvedFirstTabset) return createDockModel(entries, serverId, workspaceId).toJson()
  resolvedFirstTabset.children ??= []
  for (const entry of entries) {
    if (!present.has(entry.id)) resolvedFirstTabset.children.push(toJsonTab(entry, entry.route, serverId, workspaceId))
  }
  return next
}

function toJsonTab(entry: PanelStackEntry, name: string, serverId: string, workspaceId: string | null) {
  return {
    type: 'tab',
    id: entry.id,
    name,
    component: CONTENT_COMPONENT,
    config: {
      route: entry.route,
      serverId,
      workspaceId: workspaceId ?? '',
      contentKind: contentKindForPanel(entry),
      resourceId: entry.route,
      source: 'panel',
      instancePolicy: 'multiple',
    },
    enablePopout: false,
    enableDrag: true,
    enableClose: true,
    minWidth: 280,
    minHeight: 220,
  }
}

function toJsonToolTab(
  tool: WorkbenchTool,
  id: string,
  serverId: string,
  workspaceId: string | null,
  sessionId?: string | null,
) {
  const contentKind: ContentKind = tool.id === 'files'
    ? 'file'
    : tool.id === 'browser' || tool.browserInstanceId
      ? 'browser'
      : 'extension'
  const instancePolicy = tool.browserInstanceId
    ? 'multiple'
    : tool.extension?.contribution.workspaceContent?.instancePolicy ?? 'singleton'
  return {
    type: 'tab',
    id,
    name: tool.label,
    component: CONTENT_COMPONENT,
    config: {
      serverId,
      workspaceId: workspaceId ?? '',
      contentKind,
      resourceId: tool.id,
      sessionId: tool.id === 'files' ? undefined : tool.extension?.sessionId ?? sessionId ?? undefined,
      source: 'workspace-content',
      instancePolicy,
    },
    enablePopout: false,
    enableDrag: true,
    enableClose: true,
    minWidth: 280,
    minHeight: 220,
  }
}

function toJsonToolPickerTab(id: string, title: string, workspaceId: string | null) {
  return {
    type: 'tab',
    id,
    name: title,
    component: CONTENT_COMPONENT,
    config: {
      workspaceId: workspaceId ?? '',
      contentKind: 'tool',
      resourceId: 'workspace-content-picker',
      source: 'content-picker',
    },
    enablePopout: false,
    enableDrag: true,
    enableClose: true,
    minWidth: 280,
    minHeight: 220,
  }
}

function toolTabId(tool: WorkbenchTool, workspaceId: string | null): string {
  const scope = workspaceId
  return `dock:content:${encodeURIComponent(tool.id)}:${encodeURIComponent(scope ?? 'global')}`
}

function getContentNodes(model: Model): TabNode[] {
  const nodes: TabNode[] = []
  model.visitNodes(node => {
    if (node instanceof TabNode && node.getComponent() === CONTENT_COMPONENT) nodes.push(node)
  })
  return nodes
}

function getTabSetNodes(model: Model): TabSetNode[] {
  const nodes: TabSetNode[] = []
  model.visitNodes(node => {
    if (node instanceof TabSetNode) nodes.push(node)
  })
  return nodes
}

function getPanelContentNodes(model: Model): TabNode[] {
  return getContentNodes(model).filter(node => !isAuxiliaryContentNode(node))
}

function isWorkspaceContentNode(node: TabNode): boolean {
  return (node.getConfig() as DockTabConfig).source === 'workspace-content'
}

function isAuxiliaryContentNode(node: TabNode): boolean {
  const source = (node.getConfig() as DockTabConfig).source
  return source === 'workspace-content' || source === 'content-picker'
}

function isWorkspaceContentKind(kind: ContentKind | undefined): kind is 'file' | 'browser' | 'extension' {
  return kind === 'file' || kind === 'browser' || kind === 'extension'
}

function buildDockTabProtections(
  model: Model,
  sessions: Map<string, { isProcessing?: boolean }>,
  dynamic: Record<string, Partial<DockTabProtection>>,
): Record<string, DockTabProtection> {
  const protections: Record<string, DockTabProtection> = {}
  for (const node of getContentNodes(model)) {
    const config = node.getConfig() as DockTabConfig
    const sessionId = config.sessionId
      ?? (config.route ? parseSessionIdFromRoute(config.route as PanelStackEntry['route']) : null)
    const runtime = dynamic[node.getId()] ?? {}
    protections[node.getId()] = resolveDockTabProtection({
      persisted: config.protection,
      dynamic: runtime,
      pinned: node.isPinned(),
      ...(sessionId ? { sessionRunning: sessions.get(sessionId)?.isProcessing === true } : {}),
    })
  }
  return protections
}

function dockTabProtectionsEqual(
  left: DockTabProtection | undefined,
  right: DockTabProtection,
): boolean {
  return left?.pinned === right.pinned
    && left.dirty === right.dirty
    && left.running === right.running
    && left.awaitingInput === right.awaitingInput
}

function isProtectedContent(protection: DockTabProtection): boolean {
  return protection.pinned || protection.dirty || protection.running || protection.awaitingInput
}

function dockModelFingerprint(model: Model): string {
  return JSON.stringify(model.toJson())
}

function applyDockSemanticAttributes(root: HTMLElement | null, model: Model): void {
  if (!root) return
  const contentIds = getContentNodes(model).map(node => node.getId())
  root.querySelectorAll<HTMLElement>('[role="tab"]').forEach(element => {
    const tabId = resolveFlexLayoutTabId(element.id, contentIds)
    if (!tabId) return
    element.dataset.mortiseSemanticId = `workspace.tab.${tabId}`
    element.dataset.mortiseUiInteractions = 'select drag close'
    element.dataset.mortiseTabId = tabId
  })
}

function detachedWindowBounds(point: ScreenPoint) {
  const width = Math.min(Math.max(window.outerWidth, 800), 1_200)
  const height = Math.min(Math.max(window.outerHeight, 600), 900)
  return {
    x: Math.round(point.x - 96),
    y: Math.round(point.y - 20),
    width,
    height,
  }
}

function readDragPosition(event: React.DragEvent<HTMLElement>): DragPosition | null {
  if (event.screenX === 0 && event.screenY === 0 && event.clientX === 0 && event.clientY === 0) {
    return null
  }
  return {
    client: { x: event.clientX, y: event.clientY },
    screen: { x: event.screenX, y: event.screenY },
  }
}

function buildAppLayoutSnapshot(
  model: Model,
  sessions: Map<string, { name?: string; preview?: string; isProcessing?: boolean }>,
  defaultServerId: string,
  defaultWorkspaceId: string,
  revision: number,
  protections: Record<string, DockTabProtection>,
): AppLayout {
  const base = createDefaultAppLayout({ serverId: defaultServerId, workspaceId: defaultWorkspaceId })
  const tabs: Record<string, ContentTab> = {}
  const groups: Record<string, PanelGroup> = {}
  const groupIds: string[] = []

  model.visitNodes(node => {
    if (!(node instanceof TabSetNode)) return
    const id = node.getId()
    const tabNodes = node.getChildren().filter((child): child is TabNode =>
      child instanceof TabNode && (child.getConfig() as DockTabConfig).source !== 'content-picker')
    if (tabNodes.length === 0) return
    const tabIds = tabNodes.map(tab => tab.getId())
    const selected = node.getSelected()
    groups[id] = {
      id,
      windowId: PRIMARY_LAYOUT_WINDOW_ID,
      tabIds,
      activeTabId: selected >= 0 ? tabIds[selected] ?? null : null,
      defaultLocation: 'main',
    }
    groupIds.push(id)

    for (const tabNode of tabNodes) {
      const tabId = tabNode.getId()
      const config = tabNode.getConfig() as DockTabConfig
      const protection = protections[tabId] ?? UNPROTECTED_DOCK_TAB
      if (config.source === 'workspace-content' && isWorkspaceContentKind(config.contentKind)) {
        tabs[tabId] = {
          id: tabId,
          title: tabNode.getName(),
          groupId: id,
          ref: {
            kind: config.contentKind,
            serverId: config.serverId || defaultServerId,
            workspaceId: defaultWorkspaceId,
            ...(config.sessionId ? { sessionId: config.sessionId } : {}),
            ...(config.resourceId ? { resourceId: config.resourceId } : {}),
          },
          protection,
          instancePolicy: config.instancePolicy ?? 'singleton',
          allowDetach: config.allowDetach !== false,
          minWidth: tabNode.getMinWidth(),
          minHeight: tabNode.getMinHeight(),
        }
        continue
      }
      if (config.source !== 'panel' || !config.route) continue
      const route = config.route as PanelStackEntry['route']
      const sessionId = config.sessionId ?? parseSessionIdFromRoute(route) ?? undefined
      const meta = sessionId ? sessions.get(sessionId) : undefined
      const contentKind = config.contentKind ?? contentKindForRoute(route)
      tabs[tabId] = {
        id: tabId,
        title: tabNode.getName(),
        groupId: id,
        ref: {
          kind: contentKind,
          serverId: config.serverId || defaultServerId,
          workspaceId: defaultWorkspaceId,
          ...(sessionId ? { sessionId } : {}),
          resourceId: config.resourceId ?? route,
        },
        protection: {
          ...protection,
          running: protection.running || meta?.isProcessing === true,
        },
        instancePolicy: config.instancePolicy ?? 'multiple',
        allowDetach: config.allowDetach !== false,
        minWidth: tabNode.getMinWidth(),
        minHeight: tabNode.getMinHeight(),
      }
    }
  })

  const focused = model.getActiveTabset()?.getSelectedNode()
  return {
    ...base,
    version: APP_LAYOUT_VERSION,
    revision,
    geometry: model.toJson(),
    tabs,
    groups,
    windows: {
      [PRIMARY_LAYOUT_WINDOW_ID]: {
        id: PRIMARY_LAYOUT_WINDOW_ID,
        kind: 'primary',
        groupIds,
      },
    },
    focusedTabId: focused instanceof TabNode ? focused.getId() : Object.keys(tabs)[0] ?? null,
  }
}

function contentKindForRoute(route: PanelStackEntry['route']): ContentKind {
  const type = getPanelTypeFromRoute(route)
  if (type === 'session') return 'conversation'
  if (type === 'skills') return 'navigation'
  return 'tool'
}

function contentKindForPanel(entry: PanelStackEntry): ContentKind {
  return contentKindForRoute(entry.route)
}

function resolvePanelTitle(
  entry: PanelStackEntry,
  sessions: Map<string, { name?: string; preview?: string }>,
  t: TFunction,
): string {
  const sessionId = parseSessionIdFromRoute(entry.route)
  if (sessionId) {
    const meta = sessions.get(sessionId)
    return meta?.name?.trim() || meta?.preview?.trim() || t('chat.titlePlaceholder')
  }
  const state = parseRouteToNavigationState(entry.route)
  if (!state) return t('chat.titlePlaceholder')
  if (state.navigator === 'settings') return t('sidebar.settings')
  if (state.navigator === 'skills') return t('sidebar.skills')
  if (state.navigator === 'automations') return t('sidebar.automations')
  return t('sidebar.allSessions')
}
