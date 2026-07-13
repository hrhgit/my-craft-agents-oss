import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { PlatformServices } from '../../runtime/platform'

const deleteGlobalProvider = mock(async (_key: string) => {})
const clearDeletedProviderReferences = mock(async (_key: string) => {})
const reinitializeAuth = mock(async (_provider?: string) => {})

mock.module('@craft-agent/shared/config', () => ({
  deletePiGlobalProvider: (key: string) => deleteGlobalProvider(key),
  migratePiGlobalProviderApiKeysToAuth: () => ({ migrated: 0, removedFromModels: 0, changed: false }),
  readPiGlobalProviders: () => ({}),
  readPiGlobalSettings: () => ({}),
  sanitizePiGlobalProvider: <T>(provider: T) => provider,
  setPiGlobalDefault: async () => {},
}))

const { registerPiProviderHandlers } = await import('./pi-providers.ts')

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
  const platform: PlatformServices = {
    appRootPath: '',
    resourcesPath: '',
    isPackaged: false,
    appVersion: 'test',
    isDebugMode: false,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    imageProcessor: {
      async getMetadata() { return null },
      async process() { return Buffer.alloc(0) },
    },
  }

  return {
    sessionManager: {
      clearDeletedProviderReferences,
      reinitializeAuth,
    } as unknown as ISessionManager,
    platform,
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
  }
}

const ctx: RequestContext = {
  clientId: 'client-a',
  workspaceId: null,
  webContentsId: null,
}

describe('Pi provider RPC handlers', () => {
  beforeEach(() => {
    deleteGlobalProvider.mockReset()
    clearDeletedProviderReferences.mockReset()
    reinitializeAuth.mockReset()
    deleteGlobalProvider.mockImplementation(async () => {})
    clearDeletedProviderReferences.mockImplementation(async () => {})
    reinitializeAuth.mockImplementation(async () => {})
  })

  it('clears session overrides after deleting a global provider', async () => {
    const server = new TestRpcServer()
    registerPiProviderHandlers(server, createDeps())

    const handler = server.handlers.get(RPC_CHANNELS.pi.DELETE_GLOBAL_PROVIDER)
    expect(handler).toBeDefined()

    await expect(handler!(ctx, 'removed-provider')).resolves.toEqual({ success: true })
    expect(deleteGlobalProvider).toHaveBeenCalledWith('removed-provider')
    expect(clearDeletedProviderReferences).toHaveBeenCalledWith('removed-provider')
  })
})
