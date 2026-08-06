import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Workspace } from '@mortise/core/types'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { getWorkspaceMarkerPath, WorkspaceTopologyStore, type LegacyWorkspaceV1 } from '@mortise/shared/workspaces'
import type { HandlerDeps } from '../handler-deps'
import { CLIENT_ROUTE_WORKSPACE_MARKER_DETACH, type HandlerFn, type RpcServer } from '../../transport'
import { registerWorkspaceTopologyHandlers } from './workspace-topology'

function createHarness(
  candidate: Workspace | LegacyWorkspaceV1 | null,
  options?: {
    clientCapabilities?: string[]
    invokeClient?: (clientId: string, channel: string, ...args: unknown[]) => Promise<unknown>
  },
) {
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
    async invokeClient(clientId, channel, ...args) {
      return await options?.invokeClient?.(clientId, channel, ...args)
    },
    hasClientCapability(_clientId, capability) {
      return options?.clientCapabilities?.includes(capability) ?? false
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
  it('removes only the authenticated backend marker and treats a retry as already complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-marker-'))
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
      const context = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null }
      await harness.handlers.get(RPC_CHANNELS.workspaces.GET_TOPOLOGY)!(context)
      await writeFile(join(root, 'ordinary.txt'), 'preserved')
      const detachMarker = harness.handlers.get(RPC_CHANNELS.workspaces.DETACH_MARKER)!
      const request = { schemaVersion: 1, workspaceId: 'workspace-1', operationId: 'detach-marker' }

      await expect(detachMarker(context, request)).resolves.toMatchObject({ status: 'removed' })
      await expect(detachMarker(context, request)).resolves.toMatchObject({ status: 'already-absent' })
      expect(existsSync(getWorkspaceMarkerPath(root))).toBe(false)
      expect(existsSync(join(root, 'ordinary.txt'))).toBe(true)
      harness.store.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes remote marker removal to the selected backend before committing detach', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-remote-detach-'))
    const routed: Array<{ clientId: string; channel: string; request: unknown }> = []
    try {
      const candidate: Workspace = {
        schemaVersion: 2,
        id: 'workspace-1',
        revision: 0,
        name: 'Workspace',
        nameSource: 'derived',
        slug: 'workspace',
        primaryLocationId: 'primary',
        locations: [
          { id: 'primary', name: 'Primary', rootName: 'Workspace', endpoint: { kind: 'local', rootPath: root } },
          {
            id: 'remote',
            name: 'Remote',
            rootName: 'remote-root',
            endpoint: {
              kind: 'remote',
              url: 'wss://remote.example',
              remoteWorkspaceId: 'remote-workspace',
              credentialRef: 'credential',
            },
          },
        ],
        createdAt: 1,
      }
      const harness = createHarness(candidate, {
        clientCapabilities: [CLIENT_ROUTE_WORKSPACE_MARKER_DETACH],
        invokeClient: async (clientId, channel, request) => {
          harness.lifecycle.push('route-marker')
          routed.push({ clientId, channel, request })
          return { status: 'removed' }
        },
      })
      const handler = harness.handlers.get(RPC_CHANNELS.workspaces.TOPOLOGY_COMMAND)!
      await expect(handler(
        { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null },
        {
          schemaVersion: 1,
          workspaceId: 'workspace-1',
          operationId: 'detach-remote',
          expectedRevision: 0,
          operation: 'detach',
          locationId: 'remote',
        },
      )).resolves.toMatchObject({ status: 'applied', workspace: { locations: [{ id: 'primary' }] } })
      expect(routed).toEqual([{
        clientId: 'client-1',
        channel: CLIENT_ROUTE_WORKSPACE_MARKER_DETACH,
        request: { workspaceId: 'workspace-1', locationId: 'remote', operationId: 'detach-remote' },
      }])
      expect(harness.lifecycle.indexOf('route-marker')).toBeLessThan(harness.lifecycle.indexOf('apply'))
      harness.store.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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

  it('renames Workspace metadata without interrupting work or reporting a location change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mortise-topology-rpc-rename-'))
    try {
      const candidate: Workspace = {
        schemaVersion: 2,
        id: 'workspace-1',
        revision: 0,
        name: 'Original',
        nameSource: 'custom',
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
      const handler = harness.handlers.get(RPC_CHANNELS.workspaces.TOPOLOGY_COMMAND)!
      const result = await handler({
        clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null,
      }, {
        schemaVersion: 1,
        workspaceId: 'workspace-1',
        operationId: 'rename-workspace',
        expectedRevision: 0,
        operation: 'rename-workspace',
        name: 'Renamed Workspace',
      })

      expect(result).toMatchObject({
        status: 'applied',
        workspace: { name: 'Renamed Workspace', nameSource: 'custom', revision: 1 },
      })
      expect(harness.interruptions).toEqual([])
      expect(harness.lifecycle).toEqual(['apply', 'session-update', 'publish'])
      expect(harness.pushes[0]!.args[0]).toMatchObject({
        operation: 'rename-workspace',
        changedLocationIds: [],
      })
      harness.store.close()
    } finally {
      await rm(root, { recursive: true, force: true })
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
