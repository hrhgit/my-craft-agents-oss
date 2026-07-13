import { describe, expect, it } from 'bun:test'
import type { ExtensionContributionDeltaV1 } from '@craft-agent/shared/protocol'
import { ContributionStore, selectMountableOverflow, SurfaceLayoutManager } from './extension-contribution-store'
import type { RegisteredExtensionContribution } from './extension-contribution-store'

function upsert(revision: number, id: string, priority = 0): ExtensionContributionDeltaV1 {
  return {
    schemaVersion: 1, extensionId: id.split(':')[0], sessionId: 'session', runtimeId: 'runtime', revision,
    operation: 'upsert', contribution: { schemaVersion: 1, id, surface: 'composer.toolbar', priority, content: { type: 'text', text: id } },
  }
}

describe('ContributionStore', () => {
  it('applies revisions idempotently and resets one extension runtime', () => {
    const store = new ContributionStore()
    expect(store.apply(upsert(1, 'a:one'))).toBe(true)
    expect(store.apply(upsert(1, 'a:stale'))).toBe(false)
    expect(store.list('session')).toHaveLength(1)
    expect(store.apply({ schemaVersion: 1, extensionId: 'a', sessionId: 'session', runtimeId: 'runtime', revision: 2, operation: 'reset' })).toBe(true)
    expect(store.list('session')).toHaveLength(0)
  })

  it('allocates constrained surfaces without overlap', () => {
    const store = new ContributionStore()
    for (let index = 0; index < 6; index++) store.apply(upsert(1, `ext${index}:item`, index))
    const layout = new SurfaceLayoutManager().resolve('composer.toolbar', store.list('session', 'composer.toolbar'))
    expect(layout.visible).toHaveLength(4)
    expect(layout.overflow).toHaveLength(2)
    expect(layout.visible[0]?.contribution.priority).toBe(5)
  })

  it('replaces extension state from snapshots and clears failed runtimes', () => {
    const store = new ContributionStore()
    store.apply(upsert(1, 'a:old'))
    store.apply({
      schemaVersion: 1, extensionId: 'a', sessionId: 'session', runtimeId: 'runtime', revision: 2,
      operation: 'snapshot', contributions: [
        { schemaVersion: 1, id: 'new', surface: 'composer.toolbar', content: { type: 'text', text: 'new' } },
      ],
    })
    expect(store.list('session').map(item => item.contribution.id)).toEqual(['new'])
    store.resetRuntime('session', 'runtime')
    expect(store.list('session')).toHaveLength(0)
  })

  it('notifies when resetting a runtime that only has revision state', () => {
    const store = new ContributionStore()
    let notifications = 0
    store.subscribe(() => { notifications += 1 })
    store.apply({
      schemaVersion: 1, extensionId: 'a', sessionId: 'session', runtimeId: 'runtime', revision: 1,
      operation: 'reset',
    })
    const versionBeforeReset = store.getVersion()

    store.resetRuntime('session', 'runtime')

    expect(store.getVersion()).toBe(versionBeforeReset + 1)
    expect(notifications).toBe(2)
  })

  it('limits concurrently mounted sandbox apps even on unbounded surfaces', () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      extensionId: `ext-${index}`, sessionId: 'session', runtimeId: `runtime-${index}`, revision: 1,
      contribution: {
        schemaVersion: 1 as const, id: `app-${index}`, surface: 'conversation.timeline.before' as const,
        content: { type: 'sandbox-app' as const, appId: `app-${index}`, title: `App ${index}`, html: '' },
      },
    }))
    const layout = new SurfaceLayoutManager().resolve('conversation.timeline.before', items)
    expect(layout.visible).toHaveLength(4)
    expect(layout.overflow).toHaveLength(2)
  })

  it('keeps the sandbox budget when overflow is expanded without hiding other overflow items', () => {
    const sandbox = (id: string): RegisteredExtensionContribution => ({
      extensionId: id, sessionId: 'session', runtimeId: id, revision: 1,
      contribution: {
        schemaVersion: 1, id, surface: 'conversation.timeline.before',
        content: { type: 'sandbox-app', appId: id, title: id, html: '' },
      },
    })
    const text = (id: string): RegisteredExtensionContribution => ({
      extensionId: id, sessionId: 'session', runtimeId: id, revision: 1,
      contribution: {
        schemaVersion: 1, id, surface: 'conversation.timeline.before',
        content: { type: 'text', text: id },
      },
    })
    const mountable = selectMountableOverflow({
      visible: [sandbox('visible-1'), sandbox('visible-2'), sandbox('visible-3')],
      overflow: [sandbox('overflow-1'), sandbox('overflow-2'), text('text-1')],
    })

    expect(mountable.map(item => item.contribution.id)).toEqual(['overflow-1', 'text-1'])
  })
})
