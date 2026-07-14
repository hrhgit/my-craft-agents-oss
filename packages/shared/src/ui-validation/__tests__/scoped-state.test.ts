import { describe, expect, it } from 'bun:test'
import { UiValidationScopedStateRegistry } from '../scoped-state.ts'

describe('UiValidationScopedStateRegistry', () => {
  it('deduplicates identical state and keeps revisions monotonic', () => {
    const registry = new UiValidationScopedStateRegistry()
    const first = registry.update({ scope: 'app', phase: 'loading' }, '7')
    const duplicate = registry.update({ scope: 'app', phase: 'loading' }, '7')
    const ready = registry.update({ scope: 'app', phase: 'ready' }, '7')
    expect(duplicate.revision).toBe(first.revision)
    expect(ready.revision).toBe(first.revision + 1)
    expect(registry.events.latestSeq).toBe(2)
  })

  it('checks current state before subscribing and enforces stability', async () => {
    const registry = new UiValidationScopedStateRegistry()
    registry.update({ scope: 'route', phase: 'ready', detail: { route: 'settings' } }, '8')
    const matched = await registry.waitFor({ scope: 'route', phase: 'ready', windowId: '8' }, { stableForMs: 5, timeoutMs: 100 })
    expect(matched.detail?.route).toBe('settings')
  })

  it('supports cancellation', async () => {
    const registry = new UiValidationScopedStateRegistry()
    const controller = new AbortController()
    const waiting = registry.waitFor({ scope: 'transport', phase: 'ready' }, { signal: controller.signal })
    controller.abort('test')
    await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('reports bounded replay gaps', async () => {
    const registry = new UiValidationScopedStateRegistry(2)
    registry.update({ scope: 'app', phase: 'booting' })
    registry.update({ scope: 'app', phase: 'loading' })
    registry.update({ scope: 'app', phase: 'ready' })
    await expect(registry.waitFor({ scope: 'transport', phase: 'ready' }, { afterSeq: 0 })).rejects.toMatchObject({ code: 'EVENTS_DROPPED' })
  })

  it('prefers an already-matching current state over an old replay cursor', async () => {
    const registry = new UiValidationScopedStateRegistry(2)
    registry.update({ scope: 'app', phase: 'booting' })
    registry.update({ scope: 'app', phase: 'loading' })
    registry.update({ scope: 'app', phase: 'ready' })
    await expect(registry.waitFor({ scope: 'app', phase: 'ready' }, { afterSeq: 0 })).resolves.toMatchObject({ phase: 'ready' })
  })

  it('matches typed detail constraints without accepting a stale ready route', async () => {
    const registry = new UiValidationScopedStateRegistry()
    registry.update({ scope: 'route', phase: 'ready', detail: { route: 'settings' } }, '4')
    const waiting = registry.waitFor({ scope: 'route', phase: 'ready', windowId: '4', detail: { route: 'skills' } }, { timeoutMs: 100 })
    registry.update({ scope: 'route', phase: 'ready', detail: { route: 'skills' } }, '4')
    await expect(waiting).resolves.toMatchObject({ detail: { route: 'skills' } })
  })
})
