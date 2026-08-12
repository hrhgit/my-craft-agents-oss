import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CONFIG_DIR } from '@mortise/shared/config/paths'
import { MultiWriterStore, type JsonValue } from '@mortise/shared/storage'
import type {
  OperationAccepted,
  OperationError,
  OperationReceipt,
  OperationScope,
  OperationStatus,
} from '@mortise/shared/protocol'

const OPERATION_NAMESPACE = 'long-operations'
const OPERATION_DATABASE = join(CONFIG_DIR, 'state.sqlite')

function nowIso(): string { return new Date().toISOString() }

function asJson(value: OperationReceipt): JsonValue { return value as unknown as JsonValue }

export class OperationCoordinator {
  private readonly store: MultiWriterStore
  private readonly listeners = new Set<(receipt: OperationReceipt) => void>()
  private readonly active = new Map<string, AbortController>()
  private readonly cancellers = new Map<string, () => Promise<void> | void>()
  private readonly cancellationRequested = new Set<string>()
  private closed = false

  constructor(store = MultiWriterStore.openSync({
    databasePath: OPERATION_DATABASE,
    writerId: `operations-${process.pid}-${randomUUID()}`,
    writerVersion: 1,
  })) {
    this.store = store
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const controller of this.active.values()) controller.abort(new Error('Operation coordinator closed'))
    this.active.clear()
    this.cancellers.clear()
    this.listeners.clear()
    this.store.close()
  }

  subscribe(listener: (receipt: OperationReceipt) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  registerCancellation(operationId: string, cancel: () => Promise<void> | void): () => void {
    const receipt = this.get(operationId)
    if (!receipt) throw new Error(`Unknown operation ${operationId}`)
    this.cancellers.set(operationId, cancel)
    return () => this.cancellers.delete(operationId)
  }

  isCancellationRequested(operationId: string): boolean {
    return this.cancellationRequested.has(operationId)
  }

  get(operationId: string): OperationReceipt | null {
    const record = this.store.getRecord<JsonValue>(OPERATION_NAMESPACE, operationId)
    return (record?.value ?? null) as OperationReceipt | null
  }

  accept(operationId: string, operationType: string, scope: OperationScope = {}): OperationAccepted {
    const existing = this.get(operationId)
    if (existing) {
      if (existing.operationType !== operationType || JSON.stringify(existing.scope) !== JSON.stringify(scope)) {
        throw new Error(`Operation ${operationId} was reused with a different identity`)
      }
      return { accepted: true, operationId, status: existing.status, revision: existing.revision, duplicate: true }
    }

    const timestamp = nowIso()
    const receipt: OperationReceipt = {
      operationId,
      operationType,
      status: 'accepted',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      scope,
    }
    const mutation = this.store.mutateRecord({
      namespace: OPERATION_NAMESPACE,
      key: operationId,
      value: asJson(receipt),
      expectedVersion: null,
      operationId: `operation-accept:${operationId}`,
    })
    if (mutation.status === 'conflict' || mutation.replayed) {
      const replayed = this.get(operationId)
      if (!replayed) throw new Error(`Operation ${operationId} could not be recovered after a concurrent accept`)
      return { accepted: true, operationId, status: replayed.status, revision: replayed.revision, duplicate: true }
    }
    this.emit(receipt)
    return { accepted: true, operationId, status: 'accepted', revision: 1, duplicate: false }
  }

  start(
    operationId: string,
    operationType: string,
    scope: OperationScope,
    task: (signal: AbortSignal) => Promise<{ resultRef?: string } | void>,
    options: { cancellable?: boolean } = {},
  ): OperationAccepted {
    if (this.closed) throw new Error('Operation coordinator is closed')
    const accepted = this.accept(operationId, operationType, scope)
    if (accepted.duplicate) return accepted

    const controller = new AbortController()
    if (options.cancellable) this.active.set(operationId, controller)
    queueMicrotask(() => {
      this.update(operationId, 'running')
      void Promise.resolve().then(() => task(controller.signal)).then(result => {
        if (this.closed) return
        this.update(operationId, 'succeeded', result ?? {})
      }).catch(error => {
        if (this.closed) return
        if (this.cancellationRequested.has(operationId)) {
          this.update(operationId, 'cancelled')
          return
        }
        this.update(operationId, 'failed', {
          ...(typeof error?.resultRef === 'string' ? { resultRef: error.resultRef } : {}),
          error: {
            code: typeof error?.code === 'string' ? error.code : 'OPERATION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }).finally(() => {
        this.active.delete(operationId)
        this.cancellationRequested.delete(operationId)
      })
    })
    return accepted
  }

  async cancel(operationId: string): Promise<OperationReceipt> {
    const current = this.get(operationId)
    if (!current) throw new Error(`Unknown operation ${operationId}`)
    if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'cancelled') return current
    const controller = this.active.get(operationId)
    const canceller = this.cancellers.get(operationId)
    if (!controller && !canceller) throw new Error(`Operation ${operationId} is not cancellable`)
    this.cancellationRequested.add(operationId)
    controller?.abort(new Error('Operation cancelled'))
    await canceller?.()
    // The domain task owns cancellation acknowledgement. Until it rejects or
    // otherwise settles, the receipt remains running and is recoverable.
    return this.get(operationId) ?? current
  }

  update(operationId: string, status: OperationStatus, details: { resultRef?: string; error?: OperationError } = {}): OperationReceipt {
    const current = this.get(operationId)
    if (!current) throw new Error(`Unknown operation ${operationId}`)
    if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'cancelled') return current

    const receipt: OperationReceipt = {
      ...current,
      status,
      revision: current.revision + 1,
      updatedAt: nowIso(),
      ...details,
    }
    const mutation = this.store.mutateRecord({
      namespace: OPERATION_NAMESPACE,
      key: operationId,
      value: asJson(receipt),
      expectedVersion: current.revision,
      operationId: `operation-update:${operationId}:${receipt.revision}`,
    })
    if (mutation.status === 'conflict') {
      const latest = this.get(operationId)
      if (!latest) throw new Error(`Operation ${operationId} disappeared during an update`)
      return latest
    }
    this.emit(receipt)
    return receipt
  }

  private emit(receipt: OperationReceipt): void {
    for (const listener of this.listeners) listener(receipt)
  }
}

export function createDefaultOperationCoordinator(): OperationCoordinator {
  return new OperationCoordinator()
}
