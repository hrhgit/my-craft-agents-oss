import { describe, expect, it, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({}))
mock.module('react-pdf', () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }))
mock.module('@/context/ThemeContext', () => ({ useTheme: () => ({ effectiveTheme: 'light' }), ThemeProvider: ({ children }: { children: unknown }) => children }))
mock.module('@/hooks/useTheme', () => ({ useTheme: () => ({ effectiveTheme: 'light' }) }))
mock.module('@/components/app-shell/AppShell', () => ({ AppShell: () => null }))

async function createService() {
  const { AppShellScenarioService } = await import('../app-shell-scenario-service')
  return new AppShellScenarioService()
}

describe('AppShellScenarioService', () => {
  it('keeps scenario definitions isolated from renderer atom mutation', async () => {
    const source = await Bun.file(new URL('../app-shell-scenario-service.tsx', import.meta.url)).text()
    expect(source).not.toContain("from '@/atoms/")
    expect(source).not.toContain('useSetAtom')
    expect(source).toContain('ScenarioSessionProjectionBoundary')
  })

  it('keeps the external-store snapshot stable until a reducer event', async () => {
    const service = await createService()
    const before = service.getSnapshot()
    expect(service.getSnapshot()).toBe(before)
    service.dispatch({ type: 'show.app-loading' })
    expect(service.getSnapshot()).not.toBe(before)
  })
  it('registers the initial typed AppShell scenario matrix', async () => {
    const ids = (await createService()).scenarios.list().map(item => item.id)
    expect(ids).toEqual([
      'app.loading',
      'extension.error',
      'extension.loading',
      'extension.ready',
      'extension.reload',
      'session.empty',
      'session.queued',
      'session.reasoning-result',
      'session.streaming',
      'settings.app',
      'transport.error',
      'transport.reconnect',
    ])
  })

  it('renders queued sessions through the real AppShell host', async () => {
    const { appShellScenarioService, ScenarioAppShellHost } = await import('../app-shell-scenario-service')
    await appShellScenarioService.apply({ name: 'session.queued' })
    try {
      expect(renderToStaticMarkup(createElement(ScenarioAppShellHost))).toContain('data-testid="scenario.real-app-shell"')
    } finally {
      await appShellScenarioService.reset()
    }
  })

  it('provides process text and exactly one final result through Pi projection', async () => {
    const { appShellScenarioService, createReasoningResultProjection, ScenarioAppShellHost } = await import('../app-shell-scenario-service')
    const projection = createReasoningResultProjection()
    const payload = (entity: (typeof projection.entities)[number]) => entity.payload as Record<string, unknown>
    expect(projection.entities.filter(entity => entity.kind === 'thinking_end' || payload(entity).isIntermediate === true)).toHaveLength(2)
    expect(projection.entities
      .filter(entity => entity.kind === 'thinking_end' || entity.entityType === 'tool_run')
      .map(entity => [entity.createdSeq, entity.kind])).toEqual([
        [2, 'thinking_end'],
        [3, 'tool_execution_end'],
        [4, 'thinking_end'],
        [5, 'tool_execution_end'],
      ])
    expect(projection.entities.filter(entity => entity.entityType === 'tool_run').map(payload)).toEqual([
      expect.objectContaining({ timestamp: expect.any(Number), startedAt: expect.any(Number), completedAt: expect.any(Number) }),
      expect.objectContaining({ timestamp: expect.any(Number), startedAt: expect.any(Number), completedAt: expect.any(Number) }),
    ])
    expect(projection.entities.filter(entity => payload(entity).isFinal === true)).toMatchObject([
      { kind: 'assistant_text', payload: { text: '这是唯一渲染为卡片的最终结果。' } },
    ])
    await appShellScenarioService.apply({ name: 'session.reasoning-result' })
    try {
      expect(renderToStaticMarkup(createElement(ScenarioAppShellHost))).toContain('data-testid="scenario.real-app-shell"')
    } finally {
      await appShellScenarioService.reset()
    }
  })

  it('applies through registered reducer events and resets without arbitrary fixtures', async () => {
    const service = await createService()
    await service.apply({ name: 'transport.error', seed: 4 })
    expect(service.getSnapshot()).toMatchObject({ activeScenario: 'transport.error', view: 'transport', transport: { status: 'failed' } })
    await expect(service.apply({ name: 'transport.error', fixture: { atom: 'write' } })).rejects.toMatchObject({ code: 'SCENARIO_INVALID' })
    await service.reset()
    expect(service.getSnapshot()).toMatchObject({ view: 'idle', lastEvent: 'reset' })
  })

  it('commits one reset transition and keeps repeated reset idempotent', async () => {
    const service = await createService()
    await service.apply({ name: 'transport.error' })
    let notifications = 0
    const unsubscribe = service.subscribe(() => { notifications += 1 })
    await service.reset()
    const first = service.getSnapshot()
    expect(notifications).toBe(1)
    expect(first).toMatchObject({ view: 'idle', lastEvent: 'reset' })
    expect(first.activeScenario).toBeUndefined()
    await service.reset()
    expect(service.getSnapshot()).toBe(first)
    expect(notifications).toBe(1)
    unsubscribe()
  })

  it('prevents disposed scenario clocks from writing stale async outcomes after reset', async () => {
    const service = await createService()
    await service.apply({ name: 'transport.reconnect', clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })
    const retry = service.retryTransport()
    await Promise.resolve()
    await service.reset()
    const idle = service.getSnapshot()
    await retry
    expect(service.getSnapshot()).toBe(idle)

    await service.apply({ name: 'extension.ready', clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })
    const reload = service.reloadExtension()
    await Promise.resolve()
    await service.reset()
    const secondIdle = service.getSnapshot()
    await reload
    expect(service.getSnapshot()).toBe(secondIdle)
  })

  it('exposes only registered typed state and service primitives', async () => {
    const service = await createService()
    expect(service.primitives.list()).toEqual([
      'app.loading',
      'extension.phase',
      'route.settings',
      'session.empty',
      'session.queued',
      'session.reasoning-result',
      'session.streaming',
      'transport.state',
    ])
    expect(service.services.list()).toEqual(['extension.reload', 'session.stream', 'transport.connect'])
    const clock = new (await import('@mortise/shared/ui-validation')).FrozenUiValidationClock(0)
    await expect(service.primitives.apply('atom.write', service, {}, clock)).rejects.toMatchObject({ code: 'SCENARIO_INVALID' })
    await expect(service.services.invoke('renderer.evaluate', service, {}, clock)).rejects.toMatchObject({ code: 'SCENARIO_INVALID' })
  })

  it('advances only the registered application clock and drives scheduled reducer events', async () => {
    const service = await createService()
    await service.apply({ name: 'session.streaming', clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })
    await Promise.resolve()
    expect(service.getSnapshot().stream.active).toBeTrue()
    service.advance(999)
    await Promise.resolve()
    expect(service.getSnapshot().stream.active).toBeTrue()
    service.advance(1)
    await Promise.resolve()
    expect(service.getSnapshot().stream.active).toBeFalse()
  })

  it('accepts only named, scoped, bounded fault points', async () => {
    const service = await createService()
    await service.apply({ name: 'transport.reconnect' })
    expect(() => service.faults.set({ point: 'unknown', effect: { kind: 'drop' } })).toThrow('not registered')
    expect(() => service.faults.set({ point: 'transport.connect', scope: { surface: 'app-shell', arbitrary: 'state' }, effect: { kind: 'disconnect' } })).toThrow('scope is invalid')
    const fault = service.faults.set({ point: 'transport.connect', scope: { surface: 'app-shell' }, effect: { kind: 'disconnect' }, times: 1 })
    await service.retryTransport()
    expect(service.faults.list()).toHaveLength(0)
    expect(fault.remaining).toBe(1)
    expect(service.getSnapshot()).toMatchObject({ transport: { status: 'failed' }, serviceEvents: [{ operation: 'transport.connect', outcome: 'disconnected' }] })
  })

  it('routes drop and disconnect effects through controlled services with exact outcomes', async () => {
    const service = await createService()
    await service.apply({ name: 'session.streaming', clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })
    await service.reset()
    await service.apply({ name: 'session.streaming', clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })
    service.faults.set({ point: 'extension.reload', scope: { extensionId: 'ui-validation-example-extension' }, effect: { kind: 'drop' }, times: 1 })
    await service.services.invoke('extension.reload', service, {}, service.scenarios.activeClock!)
    expect(service.getSnapshot().serviceEvents.at(-1)).toEqual({ operation: 'extension.reload', outcome: 'dropped' })
  })

  it('routes fault delays and errors through the application retry clock', async () => {
    const service = await createService()
    await service.apply({ name: 'transport.reconnect', clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })
    service.faults.set({ point: 'transport.connect', scope: { surface: 'app-shell' }, effect: { kind: 'delay', ms: 50 }, times: 1 })
    let settled = false
    const retry = service.retryTransport().then(() => { settled = true })
    await Promise.resolve()
    service.advance(49)
    await Promise.resolve()
    expect(settled).toBeFalse()
    service.advance(1)
    await Promise.resolve()
    await Promise.resolve()
    service.advance(100)
    await retry
    expect(service.getSnapshot().serviceEvents.at(-1)).toEqual({ operation: 'transport.connect', outcome: 'completed' })

    service.faults.set({ point: 'transport.connect', scope: { surface: 'app-shell' }, effect: { kind: 'error', code: 'OFFLINE' }, times: 1 })
    await service.retryTransport()
    expect(service.getSnapshot().serviceEvents.at(-1)).toEqual({ operation: 'transport.connect', outcome: 'failed' })
  })

  it('observes an immediate service fault while scenario setup is activating', async () => {
    const service = await createService()
    await service.apply({ name: 'extension.ready' })
    service.faults.set({ point: 'session.stream', scope: { sessionId: 'ui-validation-scenario-session' }, effect: { kind: 'error', code: 'STREAM_FAILED' }, times: 1 })
    await service.apply({ name: 'session.streaming', clock: { mode: 'frozen', now: '2026-01-01T00:00:00Z' } })
    await Promise.resolve()
    expect(service.getSnapshot()).toMatchObject({ stream: { active: false }, serviceEvents: [{ operation: 'session.stream', outcome: 'failed' }] })
  })
})
