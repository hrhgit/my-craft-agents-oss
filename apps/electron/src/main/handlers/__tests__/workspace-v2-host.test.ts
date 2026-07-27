import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { Workspace } from '@mortise/core/types'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { HandlerDeps } from '../handler-deps'

let configWorkspaces: Workspace[] = []
let topologyWorkspace: Workspace | null = null
let remoteClientCreations = 0
let remoteDiscoveryWorkspaces: unknown[] = []
const transferWorkspaceFile = mock(async () => ({
  workspaceId: 'workspace-local',
  sourceLocationId: 'source',
  destinationLocationId: 'destination',
  revision: 3,
  mode: 'copy' as const,
  sha256: 'a'.repeat(64),
  bytes: 12,
  sourceRemoved: false,
}))

mock.module('@mortise/shared/config', () => ({
  getWorkspaceByNameOrId: (workspaceId: string) => (
    configWorkspaces.find(workspace => workspace.id === workspaceId) ?? null
  ),
  loadStoredConfig: () => ({
    workspaces: configWorkspaces,
    activeWorkspaceId: null,
    activeSessionId: null,
  }),
  saveConfig: (config: { workspaces: Workspace[] }) => {
    configWorkspaces = config.workspaces
  },
}))

mock.module('@mortise/shared/workspaces', () => ({
  getDefaultWorkspaceTopologyStore: () => ({
    get: (workspaceId: string) => topologyWorkspace?.id === workspaceId ? topologyWorkspace : null,
    create: (workspace: Workspace) => {
      topologyWorkspace ??= workspace
      return topologyWorkspace
    },
  }),
}))

mock.module('@mortise/shared/credentials', () => ({
  getCredentialManager: () => ({
    getWorkspaceRemoteBearer: async () => 'secret-token',
  }),
}))

mock.module('@mortise/server-core/handlers/rpc/workspace-transfer', () => ({ transferWorkspaceFile }))

mock.module('@mortise/server-core/transport', () => ({
  WsRpcClient: class {
    private connectionListener?: (state: { status: string }) => void

    constructor(_url: string, readonly options: { token: string }) {
      remoteClientCreations += 1
    }

    onConnectionStateChanged(listener: (state: { status: string }) => void) {
      this.connectionListener = listener
      return () => { this.connectionListener = undefined }
    }

    connect() {
      this.connectionListener?.({ status: 'connected' })
    }

    getConnectionState() { return { status: 'connected' } }
    getServerVersion() { return 'test' }
    destroy() {}
    isChannelAvailable() { return true }

    async invoke(channel: string) {
      if (channel === RPC_CHANNELS.server.CREATE_WORKSPACE) {
        return {
          id: 'remote-generated',
          primaryLocationId: 'primary',
          locations: [{ id: 'primary', rootName: 'remote-root' }],
        }
      }
      if (channel === RPC_CHANNELS.server.GET_WORKSPACES) return remoteDiscoveryWorkspaces
      return undefined
    }
  },
}))

type Handler = (ctx: { workspaceId?: string | null }, ...args: unknown[]) => Promise<unknown>

function handlers() {
  const registered = new Map<string, Handler>()
  const server = {
    handle: (channel: string, handler: Handler) => registered.set(channel, handler),
  }
  const deps = {
    sessionManager: { getWorkspaces: () => configWorkspaces },
    platform: { logger: console },
  } as unknown as HandlerDeps
  return { registered, server, deps }
}

function localWorkspace(): Workspace {
  return {
    schemaVersion: 2,
    id: 'workspace-local',
    revision: 3,
    name: 'Local',
    nameSource: 'custom',
    slug: 'local',
    primaryLocationId: 'source',
    locations: [
      { id: 'source', name: 'Source', rootName: 'source', endpoint: { kind: 'local', rootPath: 'C:\\source' } },
      { id: 'destination', name: 'Destination', rootName: 'destination', endpoint: { kind: 'local', rootPath: 'C:\\destination' } },
    ],
    createdAt: 1,
  }
}

beforeEach(() => {
  configWorkspaces = []
  topologyWorkspace = null
  remoteClientCreations = 0
  remoteDiscoveryWorkspaces = []
  transferWorkspaceFile.mockClear()
})

describe('Workspace V2 host handlers', () => {
  it('projects the verified remote root name during connection discovery', async () => {
    remoteDiscoveryWorkspaces = [{
      id: 'remote-existing',
      name: 'Existing',
      primaryLocationId: 'primary',
      locations: [{ id: 'primary', rootName: 'existing-root' }],
    }]
    const harness = handlers()
    const { registerWorkspaceGuiHandlers } = await import('../workspace')
    registerWorkspaceGuiHandlers(harness.server as never, harness.deps)
    const result = await harness.registered.get(RPC_CHANNELS.remote.TEST_CONNECTION)!(
      {},
      'wss://remote.example',
      'secret-token',
    ) as { remoteWorkspaces: unknown[]; remoteWorkspaceRootName: string }

    expect(result.remoteWorkspaces).toEqual([{
      id: 'remote-existing', name: 'Existing', rootName: 'existing-root',
    }])
    expect(result.remoteWorkspaceRootName).toBe('existing-root')
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('creates a remote-primary Workspace without exposing credential material', async () => {
    const harness = handlers()
    const { registerWorkspaceGuiHandlers } = await import('../workspace')
    registerWorkspaceGuiHandlers(harness.server as never, harness.deps)
    const command = {
      schemaVersion: 1,
      operation: 'create-and-connect',
      operationId: 'remote-create-1',
      workspaceId: 'workspace-logical',
      locationId: 'remote-primary',
      displayName: { source: 'custom', name: 'Remote Product' },
      remoteRootName: 'remote-root',
      server: { url: 'wss://remote.example', credentialRef: 'credential-ref' },
    }
    const handler = harness.registered.get(RPC_CHANNELS.workspaces.REMOTE_PRIMARY_COMMAND)!
    const [applied, duplicate] = await Promise.all([
      handler({}, command),
      handler({}, command),
    ]) as Array<{ status: string; workspace: unknown }>

    expect(applied.status).toBe('applied')
    expect(duplicate.status).toBe('duplicate')
    expect(configWorkspaces[0]).toMatchObject({
      id: 'workspace-logical',
      name: 'Remote Product',
      nameSource: 'custom',
      primaryLocationId: 'remote-primary',
      locations: [{
        rootName: 'remote-root',
        endpoint: { kind: 'remote', remoteWorkspaceId: 'remote-generated', credentialRef: 'credential-ref' },
      }],
    })
    expect(JSON.stringify(applied)).not.toContain('secret-token')
    expect(JSON.stringify(applied)).not.toContain('credentialRef')

    expect(remoteClientCreations).toBe(1)
  })

  it('returns a duplicate transfer receipt without repeating file I/O', async () => {
    configWorkspaces = [localWorkspace()]
    topologyWorkspace = configWorkspaces[0]
    const harness = handlers()
    const { registerWorkspaceGuiHandlers } = await import('../workspace')
    registerWorkspaceGuiHandlers(harness.server as never, harness.deps)
    const request = {
      schemaVersion: 1,
      operationId: 'transfer-1',
      workspaceId: 'workspace-local',
      expectedRevision: 3,
      mode: 'copy',
      source: { schemaVersion: 1, workspaceId: 'workspace-local', locationId: 'source', relativePath: 'a.txt' },
      destination: { schemaVersion: 1, workspaceId: 'workspace-local', locationId: 'destination', relativePath: 'a.txt' },
    }
    const handler = harness.registered.get(RPC_CHANNELS.workspaces.TRANSFER)!

    const [applied, duplicate] = await Promise.all([
      handler({ workspaceId: 'workspace-local' }, request),
      handler({ workspaceId: 'workspace-local' }, request),
    ])
    expect(applied).toMatchObject({ status: 'applied' })
    expect(duplicate).toMatchObject({ status: 'duplicate' })
    expect(transferWorkspaceFile).toHaveBeenCalledTimes(1)
  })
})
