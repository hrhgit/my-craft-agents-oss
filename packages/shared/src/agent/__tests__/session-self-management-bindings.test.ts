import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tools.ts';
import { createSessionToolContext } from '../session-tool-context.ts';
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts';
import type { SessionToolContext, TextContent } from '@mortise/session-tools-core';
import { SESSION_TOOL_REGISTRY } from '@mortise/session-tools-core';

const noop = () => {};

function createBaseContext(sessionId: string): SessionToolContext {
  return createSessionToolContext({
    sessionId,
    workspaceId: 'test-workspace',
    workspacePath: '/tmp/test-workspace',
    onPlanSubmitted: noop,
  });
}

describe('session query bindings', () => {
  const sessionId = 'test-session-query-bindings';

  beforeEach(() => unregisterSessionScopedToolCallbacks(sessionId));

  it('exposes only registered coordination callbacks', async () => {
    const context = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(context, sessionId);

    expect(context.listSessions).toBeUndefined();
    expect(context.createSession).toBeUndefined();
    expect(context.readSession).toBeUndefined();
    expect(context.sendMessageToSession).toBeUndefined();

    registerSessionScopedToolCallbacks(sessionId, {
      listSessionsFn: () => ({ sessions: [], hasMore: false }),
      createSessionFn: async () => ({ sessionId: 'created', messageId: 'message', operationId: 'operation', publication: 'published' }),
      readSessionFn: async id => ({
        session: { id, name: id, createdAt: 1, status: 'idle' },
        branch: { leafId: null, currentLeafId: null, isCurrent: true },
        turns: [],
        hasMore: false,
      }),
      sendMessageToSessionFn: async () => ({
        accepted: true,
        operationId: 'operation',
        messageId: 'message',
        delivery: 'followUp',
      }),
    });

    expect(context.listSessions!().hasMore).toBe(false);
    expect((await context.createSession!({ message: 'hello', sourceSessionId: sessionId })).sessionId).toBe('created');
    expect((await context.readSession!('other')).session.id).toBe('other');
    expect((await context.sendMessageToSession!({ sessionId: 'other', message: 'hello', sourceSessionId: sessionId })).accepted).toBe(true);
  });

  it('uses current callbacks after a late replacement', () => {
    const context = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(context, sessionId);
    registerSessionScopedToolCallbacks(sessionId, {
      listSessionsFn: () => ({ sessions: [{ id: 'one', name: 'one', createdAt: 1, status: 'idle' }], hasMore: false }),
    });
    expect(context.listSessions!().sessions[0]?.id).toBe('one');

    mergeSessionScopedToolCallbacks(sessionId, {
      listSessionsFn: () => ({ sessions: [{ id: 'two', name: 'two', createdAt: 2, status: 'idle' }], hasMore: false }),
    });
    expect(context.listSessions!().sessions[0]?.id).toBe('two');
  });

  it('does not register retired organization tools', () => {
    expect(SESSION_TOOL_REGISTRY.has('set_session_labels')).toBe(false);
    expect(SESSION_TOOL_REGISTRY.has('set_session_status')).toBe(false);
  });

  it('returns availability errors when coordination callbacks are absent', async () => {
    const context = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(context, sessionId);
    for (const name of ['list_sessions', 'create_session', 'read_session', 'send_message_to_session'] as const) {
      const result = await SESSION_TOOL_REGISTRY.get(name)!.handler!(context, {});
      expect(result.isError).toBe(true);
      expect((result.content[0] as TextContent).text).toContain('not available in this context');
    }
  });
});
