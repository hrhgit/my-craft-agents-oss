import { describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import * as realConfig from '@mortise/shared/config'
import * as realWorkspaces from '@mortise/shared/workspaces'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'

const WORKSPACE = {
  schemaVersion: 2,
  id: 'workspace-a',
  revision: 0,
  name: 'Workspace A',
  slug: 'workspace-a',
  primaryLocationId: 'primary',
  locations: [{
    id: 'primary',
    name: 'Primary',
    endpoint: { kind: 'local', rootPath: '/workspace-a' },
  }],
  createdAt: 1,
}

// getWorkspaceOrNull (server-core/handlers utils) resolves the workspace through
// this canonical workspace lookup; the settings handler reads only its identity.
mock.module('@mortise/shared/config', () => ({
  ...realConfig,
  getWorkspaceByNameOrId: (id: string) => (id === WORKSPACE.id ? WORKSPACE : null),
}))

// SETTINGS_GET dynamically imports loadWorkspaceConfig for the workspace-scoped config.
mock.module('@mortise/shared/workspaces', () => ({
  ...realWorkspaces,
  loadWorkspaceConfig: () => ({
    name: 'Configured Name',
    defaults: {
      permissionMode: 'default',
      cyclablePermissionModes: ['default', 'plan'],
    },
  }),
}))

const { registerSettingsHandlers } = await import('./settings')

class TestRpcServer implements RpcServer {
  readonly handlers = new Map<string, HandlerFn>()

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
  workspaceId: WORKSPACE.id,
  webContentsId: null,
}

function getSettingsHandler(): HandlerFn {
  const server = new TestRpcServer()
  registerSettingsHandlers(server, {
    sessionManager: {} as unknown as HandlerDeps['sessionManager'],
    platform: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as unknown as HandlerDeps['platform'],
  } as HandlerDeps)
  const handler = server.handlers.get(RPC_CHANNELS.workspace.SETTINGS_GET)
  if (!handler) throw new Error('SETTINGS_GET handler not registered')
  return handler
}

describe('workspace settings response contract', () => {
  it('omits the removed session-level workingDirectory field', async () => {
    const handler = getSettingsHandler()
    const response = (await handler(ctx, WORKSPACE.id)) as Record<string, unknown> | null

    expect(response).not.toBeNull()
    expect(response).not.toHaveProperty('workingDirectory')
  })

  it('continues exposing workspace settings through the canonical workspace contract', async () => {
    const handler = getSettingsHandler()
    const response = (await handler(ctx, WORKSPACE.id)) as Record<string, unknown> | null

    expect(response).toMatchObject({
      name: 'Configured Name',
      permissionMode: 'default',
      cyclablePermissionModes: ['default', 'plan'],
    })
  })
})
