import { UiValidationError } from './errors.ts'
import { UI_VALIDATION_PROTOCOL_VERSION, type UiValidationEvent, type UiValidationEventReadResult } from './types.ts'

export interface UiValidationEventWaitOptions {
  afterSeq?: number
  timeoutMs?: number
  signal?: AbortSignal
}

type EventListener = (event: UiValidationEvent) => void

export class UiValidationEventRing {
  private readonly events: UiValidationEvent[] = []
  private readonly listeners = new Set<EventListener>()
  private nextSeq = 1

  constructor(
    readonly capacity = 512,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new UiValidationError('INVALID_REQUEST', 'Event ring capacity must be a positive safe integer.')
    }
  }

  get latestSeq(): number {
    return this.nextSeq - 1
  }

  append<T>(type: string, payload: T, revision: number): UiValidationEvent<T> {
    if (!type.trim()) throw new UiValidationError('INVALID_REQUEST', 'Event type must be non-empty.')
    const event: UiValidationEvent<T> = {
      v: UI_VALIDATION_PROTOCOL_VERSION,
      kind: 'event',
      seq: this.nextSeq++,
      type,
      timestamp: this.now(),
      revision,
      payload,
    }
    this.events.push(event)
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    for (const listener of this.listeners) listener(event)
    return event
  }

  read(options: { afterSeq?: number; types?: readonly string[]; limit?: number } = {}): UiValidationEventReadResult {
    const afterSeq = options.afterSeq ?? 0
    const firstAvailableSeq = this.events[0]?.seq ?? this.nextSeq
    const types = options.types ? new Set(options.types) : undefined
    const limit = options.limit ?? this.capacity
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new UiValidationError('INVALID_REQUEST', 'afterSeq must be a non-negative safe integer.')
    if (!Number.isSafeInteger(limit) || limit < 1) throw new UiValidationError('INVALID_REQUEST', 'limit must be a positive safe integer.')

    const events = this.events
      .filter(event => event.seq > afterSeq && (!types || types.has(event.type)))
      .slice(0, limit)
    return {
      events,
      latestSeq: this.latestSeq,
      ...(afterSeq + 1 < firstAvailableSeq ? { droppedBeforeSeq: firstAvailableSeq } : {}),
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async waitFor(
    predicate: (event: UiValidationEvent) => boolean,
    options: UiValidationEventWaitOptions = {},
  ): Promise<UiValidationEvent> {
    const startedAt = this.now()
    const timeoutMs = options.timeoutMs ?? 10_000
    const afterSeq = options.afterSeq ?? 0
    const existing = this.read({ afterSeq }).events.find(predicate)
    if (existing) return existing
    if (options.signal?.aborted) throw abortedError(options.signal)

    return await new Promise<UiValidationEvent>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        unsubscribe()
        options.signal?.removeEventListener('abort', onAbort)
      }
      const finish = (event: UiValidationEvent) => {
        cleanup()
        resolve(event)
      }
      const onAbort = () => {
        cleanup()
        reject(abortedError(options.signal))
      }
      const unsubscribe = this.subscribe(event => {
        if (event.seq > afterSeq && predicate(event)) finish(event)
      })
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        cleanup()
        reject(new UiValidationError('TIMEOUT', `Timed out waiting for UI validation event after ${this.now() - startedAt}ms.`, {
          details: { afterSeq, timeoutMs },
          retryable: true,
        }))
      }, timeoutMs)
    })
  }
}

function abortedError(signal?: AbortSignal): UiValidationError {
  return new UiValidationError('ABORTED', 'UI validation wait was aborted.', {
    details: signal?.reason === undefined ? undefined : { reason: String(signal.reason) },
    retryable: true,
  })
}
