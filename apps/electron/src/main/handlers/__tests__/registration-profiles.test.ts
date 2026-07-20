import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { RpcServer } from '@mortise/server-core/transport'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { HandlerDeps } from '../handler-deps'

const registeredChannels: string[] = []

mock.module('electron', () => ({
  ipcMain: {
    handle: () => {},
    on: () => {},
  },
  app: {
    isPackaged: false,
    getAppPath: () => '/',
    quit: () => {},
    dock: { setIcon: () => {}, setBadge: () => {} },
  },
  nativeTheme: { shouldUseDarkColors: false },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({}),
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => ({ response: 0 }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
    showItemInFolder: () => {},
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  BrowserView: class {},
  Menu: {
    buildFromTemplate: () => ({ popup: () => {} }),
  },
  session: {},
}))

function createMockServer(): RpcServer {
  return {
    handle(channel: string, _handler: unknown) {
      registeredChannels.push(channel)
    },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
}

function createMockDeps(): HandlerDeps {
  return {
    sessionManager: { reinitializeAuth: async () => {} } as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: console,
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    windowManager: {} as HandlerDeps['windowManager'],
    layoutCoordinator: {} as NonNullable<HandlerDeps['layoutCoordinator']>,
    browserPaneManager: {
      onStateChange: () => {},
      onRemoved: () => {},
      onInteracted: () => {},
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
  }
}

async function getExpectedCoreChannels(): Promise<Set<string>> {
  // Core handler channels (now in server-core)
  const [
    auth,
    automations,
    files,
    llm,
    sessions,
    settings,
    skills,
    system,
    workspace,
    onboarding,
    resources,
    transfer,
  ] = await Promise.all([
    import('@mortise/server-core/handlers/rpc/auth'),
    import('@mortise/server-core/handlers/rpc/automations'),
    import('@mortise/server-core/handlers/rpc/files'),
    import('@mortise/server-core/handlers/rpc/pi-providers'),
    import('@mortise/server-core/handlers/rpc/sessions'),
    import('@mortise/server-core/handlers/rpc/settings'),
    import('@mortise/server-core/handlers/rpc/skills'),
    import('@mortise/server-core/handlers/rpc/system'),
    import('@mortise/server-core/handlers/rpc/workspace'),
    import('@mortise/server-core/handlers/rpc/onboarding'),
    import('@mortise/server-core/handlers/rpc/resources'),
    import('@mortise/server-core/handlers/rpc/transfer'),
  ])

  return new Set([
    ...auth.HANDLED_CHANNELS,
    ...automations.HANDLED_CHANNELS,
    ...files.HANDLED_CHANNELS,
    ...llm.HANDLED_CHANNELS,
    ...sessions.HANDLED_CHANNELS,
    ...settings.HANDLED_CHANNELS,
    ...skills.HANDLED_CHANNELS,
    ...system.CORE_HANDLED_CHANNELS,
    ...workspace.CORE_HANDLED_CHANNELS,
    ...onboarding.HANDLED_CHANNELS,
    ...resources.HANDLED_CHANNELS,
    ...transfer.HANDLED_CHANNELS,
    RPC_CHANNELS.workspaceCoordination.GET_STATUS,
  ])
}

async function getExpectedGuiChannels(): Promise<Set<string>> {
  const [browser, system, workspace, settings, layout] = await Promise.all([
    import('../browser'),
    import('../system'),
    import('../workspace'),
    import('../settings'),
    import('../layout'),
  ])

  return new Set([
    ...browser.HANDLED_CHANNELS,
    ...system.GUI_HANDLED_CHANNELS,
    ...workspace.GUI_HANDLED_CHANNELS,
    ...settings.GUI_HANDLED_CHANNELS,
    ...layout.LAYOUT_HANDLED_CHANNELS,
  ])
}

describe('RPC handler profile registration', () => {
  beforeEach(() => {
    registeredChannels.length = 0
  })

  it('registerCoreRpcHandlers registers only core channels', async () => {
    const expected = await getExpectedCoreChannels()
    const { registerCoreRpcHandlers } = await import('../index')

    registerCoreRpcHandlers(createMockServer(), createMockDeps())

    const actual = new Set(registeredChannels.filter(ch => ch.includes(':')))
    expect([...expected].filter(ch => !actual.has(ch))).toEqual([])
    expect([...actual].filter(ch => !expected.has(ch))).toEqual([])
  })

  it('registerGuiRpcHandlers registers only gui channels', async () => {
    const expected = await getExpectedGuiChannels()
    const { registerGuiRpcHandlers } = await import('../index')

    registerGuiRpcHandlers(createMockServer(), createMockDeps())

    const actual = new Set(registeredChannels.filter(ch => ch.includes(':')))
    expect([...expected].filter(ch => !actual.has(ch))).toEqual([])
    expect([...actual].filter(ch => !expected.has(ch))).toEqual([])
  })
})
