import { UiValidationError } from './errors.ts'
import type {
  UiValidationFaultEffect,
  UiValidationFaultRecord,
  UiValidationFaultSetRequest,
  UiValidationScenarioApplyRequest,
  UiValidationScenarioApplyResult,
} from './types.ts'
import { parseUiValidationFaultSetRequest, parseUiValidationScenarioApplyRequest } from './validators.ts'

export const UI_VALIDATION_APP_SHELL_SCENARIO_IDS = [
  'app.loading',
  'transport.reconnect',
  'transport.error',
  'session.empty',
  'session.streaming',
  'tool.approval',
  'extension.loading',
  'extension.ready',
  'extension.error',
  'extension.reload',
  'settings.permissions',
  'settings.app',
] as const

export interface UiValidationClock {
  readonly mode: 'real' | 'frozen'
  now(): number
  delay(ms: number, signal?: AbortSignal, domain?: UiValidationApplicationClockDomain): Promise<void>
  pending(domain?: UiValidationApplicationClockDomain): number
  describe(): UiValidationClockDescription
  dispose(): void
}

export type UiValidationApplicationClockDomain = 'timer' | 'debounce' | 'retry' | 'scheduler'

export interface UiValidationClockDescription {
  mode: UiValidationClock['mode']
  now: number
  virtualizedDomains: UiValidationApplicationClockDomain[]
  nonVirtualizedDomains: Array<'os' | 'network'>
  pending: Partial<Record<UiValidationApplicationClockDomain, number>>
}

interface RealTimer {
  timeout: ReturnType<typeof setTimeout>
  domain: UiValidationApplicationClockDomain
  reject: (error: Error) => void
}

export class RealUiValidationClock implements UiValidationClock {
  readonly mode = 'real' as const
  private readonly timers = new Map<number, RealTimer>()
  private nextId = 1
  private disposed = false
  now(): number { return Date.now() }

  delay(ms: number, signal?: AbortSignal, domain: UiValidationApplicationClockDomain = 'timer'): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new UiValidationError('INVALID_REQUEST', 'Delay must be a non-negative finite number.')
    if (this.disposed) return Promise.reject(new UiValidationError('ABORTED', 'Clock was disposed.'))
    if (signal?.aborted) return Promise.reject(new UiValidationError('ABORTED', 'Clock delay was aborted.'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timeout = setTimeout(() => {
        this.timers.delete(id)
        resolve()
      }, ms)
      this.timers.set(id, { timeout, domain, reject })
      signal?.addEventListener('abort', () => {
        if (!this.timers.delete(id)) return
        clearTimeout(timeout)
        reject(new UiValidationError('ABORTED', 'Clock delay was aborted.'))
      }, { once: true })
    })
  }

  pending(domain?: UiValidationApplicationClockDomain): number {
    return [...this.timers.values()].filter(timer => domain === undefined || timer.domain === domain).length
  }

  describe(): UiValidationClockDescription {
    return describeClock(this, [])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers.values()) {
      clearTimeout(timer.timeout)
      timer.reject(new UiValidationError('ABORTED', 'Clock was disposed.'))
    }
    this.timers.clear()
  }
}

interface FrozenTimer {
  id: number
  dueAt: number
  resolve: () => void
  reject: (error: Error) => void
  signal?: AbortSignal
  domain: UiValidationApplicationClockDomain
}

/** Deterministic application-domain clock. It does not virtualize OS or network time. */
export class FrozenUiValidationClock implements UiValidationClock {
  readonly mode = 'frozen' as const
  private current: number
  private nextId = 1
  private readonly timers = new Map<number, FrozenTimer>()
  private disposed = false

  constructor(now: string | number) {
    this.current = typeof now === 'number' ? now : Date.parse(now)
    if (!Number.isFinite(this.current)) throw new UiValidationError('INVALID_REQUEST', 'Frozen clock requires a valid timestamp.')
  }

  now(): number { return this.current }

  delay(ms: number, signal?: AbortSignal, domain: UiValidationApplicationClockDomain = 'timer'): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new UiValidationError('INVALID_REQUEST', 'Delay must be a non-negative finite number.')
    if (this.disposed) return Promise.reject(new UiValidationError('ABORTED', 'Clock was disposed.'))
    if (signal?.aborted) return Promise.reject(new UiValidationError('ABORTED', 'Clock delay was aborted.'))
    return new Promise((resolve, reject) => {
      const timer: FrozenTimer = { id: this.nextId++, dueAt: this.current + ms, resolve, reject, domain, ...(signal ? { signal } : {}) }
      this.timers.set(timer.id, timer)
      signal?.addEventListener('abort', () => {
        if (!this.timers.delete(timer.id)) return
        reject(new UiValidationError('ABORTED', 'Clock delay was aborted.'))
      }, { once: true })
      this.flushDue()
    })
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new UiValidationError('INVALID_REQUEST', 'Clock advance must be a non-negative finite number.')
    this.current += ms
    this.flushDue()
    return this.current
  }

  pending(domain?: UiValidationApplicationClockDomain): number {
    return [...this.timers.values()].filter(timer => domain === undefined || timer.domain === domain).length
  }

  describe(): UiValidationClockDescription {
    return describeClock(this, ['timer', 'debounce', 'retry', 'scheduler'])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.timers.values()) timer.reject(new UiValidationError('ABORTED', 'Clock was disposed.'))
    this.timers.clear()
  }

  private flushDue(): void {
    const due = [...this.timers.values()]
      .filter(timer => timer.dueAt <= this.current)
      .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)
    for (const timer of due) {
      if (!this.timers.delete(timer.id)) continue
      if (timer.signal?.aborted) timer.reject(new UiValidationError('ABORTED', 'Clock delay was aborted.'))
      else timer.resolve()
    }
  }
}

function describeClock(clock: UiValidationClock, virtualizedDomains: UiValidationApplicationClockDomain[]): UiValidationClockDescription {
  const domains: UiValidationApplicationClockDomain[] = ['timer', 'debounce', 'retry', 'scheduler']
  return {
    mode: clock.mode,
    now: clock.now(),
    virtualizedDomains,
    nonVirtualizedDomains: ['os', 'network'],
    pending: Object.fromEntries(domains.map(domain => [domain, clock.pending(domain)])),
  }
}

export interface UiScenarioPrimitiveDefinition<Context, Value> {
  id: string
  validate(input: unknown): Value
  apply(context: Context, value: Value, clock: UiValidationClock): Promise<void> | void
}

/** Closed registry of legal scenario state transitions. External fixtures cannot mutate application state directly. */
export class UiScenarioPrimitiveRegistry<Context> {
  private readonly definitions = new Map<string, UiScenarioPrimitiveDefinition<Context, unknown>>()

  register<Value>(definition: UiScenarioPrimitiveDefinition<Context, Value>): () => void {
    if (!/^[a-z][a-z0-9.-]*$/.test(definition.id)) throw new UiValidationError('SCENARIO_INVALID', `Invalid primitive id ${definition.id}.`)
    if (this.definitions.has(definition.id)) throw new UiValidationError('SCENARIO_INVALID', `Duplicate primitive id ${definition.id}.`)
    this.definitions.set(definition.id, definition as UiScenarioPrimitiveDefinition<Context, unknown>)
    return () => this.definitions.delete(definition.id)
  }

  list(): string[] { return [...this.definitions.keys()].sort() }

  async apply(id: string, context: Context, input: unknown, clock: UiValidationClock): Promise<void> {
    const definition = this.definitions.get(id)
    if (!definition) throw new UiValidationError('SCENARIO_INVALID', `Scenario primitive ${id} is not registered.`)
    await definition.apply(context, definition.validate(input), clock)
  }
}

export interface UiValidationServiceOperation<Context, Input, Result> {
  id: string
  validate(input: unknown): Input
  invoke(context: Context, input: Input, clock: UiValidationClock): Promise<Result> | Result
}

/** Closed service override surface used by scenarios to exercise legal production-facing operations. */
export class UiValidationServiceOverrideRegistry<Context> {
  private readonly operations = new Map<string, UiValidationServiceOperation<Context, unknown, unknown>>()

  register<Input, Result>(operation: UiValidationServiceOperation<Context, Input, Result>): () => void {
    if (!/^[a-z][a-z0-9.-]*$/.test(operation.id)) throw new UiValidationError('SCENARIO_INVALID', `Invalid service operation id ${operation.id}.`)
    if (this.operations.has(operation.id)) throw new UiValidationError('SCENARIO_INVALID', `Duplicate service operation id ${operation.id}.`)
    this.operations.set(operation.id, operation as UiValidationServiceOperation<Context, unknown, unknown>)
    return () => this.operations.delete(operation.id)
  }

  list(): string[] { return [...this.operations.keys()].sort() }

  async invoke<Result = unknown>(id: string, context: Context, input: unknown, clock: UiValidationClock): Promise<Result> {
    const operation = this.operations.get(id)
    if (!operation) throw new UiValidationError('SCENARIO_INVALID', `Scenario service operation ${id} is not registered.`)
    return await operation.invoke(context, operation.validate(input), clock) as Result
  }
}

export interface UiScenarioDefinition<Context> {
  id: string
  kind: 'component' | 'app-shell'
  validate?: (request: UiValidationScenarioApplyRequest) => void
  setup: (context: Context, request: UiValidationScenarioApplyRequest, clock: UiValidationClock) => Promise<{ aliases?: Record<string, string> } | void> | { aliases?: Record<string, string> } | void
  reset: (context: Context) => Promise<void> | void
}

export class UiScenarioRegistry<Context> {
  private readonly definitions = new Map<string, UiScenarioDefinition<Context>>()
  private active?: { definition: UiScenarioDefinition<Context>; request: UiValidationScenarioApplyRequest; clock: UiValidationClock }
  private revision = 0

  register(definition: UiScenarioDefinition<Context>): () => void {
    if (!/^[a-z][a-z0-9.-]*$/.test(definition.id)) throw new UiValidationError('SCENARIO_INVALID', `Invalid scenario id ${definition.id}.`)
    if (this.definitions.has(definition.id)) throw new UiValidationError('SCENARIO_INVALID', `Duplicate scenario id ${definition.id}.`)
    this.definitions.set(definition.id, definition)
    return () => { if (this.active?.definition !== definition) this.definitions.delete(definition.id) }
  }

  list(): Array<{ id: string; kind: UiScenarioDefinition<Context>['kind'] }> {
    return [...this.definitions.values()].map(({ id, kind }) => ({ id, kind })).sort((a, b) => a.id.localeCompare(b.id))
  }

  get activeScenario(): string | undefined { return this.active?.definition.id }
  get activeClock(): UiValidationClock | undefined { return this.active?.clock }

  async apply(context: Context, input: unknown): Promise<UiValidationScenarioApplyResult> {
    const request = parseUiValidationScenarioApplyRequest(input)
    const definition = this.definitions.get(request.name)
    if (!definition) throw new UiValidationError('SCENARIO_INVALID', `Scenario ${request.name} is not registered.`)
    definition.validate?.(request)
    await this.reset(context)
    const clock = request.clock?.mode === 'frozen'
      ? new FrozenUiValidationClock(request.clock.now)
      : new RealUiValidationClock()
    this.active = { definition, request, clock }
    let setup: { aliases?: Record<string, string> } | void
    try {
      setup = await definition.setup(context, request, clock)
    } catch (error) {
      if (this.active?.clock === clock) this.active = undefined
      clock.dispose()
      try { await definition.reset(context) } catch { /* Preserve the setup failure as the authoritative error. */ }
      throw error
    }
    this.revision += 1
    return {
      scenarioId: definition.id,
      name: definition.id,
      seed: request.seed ?? 0,
      revision: this.revision,
      aliases: setup?.aliases ?? {},
    }
  }

  async reset(context: Context): Promise<void> {
    if (!this.active) return
    const active = this.active
    this.active = undefined
    active.clock.dispose()
    await active.definition.reset(context)
    this.revision += 1
  }
}

export interface UiValidationFaultPoint {
  id: string
  validateScope?: (scope: Readonly<Record<string, string>>) => boolean
}

export class UiValidationInjectedFault extends Error {
  constructor(readonly record: UiValidationFaultRecord) {
    super(record.effect.kind === 'error' ? (record.effect.message ?? record.effect.code) : `Injected fault ${record.point}: ${record.effect.kind}`)
    this.name = 'UiValidationInjectedFault'
  }
}

export class UiValidationFaultRegistry {
  private readonly points = new Map<string, UiValidationFaultPoint>()
  private readonly faults = new Map<string, UiValidationFaultRecord>()

  register(point: UiValidationFaultPoint): () => void {
    if (!/^[a-z][a-z0-9.-]*$/.test(point.id)) throw new UiValidationError('FAULT_INVALID', `Invalid fault point ${point.id}.`)
    if (this.points.has(point.id)) throw new UiValidationError('FAULT_INVALID', `Duplicate fault point ${point.id}.`)
    this.points.set(point.id, point)
    return () => this.points.delete(point.id)
  }

  set(input: unknown): UiValidationFaultRecord {
    const request = parseUiValidationFaultSetRequest(input)
    const point = this.points.get(request.point)
    if (!point) throw new UiValidationError('FAULT_INVALID', `Fault point ${request.point} is not registered.`)
    const scope = request.scope ?? {}
    if (point.validateScope && !point.validateScope(scope)) throw new UiValidationError('FAULT_INVALID', `Fault scope is invalid for ${point.id}.`)
    const record: UiValidationFaultRecord = { ...request, faultId: crypto.randomUUID(), remaining: request.times ?? 1 }
    this.faults.set(record.faultId, record)
    return { ...record, scope: record.scope ? { ...record.scope } : undefined }
  }

  clear(faultId?: string): void {
    if (faultId) this.faults.delete(faultId)
    else this.faults.clear()
  }

  list(): UiValidationFaultRecord[] {
    return [...this.faults.values()].map(record => ({ ...record, scope: record.scope ? { ...record.scope } : undefined }))
  }

  async consume(pointId: string, scope: Readonly<Record<string, string>> = {}, clock: UiValidationClock = new RealUiValidationClock()): Promise<UiValidationFaultEffect | undefined> {
    if (!this.points.has(pointId)) throw new UiValidationError('FAULT_INVALID', `Fault point ${pointId} is not registered.`)
    const record = [...this.faults.values()].find(candidate => candidate.point === pointId && scopeMatches(candidate.scope, scope))
    if (!record) return undefined
    record.remaining -= 1
    if (record.remaining <= 0) this.faults.delete(record.faultId)
    if (record.effect.kind === 'delay') await clock.delay(record.effect.ms)
    if (record.effect.kind === 'error') throw new UiValidationInjectedFault({ ...record })
    return { ...record.effect }
  }
}

function scopeMatches(expected: Record<string, string> | undefined, actual: Readonly<Record<string, string>>): boolean {
  return !expected || Object.entries(expected).every(([key, value]) => actual[key] === value)
}
