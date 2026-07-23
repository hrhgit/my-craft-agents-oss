import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS, type Session } from '@mortise/shared/protocol'
import {
  CLIENT_SHOW_IN_FOLDER,
  type HandlerFn,
  type RequestContext,
  type RpcServer,
} from '../../transport'
import type { PlatformServices } from '../../runtime/platform'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import { registerSessionsHandlers } from './sessions'

const ctx: RequestContext = {
  clientId: 'renderer-one',
  workspaceId: 'workspace-one',
  webContentsId: null,
}

function createHarness(options: {
  capabilities?: string[]
  showItemInFolder?: (path: string) => void
} = {}) {
  const handlers = new Map<string, HandlerFn>()
  const invokeClient = mock(async () => undefined)
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    invokeClient,
    hasClientCapability(_clientId, capability) {
      return options.capabilities?.includes(capability) ?? false
    },
    findClientsWithCapability() { return [] },
  }
  const session: Session = {
    id: 'session-one',
    workspaceId: 'workspace-one',
    workspaceName: 'Workspace One',
    messages: [],
    isProcessing: false,
    messageCount: 0,
    lastMessageAt: 1,
  }
  const sessionManager = new Proxy({
    async getSession(id: string) { return id === session.id ? session : null },
    getSessionPath(id: string) { return id === session.id ? 'C:\\workspace-one\\session-one' : null },
  }, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      return () => { throw new Error(`Unexpected SessionManager call: ${String(property)}`) }
    },
  }) as unknown as ISessionManager
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const platform: PlatformServices = {
    appRootPath: '',
    resourcesPath: '',
    isPackaged: false,
    appVersion: 'test',
    isDebugMode: false,
    logger,
    imageProcessor: {
      async getMetadata() { return null },
      async process() { return Buffer.alloc(0) },
    },
    ...(options.showItemInFolder ? { showItemInFolder: options.showItemInFolder } : {}),
  }
  registerSessionsHandlers(server, { sessionManager, platform } satisfies HandlerDeps)
  const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)
  if (!command) throw new Error('Missing sessions command handler')
  return { command, invokeClient }
}

describe('session showInFinder capability routing', () => {
  it('routes through the requesting client when it advertises the capability', async () => {
    const { command, invokeClient } = createHarness({ capabilities: [CLIENT_SHOW_IN_FOLDER] })

    await command(ctx, 'session-one', { type: 'showInFinder' })

    expect(invokeClient).toHaveBeenCalledWith(
      ctx.clientId,
      CLIENT_SHOW_IN_FOLDER,
      'C:\\workspace-one\\session-one',
    )
  })

  it('uses the injected platform when the client lacks the capability', async () => {
    const showItemInFolder = mock((_path: string) => undefined)
    const { command, invokeClient } = createHarness({ showItemInFolder })

    await command(ctx, 'session-one', { type: 'showInFinder' })

    expect(invokeClient).not.toHaveBeenCalled()
    expect(showItemInFolder).toHaveBeenCalledWith('C:\\workspace-one\\session-one')
  })

  it('throws a stable typed error when neither client nor platform implements it', async () => {
    const { command } = createHarness()
    let caught: unknown

    try {
      await command(ctx, 'session-one', { type: 'showInFinder' })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'Show in Finder is unavailable because neither the requesting client nor this platform implements it',
    })
  })
})
