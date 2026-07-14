import { UiValidationError } from './errors.ts'
import { UiValidationEventRing } from './event-ring.ts'
import type { UiValidationAppState, UiValidationEvent } from './types.ts'

export interface UiValidationStateWaitOptions {
  timeoutMs?: number
  stableForMs?: number
  signal?: AbortSignal
}

export class UiValidationStateRegistry {
  private state: UiValidationAppState

  constructor(
    initial: Partial<UiValidationAppState> = {},
    readonly events = new UiValidationEventRing(),
    private readonly now: () => number = Date.now,
  ) {
    this.state = normalizeState({
      phase: 'booting',
      revision: 0,
      hydrated: false,
      pending: { rpc: 0, render: 0, transitions: 0 },
      ...initial,
    })
  }

  get snapshot(): UiValidationAppState {
    return structuredClone(this.state)
  }

  update(
    updater: Partial<UiValidationAppState> | ((current: Readonly<UiValidationAppState>) => Partial<UiValidationAppState>),
    eventType = 'state.changed',
  ): UiValidationEvent<UiValidationAppState> {
    const patch = typeof updater === 'function' ? updater(this.snapshot) : updater
    const next = normalizeState({
      ...this.state,
      ...patch,
      pending: patch.pending ? { ...patch.pending } : { ...this.state.pending },
      route: patch.route ? { ...patch.route } : this.state.route ? { ...this.state.route } : undefined,
      revision: this.state.revision + 1,
    })
    this.state = next
    return this.events.append(eventType, this.snapshot, next.revision)
  }

  async waitFor(
    predicate: (state: Readonly<UiValidationAppState>) => boolean,
    options: UiValidationStateWaitOptions = {},
  ): Promise<UiValidationAppState> {
    const timeoutMs = options.timeoutMs ?? 10_000
    const stableForMs = options.stableForMs ?? 0
    const startedAt = this.now()
    if (options.signal?.aborted) throw abortError(options.signal)

    return await new Promise<UiValidationAppState>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      let stableTimer: ReturnType<typeof setTimeout> | undefined
      let stableRevision: number | undefined

      const cleanup = () => {
        if (timeout) clearTimeout(timeout)
        if (stableTimer) clearTimeout(stableTimer)
        unsubscribe()
        options.signal?.removeEventListener('abort', onAbort)
      }
      const resolveCurrent = () => {
        cleanup()
        resolve(this.snapshot)
      }
      const evaluate = () => {
        const current = this.snapshot
        if (!predicate(current)) {
          stableRevision = undefined
          if (stableTimer) clearTimeout(stableTimer)
          stableTimer = undefined
          return
        }
        if (stableForMs === 0) return resolveCurrent()
        if (stableRevision === current.revision && stableTimer) return
        stableRevision = current.revision
        if (stableTimer) clearTimeout(stableTimer)
        stableTimer = setTimeout(() => {
          if (predicate(this.snapshot) && this.state.revision === stableRevision) resolveCurrent()
          else evaluate()
        }, stableForMs)
      }
      const onAbort = () => {
        cleanup()
        reject(abortError(options.signal))
      }
      const unsubscribe = this.events.subscribe(() => evaluate())
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timeout = setTimeout(() => {
        cleanup()
        reject(new UiValidationError('TIMEOUT', `Timed out waiting for UI state after ${this.now() - startedAt}ms.`, {
          details: { timeoutMs, stableForMs, state: this.snapshot },
          retryable: true,
        }))
      }, timeoutMs)
      evaluate()
    })
  }
}

function normalizeState(state: UiValidationAppState): UiValidationAppState {
  for (const [key, value] of Object.entries(state.pending)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new UiValidationError('INVALID_REQUEST', `pending.${key} must be a non-negative safe integer.`)
    }
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new UiValidationError('INVALID_REQUEST', 'State revision must be a non-negative safe integer.')
  }
  return structuredClone(state)
}

function abortError(signal?: AbortSignal): UiValidationError {
  return new UiValidationError('ABORTED', 'UI validation state wait was aborted.', {
    details: signal?.reason === undefined ? undefined : { reason: String(signal.reason) },
    retryable: true,
  })
}
