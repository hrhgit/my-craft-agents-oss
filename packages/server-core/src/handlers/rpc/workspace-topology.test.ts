import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@mortise/core/types'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { WorkspaceTopologyStore, type LegacyWorkspaceV1 } from '@mortise/shared/workspaces'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RpcServer } from '../../transport'
import { registerWorkspaceTopologyHandlers } from './workspace-topology'

function createHarness(candidate: Workspace | LegacyWorkspaceV1 | null) {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(channel, target, ...args) {
      pushes.push({ channel, target, args })
    },
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }
  const deps = {
    sessionManager: {
      getWorkspaces: () => candidate ? [candidate] : [],
    },
    platform: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  } as unknown as HandlerDeps
  const store = new WorkspaceTopologyStore({ databasePath: ':memory:', writerId: 'workspace-topology-rpc-test' })
  registerWorkspaceTopologyHandlers(server, deps, store)
  return { handlers, pushes, store }
}

describe('Workspace topology RPC', () => {
  it('migrates a legacy candidate once and serves later reads from topology state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-migrate-'))
    try {
      const candidate: LegacyWorkspaceV1 = {
        id: 'workspace-1',
        name: 'Legacy',
        slug: 'legacy',
        rootPath: root,
        createdAt: 1,
      }
      const harness = createHarness(candidate)
      const getTopology = harness.handlers.get(RPC_CHANNELS.workspaces.GET_TOPOLOGY)!
      const context = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null }

      const first = await getTopology(context) as { revision: number; locations: Array<{ id: string }> }
      candidate.name = 'Changed legacy projection'
      candidate.rootPath = join(root, 'missing')
      const second = await getTopology(context) as { name: string; revision: number; locations: Array<{ id: string }> }

      expect(first).toMatchObject({ revision: 0, locations: [{ id: 'primary' }] })
      expect(second).toMatchObject({ name: 'Legacy', revision: 0, locations: [{ id: 'primary' }] })
      harness.store.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('broadcasts a newly applied mutation once and not its idempotent replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-primary-'))
    const attached = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-attached-'))
    try {
      const candidate: Workspace = {
        schemaVersion: 2,
        id: 'workspace-1',
        revision: 0,
        name: 'Workspace',
        slug: 'workspace',
        primaryLocationId: 'primary',
        locations: [{ id: 'primary', name: 'Primary', endpoint: { kind: 'local', rootPath: root } }],
        createdAt: 1,
      }
      const harness = createHarness(candidate)
      const commandHandler = harness.handlers.get(RPC_CHANNELS.workspaces.TOPOLOGY_COMMAND)!
      const context = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null }
      const command = {
        schemaVersion: 1,
        workspaceId: 'workspace-1',
        operationId: 'attach-assets',
        expectedRevision: 0,
        operation: 'attach-local',
        locationId: 'assets',
        name: 'Assets',
        rootPath: attached,
      }

      await expect(commandHandler(context, command)).resolves.toMatchObject({ status: 'applied' })
      await expect(commandHandler(context, command)).resolves.toMatchObject({ status: 'duplicate' })
      expect(harness.pushes).toHaveLength(1)
      expect(harness.pushes[0]).toMatchObject({
        channel: RPC_CHANNELS.workspaces.TOPOLOGY_CHANGED,
        target: { to: 'all', exclude: 'client-1' },
      })
      expect(harness.pushes[0]!.args[0]).toMatchObject({
        workspaceId: 'workspace-1',
        operationId: 'attach-assets',
        previousRevision: 0,
        revision: 1,
        changedLocationIds: ['assets'],
      })
      harness.store.close()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(attached, { recursive: true, force: true })
    }
  })

  it('rejects topology access for a Workspace outside the trusted registry', async () => {
    const harness = createHarness(null)
    const getTopology = harness.handlers.get(RPC_CHANNELS.workspaces.GET_TOPOLOGY)!
    await expect(getTopology({
      clientId: 'client-1',
      workspaceId: 'missing',
      webContentsId: null,
    })).rejects.toThrow('Workspace not found: missing')
    await expect(getTopology({
      clientId: 'client-1',
      workspaceId: 'trusted',
      webContentsId: null,
    }, 'other')).rejects.toThrow('Workspace mismatch')
    harness.store.close()
  })
})
