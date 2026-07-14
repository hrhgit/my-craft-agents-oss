import { describe, expect, it, mock } from 'bun:test'

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
      'session.streaming',
      'settings.app',
      'settings.permissions',
      'tool.approval',
      'transport.error',
      'transport.reconnect',
    ])
  })

  it('applies through registered reducer events and resets without arbitrary fixtures', async () => {
    const service = await createService()
    await service.apply({ name: 'transport.error', seed: 4 })
    expect(service.getSnapshot()).toMatchObject({ activeScenario: 'transport.error', view: 'transport', transport: { status: 'failed' } })
    await expect(service.apply({ name: 'transport.error', fixture: { atom: 'write' } })).rejects.toMatchObject({ code: 'SCENARIO_INVALID' })
    await service.reset()
    expect(service.getSnapshot()).toMatchObject({ view: 'idle', lastEvent: 'reset' })
  })

  it('exposes only registered typed state and service primitives', async () => {
    const service = await createService()
    expect(service.primitives.list()).toEqual([
      'app.loading',
      'extension.phase',
      'route.permissions',
      'route.settings',
      'session.empty',
      'session.streaming',
      'tool.approval',
      'transport.state',
    ])
    expect(service.services.list()).toEqual(['extension.reload', 'session.stream', 'transport.connect'])
    const clock = new (await import('@craft-agent/shared/ui-validation')).FrozenUiValidationClock(0)
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
