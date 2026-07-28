import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Workspace } from '@mortise/core/types'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { WorkspaceTopologyStore, type LegacyWorkspaceV1 } from '@mortise/shared/workspaces'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RpcServer } from '../../transport'
import { registerWorkspaceTopologyHandlers } from './workspace-topology'

function createHarness(candidate: Workspace | LegacyWorkspaceV1 | null) {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const interruptions: unknown[] = []
  const topologyUpdates: Workspace[] = []
  const lifecycle: string[] = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(channel, target, ...args) {
      lifecycle.push('publish')
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
      async interruptWorkspaceSessionsForTopologyChange(target: unknown) {
        lifecycle.push('session-interrupt')
        interruptions.push(target)
      },
      updateWorkspaceTopology(workspace: Workspace) {
        lifecycle.push('session-update')
        topologyUpdates.push(workspace)
      },
      getAutomationHost() {
        return {
          async interruptForWorkspaceTopologyChange() {
            lifecycle.push('automation-interrupt')
            return { interruptedRunIds: [] }
          },
          async resumeAfterWorkspaceTopologyChange() {
            lifecycle.push('automation-resume')
          },
        }
      },
    },
    platform: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  } as unknown as HandlerDeps
  const store = new WorkspaceTopologyStore({ databasePath: ':memory:', writerId: 'workspace-topology-rpc-test' })
  const apply = store.apply.bind(store)
  store.apply = (command) => {
    lifecycle.push('apply')
    return apply(command)
  }
  registerWorkspaceTopologyHandlers(server, deps, store)
  return { handlers, pushes, interruptions, topologyUpdates, lifecycle, store }
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
        nameSource: 'derived',
        slug: 'workspace',
        primaryLocationId: 'primary',
        locations: [{
          id: 'primary',
          name: 'Primary',
          rootName: 'Workspace',
          endpoint: { kind: 'local', rootPath: root },
        }],
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
      expect(harness.topologyUpdates).toHaveLength(1)
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

  it('interrupts the required scope before a destructive mutation and not on replay', async () => {
    const primary = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-primary-'))
    const attached = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-attached-'))
    try {
      const candidate: Workspace = {
        schemaVersion: 2,
        id: 'workspace-1',
        revision: 0,
        name: 'primary',
        nameSource: 'derived',
        slug: 'workspace',
        primaryLocationId: 'primary',
        locations: [
          { id: 'primary', name: 'Primary', rootName: 'primary', endpoint: { kind: 'local', rootPath: primary } },
          { id: 'attached', name: 'Attached', rootName: 'attached', endpoint: { kind: 'local', rootPath: attached } },
        ],
        createdAt: 1,
      }
      const harness = createHarness(candidate)
      const handler = harness.handlers.get(RPC_CHANNELS.workspaces.TOPOLOGY_COMMAND)!
      const context = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null }
      const command = {
        schemaVersion: 1,
        workspaceId: 'workspace-1',
        operationId: 'set-primary',
        expectedRevision: 0,
        operation: 'set-primary',
        locationId: 'attached',
      }

      await expect(handler(context, command)).resolves.toMatchObject({ status: 'applied' })
      await expect(handler(context, command)).resolves.toMatchObject({ status: 'duplicate' })
      expect(harness.interruptions).toEqual([{ workspaceId: 'workspace-1', scope: 'workspace' }])
      expect(harness.lifecycle).toEqual([
        'automation-interrupt',
        'session-interrupt',
        'apply',
        'session-update',
        'publish',
        'automation-resume',
      ])
      expect(harness.topologyUpdates).toHaveLength(1)
      expect(harness.topologyUpdates[0]).toMatchObject({
        primaryLocationId: 'attached',
        name: basename(attached),
      })
      harness.store.close()
    } finally {
      await rm(primary, { recursive: true, force: true })
      await rm(attached, { recursive: true, force: true })
    }
  })

  it('keeps the scheduler paused until a failed topology mutation is definitive', async () => {
    const primary = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-failure-primary-'))
    const attached = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-failure-attached-'))
    try {
      const candidate: Workspace = {
        schemaVersion: 2,
        id: 'workspace-1',
        revision: 0,
        name: 'primary',
        nameSource: 'derived',
        slug: 'workspace',
        primaryLocationId: 'primary',
        locations: [
          { id: 'primary', name: 'Primary', rootName: 'primary', endpoint: { kind: 'local', rootPath: primary } },
          { id: 'attached', name: 'Attached', rootName: 'attached', endpoint: { kind: 'local', rootPath: attached } },
        ],
        createdAt: 1,
      }
      const harness = createHarness(candidate)
      harness.store.apply = () => {
        harness.lifecycle.push('apply-failed')
        throw new Error('planned topology failure')
      }
      const handler = harness.handlers.get(RPC_CHANNELS.workspaces.TOPOLOGY_COMMAND)!

      await expect(handler({
        clientId: 'client-1',
        workspaceId: 'workspace-1',
        webContentsId: null,
      }, {
        schemaVersion: 1,
        workspaceId: 'workspace-1',
        operationId: 'set-primary-failure',
        expectedRevision: 0,
        operation: 'set-primary',
        locationId: 'attached',
      })).rejects.toThrow('planned topology failure')
      expect(harness.lifecycle).toEqual([
        'automation-interrupt',
        'session-interrupt',
        'apply-failed',
        'automation-resume',
      ])
      expect(harness.topologyUpdates).toEqual([])
      expect(harness.pushes).toEqual([])
      harness.store.close()
    } finally {
      await rm(primary, { recursive: true, force: true })
      await rm(attached, { recursive: true, force: true })
    }
  })

  it('serves an authoritative topology without requiring a legacy registry candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-authority-'))
    try {
      const harness = createHarness(null)
      harness.store.create({
        schemaVersion: 2,
        id: 'workspace-1',
        revision: 0,
        name: 'authoritative',
        nameSource: 'custom',
        slug: 'authoritative',
        primaryLocationId: 'primary',
        locations: [{
          id: 'primary',
          name: 'Primary',
          rootName: 'authority-root',
          endpoint: { kind: 'local', rootPath: root },
        }],
        createdAt: 1,
      })
      const getTopology = harness.handlers.get(RPC_CHANNELS.workspaces.GET_TOPOLOGY)!

      await expect(getTopology({
        clientId: 'client-1',
        workspaceId: 'workspace-1',
        webContentsId: null,
      })).resolves.toMatchObject({ id: 'workspace-1', name: 'authoritative' })
      harness.store.close()
    } finally {
      await rm(root, { recursive: true, force: true })
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
