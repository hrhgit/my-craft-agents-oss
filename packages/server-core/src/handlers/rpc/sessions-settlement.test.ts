import { describe, expect, it, mock } from 'bun:test'
import {
  RPC_CHANNELS,
  SESSION_SETTLEMENT_ERROR_CODE,
  type Session,
  type SessionSettlementFailure,
} from '@mortise/shared/protocol'
import type { HandlerDeps } from '../handler-deps'
import type { ISessionManager } from '../session-manager-interface'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport'
import type { PlatformServices } from '../../runtime/platform'
import { registerSessionsHandlers } from './sessions'

const ctx: RequestContext = {
  clientId: 'settlement-client',
  workspaceId: 'settlement-workspace',
  webContentsId: null,
}

function createHarness(overrides: Record<string, unknown>) {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const session: Session = {
    id: 'settlement-session',
    workspaceId: ctx.workspaceId!,
    workspaceName: 'Settlement Workspace',
    messages: [],
    isProcessing: true,
    messageCount: 1,
    lastMessageAt: 1,
  }
  const sessionManager = new Proxy({
    async getSession(id: string) { return id === session.id ? session : null },
    ...overrides,
  }, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      return () => { throw new Error(`Unexpected SessionManager call: ${String(property)}`) }
    },
  }) as unknown as ISessionManager
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push(channel, target, ...args) { pushes.push({ channel, target, args }) },
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const platform: PlatformServices = {
    appRootPath: '',
    resourcesPath: '',
    isPackaged: false,
    appVersion: 'test',
    isDebugMode: false,
    logger,
    imageProcessor: {
      async getMetadata() { return null },
      async process() { return Buffer.alloc(0) },
    },
  }
  const operationCoordinator = {
    accept(operationId: string) {
      return { accepted: true as const, operationId, status: 'accepted' as const, revision: 1, duplicate: false }
    },
    update() { return undefined },
    start(operationId: string, _type: string, _scope: unknown, task: (signal: AbortSignal) => Promise<unknown>) {
      void task(new AbortController().signal)
      return { accepted: true as const, operationId, status: 'accepted' as const, revision: 1, duplicate: false }
    },
  }
  registerSessionsHandlers(server, { sessionManager, platform, operationCoordinator } as unknown as HandlerDeps)
  return { handlers, pushes, session }
}

const settlementFailure: SessionSettlementFailure = {
  code: SESSION_SETTLEMENT_ERROR_CODE,
  message: 'Accepted message is waiting for host settlement',
  data: {
    sessionId: 'settlement-session',
    stage: 'turn-settlement',
    retryable: true,
    terminal: false,
    outcome: 'accepted-pending-settlement',
  },
}

describe('session settlement RPC contract', () => {
  it('routes payload-free retrySettlement with only the Session identity', async () => {
    const retryPendingSettlement = mock(async (_sessionId: string) => undefined)
    const { handlers, session } = createHarness({ retryPendingSettlement })
    const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)!

    await command(ctx, session.id, { type: 'retrySettlement', operationId: 'retry-settlement-1' })
    await Promise.resolve()

    expect(retryPendingSettlement).toHaveBeenCalledTimes(1)
    expect(retryPendingSettlement).toHaveBeenCalledWith(session.id)
  })

  it('rejects retrySettlement commands carrying a message or other payload', async () => {
    const retryPendingSettlement = mock(async (_sessionId: string) => undefined)
    const { handlers, session } = createHarness({ retryPendingSettlement })
    const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)!

    await expect(command(ctx, session.id, {
      type: 'retrySettlement',
      operationId: 'retry-settlement-invalid',
      message: 'do not resend me',
    })).rejects.toThrow('does not accept a message or any other payload')
    expect(retryPendingSettlement).not.toHaveBeenCalled()
  })

  it('routes retryAcceptedMessage with the requesting client identity', async () => {
    const retryAcceptedMessage = mock(async (_sessionId: string, _clientId: string) => undefined)
    const { handlers, session } = createHarness({ retryAcceptedMessage })
    const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)!

    await command(ctx, session.id, { type: 'retryAcceptedMessage', operationId: 'retry-accepted-1' })
    await Promise.resolve()

    expect(retryAcceptedMessage).toHaveBeenCalledTimes(1)
    expect(retryAcceptedMessage).toHaveBeenCalledWith(session.id, ctx.clientId)
  })

  it('rejects retryAcceptedMessage commands carrying a replacement payload', async () => {
    const retryAcceptedMessage = mock(async (_sessionId: string, _clientId: string) => undefined)
    const { handlers, session } = createHarness({ retryAcceptedMessage })
    const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)!

    await expect(command(ctx, session.id, {
      type: 'retryAcceptedMessage',
      operationId: 'retry-accepted-invalid',
      message: 'do not submit a second mutation',
    })).rejects.toThrow('does not accept a message or any other payload')
    expect(retryAcceptedMessage).not.toHaveBeenCalled()
  })

  it('emits exact session_failure after ACK and never downgrades it to ordinary error', async () => {
    const sendMessage = mock(async (
      _sessionId: string,
      _message: string,
      _attachments: unknown,
      _storedAttachments: unknown,
      _options: unknown,
      _existingMessageId: unknown,
      _isAuthRetry: unknown,
      _onAck: unknown,
      _rpcContext: unknown,
      _isQueuedReplay: unknown,
      _isAutomaticResume: unknown,
      onAccepted?: (messageId: string) => void,
    ) => {
      onAccepted?.('accepted-message')
      throw settlementFailure
    })
    const { handlers, pushes, session } = createHarness({ sendMessage })
    const send = handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!

    await expect(send(ctx, session.id, 'accepted once', undefined, undefined, { operationId: 'send-settlement-1' })).resolves.toEqual({
      accepted: true,
      duplicate: false,
      messageId: 'accepted-message',
      operationId: 'send-settlement-1',
      revision: 1,
      status: 'accepted',
    })
    await Promise.resolve()

    const events = pushes
      .filter(push => push.channel === RPC_CHANNELS.sessions.EVENT)
      .flatMap(push => push.args)
    expect(events).toEqual([{
      type: 'session_failure',
      sessionId: session.id,
      error: settlementFailure,
    }])
    expect(events.some(event => (event as { type?: unknown }).type === 'error')).toBe(false)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })
})
