import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
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

function createDeps(
  onInteraction?: (requestId: string, response: unknown) => boolean,
  frontendStates: unknown[] = [],
): HandlerDeps {
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
    respondToExtensionInteraction(_sessionId: string, requestId: string, response: unknown) {
      return onInteraction?.(requestId, response) ?? true
    },
    getExtensionFrontendStates() {
      return frontendStates
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
  }
}

const ctx: RequestContext = {
  clientId: 'client-a',
  workspaceId: 'workspace-a',
  webContentsId: null,
}

const protectedCalls: Array<{ channel: string; args: unknown[] }> = [
  { channel: RPC_CHANNELS.sessions.GET_MESSAGES, args: ['session-1'] },
  { channel: RPC_CHANNELS.sessions.GET_PI_PROJECTION_SNAPSHOT, args: ['session-1'] },
  { channel: RPC_CHANNELS.sessions.DELETE, args: ['session-1'] },
  { channel: RPC_CHANNELS.sessions.SEND_MESSAGE, args: ['session-1', 'attacker prompt'] },
  { channel: RPC_CHANNELS.sessions.CANCEL, args: ['session-1'] },
  { channel: RPC_CHANNELS.sessions.KILL_SHELL, args: ['session-1', 'shell-1'] },
  { channel: RPC_CHANNELS.extensions.INTERACTION_RESPONSE, args: ['session-1', 'request-1', { schemaVersion: 1, status: 'cancelled', reason: 'user' }] },
  { channel: RPC_CHANNELS.extensions.COMMAND_INVOKE, args: ['session-1', 'command-1', {}] },
  { channel: RPC_CHANNELS.extensions.GET_FRONTEND_STATES, args: ['session-1'] },
  { channel: RPC_CHANNELS.sessions.LIST_CHILD_SESSIONS, args: ['session-1'] },
]

describe('session RPC workspace authorization', () => {
  it.each(protectedCalls)('rejects cross-workspace access for $channel', async ({ channel, args }) => {
    const server = new TestRpcServer()
    registerSessionsHandlers(server, createDeps())

    const handler = server.handlers.get(channel)
    expect(handler).toBeDefined()

    await expect(handler!(ctx, ...args)).rejects.toThrow('Session workspace mismatch')
  })

  it('rejects retired scalar interaction responses and forwards only valid V1 responses', async () => {
    const received: unknown[] = []
    const server = new TestRpcServer()
    registerSessionsHandlers(server, createDeps((requestId, response) => {
      received.push({ requestId, response })
      return true
    }))
    const handler = server.handlers.get(RPC_CHANNELS.extensions.INTERACTION_RESPONSE)!
    const trustedCtx = { ...ctx, workspaceId: 'workspace-b' }

    await expect(handler(trustedCtx, 'session-1', 'request-1', null)).rejects.toThrow('Invalid extension interaction response')
    expect(await handler(trustedCtx, 'session-1', 'request-1', {
      schemaVersion: 1,
      status: 'cancelled',
      reason: 'user',
    })).toBe(true)
    expect(received).toEqual([{
      requestId: 'request-1',
      response: { schemaVersion: 1, status: 'cancelled', reason: 'user' },
    }])
  })

  it('returns cached frontend states for the authenticated session', async () => {
    const states = [{ type: 'extension_frontend_state', extensionId: 'ask-user' }]
    const server = new TestRpcServer()
    registerSessionsHandlers(server, createDeps(undefined, states))

    const handler = server.handlers.get(RPC_CHANNELS.extensions.GET_FRONTEND_STATES)!
    expect(await handler({ ...ctx, workspaceId: 'workspace-b' }, 'session-1')).toBe(states)
  })
})
