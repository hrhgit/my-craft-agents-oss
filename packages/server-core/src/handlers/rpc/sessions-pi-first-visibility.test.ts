import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS, type Session } from '@craft-agent/shared/protocol'
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

function session(id: string, piNative: boolean): Session {
  return {
    id,
    workspaceId: 'workspace-a',
    workspaceName: 'Workspace A',
    conversationFormat: piNative ? 'pi-projection-v1' : undefined,
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
  it('hides legacy Craft sessions from the renderer session list', async () => {
    const legacy = session('legacy-session', false)
    const piNative = session('pi-session', true)
    const handler = handlerFor(createDeps([legacy, piNative]), RPC_CHANNELS.sessions.GET)

    const result = await handler(ctx) as Session[]

    expect(result.map(item => item.id)).toEqual(['pi-session'])
  })

  it('refuses to load a legacy Craft transcript by id', async () => {
    const handler = handlerFor(
      createDeps([session('legacy-session', false)]),
      RPC_CHANNELS.sessions.GET_MESSAGES,
    )

    await expect(handler(ctx, 'legacy-session')).rejects.toThrow(
      'Legacy Craft session is not available in the Pi-first UI',
    )
  })

  it('loads a Pi-native session by id', async () => {
    const piNative = session('pi-session', true)
    const handler = handlerFor(createDeps([piNative]), RPC_CHANNELS.sessions.GET_MESSAGES)

    await expect(handler(ctx, 'pi-session')).resolves.toEqual(piNative)
  })
})
