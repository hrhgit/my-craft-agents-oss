import { describe, expect, it } from 'bun:test'
import { migrateAutomationsConfigV2 } from './v3-migration.ts'

describe('Automations V2 migration', () => {
  it('maps SchedulerTick cron and prompt metadata into a V3 definition', () => {
    const result = migrateAutomationsConfigV2({ automations: {
      SchedulerTick: [{
        id: 'short1', name: 'Morning', cron: '0 9 * * *', timezone: 'Asia/Shanghai',
        permissionMode: 'ask', actions: [{ type: 'prompt', prompt: 'status', provider: 'openai', model: 'gpt' }],
      }],
    } }, { workspaceId: 'ws-one', now: new Date('2026-07-20T00:00:00Z') })

    expect(result.document.schemaVersion).toBe(3)
    expect(result.document.definitions[0]!.triggers[0]).toMatchObject({
      type: 'time', schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
    })
    expect(result.document.definitions[0]!.actions[0]).toMatchObject({
      type: 'prompt', target: { kind: 'new-session', permissionMode: 'ask', provider: 'openai', model: 'gpt' },
    })
    expect(result.aliases.short1).toBe(result.document.definitions[0]!.id)
  })

  it('disables literal-credential webhooks instead of persisting secrets', () => {
    const result = migrateAutomationsConfigV2({ automations: {
      SessionStart: [{ actions: [{ type: 'webhook', url: 'https://example.test', auth: { type: 'bearer', token: 'secret' } }] }],
    } }, { workspaceId: 'ws-one' })
    const definition = result.document.definitions[0]!
    expect(definition.enabled).toBe(false)
    expect(definition.actions[0]).not.toHaveProperty('auth')
    expect(result.diagnostics[0]?.code).toBe('literal_webhook_credential_requires_secret_import')
  })
})
