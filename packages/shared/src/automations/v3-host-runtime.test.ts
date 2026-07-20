import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      legacyGlobalConfigPath: null,
      callbacks: {
        prompt: async () => {
          await actionGate
          return { status: 'succeeded' }
        },
        webhook: async () => ({ status: 'succeeded' }),
      },
    })
    host.start()
    const document = host.store.initializeOrMigrate().document
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
})
