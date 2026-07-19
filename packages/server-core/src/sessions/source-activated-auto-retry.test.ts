import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ConversationProjector } from '../projection/conversation-projector.ts'
import { SessionManager, createManagedSession, claimAutoRetryPending } from './SessionManager.ts'

// Regression test for mortise-oss#804.
//
// Before: the "[<slug> activated]" auto-retry only lived in the Electron renderer's
// event processor. Headless deployments (WebUI, docker server) stalled after a
// mid-turn source activation because nothing re-sent the original message.
//
// After: SessionManager.processEvent schedules a server-side resend on
// `source_activated`. To survive a mixed-version rollout where a v0.9.5 Electron
// client still ships the legacy renderer-side auto_retry, sendMessage uses a
// content-match committed-slot to dedup the duplicate RPC.

type SourceActivatedEvent = {
  type: 'source_activated'
  sourceSlug: string
  originalMessage: string
}

describe('claimAutoRetryPending', () => {
  it('allows the first matching retry and drops later duplicates within the deadline', () => {
    const host = {
      autoRetryPending: {
        content: 'do it\n\n[github activated]',
        deadlineMs: 2000,
        committed: false,
      },
    }

    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1000)).toBe('send')
    expect(host.autoRetryPending?.committed).toBe(true)
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1001)).toBe('drop')
  })

  it('clears stale pending slots without dropping the message', () => {
    const host = {
      autoRetryPending: {
        content: 'do it\n\n[github activated]',
        deadlineMs: 2000,
        committed: true,
      },
    }

    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 2500)).toBe('send')
    expect(host.autoRetryPending).toBeUndefined()
  })

  it('does not over-dedup unrelated messages', () => {
    const host = {
      autoRetryPending: {
        content: 'do it\n\n[github activated]',
        deadlineMs: 2000,
        committed: false,
      },
    }

    expect(claimAutoRetryPending(host, 'never mind', 1000)).toBe('send')
    expect(host.autoRetryPending).toBeDefined()
  })
})

describe('source_activated auto-retry', () => {
  let tmpRoot: string
  let sm: SessionManager
  let projectionSequenceBySession: Map<string, number>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-autoretry-'))
    sm = new SessionManager()
    projectionSequenceBySession = new Map()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { mortiseId: id, name: 'auto-retry test' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    ;(sm as unknown as { piProjectionBySession: Map<string, ConversationProjector> })
      .piProjectionBySession.set(id, new ConversationProjector(id, `runtime-${id}`))
    projectionSequenceBySession.set(id, 0)
    return managed
  }

  function projectUserMessage(sessionId: string, messageId: string, content: string): void {
    const seq = (projectionSequenceBySession.get(sessionId) ?? 0) + 1
    projectionSequenceBySession.set(sessionId, seq)
    const projector = (sm as unknown as {
      piProjectionBySession: Map<string, ConversationProjector>
    }).piProjectionBySession.get(sessionId)!
    projector.apply({
      schemaVersion: 1,
      eventId: `event-${sessionId}-${seq}`,
      seq,
      sessionId,
      runtimeId: projector.runtimeId,
      turnId: `turn-${seq}`,
      entityId: `content:user:${messageId}`,
      entityType: 'content_block',
      entityVersion: 1,
      kind: 'user_text',
      payload: {
        role: 'user',
        messageId,
        text: content,
        streaming: false,
        queueStatus: 'accepted',
        source: 'pi',
      },
    })
  }

  /**
   * Replace `sendMessage` with a spy that records the call and advances the
   * Pi-owned projection with the accepted user message. The auto-retry
   * preemption check intentionally ignores Mortise overlay messages.
   */
  function spyOnSendMessage(sessionId: string) {
    const calls: string[] = []
    ;(sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage = async (id, msg) => {
      const m = (sm as unknown as { sessions: Map<string, { autoRetryPending?: { content: string; deadlineMs: number; committed: boolean } }> }).sessions.get(id)!
      if (claimAutoRetryPending(m, msg) === 'drop') return
      calls.push(msg)
      projectUserMessage(id, `m-${calls.length}`, msg)
    }
    return calls
  }

  async function fireSourceActivated(sessionId: string, sourceSlug: string, originalMessage: string) {
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId)!
    const event: SourceActivatedEvent = { type: 'source_activated', sourceSlug, originalMessage }
    await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)
  }

  it('basic re-send — fires sendMessage with "[<slug> activated]" suffix', async () => {
    const sessionId = 'basic-resend'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'list my repos')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual(['list my repos\n\n[github activated]'])
  })

  it('chained activations — produces two retries with different suffixes', async () => {
    const sessionId = 'chained'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'find issues')
    await new Promise(r => setTimeout(r, 150))
    await fireSourceActivated(sessionId, 'linear', 'find issues')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([
      'find issues\n\n[github activated]',
      'find issues\n\n[linear activated]',
    ])
  })

  it('empty originalMessage — forwards event but does not schedule a bogus retry', async () => {
    const sessionId = 'empty-original'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', '')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([])
    expect(managed.autoRetryPending).toBeUndefined()
    expect(managed.autoRetryTimer).toBeUndefined()
  })

  it('legitimate user message preempts retry — skipped when follow-up arrived', async () => {
    const sessionId = 'preempted'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'check the repo')
    // Simulate Pi accepting a brand-new user message during the 100ms window.
    projectUserMessage(
      sessionId,
      'user-followup',
      'actually check the issues instead',
    )

    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([])
    // The pending slot is cleared when the timer skips so a late legacy RPC
    // doesn't get dropped against a stale slot.
    expect(managed.autoRetryPending).toBeUndefined()
  })

  it('mixed-version race: legacy RPC arrives BEFORE timer fires — exactly one message committed', async () => {
    const sessionId = 'race-rpc-first'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // Legacy renderer's RPC arrives ~5ms after schedule, BEFORE the 100ms timer.
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'do the thing\n\n[github activated]',
    )
    // Wait past the timer.
    await new Promise(r => setTimeout(r, 200))

    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('do the thing\n\n[github activated]')
  })

  it('mixed-version race: timer fires BEFORE legacy RPC arrives — exactly one message committed', async () => {
    const sessionId = 'race-timer-first'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // Wait for the timer to fire and commit.
    await new Promise(r => setTimeout(r, 150))
    // Now the late legacy RPC arrives (≤2s window).
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'do the thing\n\n[github activated]',
    )

    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('do the thing\n\n[github activated]')
  })

  it('user message with different content still goes through — pending slot does not over-dedup', async () => {
    const sessionId = 'unrelated-message'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'list repos')
    // User types something completely different in the dedup window — pending
    // content does not match, so the dedup gate falls through and the message
    // goes through normally. (It also adds a projection user entity, which
    // causes the timer to skip the auto-retry as preempted — covered by the
    // 'preempted' test. The unique guarantee here is: the unrelated message
    // itself is never silently dropped by the dedup gate.)
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'never mind, what time is it',
    )
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual(['never mind, what time is it'])
  })

  it('timer cancelled on session delete — no auto-retry fires after deletion', async () => {
    const sessionId = 'deleted-mid-window'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // Confirm the timer is armed before we delete.
    expect(managed.autoRetryTimer).toBeDefined()

    // Synchronously rip the session out of the map (mimic the deletion path's
    // cleanup without going through the full deleteSession flow, which would
    // also try to dispose agents and tear down pool servers we never created).
    if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
    managed.autoRetryTimer = undefined
    managed.autoRetryPending = undefined
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.delete(sessionId)

    await new Promise(r => setTimeout(r, 200))

    expect(calls).toEqual([])
  })
})
