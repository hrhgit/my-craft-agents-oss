import { describe, expect, it } from 'bun:test'
import type { Workspace } from '@mortise/core/types'
import type { Session } from '@mortise/shared/protocol'
import { SessionCoordinator, type SessionCoordinatorGateway } from './SessionCoordinator'

function workspace(): Workspace {
  return {
    schemaVersion: 2,
    id: 'workspace-1',
    revision: 1,
    name: 'Workspace',
    nameSource: 'custom',
    slug: 'workspace',
    primaryLocationId: 'location-1',
    locations: [{
      id: 'location-1',
      name: 'Local',
      rootName: 'workspace',
      endpoint: { kind: 'local', rootPath: 'E:\\workspace' },
    }],
    createdAt: 1,
  } as Workspace
}

function session(id: string, updatedAt: number): Session {
  return {
    id,
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    name: id,
    preview: `${id} preview`,
    createdAt: updatedAt - 1,
    lastMessageAt: updatedAt,
    messages: [],
    isProcessing: false,
  }
}

function gateway(overrides: Partial<SessionCoordinatorGateway> = {}): SessionCoordinatorGateway {
  const sessions = [session('session-1', 10), session('session-2', 20)]
  return {
    getSessions: () => sessions,
    getSession: async id => sessions.find(candidate => candidate.id === id) ?? null,
    getWorkspaces: () => [workspace()],
    readPiProjection: async () => ({ leafId: null, entries: [] }),
    createAndSendFirstTurn: async input => ({
      session: session('created-session', 30),
      messageId: input.sendOptions?.operationId ?? 'message-1',
      publication: 'published',
    }),
    sendMessage: async (_sessionId, _message, _attachments, _stored, _options, _existing, _retry, _ack, _rpc, _replay, accepted) => {
      accepted?.('message-1')
    },
    ...overrides,
  }
}

describe('SessionCoordinator', () => {
  it('lists ordinary sessions with opaque cursor pagination', () => {
    const coordinator = new SessionCoordinator(gateway())
    const first = coordinator.list('workspace-1', { limit: 1 })
    expect(first.sessions.map(item => item.id)).toEqual(['session-2'])
    expect(first.hasMore).toBe(true)
    const second = coordinator.list('workspace-1', { limit: 1, cursor: first.nextCursor })
    expect(second.sessions.map(item => item.id)).toEqual(['session-1'])
    expect(second.hasMore).toBe(false)
  })

  it('creates an ordinary session through the first-turn transaction', async () => {
    let captured: Parameters<SessionCoordinatorGateway['createAndSendFirstTurn']>[0] | undefined
    const coordinator = new SessionCoordinator(gateway({
      createAndSendFirstTurn: async input => {
        captured = input
        return { session: session('created-session', 30), messageId: 'message-1', publication: 'published' }
      },
    }))
    const result = await coordinator.create('workspace-1', {
      message: 'first message',
      name: 'Created',
      sourceSessionId: 'source-session',
    })
    expect(result.sessionId).toBe('created-session')
    expect(captured?.message).toBe('first message')
    expect(captured?.sendOptions?.source).toEqual({ type: 'session', sessionId: 'source-session' })
  })

  it('sends the original message through the normal delivery path', async () => {
    let capturedMessage = ''
    let capturedOptions: Parameters<SessionCoordinatorGateway['sendMessage']>[4]
    const coordinator = new SessionCoordinator(gateway({
      sendMessage: async (_id, message, _attachments, _stored, options, _existing, _retry, _ack, _rpc, _replay, accepted) => {
        capturedMessage = message
        capturedOptions = options
        accepted?.('message-1')
      },
    }))
    const result = await coordinator.send('workspace-1', {
      sessionId: 'session-1',
      message: 'plain message',
      delivery: 'steer',
      sourceSessionId: 'source-session',
    })
    expect(result.accepted).toBe(true)
    expect(capturedMessage).toBe('plain message')
    expect(capturedOptions?.source).toEqual({ type: 'session', sessionId: 'source-session' })
  })

  it('reads only the selected Pi tree branch', async () => {
    const coordinator = new SessionCoordinator(gateway({
      readPiProjection: async () => ({
        leafId: 'assistant-current',
        entries: [
          { id: 'user-root', parentId: null, type: 'message', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'root' } },
          { id: 'assistant-old', parentId: 'user-root', type: 'message', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: 'old branch' } },
          { id: 'user-current', parentId: 'user-root', type: 'message', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: 'current question' } },
          { id: 'assistant-current', parentId: 'user-current', type: 'message', timestamp: '2026-01-01T00:00:03Z', message: { role: 'assistant', content: 'current answer' } },
        ],
      }),
    }))
    const result = await coordinator.read('workspace-1', 'session-1')
    expect(result.branch).toEqual({
      leafId: 'assistant-current',
      currentLeafId: 'assistant-current',
      isCurrent: true,
    })
    expect(result.turns).toEqual([
      expect.objectContaining({ id: 'user-root', user: 'root' }),
      expect.objectContaining({ id: 'user-current', user: 'current question', agent: 'current answer' }),
    ])
    expect(JSON.stringify(result)).not.toContain('old branch')
  })
})
