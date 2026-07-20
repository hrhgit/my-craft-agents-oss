import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'

const sequence: string[] = []
const setActiveWorkspace = mock((_workspaceId: string) => {
  sequence.push('persist')
})
const getWorkspaceByNameOrId = mock((workspaceId: string) => workspaceId === 'workspace-b'
  ? { id: workspaceId, rootPath: 'C:\\workspace-b', name: 'Workspace B', slug: 'workspace-b', createdAt: 1 }
  : null)

mock.module('@mortise/shared/config', () => ({
  CONFIG_DIR: 'C:\\mortise-test',
  addWorkspace: () => { throw new Error('not used') },
  getWorkspaceByNameOrId,
  setActiveWorkspace,
  updateWorkspaceRemoteServer: () => { throw new Error('not used') },
}))

const { registerWorkspaceCoreHandlers } = await import('./workspace.ts')

class TestRpcServer implements RpcServer {
  readonly handlers = new Map<string, HandlerFn>()
  updateClientWorkspace?: (clientId: string, workspaceId: string) => Promise<void>

  handle(channel: string, handler: HandlerFn): void {
    this.handlers.set(channel, handler)
  }

  push(): void {}
  async invokeClient(): Promise<unknown> { return undefined }
  hasClientCapability(): boolean { return false }
  findClientsWithCapability(): string[] { return [] }
}

const ctx: RequestContext = {
  clientId: 'client-a',
  workspaceId: 'workspace-a',
  webContentsId: 101,
}

function createHarness(options: { failRouting?: boolean } = {}) {
  const server = new TestRpcServer()
  server.updateClientWorkspace = async () => {
    sequence.push('transport')
    if (options.failRouting) throw new Error('routing failed')
  }

  const deps = {
    sessionManager: {
      setupConfigWatcher: () => sequence.push('watcher'),
      clearActiveViewingSession: () => {},
    },
    windowManager: {
      getWorkspaceForWindow: () => 'workspace-a',
      updateWindowWorkspace: async () => {
        sequence.push('window')
        return true
      },
      getWindowByWebContentsId: () => null,
      registerWindow: () => {},
      getAllWindowsForWorkspace: () => [],
    },
    platform: {
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
    },
  } as unknown as HandlerDeps

  registerWorkspaceCoreHandlers(server, deps)
  const handler = server.handlers.get(RPC_CHANNELS.window.SWITCH_WORKSPACE)
  if (!handler) throw new Error('SWITCH_WORKSPACE handler not registered')
  return handler
}

describe('workspace switch active-workspace persistence', () => {
  beforeEach(() => {
    sequence.length = 0
    setActiveWorkspace.mockClear()
    getWorkspaceByNameOrId.mockClear()
  })

  it('persists the workspace only after the window and transport switch succeed', async () => {
    const handler = createHarness()

    await expect(handler(ctx, 'workspace-b')).resolves.toMatchObject({ workspaceId: 'workspace-b' })

    expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-b')
    expect(sequence).toEqual(['window', 'transport', 'persist', 'watcher'])
  })

  it('does not persist a workspace when transport routing fails', async () => {
    const handler = createHarness({ failRouting: true })

    await expect(handler(ctx, 'workspace-b')).rejects.toThrow('routing failed')

    expect(setActiveWorkspace).not.toHaveBeenCalled()
    expect(sequence).toEqual(['window', 'transport'])
  })

  it('does not persist an unknown workspace', async () => {
    const handler = createHarness()

    await expect(handler(ctx, 'missing-workspace')).rejects.toThrow('Workspace not found')

    expect(setActiveWorkspace).not.toHaveBeenCalled()
    expect(sequence).toEqual([])
  })
})
