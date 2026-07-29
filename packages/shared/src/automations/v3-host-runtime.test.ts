import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityReadOnlyError, MultiWriterStore } from '../storage/index.ts'
import { AutomationWorkspaceHostV3 } from './v3-host-runtime.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('AutomationWorkspaceHostV3', () => {
  it('advances missed time boundaries without creating a recovery run', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-host-missed-'))
    roots.push(root)
    const host = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-host-missed',
      workspaceRootPath: root,
      callbacks: {
        prompt: async () => ({ status: 'succeeded' }),
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    const initial = host.store.initialize()
    const definition = {
      id: 'automation-host-missed', name: 'Missed once', enabled: true,
      triggers: [{
        id: 'trigger-host-missed', type: 'time' as const,
        schedule: { kind: 'once' as const, at: '2026-07-20T09:00:00.000Z' },
      }],
      actions: [{ id: 'action-host-missed', type: 'prompt' as const, prompt: 'do not run', target: { kind: 'new-session' as const } }],
      createdAt: '2026-07-20T08:00:00.000Z', updatedAt: '2026-07-20T08:00:00.000Z',
    }
    expect(host.store.mutateDocument({
      operationId: 'operation-host-missed-definition',
      expectedRevision: initial.revision,
      document: { ...initial, definitions: [definition] },
    }).status).toBe('ok')
    const now = new Date('2026-07-20T10:00:00.000Z')
    const due = host.store.listDueOccurrences(now, 100, now)
    expect(due).toHaveLength(1)
    expect(due[0]?.occurrence.skipReason).toBe('missed')
    host.store.recordMissedTimeOccurrence(due[0]!)
    host.store.recordMissedTimeOccurrence(due[0]!)
    expect(host.store.listRuns()).toEqual([])
    expect(host.store.listDueOccurrences(now, 100, now)).toEqual([])
    host.store.close()
  })

  it('returns a durable run claim before background action completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automation-host-'))
    roots.push(root)
    let release!: () => void
    const actionGate = new Promise<void>(resolve => { release = resolve })
    const host = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-host-test',
      workspaceRootPath: root,
      callbacks: {
        prompt: async () => {
          await actionGate
          return { status: 'succeeded' }
        },
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    host.start()
    const document = host.store.initialize()
    const now = new Date().toISOString()
    const definition = {
      id: 'automation-host-test',
      name: 'Host test',
      enabled: true,
      triggers: [{ id: 'trigger-host-test', type: 'event' as const, source: 'mortise' as const, eventType: 'mortise.test' }],
      actions: [{ id: 'action-host-test', type: 'prompt' as const, prompt: 'test', target: { kind: 'new-session' as const } }],
      createdAt: now,
      updatedAt: now,
    }
    expect(host.store.mutateDocument({
      operationId: 'create-host-test',
      expectedRevision: document.revision,
      document: { ...document, definitions: [definition] },
    }).status).toBe('ok')

    const accepted = host.acceptManual(definition.id, 'manual-host-test')
    expect(accepted.duplicate).toBe(false)
    expect(accepted.run.state).toBe('queued')
    expect(host.store.getRun(accepted.run.runId)?.state).toBe('running')
    expect(host.acceptManual(definition.id, 'manual-host-test')).toMatchObject({ duplicate: true, run: { runId: accepted.run.runId } })

    release()
    for (let attempt = 0; attempt < 50 && host.store.getRun(accepted.run.runId)?.state !== 'succeeded'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(host.store.getRun(accepted.run.runId)?.state).toBe('succeeded')
    await host.stop()
  })

  it('coalesces stale queue-one runs to only the newest occurrence during restart recovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-host-recovery-'))
    roots.push(root)
    const firstHost = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-host-recovery',
      workspaceRootPath: root,
      callbacks: {
        prompt: async () => ({ status: 'succeeded' }),
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    const initial = firstHost.store.initialize()
    const now = new Date().toISOString()
    const definition = {
      id: 'automation-recovery', name: 'Recovery', enabled: true,
      triggers: [{ id: 'trigger-recovery', type: 'event' as const, source: 'mortise' as const, eventType: 'manual' }],
      actions: [{ id: 'action-recovery', type: 'prompt' as const, prompt: 'recover', target: { kind: 'new-session' as const } }],
      runPolicy: { overlap: 'queue-one' as const }, createdAt: now, updatedAt: now,
    }
    expect(firstHost.store.mutateDocument({
      operationId: 'operation-host-recovery-definition',
      expectedRevision: initial.revision,
      document: { ...initial, definitions: [definition] },
    }).status).toBe('ok')

    const active = firstHost.runtime.acceptManual(definition.id, 'manual-active').run
    firstHost.store.claimRunExecution(active.runId, {
      ownerId: 'crashed-host',
      leaseMs: 1,
      now: new Date(Date.now() - 60_000),
    })
    await Bun.sleep(2)
    const stale = firstHost.runtime.acceptManual(definition.id, 'manual-stale').run
    await Bun.sleep(2)
    const newest = firstHost.runtime.acceptManual(definition.id, 'manual-newest').run
    firstHost.store.close()

    const executed: string[] = []
    const recoveredHost = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-host-recovery',
      workspaceRootPath: root,
      callbacks: {
        prompt: async (_action, context) => {
          executed.push(context.run.runId)
          return { status: 'succeeded' }
        },
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    recoveredHost.start()
    for (let attempt = 0; attempt < 100 && recoveredHost.store.getRun(newest.runId)?.state !== 'succeeded'; attempt++) {
      await Bun.sleep(5)
    }

    expect(executed).toEqual([newest.runId])
    expect(recoveredHost.store.getRun(active.runId)).toMatchObject({ state: 'failed', reason: 'execution-lease-expired' })
    expect(recoveredHost.store.getRun(stale.runId)).toMatchObject({ state: 'skipped', reason: 'queue-one-coalesced' })
    expect(recoveredHost.store.getRun(newest.runId)).toMatchObject({ state: 'succeeded' })
    await recoveredHost.stop()
  })

  it('keeps core automation writes available when only ingress is incompatible', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-host-readonly-'))
    roots.push(root)
    const databasePath = join(root, '.mortise', 'automations-v3.sqlite')
    const future = MultiWriterStore.openSync({
      databasePath,
      writerId: 'future-automations-host',
      writerVersion: 2,
      capabilities: {
        'automations.definitions': { minWriteVersion: 4, maxWriteVersion: 4 },
        'automations.ingress': { minWriteVersion: 3, maxWriteVersion: 3 },
        'automations.runs': { minWriteVersion: 1, maxWriteVersion: 1 },
        'automations.history': { minWriteVersion: 1, maxWriteVersion: 1 },
      },
    })
    future.close()

    const host = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-host-readonly',
      workspaceRootPath: root,
      databasePath,
      callbacks: {
        prompt: async () => ({ status: 'succeeded' }),
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    expect(() => host.start()).not.toThrow()
    expect(host.isReadOnly()).toBe(false)
    expect(host.store.getDocument()).toEqual({ schemaVersion: 3, revision: 1, definitions: [] })
    expect(() => host.store.acceptCloudEvent({
      specversion: '1.0',
      id: 'future-ingress-event',
      source: 'urn:test:future',
      type: 'test.future',
      time: '2026-07-26T00:00:00.000Z',
      data: {},
    }, { sourceKind: 'external' })).toThrow(CapabilityReadOnlyError)
    await host.stop()
  })

  it('durably interrupts active and queued runs, coalesces callers, and starts later work with a fresh signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-host-interrupt-'))
    roots.push(root)
    let releaseActive!: () => void
    const activeGate = new Promise<void>(resolve => { releaseActive = resolve })
    const observedSignals: boolean[] = []
    const host = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-host-interrupt',
      workspaceRootPath: root,
      callbacks: {
        prompt: async (_action, context) => {
          observedSignals.push(context.signal?.aborted ?? false)
          if (observedSignals.length === 1) {
            await activeGate
            observedSignals.push(context.signal?.aborted ?? false)
          }
          return { status: 'succeeded' }
        },
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    host.start()
    const document = host.store.initialize()
    const now = new Date().toISOString()
    const definition = {
      id: 'automation-host-interrupt', name: 'Interrupt', enabled: true,
      triggers: [{ id: 'trigger-host-interrupt', type: 'event' as const, source: 'mortise' as const, eventType: 'manual' }],
      actions: [{ id: 'action-host-interrupt', type: 'prompt' as const, prompt: 'interrupt', target: { kind: 'new-session' as const } }],
      runPolicy: { overlap: 'queue-one' as const }, createdAt: now, updatedAt: now,
    }
    expect(host.store.mutateDocument({
      operationId: 'operation-host-interrupt-definition',
      expectedRevision: document.revision,
      document: { ...document, definitions: [definition] },
    }).status).toBe('ok')

    const active = host.acceptManual(definition.id, 'manual-interrupt-active').run
    const queued = host.acceptManual(definition.id, 'manual-interrupt-queued').run
    for (let attempt = 0; attempt < 50 && host.store.getRun(active.runId)?.state !== 'running'; attempt++) await Bun.sleep(5)
    expect(host.store.getRun(active.runId)?.state).toBe('running')
    expect(host.store.getRun(queued.runId)?.state).toBe('queued')

    const first = host.interruptForWorkspaceTopologyChange()
    const second = host.interruptForWorkspaceTopologyChange()
    expect(second).toBe(first)
    expect(() => host.acceptManual(definition.id, 'manual-during-interrupt')).toThrow('in progress')
    expect(host.store.getRun(active.runId)).toMatchObject({ state: 'cancelled', reason: 'workspace-topology-interrupted' })
    expect(host.store.getRun(queued.runId)).toMatchObject({ state: 'cancelled', reason: 'workspace-topology-interrupted' })

    releaseActive()
    await expect(first).resolves.toMatchObject({
      selectedRunIds: expect.arrayContaining([active.runId, queued.runId]),
      cancelledRunIds: expect.arrayContaining([active.runId, queued.runId]),
    })
    expect(observedSignals).toEqual([false, true])
    expect(host.store.initialize().definitions).toMatchObject([{ id: definition.id, enabled: true }])
    expect(host.interruptForWorkspaceTopologyChange()).toBe(first)
    expect(() => host.acceptManual(definition.id, 'manual-before-topology-commit')).toThrow('in progress')
    await host.resumeAfterWorkspaceTopologyChange()

    const later = host.acceptManual(definition.id, 'manual-after-interrupt').run
    for (let attempt = 0; attempt < 50 && host.store.getRun(later.runId)?.state !== 'succeeded'; attempt++) await Bun.sleep(5)
    expect(host.store.getRun(later.runId)?.state).toBe('succeeded')
    expect(observedSignals.at(-1)).toBe(false)
    await host.interruptForWorkspaceTopologyChange()
    await host.resumeAfterWorkspaceTopologyChange()
    await host.stop()
  })

  it('does not recover topology-interrupted runs after a host restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-host-interrupt-restart-'))
    roots.push(root)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const host = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-host-interrupt-restart',
      workspaceRootPath: root,
      callbacks: {
        prompt: async () => { await gate; return { status: 'succeeded' } },
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    host.start()
    const document = host.store.initialize()
    const now = new Date().toISOString()
    const definition = {
      id: 'automation-host-interrupt-restart', name: 'Restart', enabled: true,
      triggers: [{ id: 'trigger-host-interrupt-restart', type: 'event' as const, source: 'mortise' as const, eventType: 'manual' }],
      actions: [{ id: 'action-host-interrupt-restart', type: 'prompt' as const, prompt: 'restart', target: { kind: 'new-session' as const } }],
      createdAt: now, updatedAt: now,
    }
    expect(host.store.mutateDocument({
      operationId: 'operation-host-interrupt-restart-definition',
      expectedRevision: document.revision,
      document: { ...document, definitions: [definition] },
    }).status).toBe('ok')
    const run = host.acceptManual(definition.id, 'manual-interrupt-restart').run
    for (let attempt = 0; attempt < 50 && host.store.getRun(run.runId)?.state !== 'running'; attempt++) await Bun.sleep(5)
    const interrupted = host.interruptForWorkspaceTopologyChange()
    release()
    await interrupted
    await host.stop()

    let recoveredExecutions = 0
    const recoveredHost = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-host-interrupt-restart',
      workspaceRootPath: root,
      callbacks: {
        prompt: async () => { recoveredExecutions++; return { status: 'succeeded' } },
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    recoveredHost.start()
    await Bun.sleep(25)
    expect(recoveredExecutions).toBe(0)
    expect(recoveredHost.store.getRun(run.runId)).toMatchObject({ state: 'cancelled', reason: 'workspace-topology-interrupted' })
    expect(recoveredHost.store.initialize().definitions).toMatchObject([{ id: definition.id, enabled: true }])
    await recoveredHost.stop()
  })

  it('interrupts only the active run using a changed location and preserves queued work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-location-interrupt-'))
    roots.push(root)
    let releaseActive!: () => void
    const activeGate = new Promise<void>(resolve => { releaseActive = resolve })
    let executionCount = 0
    const host = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-location-interrupt',
      workspaceRootPath: root,
      getCurrentLocationId: () => 'primary',
      callbacks: {
        prompt: async () => {
          executionCount++
          if (executionCount === 1) await activeGate
          return { status: 'succeeded' }
        },
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    host.start()
    const document = host.store.initialize()
    const now = new Date().toISOString()
    const definition = {
      id: 'automation-location-interrupt', name: 'Location interrupt', enabled: true,
      triggers: [{ id: 'trigger-location-interrupt', type: 'event' as const, source: 'mortise' as const, eventType: 'manual' }],
      actions: [{ id: 'action-location-interrupt', type: 'prompt' as const, prompt: 'run', target: { kind: 'new-session' as const } }],
      runPolicy: { overlap: 'queue-one' as const }, createdAt: now, updatedAt: now,
    }
    expect(host.store.mutateDocument({
      operationId: 'operation-location-interrupt-definition',
      expectedRevision: document.revision,
      document: { ...document, definitions: [definition] },
    }).status).toBe('ok')

    const active = host.acceptManual(definition.id, 'manual-location-active').run
    const queued = host.acceptManual(definition.id, 'manual-location-queued').run
    for (let attempt = 0; attempt < 50 && host.store.getRun(active.runId)?.state !== 'running'; attempt++) await Bun.sleep(5)

    await expect(host.interruptForWorkspaceTopologyChange({ scope: 'location', locationId: 'attached' }))
      .resolves.toEqual({ selectedRunIds: [], cancelledRunIds: [] })
    expect(host.store.getRun(active.runId)?.state).toBe('running')
    expect(host.store.getRun(queued.runId)?.state).toBe('queued')

    const interruption = host.interruptForWorkspaceTopologyChange({ scope: 'location', locationId: 'primary' })
    expect(host.store.getRun(active.runId)).toMatchObject({ state: 'cancelled', reason: 'workspace-location-interrupted' })
    expect(host.store.getRun(queued.runId)?.state).toBe('queued')
    releaseActive()
    await expect(interruption).resolves.toEqual({ selectedRunIds: [active.runId], cancelledRunIds: [active.runId] })
    await host.resumeAfterWorkspaceTopologyChange()
    for (let attempt = 0; attempt < 50 && host.store.getRun(queued.runId)?.state !== 'succeeded'; attempt++) await Bun.sleep(5)
    expect(host.store.getRun(queued.runId)?.state).toBe('succeeded')
    await host.stop()
  })

  it('fails closed when durable interruption cannot be completed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-host-interrupt-failure-'))
    roots.push(root)
    const errors: Error[] = []
    const host = new AutomationWorkspaceHostV3({
      workspaceId: 'workspace-host-interrupt-failure',
      workspaceRootPath: root,
      callbacks: {
        prompt: async () => ({ status: 'succeeded' }),
        webhook: async () => ({ status: 'succeeded' }),
      },
      onError: error => errors.push(error),
    })
    host.start()
    const originalCancel = host.store.cancelNonTerminalRuns.bind(host.store)
    host.store.cancelNonTerminalRuns = () => { throw new Error('planned interruption persistence failure') }
    await expect(host.interruptForWorkspaceTopologyChange()).rejects.toThrow('planned interruption persistence failure')
    expect(() => host.acceptManual('missing-automation', 'manual-after-failure')).toThrow('blocked after topology interruption failed')
    expect(errors.map(error => error.message)).toContain('planned interruption persistence failure')
    host.store.cancelNonTerminalRuns = originalCancel
    await host.stop()
  })
})
