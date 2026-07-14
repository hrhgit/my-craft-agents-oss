import { UiValidationError } from './errors.ts'
import { UiValidationEventRing } from './event-ring.ts'
import type { UiValidationAppPhase, UiValidationEventReadResult } from './types.ts'

export const UI_VALIDATION_STATE_SCOPES = [
  'app',
  'transport',
  'workspace',
  'sessions',
  'route',
  'session',
  'extension',
  'native-driver',
] as const

export type UiValidationStateScope = typeof UI_VALIDATION_STATE_SCOPES[number]

export interface UiValidationScopedState {
  scope: UiValidationStateScope
  phase: UiValidationAppPhase
  revision: number
  updatedAt: number
  windowId?: string
  entityId?: string
  detail?: Record<string, unknown>
  error?: { code?: string; message: string }
}

export interface UiValidationScopedStateUpdate {
  scope: UiValidationStateScope
  phase: UiValidationAppPhase
  entityId?: string
  detail?: Record<string, unknown>
  error?: { code?: string; message: string }
}

export interface UiValidationScopedWait {
  scope: UiValidationStateScope
  phase?: UiValidationAppPhase
  windowId?: string
  entityId?: string
  /** Shallow equality constraints for typed state detail fields. */
  detail?: Record<string, unknown>
}

export interface UiValidationScopedStateSnapshot {
  revision: number
  latestSeq: number
  states: UiValidationScopedState[]
}

export interface UiValidationScopedWaitOptions {
  timeoutMs?: number
  stableForMs?: number
  afterSeq?: number
  signal?: AbortSignal
}

export class UiValidationScopedStateRegistry {
  readonly events: UiValidationEventRing
  private readonly states = new Map<string, UiValidationScopedState>()
  private revision = 0

  constructor(
    capacity = 512,
    private readonly now: () => number = Date.now,
  ) {
    this.events = new UiValidationEventRing(capacity, now)
  }

  get snapshot(): UiValidationScopedStateSnapshot {
    return {
      revision: this.revision,
      latestSeq: this.events.latestSeq,
      states: [...this.states.values()].map(state => structuredClone(state)),
    }
  }

  update(update: UiValidationScopedStateUpdate, windowId?: string): UiValidationScopedState {
    validateScopedUpdate(update)
    const key = stateKey(update.scope, windowId, update.entityId)
    const comparable = { ...update, windowId }
    const current = this.states.get(key)
    if (current && JSON.stringify(stripStateMetadata(current)) === JSON.stringify(comparable)) {
      return structuredClone(current)
    }
    const next: UiValidationScopedState = {
      ...structuredClone(update),
      ...(windowId ? { windowId } : {}),
      revision: ++this.revision,
      updatedAt: this.now(),
    }
    this.states.set(key, next)
    this.events.append(`state.${update.scope}.changed`, structuredClone(next), next.revision)
    return structuredClone(next)
  }

  updateMany(updates: readonly UiValidationScopedStateUpdate[], windowId?: string): UiValidationScopedStateSnapshot {
    for (const update of updates) this.update(update, windowId)
    return this.snapshot
  }

  disposeWindow(windowId: string): void {
    for (const [key, current] of this.states) {
      if (current.windowId !== windowId || current.phase === 'disposed') continue
      this.update({ scope: current.scope, phase: 'disposed', ...(current.entityId ? { entityId: current.entityId } : {}) }, windowId)
      if (!this.states.has(key)) continue
    }
  }

  readEvents(options: { afterSeq?: number; limit?: number; types?: readonly string[] } = {}): UiValidationEventReadResult {
    return this.events.read(options)
  }

  find(predicate: UiValidationScopedWait): UiValidationScopedState | undefined {
    return this.snapshot.states.find(state => matches(state, predicate))
  }

  async waitFor(predicate: UiValidationScopedWait, options: UiValidationScopedWaitOptions = {}): Promise<UiValidationScopedState> {
    const timeoutMs = options.timeoutMs ?? 10_000
    const stableForMs = options.stableForMs ?? 0
    const startedAt = this.now()
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new UiValidationError('INVALID_REQUEST', 'timeoutMs must be non-negative.')
    if (!Number.isFinite(stableForMs) || stableForMs < 0 || stableForMs > timeoutMs) throw new UiValidationError('INVALID_REQUEST', 'stableForMs must be between zero and timeoutMs.')
    if (options.signal?.aborted) throw abortError(options.signal)
    const initialAtStart = this.find(predicate)
    if (initialAtStart && stableForMs === 0) return initialAtStart

    return await new Promise<UiValidationScopedState>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      let stableTimer: ReturnType<typeof setTimeout> | undefined
      let stableRevision: number | undefined
      const cleanup = () => {
        if (timeout) clearTimeout(timeout)
        if (stableTimer) clearTimeout(stableTimer)
        unsubscribe()
        options.signal?.removeEventListener('abort', onAbort)
      }
      const evaluate = () => {
        const current = this.find(predicate)
        if (!current) {
          stableRevision = undefined
          if (stableTimer) clearTimeout(stableTimer)
          stableTimer = undefined
          return
        }
        if (stableForMs === 0) {
          cleanup()
          resolve(current)
          return
        }
        if (stableRevision === current.revision && stableTimer) return
        stableRevision = current.revision
        if (stableTimer) clearTimeout(stableTimer)
        stableTimer = setTimeout(() => {
          const stable = this.find(predicate)
          if (stable?.revision === stableRevision) {
            cleanup()
            resolve(stable!)
          } else {
            evaluate()
          }
        }, stableForMs)
      }
      const onAbort = () => {
        cleanup()
        reject(abortError(options.signal))
      }
      const afterSeq = options.afterSeq ?? this.events.latestSeq
      const replay = this.events.read({ afterSeq })
      if (replay.droppedBeforeSeq !== undefined && !initialAtStart) {
        reject(new UiValidationError('EVENTS_DROPPED', 'Requested UI state events are no longer available.', {
          details: { afterSeq, droppedBeforeSeq: replay.droppedBeforeSeq },
          retryable: true,
        }))
        return
      }
      const unsubscribe = this.events.subscribe(() => evaluate())
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timeout = setTimeout(() => {
        cleanup()
        reject(new UiValidationError('TIMEOUT', `Timed out waiting for scoped UI state after ${this.now() - startedAt}ms.`, {
          details: { predicate, timeoutMs, stableForMs, snapshot: this.snapshot },
          retryable: true,
        }))
      }, timeoutMs)
      evaluate()
    })
  }
}

function stateKey(scope: UiValidationStateScope, windowId?: string, entityId?: string): string {
  return `${windowId ?? '*'}\u0000${scope}\u0000${entityId ?? '*'}`
}

function matches(state: UiValidationScopedState, predicate: UiValidationScopedWait): boolean {
  return state.scope === predicate.scope
    && (predicate.phase === undefined || state.phase === predicate.phase)
    && (predicate.windowId === undefined || state.windowId === predicate.windowId)
    && (predicate.entityId === undefined || state.entityId === predicate.entityId)
    && (predicate.detail === undefined || Object.entries(predicate.detail).every(([key, value]) => state.detail?.[key] === value))
}

function stripStateMetadata(state: UiValidationScopedState): Omit<UiValidationScopedState, 'revision' | 'updatedAt'> {
  const { revision: _revision, updatedAt: _updatedAt, ...rest } = state
  return rest
}

function validateScopedUpdate(update: UiValidationScopedStateUpdate): void {
  if (!UI_VALIDATION_STATE_SCOPES.includes(update.scope)) throw new UiValidationError('INVALID_REQUEST', 'Unknown UI validation state scope.')
  if (!['booting', 'loading', 'ready', 'busy', 'error', 'disposed'].includes(update.phase)) throw new UiValidationError('INVALID_REQUEST', 'Unknown UI validation state phase.')
  if (update.entityId !== undefined && (typeof update.entityId !== 'string' || update.entityId.length > 300)) throw new UiValidationError('INVALID_REQUEST', 'Invalid scoped state entityId.')
  if (update.error && (typeof update.error.message !== 'string' || update.error.message.length > 2_000)) throw new UiValidationError('INVALID_REQUEST', 'Invalid scoped state error.')
  if (update.detail && JSON.stringify(update.detail).length > 32_000) throw new UiValidationError('INVALID_REQUEST', 'Scoped state detail exceeds 32KB.')
}

function abortError(signal?: AbortSignal): UiValidationError {
  return new UiValidationError('ABORTED', 'Scoped UI state wait was aborted.', {
    details: signal?.reason === undefined ? undefined : { reason: String(signal.reason) },
    retryable: true,
  })
}
