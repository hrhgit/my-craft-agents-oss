import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { WorkspaceTopologyStore } from '@mortise/shared/workspaces'
import type { Workspace } from '@mortise/core/types'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'

const sequence: string[] = []
const setActiveWorkspace = mock((_workspaceId: string) => {
  sequence.push('persist')
})
const addWorkspace = mock((workspace: Omit<Workspace, 'id' | 'createdAt' | 'slug'>): Workspace => ({
  ...workspace,
  id: 'workspace-created',
  slug: 'workspace-created',
  createdAt: 2,
}))
const workspaceRoot = mkdtempSync(join(tmpdir(), 'mortise-workspace-switch-'))
const workspaceB: Workspace = {
  schemaVersion: 2 as const,
  id: 'workspace-b',
  revision: 0,
  name: 'Workspace B',
  nameSource: 'custom',
  slug: 'workspace-b',
  primaryLocationId: 'primary',
  locations: [{
    id: 'primary',
    name: 'Primary',
    rootName: 'mortise-workspace-switch',
    endpoint: { kind: 'local', rootPath: workspaceRoot },
  }],
  createdAt: 1,
}
const getWorkspaceByNameOrId = mock((workspaceId: string) => workspaceId === 'workspace-b'
  ? workspaceB
  : null)
const openWorkspaceExtensions = mock(async (_workspace: Workspace) => ({
  workspaceId: 'workspace-created',
  workspaceRoot,
  loadedAt: 0,
  extensions: [],
  failures: [],
}))

mock.module('@mortise/shared/config', () => ({
  CONFIG_DIR: 'C:\\mortise-test',
  addWorkspace,
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

function createHarness(
  options: { failRouting?: boolean } = {},
  channel: string = RPC_CHANNELS.window.SWITCH_WORKSPACE,
  topologyStore = new WorkspaceTopologyStore({ databasePath: ':memory:', writerId: 'workspace-switch-test' }),
) {
  const server = new TestRpcServer()
  server.updateClientWorkspace = async () => {
    sequence.push('transport')
    if (options.failRouting) throw new Error('routing failed')
  }

  const deps = {
    sessionManager: {
      getWorkspaces: () => [workspaceB],
      openWorkspaceExtensions,
      setupConfigWatcher: () => sequence.push('watcher'),
      clearActiveViewingSession: () => {},
      interruptWorkspaceSessionsForTopologyChange: async () => ({
        selectedSessionIds: [],
        interruptedSessionIds: [],
      }),
      updateWorkspaceTopology: () => {},
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

  registerWorkspaceCoreHandlers(
    server,
    deps,
    topologyStore,
  )
  const handler = server.handlers.get(channel)
  if (!handler) throw new Error(`${channel} handler not registered`)
  return handler
}

describe('workspace switch active-workspace persistence', () => {
  afterAll(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })
  beforeEach(() => {
    sequence.length = 0
    addWorkspace.mockClear()
    setActiveWorkspace.mockClear()
    getWorkspaceByNameOrId.mockClear()
    openWorkspaceExtensions.mockClear()
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

  it('opens an existing folder with a derived Workspace name using the V2 contract', async () => {
    const rootPath = join(workspaceRoot, 'opened-project')
    mkdirSync(rootPath, { recursive: true })
    const handler = createHarness({}, RPC_CHANNELS.workspaces.CREATE)

    await expect(handler(ctx, {
      schemaVersion: 1,
      locations: [{ rootPath }],
    })).resolves.toMatchObject({
      action: 'created',
      workspace: {
        id: 'workspace-created',
        name: 'opened-project',
        nameSource: 'derived',
        primaryLocationId: 'primary',
      },
    })

    expect(addWorkspace).toHaveBeenCalledWith({
      schemaVersion: 2,
      revision: 0,
      name: 'opened-project',
      nameSource: 'derived',
      primaryLocationId: 'primary',
      locations: [{
        id: 'primary',
        name: 'opened-project',
        rootName: 'opened-project',
        endpoint: { kind: 'local', rootPath },
      }],
    })
    expect(setActiveWorkspace).toHaveBeenCalledWith('workspace-created')
  })

  it('creates a named Workspace with a custom name using the V2 contract', async () => {
    const rootPath = join(workspaceRoot, 'custom-name')
    mkdirSync(rootPath, { recursive: true })
    const handler = createHarness({}, RPC_CHANNELS.workspaces.CREATE)

    await expect(handler(ctx, {
      schemaVersion: 1,
      name: 'custom-name',
      locations: [{ rootPath }],
    })).resolves.toMatchObject({
      action: 'created',
      workspace: {
        id: 'workspace-created',
        name: 'custom-name',
        nameSource: 'custom',
      },
    })

    expect(addWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 2,
      revision: 0,
      name: 'custom-name',
      nameSource: 'custom',
      primaryLocationId: 'primary',
      locations: [expect.objectContaining({
        rootName: 'custom-name',
        endpoint: { kind: 'local', rootPath },
      })],
    }))
  })

  it('opens extensions with the canonical Workspace record and includes attached folders', async () => {
    const rootPath = join(workspaceRoot, 'primary')
    const attachedRoot = join(workspaceRoot, 'attached')
    mkdirSync(rootPath, { recursive: true })
    mkdirSync(attachedRoot, { recursive: true })
    const handler = createHarness({}, RPC_CHANNELS.workspaces.CREATE)

    await expect(handler(ctx, {
      schemaVersion: 1,
      name: 'Primary',
      locations: [{ rootPath }, { rootPath: attachedRoot }],
      primaryLocationIndex: 1,
    })).resolves.toMatchObject({
      action: 'created',
      workspace: { id: 'workspace-created', primaryLocationId: 'primary' },
    })

    expect(openWorkspaceExtensions).toHaveBeenCalledWith(expect.objectContaining({
      primaryLocationId: 'primary',
      locations: [
        expect.objectContaining({ id: 'location-1', endpoint: { kind: 'local', rootPath } }),
        expect.objectContaining({ id: 'primary', endpoint: { kind: 'local', rootPath: attachedRoot } }),
      ],
    }))
  })

  it('restores a removed Workspace when the selected location carries its marker', async () => {
    const rootPath = join(workspaceRoot, 'removed-workspace')
    mkdirSync(rootPath, { recursive: true })
    const topologyStore = new WorkspaceTopologyStore({ databasePath: ':memory:', writerId: 'workspace-restore-test' })
    const removed = topologyStore.create({
      schemaVersion: 2,
      id: 'workspace-removed',
      revision: 0,
      name: 'Removed',
      nameSource: 'custom',
      slug: 'removed',
      primaryLocationId: 'primary',
      locations: [{
        id: 'primary',
        name: 'Removed',
        rootName: 'removed-workspace',
        endpoint: { kind: 'local', rootPath },
      }],
      createdAt: 1,
    })
    expect(topologyStore.remove(removed.id, 'remove-before-reconnect')).toBeTrue()
    const handler = createHarness({}, RPC_CHANNELS.workspaces.CREATE, topologyStore)

    await expect(handler(ctx, {
      schemaVersion: 1,
      locations: [{ rootPath }],
    })).resolves.toMatchObject({
      action: 'reconnected',
      workspace: { id: removed.id, name: removed.name },
    })

    expect(addWorkspace).not.toHaveBeenCalled()
    expect(setActiveWorkspace).toHaveBeenCalledWith(removed.id)
  })
})
