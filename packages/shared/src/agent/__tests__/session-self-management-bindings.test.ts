import { describe, it, expect, beforeEach } from 'bun:test';
import {
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tools.ts';
import { createSessionToolContext } from '../session-tool-context.ts';
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts';
import type { SessionToolContext, SessionInfo, TextContent } from '@craft-agent/session-tools-core';
import { SESSION_TOOL_REGISTRY } from '@craft-agent/session-tools-core';

const noop = () => {};

function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'test-session',
    name: 'Test Session',
    permissionMode: 'execute',
    createdAt: Date.now(),
    isActive: true,
    ...overrides,
  };
}

function createBaseContext(sessionId: string): SessionToolContext {
  return createSessionToolContext({
    sessionId,
    workspacePath: '/tmp/test-workspace',
    workspaceId: 'test-ws',
    onPlanSubmitted: noop,
    onAuthRequest: noop,
  });
}

describe('session query bindings', () => {
  const sessionId = 'test-session-query-bindings';

  beforeEach(() => unregisterSessionScopedToolCallbacks(sessionId));

  it('exposes only registered query callbacks', () => {
    const context = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(context, sessionId);

    expect(context.getSessionInfo).toBeUndefined();
    expect(context.listSessions).toBeUndefined();

    registerSessionScopedToolCallbacks(sessionId, {
      getSessionInfoFn: id => makeSessionInfo({ id: id ?? sessionId }),
      listSessionsFn: () => ({ total: 1, returned: 1, sessions: [] }),
    });

    expect(context.getSessionInfo!()!.id).toBe(sessionId);
    expect(context.listSessions!().total).toBe(1);
  });

  it('uses current callbacks after a late replacement', () => {
    const context = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(context, sessionId);
    registerSessionScopedToolCallbacks(sessionId, {
      listSessionsFn: () => ({ total: 1, returned: 1, sessions: [] }),
    });
    expect(context.listSessions!().total).toBe(1);

    mergeSessionScopedToolCallbacks(sessionId, {
      listSessionsFn: () => ({ total: 2, returned: 2, sessions: [] }),
    });
    expect(context.listSessions!().total).toBe(2);
  });

  it('passes explicit session IDs through and defaults omitted IDs', () => {
    const context = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(context, sessionId);
    const received: string[] = [];
    registerSessionScopedToolCallbacks(sessionId, {
      getSessionInfoFn: id => {
        received.push(id ?? 'missing');
        return makeSessionInfo({ id: id ?? sessionId });
      },
    });

    context.getSessionInfo!();
    context.getSessionInfo!('other-session');
    expect(received).toEqual([sessionId, 'other-session']);
  });

  it('does not register retired organization tools', () => {
    expect(SESSION_TOOL_REGISTRY.has('set_session_labels')).toBe(false);
    expect(SESSION_TOOL_REGISTRY.has('set_session_status')).toBe(false);
  });

  it('returns availability errors when query callbacks are absent', async () => {
    const context = createBaseContext(sessionId);
    attachSessionSelfManagementBindings(context, sessionId);
    for (const name of ['get_session_info', 'list_sessions'] as const) {
      const result = await SESSION_TOOL_REGISTRY.get(name)!.handler!(context, {});
      expect(result.isError).toBe(true);
      expect((result.content[0] as TextContent).text).toContain('not available in this context');
    }
  });
});
