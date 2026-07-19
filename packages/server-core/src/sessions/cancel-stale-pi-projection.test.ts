import { describe, expect, it, jest } from 'bun:test'
import type { PiProjectionEventV1 } from '@mortise/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('SessionManager cancellation', () => {
  it('closes a stale running Pi projection even when managed processing is already false', async () => {
    const manager = new SessionManager()
    const managed = createManagedSession(
      { mortiseId: 'session-1' },
      { id: 'workspace-1', name: 'Workspace', rootPath: process.cwd(), createdAt: 0 } as never,
      { messagesLoaded: true },
    )
    const abort = jest.fn(async () => {})
    managed.agent = { abort, isProcessing: () => false } as never
    managed.isProcessing = false
    const internals = manager as unknown as { sessions: Map<string, typeof managed> }
    internals.sessions.set(managed.id, managed)

    const start: PiProjectionEventV1 = {
      schemaVersion: 1,
      eventId: 'runtime-old:1',
      seq: 1,
      sessionId: managed.id,
      runtimeId: 'runtime-old',
      entityId: 'lifecycle:agent_start:1',
      entityType: 'conversation',
      entityVersion: 1,
      kind: 'agent_start',
      payload: { status: 'running' },
    }
    manager.applyPiProjectionEvent(start)

    await manager.cancelProcessing(managed.id)

    expect(abort).toHaveBeenCalledTimes(1)
    const snapshot = await manager.getPiProjectionSnapshot(managed.id)
    expect(snapshot?.entities.at(-1)).toMatchObject({
      kind: 'agent_end',
      payload: { status: 'interrupted' },
    })
  })
})
