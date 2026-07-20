import { describe, expect, it, mock } from 'bun:test'
import type {
  AutomationExecutionContextV1,
  PromptActionV3,
  TrustedAutomationEventV1,
} from '@mortise/shared/automations'
import { getMidStreamBehavior } from '@mortise/shared/config'
import { SessionManager, createManagedSession } from './SessionManager.ts'

function executionContext(options?: {
  workspaceId?: string
  eventSessionId?: string
}): AutomationExecutionContextV1 {
  const workspaceId = options?.workspaceId ?? 'ws-test'
  const event: TrustedAutomationEventV1 | undefined = options?.eventSessionId
    ? {
        eventId: 'evt-test',
        sourceKind: 'mortise',
        workspaceId,
        sessionId: options.eventSessionId,
        cloudEvent: {
          specversion: '1.0',
          id: 'cloud-event-test',
          source: 'urn:mortise:test',
          type: 'test.completed',
          time: new Date(0).toISOString(),
          data: {},
        },
        acceptedAt: new Date(0).toISOString(),
      }
    : undefined

  return {
    workspaceId,
    definition: {
      id: 'automation-test',
      name: 'Delivery test',
      enabled: true,
      triggers: [{ id: 'trigger-test', type: 'event', source: 'mortise', eventType: 'test.completed' }],
      actions: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    run: {
      schemaVersion: 1,
      runId: 'run-test',
      occurrenceId: 'occurrence-test',
      occurrenceKey: 'event:test',
      automationId: 'automation-test',
      definitionRevision: 1,
      definitionSnapshot: {
        id: 'automation-test',
        name: 'Delivery test',
        enabled: true,
        triggers: [{ id: 'trigger-test', type: 'event', source: 'mortise', eventType: 'test.completed' }],
        actions: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      triggerId: 'trigger-test',
      state: 'running',
      createdAt: new Date(0).toISOString(),
      actions: [],
    },
    ...(event ? { event } : {}),
  }
}

function addSession(manager: SessionManager, sessionId: string, workspaceId = 'ws-test') {
  const managed = createManagedSession(
    { mortiseId: sessionId, name: sessionId },
    {
      id: workspaceId,
      name: workspaceId,
      rootPath: `C:\\workspaces\\${workspaceId}`,
      createdAt: 0,
    } as never,
    { messagesLoaded: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
  return managed
}

describe('V3 automation prompt delivery', () => {
  it('does not expose a phantom Session when a new-session first turn fails', async () => {
    const manager = new SessionManager()
    const createAndSendFirstTurn = mock(async () => {
      throw new Error('first assistant was never persisted')
    })
    ;(manager as unknown as { createAndSendFirstTurn: typeof createAndSendFirstTurn }).createAndSendFirstTurn = createAndSendFirstTurn

    const action: PromptActionV3 = {
      id: 'action-new-session',
      type: 'prompt',
      prompt: 'run the automation',
      target: { kind: 'new-session' },
    }
    const result = await manager.executeAutomationPromptAction(action, executionContext())

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('session_first_turn_failed')
    expect(manager.getSessions('ws-test')).toEqual([])
    expect(createAndSendFirstTurn).toHaveBeenCalledTimes(1)
  })

  it('routes the legacy prompt entry point through the first-turn publication transaction', async () => {
    const manager = new SessionManager()
    const managed = addSession(manager, 'provisional-automation')
    managed.publicationState = 'provisional'
    const order: string[] = []
    const binder = mock(async () => {
      order.push('bound')
    })
    manager.setAutomationBinder(binder)
    let capturedInput: Record<string, unknown> | undefined

    ;(manager as unknown as {
      createAndSendFirstTurn: (
        input: Record<string, unknown>,
        prepare?: (session: typeof managed) => void | Promise<void>,
      ) => Promise<{ session: { id: string }; messageId: string }>
    }).createAndSendFirstTurn = async (input, prepare) => {
      capturedInput = input
      await prepare?.(managed)
      order.push('published')
      return { session: { id: managed.id }, messageId: 'message-test' }
    }

    const result = await manager.executePromptAutomation({
      workspaceId: 'ws-test',
      workspaceRootPath: managed.workspace.rootPath,
      prompt: 'legacy prompt',
      automationName: 'Legacy automation',
      telegramTopic: 'Builds',
    })

    expect(result.sessionId).toBe(managed.id)
    expect(capturedInput?.message).toBe('legacy prompt')
    expect(managed.triggeredBy?.automationName).toBe('Legacy automation')
    expect(order).toEqual(['published', 'bound'])
    expect(binder).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      sessionId: managed.id,
      topicName: 'Builds',
    })
  })

  it('delivers fixed followUp and trusted event steer to their exact Sessions', async () => {
    const manager = new SessionManager()
    addSession(manager, 'fixed-session')
    addSession(manager, 'event-session')
    const calls: Array<{ sessionId: string; prompt: string; intent: string | undefined }> = []

    ;(manager as unknown as {
      sendMessage: (...args: unknown[]) => Promise<void>
    }).sendMessage = async (...args) => {
      const [sessionId, prompt, , , options, , , onAck] = args as [
        string, string, unknown, unknown, { midStreamSendIntent?: string } | undefined,
        unknown, unknown, ((messageId: string) => void) | undefined,
      ]
      calls.push({ sessionId, prompt, intent: options?.midStreamSendIntent })
      onAck?.(`message-${calls.length}`)
    }

    const followUp = await manager.executeAutomationPromptAction({
      id: 'action-follow-up',
      type: 'prompt',
      prompt: 'after the current turn',
      target: { kind: 'session', session: { id: 'fixed-session' }, delivery: 'followUp' },
    }, executionContext())
    const steer = await manager.executeAutomationPromptAction({
      id: 'action-steer',
      type: 'prompt',
      prompt: 'change direction now',
      target: { kind: 'session', session: 'event-session', delivery: 'steer' },
    }, executionContext({ eventSessionId: 'event-session' }))

    const configured = getMidStreamBehavior()
    expect(followUp).toEqual({ status: 'succeeded', sessionId: 'fixed-session' })
    expect(steer).toEqual({ status: 'succeeded', sessionId: 'event-session' })
    expect(calls).toEqual([
      {
        sessionId: 'fixed-session',
        prompt: 'after the current turn',
        intent: configured === 'queue' ? 'default' : 'alternate',
      },
      {
        sessionId: 'event-session',
        prompt: 'change direction now',
        intent: configured === 'steer' ? 'default' : 'alternate',
      },
    ])
  })

  it('blocks missing event Sessions and cross-workspace fixed targets without substitution', async () => {
    const manager = new SessionManager()
    addSession(manager, 'other-workspace-session', 'ws-other')
    const sendMessage = mock(async () => undefined)
    ;(manager as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage

    const missingEvent = await manager.executeAutomationPromptAction({
      id: 'action-missing-event',
      type: 'prompt',
      prompt: 'do not substitute',
      target: { kind: 'session', session: 'event-session', delivery: 'followUp' },
    }, executionContext())
    const wrongWorkspace = await manager.executeAutomationPromptAction({
      id: 'action-wrong-workspace',
      type: 'prompt',
      prompt: 'do not cross workspaces',
      target: { kind: 'session', session: { id: 'other-workspace-session' }, delivery: 'steer' },
    }, executionContext())

    expect(missingEvent.status).toBe('blocked')
    expect(missingEvent.error?.code).toBe('event_session_unavailable')
    expect(wrongWorkspace.status).toBe('blocked')
    expect(wrongWorkspace.error?.code).toBe('session_workspace_mismatch')
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
