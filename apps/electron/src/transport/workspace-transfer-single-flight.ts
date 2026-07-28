import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { WorkspaceTransferRequestV1, WorkspaceTransferResultV1 } from '@mortise/shared/protocol'

export class WorkspaceTransferSingleFlight {
  private readonly entries = new Map<string, {
    request: WorkspaceTransferRequestV1
    result: Promise<WorkspaceTransferResultV1>
  }>()

  run(
    request: WorkspaceTransferRequestV1,
    operation: () => Promise<WorkspaceTransferResultV1>,
  ): Promise<WorkspaceTransferResultV1> {
    const key = `${request.workspaceId}\0${request.operationId}`
    const running = this.entries.get(key)
    if (running) {
      if (!isDeepStrictEqual(running.request, request)) {
        throw new Error(`operationId was already used for a different Workspace transfer: ${request.operationId}`)
      }
      return running.result.then(result => ({ ...result, status: 'duplicate' as const }))
    }

    const result = operation()
    this.entries.set(key, { request, result })
    return result.finally(() => {
      if (this.entries.get(key)?.result === result) this.entries.delete(key)
    })
  }
}

/** Main-process lease authority shared by every renderer/preload instance. */
export class WorkspaceTransferHostCoordinator {
  private readonly entries = new Map<string, {
    request: WorkspaceTransferRequestV1
    token: string
    ownerId: number
    settled: Promise<void>
    resolve: () => void
  }>()

  async acquire(request: WorkspaceTransferRequestV1, ownerId: number): Promise<string> {
    const key = `${request.workspaceId}\0${request.operationId}`
    for (;;) {
      const running = this.entries.get(key)
      if (!running) {
        let resolve!: () => void
        const settled = new Promise<void>(done => { resolve = done })
        const token = randomUUID()
        this.entries.set(key, { request: structuredClone(request), token, ownerId, settled, resolve })
        return token
      }
      if (!isDeepStrictEqual(running.request, request)) {
        throw new Error(`operationId was already used for a different Workspace transfer: ${request.operationId}`)
      }
      await running.settled
    }
  }

  releaseOwner(ownerId: number): void {
    for (const [key, running] of this.entries) {
      if (running.ownerId !== ownerId) continue
      this.entries.delete(key)
      running.resolve()
    }
  }

  release(request: WorkspaceTransferRequestV1, token: string): void {
    const key = `${request.workspaceId}\0${request.operationId}`
    const running = this.entries.get(key)
    if (!running || running.token !== token || !isDeepStrictEqual(running.request, request)) {
      throw new Error(`Workspace transfer lease is not owned by ${request.operationId}`)
    }
    this.entries.delete(key)
    running.resolve()
  }
}
