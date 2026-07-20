import { randomUUID } from 'node:crypto'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import type { RpcServer } from '@mortise/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { resolveWorkspaceId } from '../utils'
import { CapabilityReadOnlyError } from '@mortise/shared/storage'
import {
  AutomationDefinitionV3Schema,
  AutomationV3Runtime,
  AutomationV3Store,
  automationIdentity,
  CloudEventV1Schema,
  evaluateConditions,
  type AutomationCapabilityResultV1,
  type AutomationExecutionCallbacksV1,
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
  workspaceRootPath: string
  writerId?: string
  /** Trusted source assigned from the authenticated capability caller. */
  eventSourceKind: 'mortise' | 'agent' | 'extension' | 'external'
  callbacks?: AutomationExecutionCallbacksV1
  host?: AutomationWorkspaceHostV3
  validateSession?: (sessionId: string, workspaceId: string) => boolean
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
  const ownsStore = !context.host
  const store = context.host?.store ?? new AutomationV3Store(context)
  const finalizeMutation = <T>(result: AutomationCapabilityResultV1<T>): AutomationCapabilityResultV1<T> => {
    if (result.status === 'ok' || result.status === 'duplicate') context.host?.refresh()
    return result
  }
  try {
    const document = store.initializeOrMigrate().document
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
              'automations.definitions': { minRead: 3, maxRead: 3, minWrite: 3, maxWrite: 3 },
              'automations.ingress': { minRead: 1, maxRead: 1, minWrite: 1, maxWrite: 1 },
              'automations.runs': { minRead: 1, maxRead: 1, minWrite: 1, maxWrite: 1 },
              'automations.history': { minRead: 1, maxRead: 1, minWrite: 1, maxWrite: 1 },
            },
            triggerKinds: ['event', 'cron', 'once', 'interval'],
            actionKinds: ['prompt', 'webhook'],
            targetKinds: ['new-session', 'session', 'isolated-agent'],
            limits: { maxEventBytes: 1_048_576, maxConditionDepth: 8, maxMatcherLength: 500, maxEventTypeLength: 255, maxRunListLimit: 500 },
            permissionScopes: ['automations.read', 'automations.history.read', 'automations.write', 'automations.run', 'automations.events.emit'],
          },
        }
      case 'list':
        return { schemaVersion: 1, status: 'ok', revision: document.revision, data: document.definitions }
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
      case 'list-runs':
        return { schemaVersion: 1, status: 'ok', data: store.listRuns({ ...(request.automationId ? { automationId: request.automationId } : {}), ...(request.limit ? { limit: request.limit } : {}) }) }
      case 'run': {
        if (context.host) {
          const result = context.host.acceptManual(request.automationId, request.operationId, request.triggerId)
          return { schemaVersion: 1, operationId: request.operationId, status: result.duplicate ? 'duplicate' : 'accepted', data: { runId: result.run.runId } }
        }
        if (!context.callbacks) return { schemaVersion: 1, operationId: request.operationId, status: 'unsupported', error: { code: 'execution_callbacks_unavailable', message: 'The host has not mounted automation execution callbacks', retryable: true } }
        const runtime = new AutomationV3Runtime({ workspaceId: context.workspaceId, store, callbacks: context.callbacks })
        const result = await runtime.runManual(request.automationId, request.operationId, request.triggerId)
        return { schemaVersion: 1, operationId: request.operationId, status: result.duplicate ? 'duplicate' : 'accepted', data: { runId: result.run.runId } }
      }
      case 'emit-event': {
        if (!context.host && !context.callbacks) return { schemaVersion: 1, operationId: request.operationId, status: 'unsupported', error: { code: 'execution_callbacks_unavailable', message: 'The host has not mounted automation execution callbacks', retryable: true } }
        const parsed = CloudEventV1Schema.safeParse(request.event)
        if (!parsed.success) return { schemaVersion: 1, operationId: request.operationId, status: 'invalid', error: { code: 'invalid_cloudevent', message: parsed.error.message, retryable: false } }
        const result = context.host
          ? await context.host.acceptEvent(parsed.data as CloudEventV1, { sourceKind: context.eventSourceKind, ...(request.matchValue ? { matchValue: request.matchValue } : {}) })
          : await new AutomationV3Runtime({ workspaceId: context.workspaceId, store, callbacks: context.callbacks! }).emitEvent(parsed.data as CloudEventV1, { sourceKind: context.eventSourceKind, ...(request.matchValue ? { matchValue: request.matchValue } : {}), ...(context.validateSession ? { validateSession: context.validateSession } : {}) })
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
  } finally {
    if (ownsStore) store.close()
  }
  return {
    schemaVersion: 1,
    status: 'invalid',
    error: { code: 'unsupported_automation_operation', message: 'Unsupported automation operation', retryable: false },
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.automations.GET,
  RPC_CHANNELS.automations.TEST,
  RPC_CHANNELS.automations.SET_ENABLED,
  RPC_CHANNELS.automations.DUPLICATE,
  RPC_CHANNELS.automations.DELETE,
  RPC_CHANNELS.automations.GET_HISTORY,
  RPC_CHANNELS.automations.GET_LAST_EXECUTED,
  RPC_CHANNELS.automations.REPLAY,
] as const

export function registerAutomationsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // Bounded V2 client adapter. All reads project the canonical V3 store and
  // every mutation writes it with revision CAS; no V2 file runtime is mounted.
  const resolveHost = (contextWorkspaceId: string | null | undefined, requestedWorkspaceId: string) => {
    const workspaceId = resolveWorkspaceId(contextWorkspaceId, requestedWorkspaceId)!
    const host = deps.sessionManager.getAutomationHost(workspaceId)
    if (!host) throw new Error(`Canonical Automations host is unavailable for ${workspaceId}`)
    return { workspaceId, host }
  }
  const legacyEvent = (definition: import('@mortise/shared/automations').AutomationDefinitionV3): string => {
    const trigger = definition.triggers[0]
    return trigger?.type === 'time' ? 'SchedulerTick' : trigger?.eventType ?? 'ExternalEvent'
  }
  const definitionsForLegacy = (host: import('@mortise/shared/automations').AutomationWorkspaceHostV3, eventName: string) =>
    host.store.initializeOrMigrate().document.definitions.filter(definition => legacyEvent(definition) === eventName)

  server.handle(RPC_CHANNELS.automations.GET, async (ctx, workspaceId: string) => {
    const { host } = resolveHost(ctx.workspaceId, workspaceId)
    const document = host.store.initializeOrMigrate().document
    const automations: Record<string, unknown[]> = {}
    for (const definition of document.definitions) {
      const event = legacyEvent(definition)
      const trigger = definition.triggers[0]
      const schedule = trigger?.type === 'time' ? trigger.schedule : undefined
      ;(automations[event] ??= []).push({
        id: definition.id,
        name: definition.name,
        enabled: definition.enabled,
        ...(trigger?.type === 'event' && trigger.matcher ? { matcher: trigger.matcher } : {}),
        ...(schedule?.kind === 'cron' ? { cron: schedule.expression, timezone: schedule.timezone } : {}),
        conditions: definition.conditions,
        actions: definition.actions,
      })
    }
    return { version: 3, revision: document.revision, automations }
  })

  server.handle(RPC_CHANNELS.automations.TEST, async () => {
    throw new Error(`Legacy automations:test is retired; use ${RPC_CHANNELS.automations.COMMAND} run and get-run`)
  })

  server.handle(RPC_CHANNELS.automations.SET_ENABLED, async (ctx, workspaceId: string, eventName: string, matcherIndex: number, enabled: boolean) => {
    const { host } = resolveHost(ctx.workspaceId, workspaceId)
    const document = host.store.initializeOrMigrate().document
    const definition = definitionsForLegacy(host, eventName)[matcherIndex]
    if (!definition) throw new Error('Automation not found')
    const result = host.store.mutateDocument({
      operationId: randomUUID(), expectedRevision: document.revision,
      document: { ...document, definitions: document.definitions.map(item => item.id === definition.id ? { ...item, enabled, updatedAt: new Date().toISOString() } : item) },
    })
    if (result.status !== 'ok') throw new Error(`Automation update failed: ${result.status}`)
    host.refresh()
  })

  server.handle(RPC_CHANNELS.automations.DUPLICATE, async (ctx, workspaceId: string, eventName: string, matcherIndex: number) => {
    const { host } = resolveHost(ctx.workspaceId, workspaceId)
    const document = host.store.initializeOrMigrate().document
    const definition = definitionsForLegacy(host, eventName)[matcherIndex]
    if (!definition) throw new Error('Automation not found')
    const now = new Date().toISOString()
    const clone = {
      ...definition,
      id: automationIdentity('aut_copy', definition.id, randomUUID()),
      name: `${definition.name} Copy`,
      triggers: definition.triggers.map(trigger => ({ ...trigger, id: automationIdentity('trg_copy', trigger.id, randomUUID()) })),
      actions: definition.actions.map(action => ({ ...action, id: automationIdentity('act_copy', action.id, randomUUID()) })),
      createdAt: now,
      updatedAt: now,
    }
    const result = host.store.mutateDocument({ operationId: randomUUID(), expectedRevision: document.revision, document: { ...document, definitions: [...document.definitions, clone] } })
    if (result.status !== 'ok') throw new Error(`Automation duplicate failed: ${result.status}`)
    host.refresh()
  })

  server.handle(RPC_CHANNELS.automations.DELETE, async (ctx, workspaceId: string, eventName: string, matcherIndex: number) => {
    const { host } = resolveHost(ctx.workspaceId, workspaceId)
    const document = host.store.initializeOrMigrate().document
    const definition = definitionsForLegacy(host, eventName)[matcherIndex]
    if (!definition) throw new Error('Automation not found')
    const result = host.store.mutateDocument({ operationId: randomUUID(), expectedRevision: document.revision, document: { ...document, definitions: document.definitions.filter(item => item.id !== definition.id) } })
    if (result.status !== 'ok') throw new Error(`Automation delete failed: ${result.status}`)
    host.refresh()
  })

  server.handle(RPC_CHANNELS.automations.GET_HISTORY, async (ctx, workspaceId: string, automationId: string, limit = 20) => {
    const { host } = resolveHost(ctx.workspaceId, workspaceId)
    return host.store.listRuns({ automationId, limit }).map(run => ({
      id: run.automationId,
      ts: Date.parse(run.completedAt ?? run.startedAt ?? run.createdAt),
      ok: run.state === 'succeeded' || run.state === 'partial',
      sessionId: run.actions.find(action => action.sessionId)?.sessionId,
      error: run.actions.find(action => action.error)?.error?.message ?? run.reason,
    }))
  })

  server.handle(RPC_CHANNELS.automations.REPLAY, async (ctx, workspaceId: string, automationId: string) => {
    const { host } = resolveHost(ctx.workspaceId, workspaceId)
    const accepted = host.acceptManual(automationId, randomUUID())
    return { runId: accepted.run.runId, accepted: true }
  })

  server.handle(RPC_CHANNELS.automations.GET_LAST_EXECUTED, async (ctx, workspaceId: string) => {
    const { host } = resolveHost(ctx.workspaceId, workspaceId)
    const result: Record<string, number> = {}
    for (const run of host.store.listRuns({ limit: 500 })) {
      const timestamp = Date.parse(run.completedAt ?? run.startedAt ?? run.createdAt)
      if (timestamp > (result[run.automationId] ?? 0)) result[run.automationId] = timestamp
    }
    return result
  })
  return
}
