import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { Workspace } from '@mortise/core/types'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { HandlerDeps } from '../handler-deps'

let topologyWorkspace: Workspace | null = null
let remoteClientCreations = 0
let remoteDiscoveryWorkspaces: unknown[] = []

mock.module('@mortise/shared/config', () => ({
  getWorkspaceByNameOrId: () => { throw new Error('legacy config Workspace authority must not be read') },
  loadStoredConfig: () => { throw new Error('legacy config Workspace authority must not be read') },
  saveConfig: () => { throw new Error('legacy config Workspace authority must not be written') },
}))

mock.module('@mortise/shared/workspaces', () => ({
  initializeWorkspace: (workspace: Workspace) => {
    topologyWorkspace ??= workspace
    return topologyWorkspace
  },
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
    sessionManager: { getWorkspaces: () => [] },
    platform: { logger: console },
  } as unknown as HandlerDeps
  return { registered, server, deps }
}

beforeEach(() => {
  topologyWorkspace = null
  remoteClientCreations = 0
  remoteDiscoveryWorkspaces = []
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
    expect(topologyWorkspace).toMatchObject({
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

})
