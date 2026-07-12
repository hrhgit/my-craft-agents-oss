import { describe, expect, it, mock } from 'bun:test'
import type { AnnotationV1 } from '@craft-agent/core/types'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
  },
}))

mock.module('@sentry/electron/main', () => ({
  captureException: () => {},
}))

mock.module('../logger', () => ({
  sessionLog: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  isDebugMode: false,
  getLogFilePath: () => '/tmp/main.log',
}))

mock.module('../notifications', () => ({
  updateBadgeCount: () => {},
}))

const { SessionManager } = await import('@craft-agent/server-core/sessions')

function makeAnnotation(id: string, extraMeta?: Record<string, unknown>): AnnotationV1 {
  return {
    id,
    schemaVersion: 1,
    createdAt: Date.now(),
    intent: 'highlight',
    body: [{ type: 'highlight' }],
    target: {
      source: { sessionId: 'session-1', messageId: 'msg-1' },
      selectors: [
        { type: 'text-position', start: 0, end: 5 },
        { type: 'text-quote', exact: 'hello' },
      ],
    },
    ...(extraMeta ? { meta: extraMeta } : {}),
  }
}

function createHarness(initialAnnotations: AnnotationV1[] = []) {
  const managed = {
    id: 'session-1',
    workspace: { id: 'ws-1', rootPath: '/tmp/ws-1' },
    messagesLoaded: true,
    messages: [{
      id: 'msg-1',
      role: 'assistant',
      content: 'hello world',
      timestamp: 1,
      annotations: initialAnnotations,
    }],
  }

  let persistCalls = 0
  const events: Array<{ event: any; workspaceId: string }> = []

  const manager = Object.create(SessionManager.prototype) as any
  manager.sessions = new Map([['session-1', managed]])
  manager.piProjectionBySession = new Map([['session-1', {
    createSnapshot: () => ({
      schemaVersion: 1,
      sessionId: 'session-1',
      runtimeId: 'runtime-1',
      lastSeq: 1,
      entities: [{
        entityId: 'content:text:msg-1:0',
        entityType: 'content_block',
        entityVersion: 1,
        createdSeq: 1,
        lastSeq: 1,
        lastEventId: 'event-1',
        kind: 'assistant_text',
        payload: { role: 'assistant', messageId: 'msg-1', text: 'hello world' },
      }],
    }),
  }]])
  manager.persistSession = () => { persistCalls += 1 }
  manager.sendEvent = (event: any, workspaceId: string) => {
    events.push({ event, workspaceId })
  }

  return {
    manager,
    managed,
    get persistCalls() {
      return persistCalls
    },
    events,
  }
}

describe('SessionManager annotation validation', () => {
  it('rejects add when per-message annotation limit is reached', () => {
    const existing = Array.from({ length: 200 }, (_, i) => makeAnnotation(`ann-${i}`))
    const h = createHarness(existing)

    h.manager.addMessageAnnotation('session-1', 'msg-1', makeAnnotation('ann-over-limit'))

    expect(h.managed.messages[0].annotations).toHaveLength(200)
    expect(h.persistCalls).toBe(0)
    expect(h.events).toHaveLength(0)
  })

  it('rejects add for oversized annotation payload', () => {
    const h = createHarness([])
    const oversizedMeta = { blob: 'x'.repeat(40 * 1024) }

    h.manager.addMessageAnnotation('session-1', 'msg-1', makeAnnotation('ann-big', oversizedMeta))

    expect(h.managed.messages[0].annotations).toHaveLength(0)
    expect(h.persistCalls).toBe(0)
    expect(h.events).toHaveLength(0)
  })

  it('rejects update patch with empty selectors array', () => {
    const existing = [makeAnnotation('ann-1')]
    const h = createHarness(existing)

    h.manager.updateMessageAnnotation('session-1', 'msg-1', 'ann-1', {
      target: {
        source: { sessionId: 'session-1', messageId: 'msg-1' },
        selectors: [],
      },
    })

    expect(h.managed.messages[0].annotations).toHaveLength(1)
    expect(h.managed.messages[0].annotations[0]?.id).toBe('ann-1')
    expect(h.persistCalls).toBe(0)
    expect(h.events).toHaveLength(0)
  })

  it('creates a Craft overlay for a live projected message', () => {
    const h = createHarness([])
    h.managed.messages = []

    h.manager.addMessageAnnotation('session-1', 'msg-1', makeAnnotation('ann-live'))

    expect(h.managed.messages).toEqual([expect.objectContaining({
      id: 'msg-1',
      content: '',
      annotations: [expect.objectContaining({ id: 'ann-live' })],
    })])
    expect(h.persistCalls).toBe(1)
    expect(h.events).toHaveLength(1)
  })
})
