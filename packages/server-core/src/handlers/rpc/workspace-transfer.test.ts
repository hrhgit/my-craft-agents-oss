import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Workspace } from '@mortise/core/types'
import {
  RPC_CHANNELS,
  WORKSPACE_TRANSFER_CHUNK_BYTES,
  parseWorkspaceTransferEndpointOpenV1,
  parseWorkspaceTransferEndpointReadResultV1,
  type WorkspaceTransferRequestV1,
} from '@mortise/shared/protocol'
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

function createRpcHandlers(store: WorkspaceTopologyStore): Map<string, HandlerFn> {
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as RpcServer
  registerWorkspaceTransferHandlers(server, store)
  return handlers
}

describe('local Workspace transfer', () => {
  it('rejects endpoint responses that exceed the bounded chunk contract', () => {
    expect(() => parseWorkspaceTransferEndpointReadResultV1({
      schemaVersion: 1,
      operationId: 'oversized-response',
      offset: 0,
      bytes: new Uint8Array(WORKSPACE_TRANSFER_CHUNK_BYTES + 1),
      done: false,
    })).toThrow()
  })

  it('rejects non-canonical and private endpoint paths at the protocol boundary', () => {
    const request = {
      schemaVersion: 1, operationId: 'invalid-endpoint-path', workspaceId: 'workspace-1',
      locationId: 'primary', relativePath: 'safe.txt',
    }
    expect(() => parseWorkspaceTransferEndpointOpenV1({ ...request, relativePath: '../escape.txt' })).toThrow('canonical')
    expect(() => parseWorkspaceTransferEndpointOpenV1({ ...request, relativePath: '.mortise/workspace.json' })).toThrow('private')
  })

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
      harness.store.apply({
        schemaVersion: 1,
        operationId: 'rename-after-transfer',
        workspaceId: 'workspace-1',
        expectedRevision: 0,
        operation: 'rename',
        locationId: 'primary',
        name: 'Primary renamed',
      })
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

  it('recovers a prepared local transfer when the destination was published before the journal advanced', async () => {
    const harness = await createHarness()
    try {
      const content = 'local publication recovery'
      const sha256 = createHash('sha256').update(content).digest('hex')
      await writeFile(join(harness.primaryRoot, 'source.txt'), content)
      await writeFile(join(harness.attachedRoot, 'destination.txt'), content)
      const handlers = createRpcHandlers(harness.store)
      const request: WorkspaceTransferRequestV1 = {
        schemaVersion: 1,
        operationId: 'local-published-recovery',
        workspaceId: 'workspace-1',
        ...harness.request('copy'),
      }
      harness.store.prepareTransfer(request, { bytes: Buffer.byteLength(content), sha256 })
      const claimKey = createHash('sha256').update(request.operationId).digest('hex').slice(0, 32)
      await writeFile(join(harness.attachedRoot, `.mortise-transfer-${claimKey}.claim`), JSON.stringify({
        schemaVersion: 1, operationId: request.operationId, workspaceId: request.workspaceId,
        locationId: request.destination.locationId, relativePath: request.destination.relativePath,
        bytes: Buffer.byteLength(content), sha256,
      }))

      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER)!({
        clientId: 'local-recovery', workspaceId: 'workspace-1', webContentsId: null,
      }, request)).resolves.toMatchObject({
        status: 'applied',
        sha256,
        sourceRemoved: false,
      })
      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_GET)!({
        clientId: 'local-recovery', workspaceId: 'workspace-1', webContentsId: null,
      }, request)).resolves.toMatchObject({ status: 'duplicate', sha256 })
      expect(await readFile(join(harness.primaryRoot, 'source.txt'), 'utf8')).toBe(content)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('blocks destructive topology changes until a published transfer resolves its source', async () => {
      const harness = await createHarness()
    try {
      const operationId = 'recover-after-topology-change'
      const request: WorkspaceTransferRequestV1 = {
        schemaVersion: 1,
        operationId,
        workspaceId: 'workspace-1',
        ...harness.request('move'),
      }
      const content = Buffer.from('published before topology changed')
      const sha256 = createHash('sha256').update(content).digest('hex')
      await writeFile(join(harness.primaryRoot, 'source.txt'), content)
      await writeFile(join(harness.attachedRoot, 'destination.txt'), content)
      harness.store.prepareTransfer(request, { bytes: content.byteLength, sha256 })
      await writeFile(
        join(harness.attachedRoot, `.mortise-transfer-${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}.claim`),
        JSON.stringify({
          schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'attached',
          relativePath: 'destination.txt', bytes: content.byteLength, sha256,
        }),
      )
      harness.store.markTransferDestinationPublished(request)
      expect(() => harness.store.apply({
        schemaVersion: 1, operation: 'detach', operationId: 'detach-after-publish',
        workspaceId: 'workspace-1', expectedRevision: 0, locationId: 'attached',
      })).toThrow('used by active transfer')
      harness.store.markTransferSourceResolved(request, false)
      harness.store.recordTransferResult(request, {
        schemaVersion: 1, operationId, status: 'applied', workspaceId: 'workspace-1',
        sourceLocationId: 'primary', destinationLocationId: 'attached', revision: 0,
        mode: 'move', sha256, bytes: content.byteLength, sourceRemoved: false,
      })
      harness.store.markTransferCleanupComplete(request)
      harness.store.apply({
        schemaVersion: 1, operation: 'detach', operationId: 'detach-after-resolution',
        workspaceId: 'workspace-1', expectedRevision: 0, locationId: 'attached',
      })

      const handlers = createRpcHandlers(harness.store)
      const result = await handlers.get(RPC_CHANNELS.workspaces.TRANSFER)!(
        { clientId: 'revision-recovery', workspaceId: 'workspace-1', webContentsId: null },
        request,
      ) as { sourceRemoved: boolean }

      expect(result.sourceRemoved).toBe(false)
      expect(await readFile(join(harness.primaryRoot, 'source.txt'))).toEqual(content)
      expect(await readFile(join(harness.attachedRoot, 'destination.txt'))).toEqual(content)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('reuses a durable source outcome without deleting a replacement source', async () => {
    const harness = await createHarness()
    try {
      const content = Buffer.from('replacement with identical content')
      const sha256 = createHash('sha256').update(content).digest('hex')
      const operationId = 'source-resolved-replay'
      const request: WorkspaceTransferRequestV1 = {
        schemaVersion: 1, operationId, workspaceId: 'workspace-1', ...harness.request('move'),
      }
      await writeFile(join(harness.primaryRoot, 'source.txt'), content)
      await writeFile(join(harness.attachedRoot, 'destination.txt'), content)
      harness.store.prepareTransfer(request, { bytes: content.byteLength, sha256 })
      await writeFile(
        join(harness.attachedRoot, `.mortise-transfer-${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}.claim`),
        JSON.stringify({
          schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'attached',
          relativePath: 'destination.txt', bytes: content.byteLength, sha256,
        }),
      )
      harness.store.markTransferDestinationPublished(request)
      harness.store.markTransferSourceResolved(request, true)

      const result = await createRpcHandlers(harness.store).get(RPC_CHANNELS.workspaces.TRANSFER)!(
        { clientId: 'source-resolved-replay', workspaceId: 'workspace-1', webContentsId: null },
        request,
      ) as { sourceRemoved: boolean }

      expect(result.sourceRemoved).toBe(true)
      expect(await readFile(join(harness.primaryRoot, 'source.txt'))).toEqual(content)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('rejects a forged stale import claim without deleting its external staging path', async () => {
    const harness = await createHarness()
    try {
      const victimPath = join(harness.primaryRoot, 'source.txt')
      const bytes = Buffer.from('must survive forged cleanup')
      await writeFile(victimPath, bytes)
      const operationId = 'forged-stale-claim'
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const claimPath = join(harness.attachedRoot, `.mortise-transfer-${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}.claim`)
      await writeFile(claimPath, JSON.stringify({
        schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'attached',
        relativePath: 'destination.txt', bytes: bytes.byteLength, sha256,
        temporaryPath: victimPath, cleanupToken: randomUUID(),
      }))
      await new Promise(resolve => setTimeout(resolve, 5))
      const handlers = new Map<string, HandlerFn>()
      const server = {
        handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
        push() {}, async invokeClient() { return undefined }, hasClientCapability() { return false }, findClientsWithCapability() { return [] },
      } as RpcServer
      registerWorkspaceTransferHandlers(server, harness.store, { endpointSessionTtlMs: 1 })

      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!(
        { clientId: 'forged-claim', workspaceId: 'workspace-1', webContentsId: null },
        { schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'attached', relativePath: 'destination.txt', expectedBytes: bytes.byteLength, expectedSha256: sha256 },
      )).rejects.toThrow('invalid staging path')
      expect(await readFile(victimPath)).toEqual(bytes)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('does not remove another writer claim after losing exclusive creation', async () => {
    const harness = await createHarness()
    try {
      const content = Buffer.from('cross-writer claim ownership')
      await writeFile(join(harness.primaryRoot, 'source.txt'), content)
      const request: WorkspaceTransferRequestV1 = {
        schemaVersion: 1, operationId: 'cross-writer-claim', workspaceId: 'workspace-1', ...harness.request('copy'),
      }
      const sha256 = createHash('sha256').update(content).digest('hex')
      harness.store.prepareTransfer(request, { bytes: content.byteLength, sha256 })
      const claimPath = join(harness.attachedRoot, `.mortise-transfer-${createHash('sha256').update(request.operationId).digest('hex').slice(0, 32)}.claim`)
      await writeFile(claimPath, JSON.stringify({
        schemaVersion: 1, operationId: request.operationId, workspaceId: 'workspace-1', locationId: 'attached',
        relativePath: 'destination.txt', bytes: content.byteLength, sha256,
      }))

      await expect(transferWorkspaceFile(harness.store, request)).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(claimPath, 'utf8')).toContain(request.operationId)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('streams bounded endpoint chunks into an atomic verified publish', async () => {
    const harness = await createHarness()
    try {
      const content = Buffer.alloc(700_000, 0x5a)
      await writeFile(join(harness.primaryRoot, 'source.txt'), content)
      const handlers = new Map<string, HandlerFn>()
      const server = {
        handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
        push() {}, async invokeClient() { return undefined }, hasClientCapability() { return false }, findClientsWithCapability() { return [] },
      } as RpcServer
      registerWorkspaceTransferHandlers(server, harness.store)
      const sourceContext = { clientId: 'client-endpoint-source', workspaceId: 'workspace-1', webContentsId: null }
      const destinationContext = { clientId: 'client-endpoint-destination', workspaceId: 'workspace-1', webContentsId: null }
      const operationId = 'endpoint-1'
      const exportInfo = await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_OPEN)!(sourceContext, {
        schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'primary', relativePath: 'source.txt',
      }) as { bytes: number; sha256: string }
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!(destinationContext, {
        schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'attached', relativePath: 'destination.txt',
        expectedBytes: exportInfo.bytes, expectedSha256: exportInfo.sha256,
      })
      let offset = 0
      while (offset < exportInfo.bytes) {
        const chunk = await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_READ)!(sourceContext, {
          schemaVersion: 1, operationId, offset, maxBytes: 256 * 1024,
        }) as { bytes: Uint8Array }
        expect(chunk.bytes.byteLength).toBeLessThanOrEqual(256 * 1024)
        await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE)!(destinationContext, {
          schemaVersion: 1, operationId, offset, bytes: chunk.bytes,
        })
        offset += chunk.bytes.byteLength
      }
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_COMMIT)!(destinationContext, {
        schemaVersion: 1, operationId, bytes: exportInfo.bytes, sha256: exportInfo.sha256,
      })
      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_COMPLETE)!(sourceContext, {
        schemaVersion: 1, operationId, removeIfUnchanged: false,
      })).resolves.toMatchObject({ sourceRemoved: false })
      expect(await readFile(join(harness.attachedRoot, 'destination.txt'))).toEqual(content)
      expect((await readdir(harness.attachedRoot)).some(name => name.endsWith('.tmp'))).toBe(false)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('keeps a changed source after an endpoint move publishes the verified content', async () => {
    const harness = await createHarness()
    try {
      const original = Buffer.from('original move payload')
      const changed = Buffer.from('changed! move payload')
      await writeFile(join(harness.primaryRoot, 'source.txt'), original)
      const handlers = createRpcHandlers(harness.store)
      const sourceContext = { clientId: 'move-source', workspaceId: 'workspace-1', webContentsId: null }
      const destinationContext = { clientId: 'move-destination', workspaceId: 'workspace-1', webContentsId: null }
      const operationId = 'endpoint-move-changed'
      const exportInfo = await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_OPEN)!(sourceContext, {
        schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'primary', relativePath: 'source.txt',
      }) as { bytes: number; sha256: string }
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!(destinationContext, {
        schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'attached', relativePath: 'destination.txt',
        expectedBytes: exportInfo.bytes, expectedSha256: exportInfo.sha256,
      })
      const chunk = await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_READ)!(sourceContext, {
        schemaVersion: 1, operationId, offset: 0, maxBytes: 256 * 1024,
      }) as { bytes: Uint8Array }
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE)!(destinationContext, {
        schemaVersion: 1, operationId, offset: 0, bytes: chunk.bytes,
      })
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_COMMIT)!(destinationContext, {
        schemaVersion: 1, operationId, bytes: exportInfo.bytes, sha256: exportInfo.sha256,
      })
      await writeFile(join(harness.primaryRoot, 'source.txt'), changed)

      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_COMPLETE)!(sourceContext, {
        schemaVersion: 1, operationId, removeIfUnchanged: true,
      })).resolves.toMatchObject({ sourceRemoved: false })
      expect(await readFile(join(harness.primaryRoot, 'source.txt'))).toEqual(changed)
      expect(await readFile(join(harness.attachedRoot, 'destination.txt'))).toEqual(original)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('reconciles an already-published destination from its durable endpoint claim', async () => {
    const harness = await createHarness()
    try {
      const content = Buffer.from('published before coordinator receipt')
      const sha256 = createHash('sha256').update(content).digest('hex')
      const operationId = 'endpoint-published-replay'
      const context = { clientId: 'destination-before-restart', workspaceId: 'workspace-1', webContentsId: null }
      const openRequest = {
        schemaVersion: 1 as const, operationId, workspaceId: 'workspace-1', locationId: 'attached', relativePath: 'destination.txt',
        expectedBytes: content.byteLength, expectedSha256: sha256,
      }
      const first = createRpcHandlers(harness.store)
      await first.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!(context, openRequest)
      await first.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE)!(context, {
        schemaVersion: 1, operationId, offset: 0, bytes: content,
      })
      const committed = await first.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_COMMIT)!(context, {
        schemaVersion: 1, operationId, bytes: content.byteLength, sha256,
      }) as { cleanupToken: string }

      const restarted = createRpcHandlers(harness.store)
      await expect(restarted.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!({
        ...context,
        clientId: 'destination-after-restart',
      }, openRequest)).resolves.toMatchObject({ status: 'already-published' })
      expect(await readFile(join(harness.attachedRoot, 'destination.txt'))).toEqual(content)
      await restarted.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_CLEANUP)!(context, { ...openRequest, cleanupToken: committed.cleanupToken })
      expect((await readdir(harness.attachedRoot)).some(name => name.endsWith('.claim'))).toBe(false)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('reconciles and cleans an already-removed move source after handler recreation', async () => {
    const harness = await createHarness()
    try {
      const content = Buffer.from('source quarantine replay')
      await writeFile(join(harness.primaryRoot, 'source.txt'), content)
      const operationId = 'endpoint-source-quarantine'
      const context = { clientId: 'source-before-restart', workspaceId: 'workspace-1', webContentsId: null }
      const openRequest = {
        schemaVersion: 1 as const, operationId, workspaceId: 'workspace-1', locationId: 'primary', relativePath: 'source.txt',
      }
      const first = createRpcHandlers(harness.store)
      const opened = await first.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_OPEN)!(context, openRequest) as { bytes: number; sha256: string }
      const completed = await first.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_COMPLETE)!(context, {
        schemaVersion: 1, operationId, removeIfUnchanged: true,
      }) as { sourceRemoved: boolean; cleanupToken: string }
      expect(completed).toMatchObject({ sourceRemoved: true })
      await expect(readFile(join(harness.primaryRoot, 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

      const restarted = createRpcHandlers(harness.store)
      await expect(restarted.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_OPEN)!({
        ...context,
        clientId: 'source-after-restart',
      }, openRequest)).resolves.toMatchObject({
        status: 'already-removed',
        bytes: opened.bytes,
        sha256: opened.sha256,
      })
      await restarted.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_CLEANUP)!(context, { ...openRequest, cleanupToken: completed.cleanupToken })
      expect((await readdir(harness.primaryRoot)).some(name => name.includes('mortise-transfer-delete'))).toBe(false)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('removes endpoint staging when commit validation fails', async () => {
    const harness = await createHarness()
    try {
      const handlers = createRpcHandlers(harness.store)
      const context = { clientId: 'mismatch-destination', workspaceId: 'workspace-1', webContentsId: null }
      const operationId = 'endpoint-mismatch'
      const bytes = Buffer.from('staged payload')
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!(context, {
        schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'attached', relativePath: 'destination.txt',
        expectedBytes: bytes.byteLength, expectedSha256: createHash('sha256').update(bytes).digest('hex'),
      })
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE)!(context, {
        schemaVersion: 1, operationId, offset: 0, bytes,
      })
      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_COMMIT)!(context, {
        schemaVersion: 1, operationId, bytes: bytes.byteLength, sha256: '0'.repeat(64),
      })).rejects.toThrow('size and checksum')
      await expect(readFile(join(harness.attachedRoot, 'destination.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(harness.attachedRoot)).some(name => name.startsWith('.mortise-transfer-'))).toBe(false)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('removes endpoint staging on explicit abort', async () => {
    const harness = await createHarness()
    try {
      const handlers = createRpcHandlers(harness.store)
      const context = { clientId: 'abort-destination', workspaceId: 'workspace-1', webContentsId: null }
      const operationId = 'endpoint-abort'
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!(context, {
        schemaVersion: 1, operationId, workspaceId: 'workspace-1', locationId: 'attached', relativePath: 'destination.txt',
        expectedBytes: Buffer.byteLength('partial payload'), expectedSha256: createHash('sha256').update('partial payload').digest('hex'),
      })
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE)!(context, {
        schemaVersion: 1, operationId, offset: 0, bytes: Buffer.from('partial payload'),
      })
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_ABORT)!(context, {
        schemaVersion: 1, operationId,
      })
      await expect(readFile(join(harness.attachedRoot, 'destination.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(harness.attachedRoot)).some(name => name.startsWith('.mortise-transfer-'))).toBe(false)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('reaps abandoned endpoint staging after the inactivity deadline', async () => {
    const harness = await createHarness()
    try {
      const handlers = new Map<string, HandlerFn>()
      const server = {
        handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
        push() {}, async invokeClient() { return undefined }, hasClientCapability() { return false }, findClientsWithCapability() { return [] },
      } as RpcServer
      registerWorkspaceTransferHandlers(server, harness.store, { endpointSessionTtlMs: 20 })
      const context = { clientId: 'expired-destination', workspaceId: 'workspace-1', webContentsId: null }
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!(context, {
        schemaVersion: 1, operationId: 'endpoint-expired', workspaceId: 'workspace-1', locationId: 'attached', relativePath: 'destination.txt',
        expectedBytes: Buffer.byteLength('abandoned payload'), expectedSha256: createHash('sha256').update('abandoned payload').digest('hex'),
      })
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE)!(context, {
        schemaVersion: 1, operationId: 'endpoint-expired', offset: 0, bytes: Buffer.from('abandoned payload'),
      })
      await new Promise(resolve => setTimeout(resolve, 60))

      await expect(readFile(join(harness.attachedRoot, 'destination.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(harness.attachedRoot)).some(name => name.startsWith('.mortise-transfer-'))).toBe(false)
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('records and replays the durable receipt for an orchestrated endpoint transfer', async () => {
    const harness = await createHarness()
    try {
      const handlers = createRpcHandlers(harness.store)
      const context = { clientId: 'receipt-host', workspaceId: 'workspace-1', webContentsId: null }
      const request: WorkspaceTransferRequestV1 = {
        schemaVersion: 1,
        operationId: 'endpoint-receipt',
        workspaceId: 'workspace-1',
        ...harness.request('copy'),
      }
      const result = {
        schemaVersion: 1 as const,
        operationId: request.operationId,
        status: 'applied' as const,
        workspaceId: request.workspaceId,
        sourceLocationId: request.source.locationId,
        destinationLocationId: request.destination.locationId,
        revision: request.expectedRevision,
        mode: request.mode,
        sha256: createHash('sha256').update('endpoint receipt').digest('hex'),
        bytes: Buffer.byteLength('endpoint receipt'),
        sourceRemoved: false,
      }

      harness.store.prepareTransfer(request, { bytes: result.bytes, sha256: result.sha256 })
      harness.store.markTransferDestinationPublished(request)
      harness.store.markTransferSourceResolved(request, false)
      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_RECORD)!(context, request, result)).resolves.toEqual(result)
      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER_RECEIPT_GET)!(context, request)).resolves.toEqual({
        ...result,
        status: 'duplicate',
      })
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('keeps one import attempt authoritative across concurrent clients and tokenized cleanup', async () => {
    const harness = await createHarness()
    try {
      const handlers = createRpcHandlers(harness.store)
      const firstContext = { clientId: 'first-import', workspaceId: 'workspace-1', webContentsId: null }
      const secondContext = { clientId: 'second-import', workspaceId: 'workspace-1', webContentsId: null }
      const bytes = Buffer.from('authoritative staging')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const openRequest = {
        schemaVersion: 1 as const, operationId: 'concurrent-import', workspaceId: 'workspace-1',
        locationId: 'attached', relativePath: 'destination.txt', expectedBytes: bytes.byteLength, expectedSha256: sha256,
      }
      const opened = await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!(firstContext, openRequest) as { cleanupToken: string }
      expect((opened as { status?: string }).status).toBe('opened')
      expect(typeof opened.cleanupToken).toBe('string')
      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_OPEN)!(secondContext, openRequest)).rejects.toThrow('already staging')
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_WRITE)!(firstContext, { schemaVersion: 1, operationId: openRequest.operationId, offset: 0, bytes })
      const committed = await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_COMMIT)!(firstContext, { schemaVersion: 1, operationId: openRequest.operationId, bytes: bytes.byteLength, sha256 }) as { cleanupToken: string }
      expect(committed.cleanupToken).toBe(opened.cleanupToken)
      await expect(handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_CLEANUP)!(secondContext, { ...openRequest, cleanupToken: randomUUID() })).rejects.toThrow('cleanup token')
      expect(await readFile(join(harness.attachedRoot, 'destination.txt'))).toEqual(bytes)
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_IMPORT_CLEANUP)!(firstContext, { ...openRequest, cleanupToken: committed.cleanupToken })
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })

  it('resolves concurrent source completion to one durable quarantine outcome', async () => {
    const harness = await createHarness()
    try {
      const content = Buffer.from('concurrent source move')
      await writeFile(join(harness.primaryRoot, 'source.txt'), content)
      const handlers = createRpcHandlers(harness.store)
      const operationId = 'concurrent-source-complete'
      const firstContext = { clientId: 'first-export', workspaceId: 'workspace-1', webContentsId: null }
      const secondContext = { clientId: 'second-export', workspaceId: 'workspace-1', webContentsId: null }
      const openRequest = { schemaVersion: 1 as const, operationId, workspaceId: 'workspace-1', locationId: 'primary', relativePath: 'source.txt' }
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_OPEN)!(firstContext, openRequest)
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_OPEN)!(secondContext, openRequest)
      const completeRequest = { schemaVersion: 1 as const, operationId, removeIfUnchanged: true }
      const [first, second] = await Promise.all([
        handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_COMPLETE)!(firstContext, completeRequest),
        handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_COMPLETE)!(secondContext, completeRequest),
      ]) as Array<{ sourceRemoved: boolean; cleanupToken: string }>
      expect(first.sourceRemoved).toBe(true)
      expect(second.sourceRemoved).toBe(true)
      expect(first.cleanupToken).toBe(second.cleanupToken)
      await expect(readFile(join(harness.primaryRoot, 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await handlers.get(RPC_CHANNELS.workspaces.TRANSFER_ENDPOINT_EXPORT_CLEANUP)!(firstContext, { ...openRequest, cleanupToken: first.cleanupToken })
    } finally {
      harness.store.close()
      await rm(harness.primaryRoot, { recursive: true, force: true })
      await rm(harness.attachedRoot, { recursive: true, force: true })
    }
  })
})
