import { CapabilityReadOnlyError } from '@mortise/shared/storage'
import {
  AutomationDefinitionV3Schema,
  CloudEventV1Schema,
  evaluateConditions,
  type AutomationCapabilityResultV1,
  type AutomationRunV1,
  type AutomationWorkspaceHostV3,
  type CloudEventV1,
} from '@mortise/shared/automations'
import {
  parseAutomationWorkspaceCommandV1,
  type AutomationWorkspaceCommandV1,
} from '@mortise/shared/protocol'

export interface AutomationWorkspaceCapabilityContextV1 {
  workspaceId: string
  /** Trusted source assigned from the authenticated capability caller. */
  eventSourceKind: 'mortise' | 'agent' | 'extension' | 'external'
  host: AutomationWorkspaceHostV3
}
/**
 * Host-owned implementation of automation.workspace/v1. Transport layers only
 * authenticate/authorize and forward typed requests to this dispatcher.
 */
export async function executeAutomationWorkspaceOperationV1(
  context: AutomationWorkspaceCapabilityContextV1,
  input: AutomationWorkspaceCommandV1 | unknown,
): Promise<AutomationCapabilityResultV1<unknown>> {
  let request: AutomationWorkspaceCommandV1
  try {
    request = parseAutomationWorkspaceCommandV1(input)
  } catch (error) {
    return {
      schemaVersion: 1,
      status: 'invalid',
      error: { code: 'invalid_automation_command', message: error instanceof Error ? error.message : String(error), retryable: false },
    }
  }
  const store = context.host.store
  const finalizeMutation = <T>(result: AutomationCapabilityResultV1<T>): AutomationCapabilityResultV1<T> => {
    if (result.status === 'ok' || result.status === 'duplicate') context.host.refresh()
    return result
  }
  try {
    const document = store.initialize()
    switch (request.operation) {
      case 'describe':
        return {
          schemaVersion: 1,
          status: 'ok',
          revision: document.revision,
          data: {
            capability: 'automation.workspace',
            schemaVersion: 1,
            capabilities: {
              'automations.definitions': { minRead: 4, maxRead: 4, minWrite: 4, maxWrite: 4 },
              'automations.ingress': { minRead: 2, maxRead: 2, minWrite: 2, maxWrite: 2 },
              'automations.runs': { minRead: 2, maxRead: 2, minWrite: 2, maxWrite: 2 },
              'automations.history': { minRead: 2, maxRead: 2, minWrite: 2, maxWrite: 2 },
            },
            triggerKinds: ['event', 'cron', 'once', 'interval'],
            actionKinds: ['prompt', 'webhook'],
            targetKinds: ['new-session', 'session', 'isolated-agent'],
            limits: { maxEventBytes: 1_048_576, maxConditionDepth: 8, maxMatcherLength: 500, maxEventTypeLength: 255, maxRunListLimit: 500 },
            permissionScopes: ['automations.read', 'automations.history.read', 'automations.write', 'automations.run', 'automations.events.emit'],
          },
        }
      case 'list': {
        const page = store.listDefinitionsPage({
          ...(request.limit ? { limit: request.limit } : {}),
          ...(request.cursor ? { cursor: request.cursor } : {}),
        })
        return {
          schemaVersion: 1,
          status: 'ok',
          revision: page.revision,
          data: { schemaVersion: 1, ...page },
        }
      }
      case 'get': {
        const definition = document.definitions.find(item => item.id === request.automationId)
        return definition
          ? { schemaVersion: 1, status: 'ok', revision: document.revision, data: definition }
          : { schemaVersion: 1, status: 'invalid', revision: document.revision, error: { code: 'automation_not_found', message: 'Automation not found', retryable: false } }
      }
      case 'validate': {
        const parsed = AutomationDefinitionV3Schema.safeParse(request.definition)
        return parsed.success
          ? { schemaVersion: 1, status: 'ok', data: parsed.data }
          : { schemaVersion: 1, status: 'invalid', error: { code: 'invalid_definition', message: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), retryable: false } }
      }
      case 'simulate': {
        const parsed = CloudEventV1Schema.safeParse(request.event)
        if (!parsed.success) return { schemaVersion: 1, status: 'invalid', error: { code: 'invalid_cloudevent', message: parsed.error.message, retryable: false } }
        const payload = parsed.data.data && typeof parsed.data.data === 'object' && !Array.isArray(parsed.data.data)
          ? { ...parsed.data, ...(parsed.data.data as Record<string, unknown>), data: parsed.data.data }
          : { ...parsed.data, data: parsed.data.data }
        const plans = document.definitions.flatMap(definition => {
          if (!definition.enabled || (definition.conditions && !evaluateConditions(definition.conditions, { payload }))) return []
          const triggerIds = definition.triggers.filter(trigger => trigger.type === 'event'
            && trigger.source === request.sourceKind
            && trigger.eventType === parsed.data.type
            && (!trigger.matcher || new RegExp(trigger.matcher).test(request.matchValue ?? ''))).map(trigger => trigger.id)
          return triggerIds.length ? [{
            automationId: definition.id,
            triggerIds,
            conditionsMatched: true,
            actions: definition.actions.map((action, ordinal) => ({ id: action.id, type: action.type, ordinal })),
          }] : []
        })
        return { schemaVersion: 1, status: 'ok', revision: document.revision, data: plans }
      }
      case 'create': {
        const existing = document.definitions.find(item => item.id === request.definition.id)
        if (existing) {
          if (request.expectedRevision !== null && document.revision === request.expectedRevision + 1 && JSON.stringify(existing) === JSON.stringify(request.definition)) {
            return store.mutateDocument({ operationId: request.operationId, expectedRevision: request.expectedRevision, document })
          }
          return { schemaVersion: 1, operationId: request.operationId, status: 'conflict', revision: document.revision, error: { code: 'automation_exists', message: 'Automation ID already exists', retryable: false } }
        }
        return finalizeMutation(store.mutateDocument({ operationId: request.operationId, expectedRevision: request.expectedRevision, document: { ...document, definitions: [...document.definitions, request.definition] } }))
      }
      case 'update': {
        const index = document.definitions.findIndex(item => item.id === request.definition.id)
        if (index < 0) return { schemaVersion: 1, operationId: request.operationId, status: 'invalid', revision: document.revision, error: { code: 'automation_not_found', message: 'Automation not found', retryable: false } }
        if (request.expectedRevision !== null && document.revision === request.expectedRevision + 1 && JSON.stringify(document.definitions[index]) === JSON.stringify(request.definition)) {
          return store.mutateDocument({ operationId: request.operationId, expectedRevision: request.expectedRevision, document })
        }
        const definitions = document.definitions.map((item, position) => position === index ? request.definition : item)
        return finalizeMutation(store.mutateDocument({ operationId: request.operationId, expectedRevision: request.expectedRevision, document: { ...document, definitions } }))
      }
      case 'delete': {
        if (!document.definitions.some(item => item.id === request.automationId)) {
          if (request.expectedRevision !== null && document.revision === request.expectedRevision + 1) return store.mutateDocument({ operationId: request.operationId, expectedRevision: request.expectedRevision, document })
          return { schemaVersion: 1, operationId: request.operationId, status: 'invalid', revision: document.revision, error: { code: 'automation_not_found', message: 'Automation not found', retryable: false } }
        }
        return finalizeMutation(store.mutateDocument({ operationId: request.operationId, expectedRevision: request.expectedRevision, document: { ...document, definitions: document.definitions.filter(item => item.id !== request.automationId) } }))
      }
      case 'set-enabled': {
        if (!document.definitions.some(item => item.id === request.automationId)) return { schemaVersion: 1, operationId: request.operationId, status: 'invalid', revision: document.revision, error: { code: 'automation_not_found', message: 'Automation not found', retryable: false } }
        if (request.expectedRevision !== null && document.revision === request.expectedRevision + 1 && document.definitions.find(item => item.id === request.automationId)?.enabled === request.enabled) {
          return store.mutateDocument({ operationId: request.operationId, expectedRevision: request.expectedRevision, document })
        }
        const updatedAt = new Date().toISOString()
        return finalizeMutation(store.mutateDocument({ operationId: request.operationId, expectedRevision: request.expectedRevision, document: { ...document, definitions: document.definitions.map(item => item.id === request.automationId ? { ...item, enabled: request.enabled, updatedAt } : item) } }))
      }
      case 'get-run': {
        const run = store.getRun(request.runId)
        return run ? { schemaVersion: 1, status: 'ok', data: run } : { schemaVersion: 1, status: 'invalid', error: { code: 'run_not_found', message: 'Automation run not found', retryable: false } }
      }
      case 'list-runs': {
        const page = store.listRunsPage({
          ...(request.automationId ? { automationId: request.automationId } : {}),
          ...(request.states ? { states: request.states } : {}),
          ...(request.eventId ? { eventId: request.eventId } : {}),
          ...(request.createdAfter !== undefined ? { createdAfter: request.createdAfter } : {}),
          ...(request.createdBefore !== undefined ? { createdBefore: request.createdBefore } : {}),
          ...(request.limit ? { limit: request.limit } : {}),
          ...(request.cursor ? { cursor: request.cursor } : {}),
        })
        return { schemaVersion: 1, status: 'ok', data: { schemaVersion: 1, ...page } }
      }
      case 'list-changes': {
        const page = store.readHistoryChanges({
          ...(request.automationId ? { automationId: request.automationId } : {}),
          ...(request.runId ? { runId: request.runId } : {}),
          ...(request.limit ? { limit: request.limit } : {}),
          ...(request.cursor ? { cursor: request.cursor } : {}),
        })
        return { schemaVersion: 1, status: 'ok', data: { schemaVersion: 1, ...page } }
      }
      case 'run': {
        const result = context.host.acceptManual(request.automationId, request.operationId, request.triggerId)
        return { schemaVersion: 1, operationId: request.operationId, status: result.duplicate ? 'duplicate' : 'accepted', data: { runId: result.run.runId } }
      }
      case 'emit-event': {
        const parsed = CloudEventV1Schema.safeParse(request.event)
        if (!parsed.success) return { schemaVersion: 1, operationId: request.operationId, status: 'invalid', error: { code: 'invalid_cloudevent', message: parsed.error.message, retryable: false } }
        const result = await context.host.acceptEvent(parsed.data as CloudEventV1, {
          sourceKind: context.eventSourceKind,
          ...(request.matchValue ? { matchValue: request.matchValue } : {}),
        })
        if (result.status !== 'accepted' && result.status !== 'duplicate') {
          return { schemaVersion: 1, operationId: request.operationId, status: result.status, error: result.error }
        }
        return { schemaVersion: 1, operationId: request.operationId, status: result.duplicate ? 'duplicate' : 'accepted', data: { eventId: result.event!.eventId, runIds: result.runs.map((run: AutomationRunV1) => run.runId), persisted: true } }
      }
    }
  } catch (error) {
    if (error instanceof CapabilityReadOnlyError) {
      return {
        schemaVersion: 1,
        ...('operationId' in request ? { operationId: request.operationId } : {}),
        status: 'unsupported',
        error: { code: 'automation_storage_read_only', message: error.message, retryable: false },
      }
    }
    throw error
  }
  return {
    schemaVersion: 1,
    status: 'invalid',
    error: { code: 'unsupported_automation_operation', message: 'Unsupported automation operation', retryable: false },
  }
}
