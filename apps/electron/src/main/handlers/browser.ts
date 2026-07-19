import { RPC_CHANNELS, type BrowserPaneCreateOptions, type BrowserEmbedBounds } from '../../shared/types'
import type { BrowserScreenshotOptions } from '../browser-pane-manager'
import { pushTyped, type RpcServer } from '@mortise/server-core/transport'
import { getWorkspaceByNameOrId } from '@mortise/shared/config'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.browserPane.CREATE,
  RPC_CHANNELS.browserPane.EMBED,
  RPC_CHANNELS.browserPane.UPDATE_EMBED_BOUNDS,
  RPC_CHANNELS.browserPane.DETACH,
  RPC_CHANNELS.browserPane.DESTROY,
  RPC_CHANNELS.browserPane.LIST,
  RPC_CHANNELS.browserPane.NAVIGATE,
  RPC_CHANNELS.browserPane.GO_BACK,
  RPC_CHANNELS.browserPane.GO_FORWARD,
  RPC_CHANNELS.browserPane.RELOAD,
  RPC_CHANNELS.browserPane.STOP,
  RPC_CHANNELS.browserPane.FOCUS,
  RPC_CHANNELS.browserPane.SNAPSHOT,
  RPC_CHANNELS.browserPane.CLICK,
  RPC_CHANNELS.browserPane.FILL,
  RPC_CHANNELS.browserPane.SELECT,
  RPC_CHANNELS.browserPane.SCREENSHOT,
  RPC_CHANNELS.browserPane.EVALUATE,
  RPC_CHANNELS.browserPane.SCROLL,
] as const

export function registerBrowserHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, platform } = deps
  if (!browserPaneManager) return

  const workspaceAliasesFromContext = (workspaceId: string | null): readonly string[] => {
    if (!workspaceId) return []
    const remoteWorkspaceId = getWorkspaceByNameOrId(workspaceId)?.remoteServer?.remoteWorkspaceId
    return remoteWorkspaceId && remoteWorkspaceId !== workspaceId
      ? [workspaceId, remoteWorkspaceId]
      : [workspaceId]
  }
  const assertWorkspaceOwnership = (workspaceId: string | null, id: string): void => {
    browserPaneManager.assertInstanceOwnedByWorkspaceAliases(id, workspaceAliasesFromContext(workspaceId))
  }

  server.handle(RPC_CHANNELS.browserPane.CREATE, (ctx, input?: string | BrowserPaneCreateOptions) => {
    const requestedWorkspaceId = typeof input === 'object' ? input.workspaceId?.trim() : undefined
    if (
      requestedWorkspaceId
      && ctx.workspaceId
      && !workspaceAliasesFromContext(ctx.workspaceId).includes(requestedWorkspaceId)
    ) {
      throw new Error(`Cannot create a browser for workspace ${requestedWorkspaceId} from workspace ${ctx.workspaceId}`)
    }
    const workspaceId = requestedWorkspaceId || ctx.workspaceId
    if (!workspaceId) throw new Error('Browser creation requires a workspaceId')
    const requestedId = typeof input === 'string' ? input : input?.id
    if (requestedId && browserPaneManager.listInstances().some(instance => instance.id === requestedId)) {
      assertWorkspaceOwnership(workspaceId, requestedId)
    }

    if (typeof input === 'string') {
      return browserPaneManager.createInstance(input, { workspaceId })
    }

    if (input?.bindToSessionId) {
      const existingId = browserPaneManager.getBoundForSession(input.bindToSessionId)
      if (existingId) assertWorkspaceOwnership(workspaceId, existingId)
      return browserPaneManager.createForSession(input.bindToSessionId, {
        show: input.show ?? false,
        workspaceId,
      })
    }

    return browserPaneManager.createInstance(input?.id, { show: input?.show, workspaceId })
  })

  server.handle(RPC_CHANNELS.browserPane.EMBED, (ctx, id: string, bounds: BrowserEmbedBounds) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    if (ctx.webContentsId == null) throw new Error('Embedding requires a renderer window')
    browserPaneManager.embedInHost(id, ctx.webContentsId, bounds)
  })

  server.handle(RPC_CHANNELS.browserPane.UPDATE_EMBED_BOUNDS, (ctx, id: string, bounds: BrowserEmbedBounds) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    if (ctx.webContentsId == null) throw new Error('Embedding requires a renderer window')
    browserPaneManager.updateEmbeddedBounds(id, ctx.webContentsId, bounds)
  })

  server.handle(RPC_CHANNELS.browserPane.DETACH, (ctx, id: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    browserPaneManager.detachFromHost(id, ctx.webContentsId ?? undefined)
  })

  server.handle(RPC_CHANNELS.browserPane.DESTROY, (ctx, id: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    browserPaneManager.destroyInstance(id)
  })

  server.handle(RPC_CHANNELS.browserPane.LIST, (ctx) => {
    return browserPaneManager.listInstancesForWorkspaceAliases(workspaceAliasesFromContext(ctx.workspaceId))
  })

  server.handle(RPC_CHANNELS.browserPane.NAVIGATE, async (ctx, id: string, url: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    try {
      return await browserPaneManager.navigate(id, url)
    } catch (err) {
      platform.logger.error(`[browser-pane] navigate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_BACK, async (ctx, id: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    try {
      return await browserPaneManager.goBack(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goBack failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.GO_FORWARD, async (ctx, id: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    try {
      return await browserPaneManager.goForward(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goForward failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.RELOAD, (ctx, id: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    browserPaneManager.reload(id)
  })

  server.handle(RPC_CHANNELS.browserPane.STOP, (ctx, id: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    browserPaneManager.stop(id)
  })

  server.handle(RPC_CHANNELS.browserPane.FOCUS, (ctx, id: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    browserPaneManager.focus(id)
  })

  server.handle(RPC_CHANNELS.browserPane.SNAPSHOT, async (ctx, id: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    try {
      return await browserPaneManager.getAccessibilitySnapshot(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] snapshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.CLICK, async (ctx, id: string, ref: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    try {
      return await browserPaneManager.clickElement(id, ref)
    } catch (err) {
      platform.logger.error(`[browser-pane] click failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.FILL, async (ctx, id: string, ref: string, value: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    try {
      return await browserPaneManager.fillElement(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] fill failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SELECT, async (ctx, id: string, ref: string, value: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    try {
      return await browserPaneManager.selectOption(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] select failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCREENSHOT, async (ctx, id: string, options?: BrowserScreenshotOptions) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    try {
      const result = await browserPaneManager.screenshot(id, options)
      return {
        base64: result.imageBuffer.toString('base64'),
        imageFormat: result.imageFormat,
        metadata: result.metadata,
      }
    } catch (err) {
      platform.logger.error(`[browser-pane] screenshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.EVALUATE, async (ctx, id: string, expression: string) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    try {
      return await browserPaneManager.evaluate(id, expression)
    } catch (err) {
      platform.logger.error(`[browser-pane] evaluate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_CHANNELS.browserPane.SCROLL, async (ctx, id: string, direction: string, amount?: number) => {
    assertWorkspaceOwnership(ctx.workspaceId, id)
    const validDirections = ['up', 'down', 'left', 'right']
    if (!validDirections.includes(direction)) {
      throw new Error(`Invalid scroll direction: ${direction}`)
    }
    try {
      return await browserPaneManager.scroll(id, direction as 'up' | 'down' | 'left' | 'right', amount)
    } catch (err) {
      platform.logger.error(`[browser-pane] scroll failed for ${id}:`, err)
      throw err
    }
  })

  // Instance commands and LIST are authorized against ctx.workspaceId above.
  // Event fanout remains broad because renderer subscriptions are shared; each
  // renderer registry discards events outside its local or mirrored workspace.
  //
  // We can't route STATE_CHANGED to `{ to: 'workspace', workspaceId }` here
  // because the broadcast routing uses the client's transport-level workspaceId
  // (the local Mortise window's id, set by `updateClientWorkspace`),
  // while remote-bridged instances are stamped with the remote server's
  // workspaceId. The two never match, so a workspace-targeted broadcast would
  // silently fail to reach the renderer. Broadcast to all + filter in the
  // renderer is the contract that actually works in both local-only and
  // remote-mirror deployments.
  browserPaneManager.onStateChange((info) => {
    pushTyped(server, RPC_CHANNELS.browserPane.STATE_CHANGED, { to: 'all' }, info)
  })

  browserPaneManager.onRemoved((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.REMOVED, { to: 'all' }, id)
  })

  browserPaneManager.onInteracted((id) => {
    pushTyped(server, RPC_CHANNELS.browserPane.INTERACTED, { to: 'all' }, id)
  })
}
