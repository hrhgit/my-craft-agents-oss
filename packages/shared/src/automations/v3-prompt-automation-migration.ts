import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PI_AGENT_DIR } from '../config/paths.ts'
import { atomicWriteFileSync } from '../utils/files.ts'
import type { AutomationDefinitionV3, AutomationMigrationDiagnosticV1, TimeScheduleV3 } from './v3-types.ts'

interface LegacyScheduleJob {
  id?: string
  name?: string
  schedule?: string
  prompt?: string
  enabled?: boolean
  type?: 'cron' | 'once' | 'interval'
  intervalMs?: number
  createdAt?: string
  model?: string
  notify?: boolean
  session?: string
}

interface LegacyTrigger {
  prompt?: string
  description?: string
  includePayload?: boolean
  delivery?: 'followUp' | 'steer'
}

export interface LegacyPromptAutomationMigrationPlanV1 {
  definitions: AutomationDefinitionV3[]
  diagnostics: AutomationMigrationDiagnosticV1[]
  sources: Array<{ path: string; kind: 'scheduled-jobs' | 'project-triggers' | 'global-triggers'; archive: boolean }>
}

function id(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown } catch { return null }
}

function iso(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback
}

function triggerEventType(name: string): string {
  const segment = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
  return `mortise.prompt-automation.trigger.${segment}`.slice(0, 255)
}

export function planLegacyPromptAutomationMigration(
  workspaceId: string,
  workspaceRootPath: string,
  now = new Date(),
  options: { globalConfigPath?: string | null } = {},
): LegacyPromptAutomationMigrationPlanV1 {
  const definitions: AutomationDefinitionV3[] = []
  const diagnostics: AutomationMigrationDiagnosticV1[] = []
  const sources: LegacyPromptAutomationMigrationPlanV1['sources'] = []
  const timestamp = now.toISOString()
  const scheduledPath = join(workspaceRootPath, '.pi', 'schedule-prompts.json')
  const projectTriggerPath = join(workspaceRootPath, '.pi', 'prompt-automation.json')
  const globalTriggerPath = options.globalConfigPath === undefined
    ? join(PI_AGENT_DIR, 'prompt-automation.json')
    : options.globalConfigPath

  if (existsSync(scheduledPath)) {
    sources.push({ path: scheduledPath, kind: 'scheduled-jobs', archive: true })
    const raw = readJson(scheduledPath) as { jobs?: unknown } | null
    const jobs = Array.isArray(raw) ? raw : Array.isArray(raw?.jobs) ? raw.jobs : []
    for (let index = 0; index < jobs.length; index++) {
      const job = jobs[index] as LegacyScheduleJob
      if (!job || typeof job.prompt !== 'string' || !job.prompt.trim() || !job.type) {
        diagnostics.push({ code: 'legacy_scheduled_job_invalid', message: `Skipped invalid scheduled prompt at index ${index}.` })
        continue
      }
      const automationId = id('aut', workspaceId, 'prompt-automation-job', job.id ?? index)
      const createdAt = iso(job.createdAt, timestamp)
      let schedule: TimeScheduleV3
      if (job.type === 'cron' && typeof job.schedule === 'string' && job.schedule.trim()) {
        schedule = { kind: 'cron', expression: job.schedule.trim() }
      } else if (job.type === 'once' && typeof job.schedule === 'string' && Number.isFinite(Date.parse(job.schedule))) {
        schedule = { kind: 'once', at: new Date(job.schedule).toISOString() }
      } else if (job.type === 'interval' && typeof job.intervalMs === 'number' && Number.isSafeInteger(job.intervalMs) && job.intervalMs >= 1_000) {
        schedule = { kind: 'interval', everyMs: job.intervalMs, anchorAt: createdAt }
      } else {
        diagnostics.push({ automationId, code: 'legacy_schedule_invalid', message: `Scheduled prompt "${job.name ?? job.id ?? index}" has an invalid ${job.type} schedule and was not imported.` })
        continue
      }

      const target = job.model
        ? {
            kind: 'isolated-agent' as const,
            model: job.model,
            ...(job.notify && job.session ? { notify: { session: { id: job.session }, delivery: 'followUp' as const } } : {}),
          }
        : job.session
          ? { kind: 'session' as const, session: { id: job.session }, delivery: 'followUp' as const }
          : { kind: 'new-session' as const }
      definitions.push({
        id: automationId,
        name: job.name?.trim() || `Scheduled prompt ${index + 1}`,
        enabled: job.enabled !== false,
        triggers: [{ id: id('trg', automationId, 'time'), type: 'time', schedule }],
        actions: [{ id: id('act', automationId, 'prompt'), type: 'prompt', prompt: job.prompt, target }],
        runPolicy: { overlap: 'skip', actionFailure: 'stop' },
        createdAt,
        updatedAt: timestamp,
      })
    }
  }

  const mergedTriggers = new Map<string, { trigger: LegacyTrigger; origin: 'global' | 'project' }>()
  for (const [path, origin, archive] of [
    ...(globalTriggerPath ? [[globalTriggerPath, 'global', false] as const] : []),
    [projectTriggerPath, 'project', true],
  ] as const) {
    if (!existsSync(path)) continue
    sources.push({ path, kind: origin === 'global' ? 'global-triggers' : 'project-triggers', archive })
    const raw = readJson(path) as { triggers?: Record<string, LegacyTrigger> } | null
    if (!raw?.triggers || typeof raw.triggers !== 'object') continue
    for (const [name, trigger] of Object.entries(raw.triggers)) mergedTriggers.set(name, { trigger, origin })
  }
  for (const [name, { trigger, origin }] of mergedTriggers) {
    if (typeof trigger.prompt !== 'string' || !trigger.prompt.trim()) {
      diagnostics.push({ code: 'legacy_trigger_invalid', message: `Skipped invalid ${origin} trigger "${name}".` })
      continue
    }
    const automationId = id('aut', workspaceId, 'prompt-automation-trigger', name, origin)
    definitions.push({
      id: automationId,
      name: trigger.description?.trim() || name,
      description: `Imported ${origin} prompt-automation trigger: ${name}`,
      enabled: true,
      triggers: [{
        id: id('trg', automationId, 'event'),
        type: 'event',
        source: 'external',
        eventType: triggerEventType(name),
      }],
      actions: [{
        id: id('act', automationId, 'prompt'),
        type: 'prompt',
        prompt: trigger.prompt,
        ...(trigger.includePayload ? { eventData: 'append-json' as const } : {}),
        target: { kind: 'session', session: 'event-session', delivery: trigger.delivery ?? 'followUp' },
      }],
      runPolicy: { overlap: 'queue-one', actionFailure: 'stop' },
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  }

  return { definitions, diagnostics, sources }
}

export function commitLegacyPromptAutomationMigration(
  workspaceRootPath: string,
  plan: LegacyPromptAutomationMigrationPlanV1,
): void {
  if (plan.sources.length === 0) return
  const reportPath = join(workspaceRootPath, '.mortise', 'automations-v3-migration.json')
  mkdirSync(dirname(reportPath), { recursive: true })
  atomicWriteFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    committedAt: new Date().toISOString(),
    importedAutomationIds: plan.definitions.map(item => item.id),
    diagnostics: plan.diagnostics,
    sources: plan.sources,
  }, null, 2)}\n`)

  for (const source of plan.sources) {
    if (!source.archive || !existsSync(source.path)) continue
    const archivePath = `${source.path}.migrated-v3`
    if (existsSync(archivePath)) continue
    try { renameSync(source.path, archivePath) } catch { /* The durable report records any source left for a later retry. */ }
  }
}
