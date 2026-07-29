import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import type { HandlerFn, RpcServer } from '../../transport'
import { registerSettingsHandlers } from './settings'

class TestRpcServer implements RpcServer {
  readonly handlers = new Map<string, HandlerFn>()
  handle(channel: string, handler: HandlerFn): void { this.handlers.set(channel, handler) }
  push(): void {}
  async invokeClient(): Promise<unknown> { return undefined }
  hasClientCapability(): boolean { return false }
  findClientsWithCapability(): string[] { return [] }
}

describe('Extension settings load boundary', () => {
  it('does not expose the retired runtime reload operation', () => {
    const server = new TestRpcServer()
    registerSettingsHandlers(server, {
      sessionManager: {} as ISessionManager,
      platform: {} as HandlerDeps['platform'],
    })

    expect(Object.values(RPC_CHANNELS.piExtensions)).not.toContain('piExtensions:reload')
    expect(server.handlers.has('piExtensions:reload')).toBe(false)
  })
})
