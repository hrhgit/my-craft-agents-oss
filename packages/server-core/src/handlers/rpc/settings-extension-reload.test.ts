import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import { registerSettingsHandlers } from './settings'

class TestRpcServer implements RpcServer {
  readonly handlers = new Map<string, HandlerFn>()

  handle(channel: string, handler: HandlerFn): void {
    this.handlers.set(channel, handler)
  }

  push(): void {}
  async invokeClient(): Promise<unknown> { return undefined }
  hasClientCapability(): boolean { return false }
  findClientsWithCapability(): string[] { return [] }
}

const ctx: RequestContext = {
  clientId: 'client-a',
  workspaceId: null,
  webContentsId: null,
}

describe('extension reload RPC boundary', () => {
  it('forwards the ElectronAPI boolean confirmation argument', async () => {
    const requestExtensionReload = mock(async (interruptRunning: boolean) => ({
      status: 'reloaded' as const,
      interruptedSessionCount: interruptRunning ? 1 : 0,
      reloadedSessionCount: 1,
      deferredSessionCount: 0,
    }))
    const server = new TestRpcServer()
    registerSettingsHandlers(server, {
      sessionManager: { requestExtensionReload } as unknown as ISessionManager,
      platform: {} as HandlerDeps['platform'],
      oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    })

    const handler = server.handlers.get(RPC_CHANNELS.piExtensions.RELOAD)
    expect(handler).toBeDefined()

    await expect(handler!(ctx, true)).resolves.toMatchObject({
      status: 'reloaded',
      interruptedSessionCount: 1,
    })
    expect(requestExtensionReload).toHaveBeenCalledWith(true)
  })

  it('keeps object payload compatibility for direct RPC clients', async () => {
    const requestExtensionReload = mock(async (interruptRunning: boolean) => ({
      status: 'reloaded' as const,
      interruptedSessionCount: interruptRunning ? 1 : 0,
      reloadedSessionCount: 1,
      deferredSessionCount: 0,
    }))
    const server = new TestRpcServer()
    registerSettingsHandlers(server, {
      sessionManager: { requestExtensionReload } as unknown as ISessionManager,
      platform: {} as HandlerDeps['platform'],
      oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    })

    const handler = server.handlers.get(RPC_CHANNELS.piExtensions.RELOAD)
    await handler!(ctx, { interruptRunning: true })

    expect(requestExtensionReload).toHaveBeenCalledWith(true)
  })
})
