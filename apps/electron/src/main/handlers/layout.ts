import { randomUUID } from 'node:crypto'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'
import type { AppLayout, LayoutWindow } from '../../shared/app-layout'

export const LAYOUT_HANDLED_CHANNELS = [
  RPC_CHANNELS.layout.GET,
  RPC_CHANNELS.layout.SAVE,
  RPC_CHANNELS.layout.DETACH_TAB,
  RPC_CHANNELS.layout.DETACH_GROUP,
  RPC_CHANNELS.layout.REDOCK_WINDOW,
] as const

export function registerLayoutHandlers(server: RpcServer, deps: HandlerDeps): void {
  const coordinator = deps.layoutCoordinator
  const windowManager = deps.windowManager
  if (!coordinator) return

  server.handle(RPC_CHANNELS.layout.GET, (ctx, requestedWorkspaceId?: string, serverId?: string) => {
    const windowWorkspaceId = ctx.webContentsId != null
      ? windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? undefined
      : undefined
    if (requestedWorkspaceId && windowWorkspaceId && requestedWorkspaceId !== windowWorkspaceId) {
      throw new Error(`Cannot read layout for workspace ${requestedWorkspaceId} from window ${windowWorkspaceId}`)
    }
    const workspaceId = requestedWorkspaceId ?? ctx.workspaceId ?? windowWorkspaceId ?? ''
    return coordinator.getSnapshot(workspaceId, serverId)
  })
  server.handle(RPC_CHANNELS.layout.SAVE, (ctx, layout: AppLayout, expectedRevision?: number) => {
    const windowWorkspaceId = ctx.workspaceId
      ?? (ctx.webContentsId != null ? windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
    if (windowWorkspaceId && layout.workspaceId !== windowWorkspaceId) {
      throw new Error(`Cannot save layout for workspace ${layout.workspaceId} from window ${windowWorkspaceId}`)
    }
    if (ctx.webContentsId != null && windowManager) {
      const writeContext = windowManager.getLayoutWriteContext(ctx.webContentsId)
      if (!writeContext) throw new Error('This window is not a layout writer')
      if (writeContext.workspaceId !== layout.workspaceId) {
        throw new Error(`Cannot save layout for workspace ${layout.workspaceId} from window ${writeContext.workspaceId}`)
      }
      return coordinator.saveWindowSnapshot(writeContext.layoutWindowId, layout, expectedRevision)
    }
    return coordinator.saveSnapshot(layout, expectedRevision)
  })
  const detach = (
    webContentsId: number | null,
    bounds: LayoutWindow['bounds'] | undefined,
    updateLayout: (windowId: string, bounds: LayoutWindow['bounds']) => AppLayout,
  ): AppLayout => {
    if (!windowManager) throw new Error('Window manager is unavailable')
    if (webContentsId == null) throw new Error('A desktop window is required to detach layout content')
    const writeContext = windowManager.getLayoutWriteContext(webContentsId)
    if (!writeContext || writeContext.role !== 'primary') {
      throw new Error('Only the primary layout window can detach layout content')
    }
    const windowId = `aux:${randomUUID()}`
    const workspaceId = writeContext.workspaceId
    const resolvedBounds = windowManager.resolveAuxiliaryWindowBounds(webContentsId, bounds)
    const next = updateLayout(windowId, resolvedBounds)
    try {
      windowManager.createAuxiliaryWindow(windowId, workspaceId, webContentsId, resolvedBounds)
    } catch (error) {
      coordinator.redockWindow(windowId, workspaceId)
      throw error
    }
    return next
  }

  server.handle(RPC_CHANNELS.layout.DETACH_TAB, (ctx, tabId: string, bounds?: LayoutWindow['bounds']) => {
    const workspaceId = ctx.webContentsId != null
      ? windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? ''
      : ''
    return detach(ctx.webContentsId, bounds, (windowId, resolvedBounds) =>
      coordinator.detachTab(workspaceId, tabId, windowId, resolvedBounds))
  })
  server.handle(RPC_CHANNELS.layout.DETACH_GROUP, (ctx, groupId: string, bounds?: LayoutWindow['bounds']) => {
    const workspaceId = ctx.webContentsId != null
      ? windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? ''
      : ''
    return detach(ctx.webContentsId, bounds, (windowId, resolvedBounds) =>
      coordinator.detachGroup(workspaceId, groupId, windowId, resolvedBounds))
  })
  server.handle(RPC_CHANNELS.layout.REDOCK_WINDOW, (ctx, windowId: string) => {
    const workspaceId = ctx.workspaceId
      ?? (ctx.webContentsId != null ? windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
      ?? undefined
    if (ctx.webContentsId != null && windowManager) {
      const writeContext = windowManager.getLayoutWriteContext(ctx.webContentsId)
      if (!writeContext) throw new Error('This window is not a layout writer')
      if (writeContext.role === 'auxiliary' && writeContext.layoutWindowId !== windowId) {
        throw new Error('An auxiliary window can only redock itself')
      }
    }
    return coordinator.redockWindow(windowId, workspaceId) ?? coordinator.getSnapshot(workspaceId ?? '')
  })
}
