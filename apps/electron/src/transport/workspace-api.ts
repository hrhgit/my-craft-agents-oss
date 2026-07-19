import type { RpcClient } from '@mortise/server-core/transport'
import { isLocalOnly } from '@mortise/shared/protocol'
import type { WorkspaceRoute } from '../shared/app-layout'
import type { ElectronAPI } from '../shared/types'
import { buildClientApi, type ChannelMap } from './build-api'
import { workspaceRouteKey } from './workspace-runtime-registry'

export interface WorkspaceApiTransport {
  invoke(route: WorkspaceRoute, channel: string, ...args: unknown[]): Promise<unknown>
  on(route: WorkspaceRoute, channel: string, callback: (...args: any[]) => void): () => void
  isChannelAvailable?(route: WorkspaceRoute, channel: string): boolean
}

export function evictWorkspaceApiCache<T>(
  cache: Map<string, T>,
  workspaceId: string,
  keepServerId?: string,
): void {
  const suffix = `::${encodeURIComponent(workspaceId)}`
  const keepKey = keepServerId ? workspaceRouteKey({ serverId: keepServerId, workspaceId }) : null
  for (const key of cache.keys()) {
    if (key.endsWith(suffix) && key !== keepKey) cache.delete(key)
  }
}

/**
 * Builds the normal typed Electron API surface on top of one trusted workspace
 * route. The renderer selects methods, while the preload owns channel lookup
 * and the runtime connection containing credentials.
 */
export function buildWorkspaceClientApi(
  transport: WorkspaceApiTransport,
  route: WorkspaceRoute,
  channelMap: ChannelMap,
): ElectronAPI {
  const client: RpcClient = {
    invoke: (channel, ...args) => {
      assertWorkspaceChannel(channel)
      return transport.invoke(route, channel, ...args)
    },
    on: (channel, callback) => {
      assertWorkspaceChannel(channel)
      return transport.on(route, channel, callback)
    },
    handleCapability: () => {
      throw new Error('Workspace-scoped renderer APIs cannot register capabilities')
    },
  }

  return buildClientApi(
    client,
    channelMap,
    channel => transport.isChannelAvailable?.(route, channel) ?? true,
  )
}

function assertWorkspaceChannel(channel: string): void {
  if (isLocalOnly(channel)) {
    throw new Error(`Workspace-scoped API cannot use local-only channel: ${channel}`)
  }
}

export function resolveWorkspaceApiMethod(
  api: ElectronAPI,
  method: string,
): ((...args: any[]) => any) | null {
  const dot = method.indexOf('.')
  const value = dot < 0
    ? (api as any)[method]
    : (api as any)[method.slice(0, dot)]?.[method.slice(dot + 1)]
  return typeof value === 'function' ? value : null
}
