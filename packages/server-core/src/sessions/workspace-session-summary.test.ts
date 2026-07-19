import { describe, expect, it } from 'bun:test'

import { RPC_CHANNELS, type UnreadSummary } from '@mortise/shared/protocol'
import { createManagedSession, SessionManager } from './SessionManager.ts'

describe('workspace session summary', () => {
  it('aggregates processing state independently from unread state', () => {
    const manager = new SessionManager()
    const workspace = {
      id: 'ws_running',
      name: 'Running Workspace',
      rootPath: '/tmp/running-workspace',
      createdAt: Date.now(),
    }
    const running = createManagedSession({ mortiseId: 'running' }, workspace as never)
    running.isProcessing = true
    const idleUnread = createManagedSession({ mortiseId: 'idle-unread', hasUnread: true }, workspace as never)
    const hiddenRunning = createManagedSession({ mortiseId: 'hidden-running', hidden: true }, {
      ...workspace,
      id: 'ws_hidden',
    } as never)
    hiddenRunning.isProcessing = true

    const sessions = (manager as unknown as { sessions: Map<string, typeof running> }).sessions
    sessions.set(running.id, running)
    sessions.set(idleUnread.id, idleUnread)
    sessions.set(hiddenRunning.id, hiddenRunning)

    const summary = manager.getUnreadSummary()

    expect(summary.hasProcessingByWorkspace.ws_running).toBe(true)
    expect(summary.hasUnreadByWorkspace.ws_running).toBe(true)
    expect(summary.byWorkspace.ws_running).toBe(1)
    expect(summary.hasProcessingByWorkspace.ws_hidden).not.toBe(true)
  })

  it('broadcasts summary updates on processing transitions', () => {
    const manager = new SessionManager()
    const workspace = {
      id: 'ws_broadcast',
      name: 'Broadcast Workspace',
      rootPath: '/tmp/broadcast-workspace',
      createdAt: Date.now(),
    }
    const session = createManagedSession({ mortiseId: 'broadcast-session' }, workspace as never)
    ;(manager as unknown as { sessions: Map<string, typeof session> }).sessions.set(session.id, session)

    const summaries: UnreadSummary[] = []
    manager.setEventSink((channel, _target, ...args) => {
      if (channel === RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED) {
        summaries.push(args[0] as UnreadSummary)
      }
    })

    const setProcessing = (manager as unknown as {
      setProcessing: (managed: typeof session, processing: boolean) => void
    }).setProcessing.bind(manager)

    setProcessing(session, true)
    setProcessing(session, false)

    expect(summaries).toHaveLength(2)
    expect(summaries[0]?.hasProcessingByWorkspace.ws_broadcast).toBe(true)
    expect(summaries[1]?.hasProcessingByWorkspace.ws_broadcast).not.toBe(true)
  })
})
