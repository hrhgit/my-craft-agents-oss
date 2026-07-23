import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MultiWriterStore } from '../storage/index.ts'
import { AutomationWorkspaceHostV3 } from './v3-host-runtime.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('AutomationWorkspaceHostV3', () => {
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

  it('enters read-only mode without trying to initialize an incompatible store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-automations-host-readonly-'))
    roots.push(root)
    const databasePath = join(root, '.mortise', 'automations-v3.sqlite')
    const future = MultiWriterStore.openSync({
      databasePath,
      writerId: 'future-automations-host',
      writerVersion: 2,
      capabilities: {
        'automations.definitions': { minWriteVersion: 4, maxWriteVersion: 4 },
        'automations.ingress': { minWriteVersion: 1, maxWriteVersion: 1 },
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
    expect(host.isReadOnly()).toBe(true)
    expect(host.store.getDocument()).toBeNull()
    await host.stop()
  })
})
