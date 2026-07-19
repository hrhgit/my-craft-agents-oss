import { describe, expect, it } from 'bun:test'
import type { ExtensionContributionDeltaV1 } from '@mortise/shared/protocol'
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

  it('limits workspace content sandboxes even when the dock eagerly renders every tab', () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      extensionId: `ext-${index}`, sessionId: 'session', runtimeId: `runtime-${index}`, revision: 1,
      contribution: {
        schemaVersion: 1 as const, id: `app-${index}`, surface: 'workspace.content' as const,
        workspaceContent: { title: `App ${index}`, icon: 'activity' as const },
        content: { type: 'sandbox-app' as const, appId: `app-${index}`, title: `App ${index}`, html: '' },
      },
    }))
    const layout = new SurfaceLayoutManager().resolve('workspace.content', items)
    expect(layout.visible).toHaveLength(4)
    expect(layout.overflow).toHaveLength(4)
    expect(selectMountableOverflow(layout)).toHaveLength(0)
  })

  it('shares one workspace content sandbox admission budget across session resolvers', () => {
    const store = new ContributionStore()
    for (let index = 0; index < 6; index++) {
      store.apply({
        schemaVersion: 1,
        extensionId: `ext-${index}`,
        sessionId: `session-${index}`,
        runtimeId: `runtime-${index}`,
        workspaceId: 'workspace',
        revision: 1,
        operation: 'upsert',
        contribution: {
          schemaVersion: 1,
          id: 'app',
          surface: 'workspace.content',
          workspaceContent: { title: `App ${index}`, icon: 'activity', scope: 'session' },
          content: { type: 'sandbox-app', appId: `app-${index}`, title: `App ${index}`, html: '' },
        },
      })
    }

    const admitted = Array.from({ length: 6 }, (_, index) =>
      store.listWorkspaceContent(`session-${index}`, 'workspace'))
      .flat()
    expect(admitted).toHaveLength(4)
    expect(admitted.map(item => item.extensionId)).toEqual(['ext-0', 'ext-1', 'ext-2', 'ext-3'])
  })

  it('isolates revisions, snapshots and runtime resets by workspace', () => {
    const store = new ContributionStore()
    const delta = (workspaceId: string, text: string): ExtensionContributionDeltaV1 => ({
      schemaVersion: 1,
      extensionId: 'inspector',
      sessionId: 'shared-session',
      runtimeId: 'shared-runtime',
      workspaceId,
      revision: 1,
      operation: 'upsert',
      contribution: {
        schemaVersion: 1,
        id: 'status',
        surface: 'composer.status',
        content: { type: 'text', text },
      },
    })

    expect(store.apply(delta('workspace-a', 'A'))).toBe(true)
    expect(store.apply(delta('workspace-b', 'B'))).toBe(true)
    expect(store.list('shared-session', undefined, 'workspace-a')[0]?.contribution.content)
      .toEqual({ type: 'text', text: 'A' })
    expect(store.list('shared-session', undefined, 'workspace-b')[0]?.contribution.content)
      .toEqual({ type: 'text', text: 'B' })

    store.apply({
      schemaVersion: 1,
      extensionId: 'inspector',
      sessionId: 'shared-session',
      runtimeId: 'shared-runtime',
      workspaceId: 'workspace-a',
      revision: 2,
      operation: 'snapshot',
      contributions: [],
    })
    expect(store.list('shared-session', undefined, 'workspace-a')).toHaveLength(0)
    expect(store.list('shared-session', undefined, 'workspace-b')).toHaveLength(1)

    store.resetRuntime('shared-session', 'shared-runtime', 'workspace-a')
    expect(store.apply(delta('workspace-a', 'A restarted'))).toBe(true)
    expect(store.apply(delta('workspace-b', 'B stale'))).toBe(false)
  })

  it('resolves session, workspace and global content scopes with singleton policy', () => {
    const store = new ContributionStore()
    const revisions = new Map<string, number>()
    const add = (
      sessionId: string,
      workspaceId: string,
      scope: 'session' | 'workspace' | 'global',
      instancePolicy: 'singleton' | 'multiple' = 'singleton',
    ) => {
      const revision = (revisions.get(sessionId) ?? 0) + 1
      revisions.set(sessionId, revision)
      return store.apply({
      schemaVersion: 1,
      extensionId: 'inspector',
      sessionId,
      runtimeId: `runtime-${sessionId}`,
      workspaceId,
      revision,
      operation: 'upsert',
      contribution: {
        schemaVersion: 1,
        id: `${scope}-tool`,
        surface: 'workspace.content',
        workspaceContent: { title: scope, icon: 'activity', scope, instancePolicy },
        content: { type: 'text', text: sessionId },
      },
      })
    }

    add('session-a', 'workspace-a', 'session')
    add('session-b', 'workspace-a', 'session')
    add('session-a', 'workspace-a', 'workspace')
    add('session-b', 'workspace-a', 'workspace')
    add('session-c', 'workspace-b', 'workspace')
    add('session-a', 'workspace-a', 'global')
    add('session-c', 'workspace-b', 'global')

    const resolved = store.listWorkspaceContent('session-a', 'workspace-a')
    expect(resolved.filter(item => item.contribution.workspaceContent?.scope === 'session')).toHaveLength(1)
    expect(resolved.filter(item => item.contribution.workspaceContent?.scope === 'workspace')).toHaveLength(1)
    expect(resolved.filter(item => item.contribution.workspaceContent?.scope === 'global')).toHaveLength(1)
    expect(resolved.every(item => item.sessionId === 'session-a')).toBe(true)
    const workspaceB = store.listWorkspaceContent('session-a', 'workspace-b')
    expect(workspaceB).toHaveLength(2)
    expect(workspaceB.every(item => item.sessionId === 'session-c')).toBe(true)
  })

  it('keeps every scoped workspace content instance when multiple is requested', () => {
    const store = new ContributionStore()
    for (const sessionId of ['session-a', 'session-b']) {
      store.apply({
        schemaVersion: 1,
        extensionId: 'logs',
        sessionId,
        runtimeId: `runtime-${sessionId}`,
        workspaceId: 'workspace-a',
        revision: 1,
        operation: 'upsert',
        contribution: {
          schemaVersion: 1,
          id: 'logs',
          surface: 'workspace.content',
          workspaceContent: { title: 'Logs', icon: 'activity', scope: 'workspace', instancePolicy: 'multiple' },
          content: { type: 'text', text: sessionId },
        },
      })
    }
    expect(store.listWorkspaceContent('session-a', 'workspace-a')).toHaveLength(2)
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
