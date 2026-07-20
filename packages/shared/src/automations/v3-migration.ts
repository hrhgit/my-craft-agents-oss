import { createHash } from 'node:crypto'
import type { AutomationsConfig, AutomationMatcher } from './types.ts'
import type {
  AutomationActionV3,
  AutomationDefinitionV3,
  AutomationMigrationDiagnosticV1,
  AutomationMigrationResultV1,
  AutomationTriggerV3,
  AutomationsDocumentV3,
} from './v3-types.ts'
import { AutomationsDocumentV3Schema } from './v3-schemas.ts'

const AGENT_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'UserPromptSubmit',
  'SessionStart', 'SessionEnd', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact',
  'PermissionRequest', 'Setup',
])

function hash(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
}

function opaqueId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${hash(parts)}`
}

function retainOrMigrateId(
  candidate: string | undefined,
  prefix: string,
  used: Set<string>,
  aliases: Record<string, string>,
  ...seed: unknown[]
): string {
  const valid = candidate && /^[A-Za-z0-9][A-Za-z0-9._:-]{11,255}$/.test(candidate) && !used.has(candidate)
  const id = valid ? candidate : opaqueId(prefix, ...seed, candidate ?? '')
  if (candidate && candidate !== id) aliases[candidate] = id
  used.add(id)
  return id
}

function migrateAction(
  action: AutomationMatcher['actions'][number],
  actionId: string,
  matcher: AutomationMatcher,
  diagnostics: AutomationMigrationDiagnosticV1[],
  automationId: string,
): { action: AutomationActionV3; blocksDefinition: boolean } {
  if (action.type === 'prompt') {
    return {
      action: {
        id: actionId,
        type: 'prompt',
        prompt: action.prompt,
        target: {
          kind: 'new-session',
          ...(action.provider ? { provider: action.provider } : {}),
          ...(action.model ? { model: action.model } : {}),
          ...(action.thinkingLevel ? { thinkingLevel: action.thinkingLevel } : {}),
          ...(matcher.permissionMode ? { permissionMode: matcher.permissionMode } : {}),
          ...(matcher.telegramTopic ? { telegramTopic: matcher.telegramTopic } : {}),
        },
      },
      blocksDefinition: false,
    }
  }

  let blocksDefinition = false
  if (action.auth) {
    blocksDefinition = true
    diagnostics.push({
      automationId,
      code: 'literal_webhook_credential_requires_secret_import',
      message: 'Webhook credentials were not copied; import them into Mortise secrets before enabling this automation.',
    })
  }
  return {
    action: {
      id: actionId,
      type: 'webhook',
      url: action.url,
      ...(action.method ? { method: action.method } : {}),
      ...(action.headers ? { headers: action.headers } : {}),
      ...(action.bodyFormat ? { bodyFormat: action.bodyFormat } : {}),
      ...(action.body !== undefined ? { body: action.body } : {}),
      ...(action.captureResponse !== undefined ? { captureResponse: action.captureResponse } : {}),
    },
    blocksDefinition,
  }
}

export function migrateAutomationsConfigV2(
  config: AutomationsConfig,
  options: { workspaceId: string; now?: Date; initialRevision?: number },
): AutomationMigrationResultV1 {
  const now = (options.now ?? new Date()).toISOString()
  const aliases: Record<string, string> = {}
  const diagnostics: AutomationMigrationDiagnosticV1[] = []
  const definitions: AutomationDefinitionV3[] = []
  const usedIds = new Set<string>()

  for (const [eventType, matchers] of Object.entries(config.automations)) {
    if (!matchers) continue
    for (let matcherIndex = 0; matcherIndex < matchers.length; matcherIndex++) {
      const matcher = matchers[matcherIndex]!
      const id = retainOrMigrateId(
        matcher.id,
        'aut',
        usedIds,
        aliases,
        options.workspaceId,
        eventType,
        matcherIndex,
        matcher,
      )
      const triggerId = retainOrMigrateId(undefined, 'trg', usedIds, aliases, id, eventType)
      let trigger: AutomationTriggerV3
      if (eventType === 'SchedulerTick' && matcher.cron) {
        trigger = {
          id: triggerId,
          type: 'time',
          schedule: {
            kind: 'cron',
            expression: matcher.cron,
            ...(matcher.timezone ? { timezone: matcher.timezone } : {}),
          },
        }
      } else {
        trigger = {
          id: triggerId,
          type: 'event',
          source: AGENT_EVENTS.has(eventType) ? 'agent' : 'mortise',
          eventType,
          ...(matcher.matcher ? { matcher: matcher.matcher } : {}),
        }
      }

      let blocked = false
      const actions = matcher.actions.map((action, actionIndex) => {
        const actionId = retainOrMigrateId(undefined, 'act', usedIds, aliases, id, actionIndex, action)
        const migrated = migrateAction(action, actionId, matcher, diagnostics, id)
        blocked ||= migrated.blocksDefinition
        return migrated.action
      })
      definitions.push({
        id,
        name: matcher.name?.trim() || `Automation ${definitions.length + 1}`,
        enabled: matcher.enabled !== false && !blocked,
        triggers: [trigger],
        ...(matcher.conditions?.length ? { conditions: matcher.conditions } : {}),
        actions,
        runPolicy: { overlap: 'skip', actionFailure: 'continue' },
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  const document: AutomationsDocumentV3 = {
    schemaVersion: 3,
    revision: options.initialRevision ?? 1,
    definitions,
  }
  AutomationsDocumentV3Schema.parse(document)
  return { document, aliases, diagnostics }
}
