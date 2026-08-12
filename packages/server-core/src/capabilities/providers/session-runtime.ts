import { randomUUID } from 'node:crypto'
import type { Session } from '@mortise/shared/protocol'
import type { ThinkingLevel } from '@mortise/shared/agent/thinking-levels'
import { isValidThinkingLevel } from '@mortise/shared/agent/thinking-levels'
import type { OperationCoordinator } from '../../operations/index.ts'
import type { CapabilityProvider, CapabilityProviderContext } from '../types.ts'

export const SESSION_EXECUTION_CAPABILITY = 'session.execution'
export const SESSION_CATALOG_CAPABILITY = 'session.catalog'
export const SESSION_SETTINGS_CAPABILITY = 'session.settings'
export const AGENT_CHILD_TASK_CAPABILITY = 'agent.child-task'

type JsonRecord = Record<string, unknown>

export interface SessionRuntimeCapabilityAdapter {
  getSession(sessionId: string): Promise<Session | null>
  listSessions(workspaceId: string): Session[]
  getSessionCwd(sessionId: string): string | undefined
  submitMessage(
    sessionId: string,
    message: string,
    operationId: string,
    delivery?: 'steer' | 'followUp',
  ): Promise<void>
  compactSession(sessionId: string, operationId: string, instructions?: string): Promise<void>
  interruptSession(sessionId: string): Promise<void>
  updateSessionModel(sessionId: string, workspaceId: string, model: string, provider: string): Promise<void>
  updateSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void
  createAndSubmit(
    workspaceId: string,
    message: string,
    operationId: string,
    options: { name?: string; signal: AbortSignal },
  ): Promise<string>
  runChildTask(input: {
    parentSessionId: string
    prompt: string
    model?: string
    thinkingLevel?: ThinkingLevel
    tools?: string[]
    systemPrompt?: string
  }): Promise<unknown>
}

export interface SessionCatalogEntry {
  id: string
  workspaceId: string
  name?: string
  createdAt?: number
  lastUsedAt?: number
  preview?: string
  messageCount: number
  isProcessing: boolean
  model?: string
  provider?: string
  thinkingLevel?: ThinkingLevel
  cwd?: string
  messages?: Session['messages']
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonRecord
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  return trimmed || undefined
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value, label)
  if (!result) throw new Error(`${label} must be a non-empty string`)
  return result
}

function optionalStrings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
  return value.map(item => item.trim())
}

async function resolveTargetSession(
  adapter: SessionRuntimeCapabilityAdapter,
  context: CapabilityProviderContext,
  input: JsonRecord,
): Promise<Session> {
  const caller = await adapter.getSession(context.request.sessionId)
  if (!caller) throw new Error('Capability caller Session is unavailable')
  const targetId = optionalString(input.sessionId, 'sessionId') ?? caller.id
  const target = await adapter.getSession(targetId)
  if (!target || target.workspaceId !== caller.workspaceId) {
    throw new Error('Target Session must exist in the caller Workspace')
  }
  return target
}

function operationId(input: JsonRecord): string {
  return optionalString(input.operationId, 'operationId') ?? randomUUID()
}

function catalogEntry(
  adapter: SessionRuntimeCapabilityAdapter,
  session: Session,
  includeMessages: boolean,
): SessionCatalogEntry {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    name: session.name,
    createdAt: session.createdAt,
    lastUsedAt: session.lastMessageAt ?? session.createdAt,
    preview: session.preview,
    messageCount: session.messageCount ?? session.messages?.length ?? 0,
    isProcessing: session.isProcessing,
    model: session.model,
    provider: session.provider,
    thinkingLevel: session.thinkingLevel,
    cwd: adapter.getSessionCwd(session.id),
    ...(includeMessages ? { messages: session.messages ?? [] } : {}),
  }
}

export function createSessionRuntimeCapabilityProviders(
  adapter: SessionRuntimeCapabilityAdapter,
  operations: OperationCoordinator,
): CapabilityProvider[] {
  const execution: CapabilityProvider = {
    capability: SESSION_EXECUTION_CAPABILITY,
    async invoke(action, value, context) {
      const input = record(value ?? {}, 'session.execution input')
      if (action === 'query-operation') {
        const id = requiredString(input.operationId, 'operationId')
        const receipt = operations.get(id)
        if (!receipt) return null
        const caller = await adapter.getSession(context.request.sessionId)
        if (!caller || receipt.scope.workspaceId !== caller.workspaceId) {
          throw new Error('Operation does not belong to the caller Workspace')
        }
        if (receipt.scope.extensionId && receipt.scope.extensionId !== context.request.extensionId) {
          throw new Error('Operation does not belong to the caller Extension')
        }
        return receipt
      }
      if (action === 'create-and-submit') {
        const caller = await adapter.getSession(context.request.sessionId)
        if (!caller) throw new Error('Capability caller Session is unavailable')
        const id = operationId(input)
        const message = requiredString(input.message, 'message')
        const name = optionalString(input.name, 'name')
        return operations.start(
          id,
          'extension.session.create-and-submit',
          { workspaceId: caller.workspaceId, sessionId: caller.id, extensionId: context.request.extensionId },
          async signal => ({
            resultRef: `session:${await adapter.createAndSubmit(caller.workspaceId, message, id, { name, signal })}`,
          }),
          { cancellable: true },
        )
      }

      const target = await resolveTargetSession(adapter, context, input)
      if (action === 'interrupt') {
        await adapter.interruptSession(target.id)
        return { interrupted: true, sessionId: target.id }
      }

      const id = operationId(input)
      if (action === 'submit-message') {
        const message = requiredString(input.message, 'message')
        const delivery = optionalString(input.delivery, 'delivery')
        if (delivery !== undefined && delivery !== 'steer' && delivery !== 'followUp') {
          throw new Error('delivery must be steer or followUp')
        }
        return operations.start(
          id,
          'extension.session.submit-message',
          { workspaceId: target.workspaceId, sessionId: target.id, extensionId: context.request.extensionId },
          async () => {
            await adapter.submitMessage(target.id, message, id, delivery)
            return { resultRef: `session:${target.id}:message:${id}` }
          },
        )
      }
      if (action === 'compact') {
        const instructions = optionalString(input.instructions, 'instructions')
        return operations.start(
          id,
          'extension.session.compact',
          { workspaceId: target.workspaceId, sessionId: target.id, extensionId: context.request.extensionId },
          () => adapter.compactSession(target.id, id, instructions),
        )
      }
      throw new Error(`Unsupported session.execution operation: ${action}`)
    },
  }

  const catalog: CapabilityProvider = {
    capability: SESSION_CATALOG_CAPABILITY,
    async invoke(action, value, context) {
      const input = record(value ?? {}, 'session.catalog input')
      const caller = await adapter.getSession(context.request.sessionId)
      if (!caller) throw new Error('Capability caller Session is unavailable')
      if (action === 'list') {
        return adapter.listSessions(caller.workspaceId).map(session => catalogEntry(adapter, session, false))
      }
      if (action === 'get') {
        const target = await adapter.getSession(requiredString(input.sessionId, 'sessionId'))
        return target?.workspaceId === caller.workspaceId ? catalogEntry(adapter, target, true) : null
      }
      throw new Error(`Unsupported session.catalog operation: ${action}`)
    },
  }

  const settings: CapabilityProvider = {
    capability: SESSION_SETTINGS_CAPABILITY,
    async invoke(action, value, context) {
      const input = record(value ?? {}, 'session.settings input')
      const target = await resolveTargetSession(adapter, context, input)
      if (action === 'get') {
        return {
          sessionId: target.id,
          model: target.model,
          provider: target.provider,
          thinkingLevel: target.thinkingLevel,
        }
      }
      if (action === 'set-model') {
        const provider = requiredString(input.provider, 'provider')
        const model = requiredString(input.model, 'model')
        await adapter.updateSessionModel(target.id, target.workspaceId, model, provider)
        return { updated: true, sessionId: target.id, provider, model }
      }
      if (action === 'set-thinking-level') {
        const level = requiredString(input.level, 'level')
        if (!isValidThinkingLevel(level)) throw new Error('Invalid thinking level')
        adapter.updateSessionThinkingLevel(target.id, level)
        return { updated: true, sessionId: target.id, thinkingLevel: level }
      }
      throw new Error(`Unsupported session.settings operation: ${action}`)
    },
  }

  const childTask: CapabilityProvider = {
    capability: AGENT_CHILD_TASK_CAPABILITY,
    async invoke(action, value, context) {
      if (action !== 'run') throw new Error(`Unsupported agent.child-task operation: ${action}`)
      const input = record(value ?? {}, 'agent.child-task input')
      const parent = await resolveTargetSession(adapter, context, input)
      const thinkingLevel = optionalString(input.thinkingLevel, 'thinkingLevel') as ThinkingLevel | undefined
      return adapter.runChildTask({
        parentSessionId: parent.id,
        prompt: requiredString(input.prompt, 'prompt'),
        model: optionalString(input.model, 'model'),
        thinkingLevel,
        tools: optionalStrings(input.tools, 'tools'),
        systemPrompt: optionalString(input.systemPrompt, 'systemPrompt'),
      })
    },
  }

  return [execution, catalog, settings, childTask]
}
