import { Cron } from 'croner'
import { z } from 'zod'
import { AutomationConditionSchema } from './schemas.ts'

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{11,255}$/
const RISKY_REGEX = /(\([^)]*[+*][^)]*\)[+*{])|(\.\*){2,}|(\.\+){2,}|\([^)]*\|[^)]*\)[+*{]/
const OpaqueIdSchema = z.string().regex(OPAQUE_ID, 'Must be an opaque collision-safe ID with at least 12 characters')
const IsoDateSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Must be an ISO date-time')

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

function isCron(value: string): boolean {
  const fields = value.trim().split(/\s+/)
  if (fields.length !== 5 && fields.length !== 6) return false
  try {
    new Cron(value)
    return true
  } catch {
    return false
  }
}

const SecretReferenceSchema = z.object({
  provider: z.literal('mortise-secrets'),
  id: OpaqueIdSchema,
}).strict()

const SessionReferenceSchema = z.union([
  z.literal('event-session'),
  z.object({ id: OpaqueIdSchema }).strict(),
])

const EventTriggerSchema = z.object({
  id: OpaqueIdSchema,
  type: z.literal('event'),
  source: z.enum(['mortise', 'agent', 'extension', 'external']),
  eventType: z.string().min(1).max(255),
  matcher: z.string().min(1).max(500).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.matcher) return
  try { new RegExp(value.matcher) } catch { ctx.addIssue({ code: 'custom', path: ['matcher'], message: 'Invalid matcher regular expression' }) }
  if (RISKY_REGEX.test(value.matcher)) ctx.addIssue({ code: 'custom', path: ['matcher'], message: 'Matcher rejected: potential catastrophic backtracking' })
})

const CronScheduleSchema = z.object({
  kind: z.literal('cron'),
  expression: z.string().refine(isCron, 'Must be a valid five- or six-field cron expression'),
  timezone: z.string().refine(isIanaTimezone, 'Must be an IANA timezone').optional(),
  misfire: z.enum(['skip', 'run-once']).optional(),
}).strict()

const OnceScheduleSchema = z.object({
  kind: z.literal('once'),
  at: IsoDateSchema,
  expiresAt: IsoDateSchema.optional(),
  misfire: z.enum(['skip', 'run-once']).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.expiresAt && Date.parse(value.expiresAt) < Date.parse(value.at)) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must not precede at' })
  }
})

const IntervalScheduleSchema = z.object({
  kind: z.literal('interval'),
  everyMs: z.number().int().positive().max(365 * 24 * 60 * 60 * 1000),
  anchorAt: IsoDateSchema,
  misfire: z.enum(['skip', 'run-once']).optional(),
}).strict()

const TimeTriggerSchema = z.object({
  id: OpaqueIdSchema,
  type: z.literal('time'),
  schedule: z.discriminatedUnion('kind', [CronScheduleSchema, OnceScheduleSchema, IntervalScheduleSchema]),
}).strict()

export const AutomationTriggerV3Schema = z.discriminatedUnion('type', [EventTriggerSchema, TimeTriggerSchema])

const PromptTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new-session'),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    thinkingLevel: z.string().min(1).optional(),
    permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional(),
    telegramTopic: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({
    kind: z.literal('session'),
    session: SessionReferenceSchema,
    delivery: z.enum(['followUp', 'steer']),
  }).strict(),
  z.object({
    kind: z.literal('isolated-agent'),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    thinkingLevel: z.string().min(1).optional(),
    permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional(),
    notify: z.object({ session: SessionReferenceSchema, delivery: z.enum(['followUp', 'steer']) }).strict().optional(),
  }).strict(),
])

const PromptActionV3Schema = z.object({
  id: OpaqueIdSchema,
  type: z.literal('prompt'),
  prompt: z.string().min(1),
  eventData: z.literal('append-json').optional(),
  target: PromptTargetSchema,
}).strict()

const WebhookActionV3Schema = z.object({
  id: OpaqueIdSchema,
  type: z.literal('webhook'),
  url: z.string().refine(value => {
    try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
  }, 'Must be an HTTP or HTTPS URL'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  bodyFormat: z.enum(['json', 'form', 'raw']).optional(),
  body: z.unknown().optional(),
  captureResponse: z.boolean().optional(),
  auth: z.union([
    z.object({ type: z.literal('basic'), username: z.string().min(1), password: SecretReferenceSchema }).strict(),
    z.object({ type: z.literal('bearer'), token: SecretReferenceSchema }).strict(),
  ]).optional(),
}).strict()

export const AutomationActionV3Schema = z.discriminatedUnion('type', [PromptActionV3Schema, WebhookActionV3Schema])

function validateConditionTree(value: unknown, depth = 0): string | undefined {
  if (depth >= 8) return 'Condition nesting depth exceeds 8'
  if (!value || typeof value !== 'object') return undefined
  const condition = value as { condition?: string; after?: string; before?: string; timezone?: string; conditions?: unknown[] }
  if (condition.condition === 'time') {
    for (const time of [condition.after, condition.before]) {
      if (!time) continue
      const [hour, minute] = time.split(':').map(Number)
      if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour! < 0 || hour! > 23 || minute! < 0 || minute! > 59) return `Invalid time value: ${time}`
    }
    if (condition.timezone && !isIanaTimezone(condition.timezone)) return `Invalid IANA timezone: ${condition.timezone}`
  }
  for (const child of condition.conditions ?? []) {
    const error = validateConditionTree(child, depth + 1)
    if (error) return error
  }
  return undefined
}

export const AutomationDefinitionV3Schema = z.object({
  id: OpaqueIdSchema,
  name: z.string().min(1).max(255),
  description: z.string().max(4096).optional(),
  enabled: z.boolean(),
  triggers: z.array(AutomationTriggerV3Schema).min(1),
  conditions: z.array(AutomationConditionSchema).optional(),
  actions: z.array(AutomationActionV3Schema).min(1),
  runPolicy: z.object({
    overlap: z.enum(['skip', 'queue-one']).optional(),
    actionFailure: z.enum(['continue', 'stop']).optional(),
  }).strict().optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
}).strict().superRefine((value, ctx) => {
  const ids = [value.id, ...value.triggers.map(trigger => trigger.id), ...value.actions.map(action => action.id)]
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Definition, trigger, and action IDs must be unique' })
  for (const condition of value.conditions ?? []) {
    const error = validateConditionTree(condition)
    if (error) ctx.addIssue({ code: 'custom', path: ['conditions'], message: error })
  }
  const hasTime = value.triggers.some(trigger => trigger.type === 'time')
  const usesEventSession = value.actions.some(action => action.type === 'prompt' && (
    (action.target.kind === 'session' && action.target.session === 'event-session')
    || (action.target.kind === 'isolated-agent' && action.target.notify?.session === 'event-session')
  ))
  if (hasTime && usesEventSession) ctx.addIssue({ code: 'custom', path: ['actions'], message: 'event-session cannot be used when any trigger is a time trigger' })
})

export const AutomationsDocumentV3Schema = z.object({
  schemaVersion: z.literal(3),
  revision: z.number().int().positive(),
  definitions: z.array(AutomationDefinitionV3Schema),
}).strict().superRefine((value, ctx) => {
  const ids = value.definitions.map(definition => definition.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['definitions'], message: 'Automation IDs must be unique' })
})

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
]))

function validateJsonBounds(value: unknown, depth = 0): string | undefined {
  if (depth > 32) return 'Event data nesting exceeds 32 levels'
  if (typeof value === 'string' && value.length > 65_536) return 'Event data string exceeds 65536 characters'
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = validateJsonBounds(item, depth + 1)
      if (error) return error
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const error = validateJsonBounds(item, depth + 1)
      if (error) return error
    }
  }
  return undefined
}

export const CloudEventV1Schema = z.object({
  specversion: z.literal('1.0'),
  id: z.string().min(1).max(255),
  source: z.string().min(1).max(1024),
  type: z.string().min(1).max(255),
  subject: z.string().max(1024).optional(),
  time: IsoDateSchema,
  datacontenttype: z.literal('application/json').optional(),
  dataschema: z.string().max(1024).optional(),
  mortiseworkspaceid: z.string().max(255).optional(),
  mortisesessionid: z.string().max(255).optional(),
  data: JsonValueSchema,
}).strict().superRefine((value, ctx) => {
  const boundsError = validateJsonBounds(value.data)
  if (boundsError) ctx.addIssue({ code: 'custom', path: ['data'], message: boundsError })
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_048_576) {
    ctx.addIssue({ code: 'custom', message: 'CloudEvent exceeds the 1 MiB structured-content limit' })
  }
})

export function parseAutomationsDocumentV3(input: unknown) {
  return AutomationsDocumentV3Schema.parse(input)
}

export function parseCloudEventV1(input: unknown) {
  return CloudEventV1Schema.parse(input)
}
