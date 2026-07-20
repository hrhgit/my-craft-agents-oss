import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '../../../shared/types'
import type { RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

type HandlerFn = (ctx: { clientId: string }, ...args: any[]) => Promise<any> | any

const getDefaultThinkingLevelMock = mock(() => 'think')
const setDefaultThinkingLevelMock = mock((_level: string) => true)
const getMidStreamBehaviorMock = mock(() => 'steer')
const setMidStreamBehaviorMock = mock((_behavior: string) => true)
const updateMainAgentSettingsMock = mock(() => {})

mock.module('@mortise/shared/config', () => ({
  getPreferencesPath: () => '/tmp/preferences.json',
  getSessionDraft: () => null,
  setSessionDraft: () => {},
  deleteSessionDraft: () => {},
  getAllSessionDrafts: () => ({}),
  getWorkspaceByNameOrId: () => null,
  getDefaultThinkingLevel: getDefaultThinkingLevelMock,
  setDefaultThinkingLevel: setDefaultThinkingLevelMock,
  getMidStreamBehavior: getMidStreamBehaviorMock,
  setMidStreamBehavior: setMidStreamBehaviorMock,
  getAgentSettingsSnapshot: () => ({}),
  updateMainAgentSettings: updateMainAgentSettingsMock,
  upsertSubagent: () => ({}),
  deleteSubagent: () => {},
  readPiGlobalProviders: () => ({}),
}))

describe('settings default thinking RPC handlers', () => {
  const handlers = new Map<string, HandlerFn>()

  beforeEach(async () => {
    handlers.clear()
    getDefaultThinkingLevelMock.mockClear()
    setDefaultThinkingLevelMock.mockClear()
    getMidStreamBehaviorMock.mockClear()
    setMidStreamBehaviorMock.mockClear()

    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn)
      },
      push() {},
      async invokeClient() {
        return null
      },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }

    const deps: HandlerDeps = {
      sessionManager: {
        reloadProviderRuntime: async () => {},
        getAgentRuntimeProfile: async () => undefined,
      } as unknown as HandlerDeps['sessionManager'],
      platform: {
        appRootPath: '',
        resourcesPath: '',
        isPackaged: false,
        appVersion: '0.0.0-test',
        isDebugMode: true,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        imageProcessor: {
          getMetadata: async () => null,
          process: async () => Buffer.from(''),
        },
      },
    }

    const { registerSettingsHandlers } = await import('@mortise/server-core/handlers/rpc/settings')
    registerSettingsHandlers(server, deps)
  })

  it('returns persisted default thinking level', async () => {
    const getHandler = handlers.get(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL)
    expect(getHandler).toBeTruthy()

    const result = await getHandler!({ clientId: 'client-1' })
    expect(result).toBe('think')
    expect(getDefaultThinkingLevelMock).toHaveBeenCalledTimes(1)
  })

  it('persists valid thinking level values', async () => {
    const setHandler = handlers.get(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL)
    expect(setHandler).toBeTruthy()

    const result = await setHandler!({ clientId: 'client-1' }, 'xhigh')
    expect(result).toEqual({ success: true })
    expect(setDefaultThinkingLevelMock).toHaveBeenCalledWith('xhigh')
    expect(setDefaultThinkingLevelMock).toHaveBeenCalledTimes(1)
  })

  it('normalizes legacy max before persistence', async () => {
    const setHandler = handlers.get(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL)
    expect(setHandler).toBeTruthy()

    const result = await setHandler!({ clientId: 'client-1' }, 'max')
    expect(result).toEqual({ success: true })
    expect(setDefaultThinkingLevelMock).toHaveBeenCalledWith('xhigh')
  })

  it('rejects invalid thinking level values before persistence', async () => {
    const setHandler = handlers.get(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL)
    expect(setHandler).toBeTruthy()

    await expect(setHandler!({ clientId: 'client-1' }, 'ultra')).rejects.toThrow('Invalid thinking level')
    expect(setDefaultThinkingLevelMock).not.toHaveBeenCalled()
  })

  it('returns persisted mid-stream behavior', async () => {
    const getHandler = handlers.get(RPC_CHANNELS.settings.GET_MID_STREAM_BEHAVIOR)
    expect(getHandler).toBeTruthy()

    const result = await getHandler!({ clientId: 'client-1' })
    expect(result).toBe('steer')
    expect(getMidStreamBehaviorMock).toHaveBeenCalledTimes(1)
  })

  it('persists valid mid-stream behavior values', async () => {
    const setHandler = handlers.get(RPC_CHANNELS.settings.SET_MID_STREAM_BEHAVIOR)
    expect(setHandler).toBeTruthy()

    const result = await setHandler!({ clientId: 'client-1' }, 'queue')
    expect(result).toEqual({ success: true })
    expect(setMidStreamBehaviorMock).toHaveBeenCalledWith('queue')
    expect(setMidStreamBehaviorMock).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid mid-stream behavior values before persistence', async () => {
    const setHandler = handlers.get(RPC_CHANNELS.settings.SET_MID_STREAM_BEHAVIOR)
    expect(setHandler).toBeTruthy()

    await expect(setHandler!({ clientId: 'client-1' }, 'abort')).rejects.toThrow('Invalid mid-stream behavior')
    expect(setMidStreamBehaviorMock).not.toHaveBeenCalled()
  })
})
