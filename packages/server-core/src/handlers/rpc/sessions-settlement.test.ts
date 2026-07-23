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
  registerSessionsHandlers(server, { sessionManager, platform } satisfies HandlerDeps)
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

    await command(ctx, session.id, { type: 'retrySettlement' })

    expect(retryPendingSettlement).toHaveBeenCalledTimes(1)
    expect(retryPendingSettlement).toHaveBeenCalledWith(session.id)
  })

  it('rejects retrySettlement commands carrying a message or other payload', async () => {
    const retryPendingSettlement = mock(async (_sessionId: string) => undefined)
    const { handlers, session } = createHarness({ retryPendingSettlement })
    const command = handlers.get(RPC_CHANNELS.sessions.COMMAND)!

    await expect(command(ctx, session.id, {
      type: 'retrySettlement',
      message: 'do not resend me',
    })).rejects.toThrow('does not accept a message or any other payload')
    expect(retryPendingSettlement).not.toHaveBeenCalled()
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
      onAck?: (messageId: string) => void,
    ) => {
      onAck?.('accepted-message')
      throw settlementFailure
    })
    const { handlers, pushes, session } = createHarness({ sendMessage })
    const send = handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!

    await expect(send(ctx, session.id, 'accepted once')).resolves.toEqual({
      accepted: true,
      messageId: 'accepted-message',
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
