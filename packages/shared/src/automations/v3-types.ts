import type { AutomationCondition } from './types.ts'

export type AutomationEventSourceV3 = 'mortise' | 'agent' | 'extension' | 'external'
export type AutomationRunStateV1 = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'skipped'
export type AutomationActionStateV1 = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'skipped'

export interface EventTriggerV3 {
  id: string
  type: 'event'
  source: AutomationEventSourceV3
  eventType: string
  matcher?: string
}

export type TimeScheduleV3 =
  | { kind: 'cron'; expression: string; timezone?: string; misfire?: 'skip' | 'run-once' }
  | { kind: 'once'; at: string; expiresAt?: string; misfire?: 'skip' | 'run-once' }
  | { kind: 'interval'; everyMs: number; anchorAt: string; misfire?: 'skip' | 'run-once' }

export interface TimeTriggerV3 {
  id: string
  type: 'time'
  schedule: TimeScheduleV3
}

export type AutomationTriggerV3 = EventTriggerV3 | TimeTriggerV3

export interface SecretReferenceV1 {
  provider: 'mortise-secrets'
  id: string
}

export type SessionReferenceV1 = 'event-session' | { id: string }

export type PromptTargetV3 =
  | {
      kind: 'new-session'
      provider?: string
      model?: string
      thinkingLevel?: string
      permissionMode?: 'safe' | 'ask' | 'allow-all'
      telegramTopic?: string
    }
  | {
      kind: 'session'
      session: SessionReferenceV1
      delivery: 'followUp' | 'steer'
    }
  | {
      kind: 'isolated-agent'
      provider?: string
      model?: string
      thinkingLevel?: string
      permissionMode?: 'safe' | 'ask' | 'allow-all'
      notify?: { session: SessionReferenceV1; delivery: 'followUp' | 'steer' }
    }

export interface PromptActionV3 {
  id: string
  type: 'prompt'
  prompt: string
  eventData?: 'append-json'
  target: PromptTargetV3
}

export interface WebhookActionV3 {
  id: string
  type: 'webhook'
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Record<string, string>
  bodyFormat?: 'json' | 'form' | 'raw'
  body?: unknown
  captureResponse?: boolean
  auth?:
    | { type: 'basic'; username: string; password: SecretReferenceV1 }
    | { type: 'bearer'; token: SecretReferenceV1 }
}

export type AutomationActionV3 = PromptActionV3 | WebhookActionV3

export interface AutomationDefinitionV3 {
  id: string
  name: string
  description?: string
  enabled: boolean
  triggers: AutomationTriggerV3[]
  conditions?: AutomationCondition[]
  actions: AutomationActionV3[]
  runPolicy?: {
    overlap?: 'skip' | 'queue-one'
    actionFailure?: 'continue' | 'stop'
  }
  createdAt: string
  updatedAt: string
}

export interface AutomationsDocumentV3 {
  schemaVersion: 3
  revision: number
  definitions: AutomationDefinitionV3[]
}

export interface CloudEventV1 {
  specversion: '1.0'
  id: string
  source: string
  type: string
  subject?: string
  time: string
  datacontenttype?: 'application/json'
  dataschema?: string
  mortiseworkspaceid?: string
  mortisesessionid?: string
  data: unknown
}

export interface TrustedAutomationEventV1 {
  eventId: string
  sourceKind: AutomationEventSourceV3
  workspaceId: string
  sessionId?: string
  matchValue?: string
  cloudEvent: CloudEventV1
  acceptedAt: string
}

export interface AutomationActionRunV1 {
  actionRunId: string
  actionId: string
  state: AutomationActionStateV1
  attempts: number
  startedAt?: string
  completedAt?: string
  sessionId?: string
  details?: AutomationActionExecutionDetailsV1
  error?: { code: string; message: string; retryable: boolean }
}

export type AutomationActionExecutionDetailsV1 =
  | { kind: 'webhook'; statusCode?: number; attempts: number; durationMs: number; responseBody?: string }
  | { kind: 'isolated-agent'; output: string; notification: 'none' | 'delivered' }

export interface AutomationRunV1 {
  schemaVersion: 1
  runId: string
  occurrenceId: string
  occurrenceKey: string
  automationId: string
  definitionRevision: number
  definitionSnapshot: AutomationDefinitionV3
  triggerId: string
  state: AutomationRunStateV1
  reason?: string
  eventId?: string
  scheduledAt?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  executor?: {
    ownerId: string
    claimedAt: string
    leaseExpiresAt: string
  }
  actions: AutomationActionRunV1[]
}

export interface AutomationActionExecutionResultV1 {
  status: 'succeeded' | 'failed' | 'blocked' | 'cancelled'
  sessionId?: string
  details?: AutomationActionExecutionDetailsV1
  error?: { code: string; message: string; retryable?: boolean }
}

export interface AutomationExecutionCallbacksV1 {
  prompt(action: PromptActionV3, context: AutomationExecutionContextV1): Promise<AutomationActionExecutionResultV1>
  webhook(action: WebhookActionV3, context: AutomationExecutionContextV1 & { attemptId: string }): Promise<AutomationActionExecutionResultV1>
}

export interface AutomationExecutionContextV1 {
  workspaceId: string
  definition: AutomationDefinitionV3
  run: AutomationRunV1
  event?: TrustedAutomationEventV1
  signal?: AbortSignal
}

export interface AutomationMigrationDiagnosticV1 {
  automationId?: string
  code: string
  message: string
}

export interface AutomationMigrationResultV1 {
  document: AutomationsDocumentV3
  aliases: Record<string, string>
  diagnostics: AutomationMigrationDiagnosticV1[]
}

export type AutomationCapabilityStatusV1 =
  | 'ok'
  | 'accepted'
  | 'duplicate'
  | 'conflict'
  | 'invalid'
  | 'denied'
  | 'unsupported'

export interface AutomationCapabilityResultV1<T> {
  schemaVersion: 1
  operationId?: string
  status: AutomationCapabilityStatusV1
  revision?: number
  data?: T
  error?: { code: string; message: string; retryable: boolean }
}
