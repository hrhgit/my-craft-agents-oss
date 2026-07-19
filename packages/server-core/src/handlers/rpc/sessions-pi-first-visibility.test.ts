import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS, type Session } from '@mortise/shared/protocol'
import type { PlatformServices } from '../../runtime/platform'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import { registerSessionsHandlers } from './sessions'

class TestRpcServer implements RpcServer {
  readonly handlers = new Map<string, HandlerFn>()
  handle(channel: string, handler: HandlerFn): void { this.handlers.set(channel, handler) }
  push(): void {}
  async invokeClient(): Promise<unknown> { return undefined }
  hasClientCapability(): boolean { return false }
  findClientsWithCapability(): string[] { return [] }
}

const ctx: RequestContext = {
  clientId: 'renderer',
  workspaceId: 'workspace-a',
  webContentsId: null,
}

function session(id: string): Session {
  return {
    id,
    workspaceId: 'workspace-a',
    workspaceName: 'Workspace A',
    messages: [],
    isProcessing: false,
    messageCount: 0,
    lastMessageAt: 1,
  }
}

function createDeps(sessions: Session[]): HandlerDeps {
  const sessionManager = new Proxy({
    async waitForInit() {},
    getSessions: () => sessions,
    async getSession(id: string) { return sessions.find(item => item.id === id) ?? null },
  }, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      return () => { throw new Error(`Unexpected SessionManager call: ${String(prop)}`) }
    },
  }) as unknown as ISessionManager

  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const platform: PlatformServices = {
    appRootPath: '', resourcesPath: '', isPackaged: false, appVersion: 'test',
    isDebugMode: false, logger,
    imageProcessor: {
      async getMetadata() { return null },
      async process() { return Buffer.alloc(0) },
    },
  }
  return { sessionManager, platform, oauthFlowStore: {} as HandlerDeps['oauthFlowStore'] }
}

function handlerFor(deps: HandlerDeps, channel: string): HandlerFn {
  const server = new TestRpcServer()
  registerSessionsHandlers(server, deps)
  const handler = server.handlers.get(channel)
  if (!handler) throw new Error(`Missing handler: ${channel}`)
  return handler
}

describe('Pi-first session visibility', () => {
  it('returns all managed sessions to the renderer session list', async () => {
    const first = session('session-a')
    const second = session('session-b')
    const handler = handlerFor(createDeps([first, second]), RPC_CHANNELS.sessions.GET)

    const result = await handler(ctx) as Session[]

    expect(result.map(item => item.id)).toEqual(['session-a', 'session-b'])
  })

  it('loads a managed session by id', async () => {
    const piNative = session('pi-session')
    const handler = handlerFor(createDeps([piNative]), RPC_CHANNELS.sessions.GET_MESSAGES)

    await expect(handler(ctx, 'pi-session')).resolves.toEqual(piNative)
  })
})
