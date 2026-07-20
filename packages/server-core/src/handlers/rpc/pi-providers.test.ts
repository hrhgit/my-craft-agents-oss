import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { PlatformServices } from '../../runtime/platform'

const deleteGlobalProvider = mock(async (_key: string) => {})
const saveGlobalProvider = mock((_key: string, _provider: unknown, _apiKey?: string) => {})
const setGlobalDefault = mock(async (_provider: string, _model: string, _thinkingLevel?: string) => {})
const setGlobalDefaultSlot = mock(async (_slot: number, _provider: string, _model: string, _thinkingLevel: string) => {})
const removeGlobalDefaultSlot = mock(async (_slot: number) => {})
const clearDeletedProviderReferences = mock(async (_key: string) => {})
const reinitializeAuth = mock(async (_provider?: string) => {})
const reloadProviderRuntime = mock(async (_provider?: string) => {})

mock.module('@mortise/shared/config', () => ({
  deletePiGlobalProvider: (key: string) => deleteGlobalProvider(key),
  migratePiGlobalProviderApiKeysToAuth: () => ({ migrated: 0, removedFromModels: 0, changed: false }),
  readPiGlobalProviders: () => ({}),
  readPiGlobalSettings: () => ({}),
  savePiGlobalProvider: (key: string, provider: unknown, apiKey?: string) => saveGlobalProvider(key, provider, apiKey),
  sanitizePiGlobalProvider: <T>(provider: T) => provider,
  setPiGlobalDefault: (provider: string, model: string, thinkingLevel?: string) => setGlobalDefault(provider, model, thinkingLevel),
  setPiGlobalDefaultSlot: (slot: number, provider: string, model: string, thinkingLevel: string) => setGlobalDefaultSlot(slot, provider, model, thinkingLevel),
  removePiGlobalDefaultSlot: (slot: number) => removeGlobalDefaultSlot(slot),
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
      reloadProviderRuntime,
    } as unknown as ISessionManager,
    platform,
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
    saveGlobalProvider.mockReset()
    setGlobalDefault.mockReset()
    setGlobalDefaultSlot.mockReset()
    removeGlobalDefaultSlot.mockReset()
    clearDeletedProviderReferences.mockReset()
    reinitializeAuth.mockReset()
    reloadProviderRuntime.mockReset()
    deleteGlobalProvider.mockImplementation(async () => {})
    saveGlobalProvider.mockImplementation(() => {})
    setGlobalDefault.mockImplementation(async () => {})
    setGlobalDefaultSlot.mockImplementation(async () => {})
    removeGlobalDefaultSlot.mockImplementation(async () => {})
    clearDeletedProviderReferences.mockImplementation(async () => {})
    reinitializeAuth.mockImplementation(async () => {})
    reloadProviderRuntime.mockImplementation(async () => {})
  })

  it('reloads the matching provider runtime after saving', async () => {
    const server = new TestRpcServer()
    registerPiProviderHandlers(server, createDeps())
    const provider = { baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [] }

    const handler = server.handlers.get(RPC_CHANNELS.pi.SAVE_GLOBAL_PROVIDER)
    await expect(handler!(ctx, { key: 'changed-provider', provider, apiKey: 'secret' })).resolves.toEqual({ success: true })

    expect(saveGlobalProvider).toHaveBeenCalledWith('changed-provider', provider, 'secret')
    expect(reloadProviderRuntime).toHaveBeenCalledWith('changed-provider')
  })

  it('clears session overrides after deleting a global provider', async () => {
    const server = new TestRpcServer()
    registerPiProviderHandlers(server, createDeps())

    const handler = server.handlers.get(RPC_CHANNELS.pi.DELETE_GLOBAL_PROVIDER)
    expect(handler).toBeDefined()

    await expect(handler!(ctx, 'removed-provider')).resolves.toEqual({ success: true })
    expect(deleteGlobalProvider).toHaveBeenCalledWith('removed-provider')
    expect(clearDeletedProviderReferences).toHaveBeenCalledWith('removed-provider')
    expect(reloadProviderRuntime).toHaveBeenCalledWith()
  })

  it('reloads all runtimes after changing the global default', async () => {
    const server = new TestRpcServer()
    registerPiProviderHandlers(server, createDeps())

    const handler = server.handlers.get(RPC_CHANNELS.pi.SET_GLOBAL_DEFAULT)
    await expect(handler!(ctx, {
      provider: 'default-provider',
      model: 'default-model',
      thinkingLevel: 'high',
    })).resolves.toEqual({ success: true })

    expect(setGlobalDefault).toHaveBeenCalledWith('default-provider', 'default-model', 'high')
    expect(reloadProviderRuntime).toHaveBeenCalledWith()
  })

  it('writes secondary defaults without replacing the Pi primary default', async () => {
    const server = new TestRpcServer()
    registerPiProviderHandlers(server, createDeps())

    const handler = server.handlers.get(RPC_CHANNELS.pi.SET_GLOBAL_DEFAULT)
    await expect(handler!(ctx, {
      provider: 'review-provider',
      model: 'review-model',
      thinkingLevel: 'xhigh',
      slot: 5,
    })).resolves.toEqual({ success: true })

    expect(setGlobalDefaultSlot).toHaveBeenCalledWith(5, 'review-provider', 'review-model', 'xhigh')
    expect(setGlobalDefault).not.toHaveBeenCalled()
    expect(reloadProviderRuntime).toHaveBeenCalledWith()
  })

  it('removes and compacts a secondary default', async () => {
    const server = new TestRpcServer()
    registerPiProviderHandlers(server, createDeps())

    const handler = server.handlers.get(RPC_CHANNELS.pi.SET_GLOBAL_DEFAULT)
    await expect(handler!(ctx, { slot: 2, remove: true })).resolves.toEqual({ success: true })

    expect(removeGlobalDefaultSlot).toHaveBeenCalledWith(2)
    expect(setGlobalDefault).not.toHaveBeenCalled()
    expect(reloadProviderRuntime).toHaveBeenCalledWith()
  })
})
