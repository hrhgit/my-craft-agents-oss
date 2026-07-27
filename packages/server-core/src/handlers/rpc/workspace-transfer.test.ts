import { createHash } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@mortise/core/types'
import { RPC_CHANNELS, type WorkspaceTransferRequestV1 } from '@mortise/shared/protocol'
import { WorkspaceTopologyStore } from '@mortise/shared/workspaces'
import type { HandlerFn, RpcServer } from '../../transport'
import {
  registerWorkspaceTransferHandlers,
  transferWorkspaceFile,
  type WorkspaceLocalTransferRequest,
} from './workspace-transfer'

async function createHarness() {
  const primaryRoot = await mkdtemp(join(tmpdir(), 'mortise-transfer-primary-'))
  const attachedRoot = await mkdtemp(join(tmpdir(), 'mortise-transfer-attached-'))
  const store = new WorkspaceTopologyStore({ databasePath: ':memory:', writerId: 'workspace-transfer-test' })
  const workspace: Workspace = {
    schemaVersion: 2,
    id: 'workspace-1',
    revision: 0,
    name: 'Workspace',
    nameSource: 'custom',
    slug: 'workspace',
    primaryLocationId: 'primary',
    locations: [
      { id: 'primary', name: 'Primary', rootName: 'primary', endpoint: { kind: 'local', rootPath: primaryRoot } },
      { id: 'attached', name: 'Attached', rootName: 'attached', endpoint: { kind: 'local', rootPath: attachedRoot } },
    ],
    createdAt: 1,
  }
  store.create(workspace)
  const request = (mode: 'copy' | 'move'): WorkspaceLocalTransferRequest => ({
    source: {
      schemaVersion: 1,
      workspaceId: workspace.id,
      locationId: 'primary',
      relativePath: 'source.txt',
    },
    destination: {
      schemaVersion: 1,
      workspaceId: workspace.id,
      locationId: 'attached',
      relativePath: 'destination.txt',
    },
    expectedRevision: 0,
    mode,
  })
  return { primaryRoot, attachedRoot, store, request }
}

describe('local Workspace transfer', () => {
  it('stages, verifies, and atomically publishes a qualified cross-location copy', async () => {
    const harness = await createHarness()
    try {
      const content = 'transfer payload'
      await writeFile(join(harness.primaryRoot, 'source.txt'), content)
      const expectedSha256 = createHash('sha256').update(content).digest('hex')
      const result = await transferWorkspaceFile(harness.store, {
        ...harness.request('copy'),
        expectedSha256,
      })

      expect(result).toEqual({
        workspaceId: 'workspace-1',
        sourceLocationId: 'primary',
        destinationLocationId: 'attached',
        revision: 0,
        mode: 'copy',
        sha256: expectedSha256,
        bytes: Buffer.byteLength(content),
        sourceRemoved: false,
      })
      expect(await readFile(join(harness.primaryRoot, 'source.txt'), 'utf-8')).toBe(content)
      expect(await readFile(join(harness.attachedRoot, 'destination.txt'), 'utf-8')).toBe(content)
      expect((await readdir(harness.attachedRoot)).some(name => name.startsWith('.mortise-transfer-'))).toBe(false)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('removes the source only after a verified destination publish', async () => {
    const harness = await createHarness()
    try {
      await writeFile(join(harness.primaryRoot, 'source.txt'), 'move payload')
      await expect(transferWorkspaceFile(harness.store, harness.request('move'))).resolves.toMatchObject({
        mode: 'move',
        sourceRemoved: true,
      })
      await expect(readFile(join(harness.primaryRoot, 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(harness.attachedRoot, 'destination.txt'), 'utf-8')).toBe('move payload')
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('rejects stale revisions and checksum mismatches without publishing a destination', async () => {
    const harness = await createHarness()
    try {
      await writeFile(join(harness.primaryRoot, 'source.txt'), 'payload')
      await expect(transferWorkspaceFile(harness.store, {
        ...harness.request('copy'),
        expectedRevision: 1,
      })).rejects.toMatchObject({ code: 'WORKSPACE_STALE_REVISION' })
      await expect(transferWorkspaceFile(harness.store, {
        ...harness.request('copy'),
        expectedSha256: '0'.repeat(64),
      })).rejects.toThrow('checksum mismatch')
      await expect(readFile(join(harness.attachedRoot, 'destination.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(harness.attachedRoot)).some(name => name.startsWith('.mortise-transfer-'))).toBe(false)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('registers the transfer RPC and replays a durable operation receipt without copying twice', async () => {
    const harness = await createHarness()
    try {
      await writeFile(join(harness.primaryRoot, 'source.txt'), 'rpc payload')
      const handlers = new Map<string, HandlerFn>()
      const server = {
        handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
        push() {},
        async invokeClient() { return undefined },
        hasClientCapability() { return false },
        findClientsWithCapability() { return [] },
      } as RpcServer
      registerWorkspaceTransferHandlers(server, harness.store)
      const handler = handlers.get(RPC_CHANNELS.workspaces.TRANSFER)!
      const context = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null }
      const request: WorkspaceTransferRequestV1 = {
        schemaVersion: 1,
        operationId: 'transfer-1',
        workspaceId: 'workspace-1',
        ...harness.request('copy'),
      }

      const concurrent = await Promise.all([
        handler(context, request),
        handler(context, request),
      ]) as Array<{ operationId: string; status: string }>
      expect(concurrent.map(result => result.status).sort()).toEqual(['applied', 'duplicate'])
      expect(concurrent.every(result => result.operationId === 'transfer-1')).toBe(true)
      await expect(handler(context, request)).resolves.toMatchObject({
        operationId: 'transfer-1',
        status: 'duplicate',
      })
      await expect(handler(context, {
        ...request,
        destination: { ...request.destination, relativePath: 'different.txt' },
      })).rejects.toThrow('different Workspace transfer')
      expect(await readFile(join(harness.attachedRoot, 'destination.txt'), 'utf-8')).toBe('rpc payload')
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })
})
