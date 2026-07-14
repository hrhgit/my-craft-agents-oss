import { describe, expect, it } from 'bun:test'
import {
  FrozenUiValidationClock,
  UiScenarioRegistry,
  UiScenarioPrimitiveRegistry,
  UiValidationFaultRegistry,
  UiValidationInjectedFault,
} from '../runtime.ts'

describe('UI validation runtime', () => {
  it('advances only the application clock domain', async () => {
    const clock = new FrozenUiValidationClock('2026-01-01T00:00:00.000Z')
    let finished = false
    void clock.delay(250).then(() => { finished = true })
    clock.advance(249)
    await Promise.resolve()
    expect(finished).toBeFalse()
    clock.advance(1)
    await Promise.resolve()
    expect(finished).toBeTrue()
    expect(clock.pending()).toBe(0)
    expect(clock.describe()).toEqual({
      mode: 'frozen',
      now: Date.parse('2026-01-01T00:00:00.250Z'),
      virtualizedDomains: ['timer', 'debounce', 'retry', 'scheduler'],
      nonVirtualizedDomains: ['os', 'network'],
      pending: { timer: 0, debounce: 0, retry: 0, scheduler: 0 },
    })
  })

  it('runs only registered typed state primitives', async () => {
    const registry = new UiScenarioPrimitiveRegistry<{ phase: string }>()
    registry.register({
      id: 'app.phase',
      validate: input => {
        if (input !== 'loading' && input !== 'ready') throw new Error('invalid phase')
        return input
      },
      apply: (context, phase) => { context.phase = phase },
    })
    const context = { phase: 'booting' }
    const clock = new FrozenUiValidationClock(0)
    await registry.apply('app.phase', context, 'loading', clock)
    expect(context.phase).toBe('loading')
    await expect(registry.apply('app.phase', context, 'impossible', clock)).rejects.toThrow('invalid phase')
    await expect(registry.apply('atom.write', context, {}, clock)).rejects.toMatchObject({ code: 'SCENARIO_INVALID' })
  })

  it('cancels scheduled application work when a scenario resets', async () => {
    let completed = false
    const registry = new UiScenarioRegistry<Record<string, never>>()
    registry.register({
      id: 'app.loading',
      kind: 'app-shell',
      setup: (_context, _request, clock) => { void clock.delay(10_000, undefined, 'scheduler').then(() => { completed = true }).catch(() => {}) },
      reset: () => {},
    })
    await registry.apply({}, { name: 'app.loading', clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })
    const clock = registry.activeClock as FrozenUiValidationClock
    expect(clock.pending('scheduler')).toBe(1)
    await registry.reset({})
    expect(clock.pending()).toBe(0)
    expect(completed).toBeFalse()
  })

  it('disposes the application clock when scenario setup fails', async () => {
    let clockFromSetup: FrozenUiValidationClock | undefined
    let reset = false
    const registry = new UiScenarioRegistry<Record<string, never>>()
    registry.register({
      id: 'app.loading',
      kind: 'app-shell',
      setup: (_context, _request, clock) => {
        clockFromSetup = clock as FrozenUiValidationClock
        void clock.delay(1_000, undefined, 'timer').catch(() => {})
        throw new Error('setup failed')
      },
      reset: () => { reset = true },
    })
    await expect(registry.apply({}, { name: 'app.loading', clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })).rejects.toThrow('setup failed')
    expect(clockFromSetup?.pending()).toBe(0)
    expect(registry.activeClock).toBeUndefined()
    expect(reset).toBeTrue()
  })

  it('runs only registered scenario setup and reset handlers', async () => {
    const events: string[] = []
    const registry = new UiScenarioRegistry<{ events: string[] }>()
    registry.register({
      id: 'app.loading',
      kind: 'app-shell',
      setup: (context, request, clock) => {
        context.events.push(`setup:${clock.mode}:${request.seed}`)
        return { aliases: { loading: 'app.loading' } }
      },
      reset: context => { context.events.push('reset') },
    })
    const result = await registry.apply({ events }, { name: 'app.loading', seed: 7, clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })
    expect(result.aliases.loading).toBe('app.loading')
    expect(events).toEqual(['setup:frozen:7'])
    await registry.reset({ events })
    expect(events).toEqual(['setup:frozen:7', 'reset'])
    await expect(registry.apply({ events }, { name: 'missing' })).rejects.toMatchObject({ code: 'SCENARIO_INVALID' })
  })

  it('allows only registered bounded fault points and consumes exact counts', async () => {
    const registry = new UiValidationFaultRegistry()
    registry.register({ id: 'transport.connect', validateScope: scope => typeof scope.workspaceId === 'string' })
    const record = registry.set({ point: 'transport.connect', effect: { kind: 'disconnect' }, times: 2, scope: { workspaceId: 'w1' } })
    expect(await registry.consume('transport.connect', { workspaceId: 'w2' })).toBeUndefined()
    expect(await registry.consume('transport.connect', { workspaceId: 'w1' })).toEqual({ kind: 'disconnect' })
    expect(registry.list()[0]?.remaining).toBe(1)
    expect(await registry.consume('transport.connect', { workspaceId: 'w1' })).toEqual({ kind: 'disconnect' })
    expect(registry.list()).toHaveLength(0)
    expect(record.remaining).toBe(2)

    registry.set({ point: 'transport.connect', effect: { kind: 'error', code: 'OFFLINE' }, scope: { workspaceId: 'w1' } })
    await expect(registry.consume('transport.connect', { workspaceId: 'w1' })).rejects.toBeInstanceOf(UiValidationInjectedFault)
    expect(() => registry.set({ point: 'unknown.point', effect: { kind: 'drop' } })).toThrow('not registered')
  })
})
