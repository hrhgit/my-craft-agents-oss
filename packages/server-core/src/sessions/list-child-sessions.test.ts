import { describe, expect, it, mock } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('SessionManager child session listing', () => {
  it('lets a cold backend establish its runtime identity before listing children', async () => {
    const manager = new SessionManager()
    const managed = createManagedSession(
      { mortiseId: 'mortise-parent', name: 'Parent' },
      {
        id: 'workspace',
        name: 'Workspace',
        rootPath: process.cwd(),
        createdAt: Date.now(),
      } as never,
      { messagesLoaded: true },
    )
    const children = [{
      sessionId: 'child',
      sessionPath: '/sessions/child.jsonl',
      cwd: process.cwd(),
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
      firstMessage: 'Check the child task.',
    }]
    const agent = {
      getSessionId: mock(() => null),
      listChildSessions: mock(async () => children),
    }
    managed.agent = agent as never
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)

    await expect(manager.listChildSessions(managed.id)).resolves.toEqual(children)
    expect(agent.listChildSessions).toHaveBeenCalledWith('mortise-parent')
  })
})
