import { z } from 'zod'
import {
  AutomationDefinitionV3Schema,
  CloudEventV1Schema,
} from '../automations/v3-schemas.ts'
import type {
  AutomationCapabilityResultV1,
  AutomationDefinitionV3,
  AutomationEventSourceV3,
  AutomationRunV1,
  AutomationsDocumentV3,
  CloudEventV1,
} from '../automations/v3-types.ts'
import type { CapabilityRequestV1, CapabilityResultV1 } from './capabilities.ts'

export const AUTOMATION_WORKSPACE_CAPABILITY_V1 = 'automation.workspace' as const

export const AUTOMATION_WORKSPACE_OPERATIONS_V1 = [
  'describe',
  'list',
  'get',
  'validate',
  'simulate',
  'create',
  'update',
  'delete',
  'set-enabled',
  'run',
  'get-run',
  'list-runs',
  'emit-event',
] as const

export type AutomationWorkspaceOperationV1 = typeof AUTOMATION_WORKSPACE_OPERATIONS_V1[number]

export type AutomationPermissionScopeV1 =
  | 'automations.read'
  | 'automations.history.read'
  | 'automations.write'
  | 'automations.run'
  | 'automations.events.emit'

export interface AutomationCapabilityVersionRangeV1 {
  minRead: number
  maxRead: number
  minWrite: number
  maxWrite: number
}

export interface AutomationWorkspaceDescriptionV1 {
  capability: typeof AUTOMATION_WORKSPACE_CAPABILITY_V1
  schemaVersion: 1
  capabilities: {
    'automations.definitions': AutomationCapabilityVersionRangeV1
    'automations.ingress': AutomationCapabilityVersionRangeV1
    'automations.runs': AutomationCapabilityVersionRangeV1
    'automations.history': AutomationCapabilityVersionRangeV1
  }
  triggerKinds: Array<'event' | 'cron' | 'once' | 'interval'>
  actionKinds: Array<'prompt' | 'webhook'>
  targetKinds: Array<'new-session' | 'session' | 'isolated-agent'>
  limits: {
    maxEventBytes: number
    maxConditionDepth: number
    maxMatcherLength: number
    maxEventTypeLength: number
    maxRunListLimit: number
  }
  permissionScopes: AutomationPermissionScopeV1[]
}

export interface AutomationSimulationPlanV1 {
  automationId: string
  triggerIds: string[]
  conditionsMatched: boolean
  actions: Array<{ id: string; type: 'prompt' | 'webhook'; ordinal: number }>
}

export interface AutomationRunAcceptedV1 {
  runId: string
}

export interface AutomationEventAcceptedV1 {
  eventId: string
  runIds: string[]
  persisted: true
}

interface AutomationWorkspaceInputBaseV1 {
  schemaVersion: 1
}

export interface AutomationWorkspaceInputMapV1 {
  describe: AutomationWorkspaceInputBaseV1
  list: AutomationWorkspaceInputBaseV1
  get: AutomationWorkspaceInputBaseV1 & { automationId: string }
  validate: AutomationWorkspaceInputBaseV1 & { definition: AutomationDefinitionV3 }
  simulate: AutomationWorkspaceInputBaseV1 & {
    event: CloudEventV1
    sourceKind: AutomationEventSourceV3
    matchValue?: string
  }
  create: AutomationWorkspaceInputBaseV1 & {
    operationId: string
    expectedRevision: number | null
    definition: AutomationDefinitionV3
  }
  update: AutomationWorkspaceInputBaseV1 & {
    operationId: string
    expectedRevision: number | null
    definition: AutomationDefinitionV3
  }
  delete: AutomationWorkspaceInputBaseV1 & {
    operationId: string
    expectedRevision: number | null
    automationId: string
  }
  'set-enabled': AutomationWorkspaceInputBaseV1 & {
    operationId: string
    expectedRevision: number | null
    automationId: string
    enabled: boolean
  }
  run: AutomationWorkspaceInputBaseV1 & {
    operationId: string
    automationId: string
    triggerId?: string
  }
  'get-run': AutomationWorkspaceInputBaseV1 & { runId: string }
  'list-runs': AutomationWorkspaceInputBaseV1 & { automationId?: string; limit?: number }
  'emit-event': AutomationWorkspaceInputBaseV1 & {
    operationId: string
    event: CloudEventV1
    matchValue?: string
  }
}

export interface AutomationWorkspaceDataMapV1 {
  describe: AutomationWorkspaceDescriptionV1
  list: AutomationDefinitionV3[]
  get: AutomationDefinitionV3
  validate: AutomationDefinitionV3
  simulate: AutomationSimulationPlanV1[]
  create: AutomationsDocumentV3
  update: AutomationsDocumentV3
  delete: AutomationsDocumentV3
  'set-enabled': AutomationsDocumentV3
  run: AutomationRunAcceptedV1
  'get-run': AutomationRunV1
  'list-runs': AutomationRunV1[]
  'emit-event': AutomationEventAcceptedV1
}

export type AutomationWorkspaceCommandV1 = {
  [Operation in AutomationWorkspaceOperationV1]: AutomationWorkspaceInputMapV1[Operation] & { operation: Operation }
}[AutomationWorkspaceOperationV1]

export type AutomationWorkspaceCapabilityRequestV1<Operation extends AutomationWorkspaceOperationV1 = AutomationWorkspaceOperationV1> =
  { [CurrentOperation in Operation]:
    Omit<CapabilityRequestV1, 'capability' | 'operation' | 'input'> & {
      capability: typeof AUTOMATION_WORKSPACE_CAPABILITY_V1
      operation: CurrentOperation
      input: AutomationWorkspaceInputMapV1[CurrentOperation]
    }
  }[Operation]

export type AutomationWorkspaceOperationResultV1<Operation extends AutomationWorkspaceOperationV1> =
  AutomationCapabilityResultV1<AutomationWorkspaceDataMapV1[Operation]>

export type AutomationWorkspaceCapabilityResultV1<Operation extends AutomationWorkspaceOperationV1 = AutomationWorkspaceOperationV1> =
  | { requestId: string; status: 'success'; output: AutomationWorkspaceOperationResultV1<Operation> }
  | Exclude<CapabilityResultV1, { status: 'success' }>

const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{11,255}$/
const BoundedIdSchema = z.string().regex(BOUNDED_ID, 'Must be a bounded identifier')
const OpaqueIdSchema = z.string().regex(OPAQUE_ID, 'Must be an opaque collision-safe ID with at least 12 characters')
const OperationIdSchema = z.string().min(1).max(256).refine(value => value.trim().length > 0, 'operationId must not be blank')
const ExpectedRevisionSchema = z.union([z.number().int().positive(), z.null()])
const BaseInputSchema = z.object({ schemaVersion: z.literal(1) }).strict()

const AutomationWorkspaceCommandV1Schema = z.discriminatedUnion('operation', [
  BaseInputSchema.extend({ operation: z.literal('describe') }),
  BaseInputSchema.extend({ operation: z.literal('list') }),
  BaseInputSchema.extend({ operation: z.literal('get'), automationId: OpaqueIdSchema }),
  BaseInputSchema.extend({ operation: z.literal('validate'), definition: AutomationDefinitionV3Schema }),
  BaseInputSchema.extend({
    operation: z.literal('simulate'),
    event: CloudEventV1Schema,
    sourceKind: z.enum(['mortise', 'agent', 'extension', 'external']),
    matchValue: z.string().max(4096).optional(),
  }),
  BaseInputSchema.extend({
    operation: z.literal('create'),
    operationId: OperationIdSchema,
    expectedRevision: ExpectedRevisionSchema,
    definition: AutomationDefinitionV3Schema,
  }),
  BaseInputSchema.extend({
    operation: z.literal('update'),
    operationId: OperationIdSchema,
    expectedRevision: ExpectedRevisionSchema,
    definition: AutomationDefinitionV3Schema,
  }),
  BaseInputSchema.extend({
    operation: z.literal('delete'),
    operationId: OperationIdSchema,
    expectedRevision: ExpectedRevisionSchema,
    automationId: OpaqueIdSchema,
  }),
  BaseInputSchema.extend({
    operation: z.literal('set-enabled'),
    operationId: OperationIdSchema,
    expectedRevision: ExpectedRevisionSchema,
    automationId: OpaqueIdSchema,
    enabled: z.boolean(),
  }),
  BaseInputSchema.extend({
    operation: z.literal('run'),
    operationId: OperationIdSchema,
    automationId: OpaqueIdSchema,
    triggerId: OpaqueIdSchema.optional(),
  }),
  BaseInputSchema.extend({ operation: z.literal('get-run'), runId: OpaqueIdSchema }),
  BaseInputSchema.extend({
    operation: z.literal('list-runs'),
    automationId: OpaqueIdSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  BaseInputSchema.extend({
    operation: z.literal('emit-event'),
    operationId: OperationIdSchema,
    event: CloudEventV1Schema,
    matchValue: z.string().max(4096).optional(),
  }),
])

const CapabilityRequestV1Schema = z.object({
  version: z.literal(1),
  requestId: BoundedIdSchema,
  capability: z.literal(AUTOMATION_WORKSPACE_CAPABILITY_V1),
  sessionId: BoundedIdSchema,
  runtimeId: BoundedIdSchema,
  extensionId: BoundedIdSchema,
  operation: z.enum(AUTOMATION_WORKSPACE_OPERATIONS_V1),
  input: z.unknown(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
}).strict()

const CapabilityVersionRangeV1Schema = z.object({
  minRead: z.number().int().positive(),
  maxRead: z.number().int().positive(),
  minWrite: z.number().int().positive(),
  maxWrite: z.number().int().positive(),
}).strict().refine(value => value.minRead <= value.maxRead && value.minWrite <= value.maxWrite, 'Invalid capability version range')

const AutomationWorkspaceDescriptionV1Schema = z.object({
  capability: z.literal(AUTOMATION_WORKSPACE_CAPABILITY_V1),
  schemaVersion: z.literal(1),
  capabilities: z.object({
    'automations.definitions': CapabilityVersionRangeV1Schema,
    'automations.ingress': CapabilityVersionRangeV1Schema,
    'automations.runs': CapabilityVersionRangeV1Schema,
    'automations.history': CapabilityVersionRangeV1Schema,
  }).strict(),
  triggerKinds: z.array(z.enum(['event', 'cron', 'once', 'interval'])),
  actionKinds: z.array(z.enum(['prompt', 'webhook'])),
  targetKinds: z.array(z.enum(['new-session', 'session', 'isolated-agent'])),
  limits: z.object({
    maxEventBytes: z.number().int().positive(),
    maxConditionDepth: z.number().int().positive(),
    maxMatcherLength: z.number().int().positive(),
    maxEventTypeLength: z.number().int().positive(),
    maxRunListLimit: z.number().int().positive(),
  }).strict(),
  permissionScopes: z.array(z.enum([
    'automations.read',
    'automations.history.read',
    'automations.write',
    'automations.run',
    'automations.events.emit',
  ])),
}).strict()

const AutomationRunV1Schema = z.object({
  schemaVersion: z.literal(1),
  runId: OpaqueIdSchema,
  occurrenceId: OpaqueIdSchema,
  occurrenceKey: z.string().min(1).max(4096),
  automationId: OpaqueIdSchema,
  definitionRevision: z.number().int().positive(),
  definitionSnapshot: AutomationDefinitionV3Schema,
  triggerId: OpaqueIdSchema,
  state: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'skipped']),
  reason: z.string().min(1).max(512).optional(),
  eventId: OpaqueIdSchema.optional(),
  scheduledAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  executor: z.object({
    ownerId: z.string().min(1).max(512),
    claimedAt: z.string().datetime(),
    leaseExpiresAt: z.string().datetime(),
  }).strict().optional(),
  actions: z.array(z.object({
    actionRunId: OpaqueIdSchema,
    actionId: OpaqueIdSchema,
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'skipped']),
    attempts: z.number().int().nonnegative(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    sessionId: z.string().min(1).max(256).optional(),
    details: z.union([
      z.object({
        kind: z.literal('webhook'),
        statusCode: z.number().int().min(100).max(599).optional(),
        attempts: z.number().int().positive(),
        durationMs: z.number().nonnegative(),
        responseBody: z.string().max(16_384).optional(),
      }).strict(),
      z.object({
        kind: z.literal('isolated-agent'),
        output: z.string().max(65_536),
        notification: z.enum(['none', 'delivered']),
      }).strict(),
    ]).optional(),
    error: z.object({ code: z.string().min(1).max(256), message: z.string().max(4096), retryable: z.boolean() }).strict().optional(),
  }).strict()),
}).strict()

const AutomationSimulationPlanV1Schema = z.object({
  automationId: OpaqueIdSchema,
  triggerIds: z.array(OpaqueIdSchema).min(1),
  conditionsMatched: z.boolean(),
  actions: z.array(z.object({
    id: OpaqueIdSchema,
    type: z.enum(['prompt', 'webhook']),
    ordinal: z.number().int().nonnegative(),
  }).strict()),
}).strict()

const AutomationWorkspaceDataSchemasV1: Record<AutomationWorkspaceOperationV1, z.ZodType> = {
  describe: AutomationWorkspaceDescriptionV1Schema,
  list: z.array(AutomationDefinitionV3Schema),
  get: AutomationDefinitionV3Schema,
  validate: AutomationDefinitionV3Schema,
  simulate: z.array(AutomationSimulationPlanV1Schema),
  create: z.object({ schemaVersion: z.literal(3), revision: z.number().int().positive(), definitions: z.array(AutomationDefinitionV3Schema) }).strict(),
  update: z.object({ schemaVersion: z.literal(3), revision: z.number().int().positive(), definitions: z.array(AutomationDefinitionV3Schema) }).strict(),
  delete: z.object({ schemaVersion: z.literal(3), revision: z.number().int().positive(), definitions: z.array(AutomationDefinitionV3Schema) }).strict(),
  'set-enabled': z.object({ schemaVersion: z.literal(3), revision: z.number().int().positive(), definitions: z.array(AutomationDefinitionV3Schema) }).strict(),
  run: z.object({ runId: OpaqueIdSchema }).strict(),
  'get-run': AutomationRunV1Schema,
  'list-runs': z.array(AutomationRunV1Schema),
  'emit-event': z.object({ eventId: OpaqueIdSchema, runIds: z.array(OpaqueIdSchema), persisted: z.literal(true) }).strict(),
}

const AutomationCapabilityResultBaseV1Schema = z.object({
  schemaVersion: z.literal(1),
  operationId: OperationIdSchema.optional(),
  status: z.enum(['ok', 'accepted', 'duplicate', 'conflict', 'invalid', 'denied', 'unsupported']),
  revision: z.number().int().positive().optional(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1).max(256),
    message: z.string().max(4096),
    retryable: z.boolean(),
  }).strict().optional(),
}).strict()

const CapabilityResultV1Schema = z.discriminatedUnion('status', [
  z.object({ requestId: BoundedIdSchema, status: z.literal('success'), output: z.unknown() }).strict(),
  z.object({
    requestId: BoundedIdSchema,
    status: z.enum(['denied', 'cancelled', 'unsupported', 'failed']),
    error: z.object({
      code: z.string().min(1).max(256),
      message: z.string().max(4096),
      retryable: z.boolean().optional(),
    }).strict().optional(),
  }).strict(),
])

export function parseAutomationWorkspaceCommandV1(value: unknown): AutomationWorkspaceCommandV1 {
  return AutomationWorkspaceCommandV1Schema.parse(value) as AutomationWorkspaceCommandV1
}

export function validateAutomationWorkspaceCommandV1(value: unknown): string | null {
  const result = AutomationWorkspaceCommandV1Schema.safeParse(value)
  return result.success ? null : result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}

export function parseAutomationWorkspaceCapabilityRequestV1(value: unknown): AutomationWorkspaceCapabilityRequestV1 {
  const request = CapabilityRequestV1Schema.parse(value)
  if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw new z.ZodError([{ code: 'custom', path: ['input'], message: 'input must be an object', input: request.input }])
  }
  if ('operation' in request.input) {
    throw new z.ZodError([{ code: 'custom', path: ['input', 'operation'], message: 'operation belongs to the capability envelope', input: request.input }])
  }
  const command = parseAutomationWorkspaceCommandV1({ ...request.input, operation: request.operation })
  const { operation: _operation, ...input } = command
  return { ...request, input } as AutomationWorkspaceCapabilityRequestV1
}

export function validateAutomationWorkspaceCapabilityRequestV1(value: unknown): string | null {
  try {
    parseAutomationWorkspaceCapabilityRequestV1(value)
    return null
  } catch (error) {
    return error instanceof z.ZodError
      ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : error instanceof Error ? error.message : String(error)
  }
}

export function parseAutomationWorkspaceOperationResultV1<Operation extends AutomationWorkspaceOperationV1>(
  operation: Operation,
  value: unknown,
): AutomationWorkspaceOperationResultV1<Operation> {
  const result = AutomationCapabilityResultBaseV1Schema.parse(value)
  if (result.data !== undefined) AutomationWorkspaceDataSchemasV1[operation].parse(result.data)
  const sideEffecting = ['create', 'update', 'delete', 'set-enabled', 'run', 'emit-event'].includes(operation)
  if (sideEffecting && result.operationId === undefined) {
    throw new z.ZodError([{ code: 'custom', path: ['operationId'], message: `${operation} results must echo operationId`, input: value }])
  }
  const dataRequiredStatuses: Partial<Record<AutomationWorkspaceOperationV1, string[]>> = {
    describe: ['ok'],
    list: ['ok'],
    get: ['ok'],
    validate: ['ok'],
    simulate: ['ok'],
    create: ['ok', 'duplicate'],
    update: ['ok', 'duplicate'],
    delete: ['ok', 'duplicate'],
    'set-enabled': ['ok', 'duplicate'],
    run: ['accepted', 'duplicate'],
    'get-run': ['ok'],
    'list-runs': ['ok'],
    'emit-event': ['accepted', 'duplicate'],
  }
  if (dataRequiredStatuses[operation]?.includes(result.status) && result.data === undefined) {
    throw new z.ZodError([{ code: 'custom', path: ['data'], message: `${operation} ${result.status} results require data`, input: value }])
  }
  return result as AutomationWorkspaceOperationResultV1<Operation>
}

export function validateAutomationWorkspaceOperationResultV1(
  operation: AutomationWorkspaceOperationV1,
  value: unknown,
): string | null {
  try {
    parseAutomationWorkspaceOperationResultV1(operation, value)
    return null
  } catch (error) {
    return error instanceof z.ZodError
      ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : error instanceof Error ? error.message : String(error)
  }
}

export function parseAutomationWorkspaceCapabilityResultV1<Operation extends AutomationWorkspaceOperationV1>(
  operation: Operation,
  value: unknown,
): AutomationWorkspaceCapabilityResultV1<Operation> {
  const result = CapabilityResultV1Schema.parse(value)
  if (result.status === 'success') parseAutomationWorkspaceOperationResultV1(operation, result.output)
  return result as AutomationWorkspaceCapabilityResultV1<Operation>
}

export function validateAutomationWorkspaceCapabilityResultV1(
  operation: AutomationWorkspaceOperationV1,
  value: unknown,
): string | null {
  try {
    parseAutomationWorkspaceCapabilityResultV1(operation, value)
    return null
  } catch (error) {
    return error instanceof z.ZodError
      ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : error instanceof Error ? error.message : String(error)
  }
}
