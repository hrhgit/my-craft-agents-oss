import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { registerSessionsHandlers } from './sessions'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { PlatformServices } from '../../runtime/platform'

class TestRpcServer implements RpcServer {
  readonly handlers = new Map<string, HandlerFn>()

  handle(channel: string, handler: HandlerFn): void {
    this.handlers.set(channel, handler)
  }

  push(): void {}

  async invokeClient(): Promise<unknown> {
    return undefined
  }

  hasClientCapability(): boolean {
    return false
  }

  findClientsWithCapability(): string[] {
    return []
  }
}

function createDeps(): HandlerDeps {
  const sessionManager = new Proxy({
    async getSession(sessionId: string) {
      return {
        id: sessionId,
        workspaceId: 'workspace-b',
        messages: [],
        isProcessing: false,
        messageCount: 0,
        lastMessageAt: Date.now(),
      }
    },
  }, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver)
      }
      return () => {
        throw new Error(`Unexpected SessionManager call: ${String(prop)}`)
      }
    },
  }) as unknown as ISessionManager

  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  }

  const platform: PlatformServices = {
    appRootPath: '',
    resourcesPath: '',
    isPackaged: false,
    appVersion: 'test',
    isDebugMode: false,
    logger,
    imageProcessor: {
      async getMetadata() {
        return null
      },
      async process() {
        return Buffer.alloc(0)
      },
    },
  }

  return {
    sessionManager,
    platform,
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  }
}

const ctx: RequestContext = {
  clientId: 'client-a',
  workspaceId: 'workspace-a',
  webContentsId: null,
}

const protectedCalls: Array<{ channel: string; args: unknown[] }> = [
  { channel: RPC_CHANNELS.sessions.GET_MESSAGES, args: ['session-1'] },
  { channel: RPC_CHANNELS.sessions.DELETE, args: ['session-1'] },
  { channel: RPC_CHANNELS.sessions.SEND_MESSAGE, args: ['session-1', 'attacker prompt'] },
  { channel: RPC_CHANNELS.sessions.CANCEL, args: ['session-1'] },
  { channel: RPC_CHANNELS.sessions.KILL_SHELL, args: ['session-1', 'shell-1'] },
  { channel: RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION, args: ['session-1', 'request-1', true, true] },
  { channel: RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL, args: ['session-1', 'request-1', {}] },
  { channel: RPC_CHANNELS.extensions.REMOTEUI_RESPONSE, args: ['session-1', 'request-1', null] },
  { channel: RPC_CHANNELS.extensions.COMMAND_INVOKE, args: ['session-1', 'command-1', {}] },
  { channel: RPC_CHANNELS.sessions.LIST_CHILD_SESSIONS, args: ['session-1'] },
  { channel: RPC_CHANNELS.sessions.COMMAND, args: ['session-1', { type: 'setPermissionMode', mode: 'allow-all' }] },
]

describe('session RPC workspace authorization', () => {
  it.each(protectedCalls)('rejects cross-workspace access for $channel', async ({ channel, args }) => {
    const server = new TestRpcServer()
    registerSessionsHandlers(server, createDeps())

    const handler = server.handlers.get(channel)
    expect(handler).toBeDefined()

    await expect(handler!(ctx, ...args)).rejects.toThrow('Session workspace mismatch')
  })
})
