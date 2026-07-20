import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutomationV3Store } from './v3-store.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('legacy prompt-automation migration', () => {
  it('commits jobs and external triggers before archiving project files', () => {
    const root = mkdtempSync(join(tmpdir(), 'mortise-prompt-automation-migration-'))
    roots.push(root)
    const piDir = join(root, '.pi')
    mkdirSync(piDir, { recursive: true })
    writeFileSync(join(piDir, 'schedule-prompts.json'), JSON.stringify({
      version: 1,
      jobs: [{
        id: 'legacy-job', name: 'Daily review', type: 'interval', intervalMs: 60_000,
        schedule: '1m', prompt: 'review the workspace', enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z', runCount: 0,
      }],
    }))
    writeFileSync(join(piDir, 'prompt-automation.json'), JSON.stringify({
      triggers: { deploy: { prompt: 'check deployment', includePayload: true, delivery: 'steer' } },
    }))

    const store = new AutomationV3Store({ workspaceId: 'workspace-migration', workspaceRootPath: root, legacyGlobalConfigPath: null })
    const result = store.initializeOrMigrate()
    store.close()

    expect(result.document.definitions).toHaveLength(2)
    expect(result.document.definitions.some(item => item.triggers[0]?.type === 'time')).toBe(true)
    const external = result.document.definitions.find(item => item.triggers[0]?.type === 'event')!
    expect(external.actions[0]).toMatchObject({ eventData: 'append-json', target: { kind: 'session', session: 'event-session', delivery: 'steer' } })
    expect(existsSync(join(piDir, 'schedule-prompts.json.migrated-v3'))).toBe(true)
    expect(existsSync(join(piDir, 'prompt-automation.json.migrated-v3'))).toBe(true)
    expect(existsSync(join(root, '.mortise', 'automations-v3-migration.json'))).toBe(true)
  })
})
