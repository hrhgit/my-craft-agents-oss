import { describe, expect, it } from 'bun:test'
import type { WorkspaceTransferRequestV1, WorkspaceTransferResultV1 } from '@mortise/shared/protocol'
import { WorkspaceTransferHostCoordinator, WorkspaceTransferSingleFlight } from '../workspace-transfer-single-flight'

function request(operationId = 'operation'): WorkspaceTransferRequestV1 {
  return {
    schemaVersion: 1, operationId, workspaceId: 'workspace', expectedRevision: 3, mode: 'copy',
    source: { schemaVersion: 1, workspaceId: 'workspace', locationId: 'source', relativePath: 'source.txt' },
    destination: { schemaVersion: 1, workspaceId: 'workspace', locationId: 'destination', relativePath: 'destination.txt' },
  }
}

function result(operationId = 'operation'): WorkspaceTransferResultV1 {
  return {
    schemaVersion: 1, operationId, status: 'applied', workspaceId: 'workspace',
    sourceLocationId: 'source', destinationLocationId: 'destination', revision: 3, mode: 'copy',
    sha256: 'a'.repeat(64), bytes: 1, sourceRemoved: false,
  }
}

describe('WorkspaceTransferSingleFlight', () => {
  it('shares an identical in-flight operation and marks the follower duplicate', async () => {
    const singleFlight = new WorkspaceTransferSingleFlight()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const first = singleFlight.run(request(), async () => { calls++; await blocked; return result() })
    const second = singleFlight.run(request(), async () => { calls++; return result() })
    release()
    expect(await first).toMatchObject({ status: 'applied' })
    expect(await second).toMatchObject({ status: 'duplicate' })
    expect(calls).toBe(1)
  })

  it('rejects a conflicting request that reuses the operation identity', async () => {
    const singleFlight = new WorkspaceTransferSingleFlight()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const first = singleFlight.run(request(), async () => { await blocked; return result() })
    expect(() => singleFlight.run({ ...request(), mode: 'move' }, async () => result())).toThrow('different Workspace transfer')
    release()
    await first
  })
})

describe('WorkspaceTransferHostCoordinator', () => {
  it('serializes the same operation across independent preload callers', async () => {
    const coordinator = new WorkspaceTransferHostCoordinator()
    const firstToken = await coordinator.acquire(request(), 1)
    let secondAcquired = false
    const second = coordinator.acquire(request(), 2).then(token => {
      secondAcquired = true
      return token
    })
    await Promise.resolve()
    expect(secondAcquired).toBe(false)
    coordinator.release(request(), firstToken)
    const secondToken = await second
    expect(secondToken).not.toBe(firstToken)
    coordinator.release(request(), secondToken)
  })

  it('rejects conflicting payloads while an operation identity is leased', async () => {
    const coordinator = new WorkspaceTransferHostCoordinator()
    const token = await coordinator.acquire(request(), 1)
    await expect(coordinator.acquire({ ...request(), mode: 'move' }, 2)).rejects.toThrow('different Workspace transfer')
    coordinator.release(request(), token)
  })

  it('releases a lease when its renderer owner is destroyed', async () => {
    const coordinator = new WorkspaceTransferHostCoordinator()
    await coordinator.acquire(request(), 1)
    const follower = coordinator.acquire(request(), 2)
    coordinator.releaseOwner(1)
    const followerToken = await follower
    coordinator.release(request(), followerToken)
  })
})
