import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@mortise/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { PiAgent } from '../pi-agent.ts';

function createAgent(): PiAgent {
  const agent = new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/mortise-test' } as any,
    session: {
      id: 'session-test',
      mortiseId: 'session-test',
      workspaceRootPath: '/tmp/mortise-test',
      createdAt: 0,
      lastUsedAt: 0,
    } as any,
    isHeadless: true,
  } satisfies BackendConfig);
  (agent as any).rpcClient = { runtimeId: 'runtime-test' };
  (agent as any).eventQueue.reset();
  return agent;
}

function queuedEvents(agent: PiAgent): AgentEvent[] {
  return (agent as any).eventQueue.queue as AgentEvent[];
}

describe('Pi user-message durability bridge', () => {
  it('queues the persisted marker before logical completion', () => {
    const agent = createAgent();

    try {
      (agent as any).handlePiEvent({
        type: 'pi_user_message_persisted',
        clientMutationId: 'mutation-1',
        entryId: 'entry-1',
        sessionFile: '/tmp/mortise-test/session.jsonl',
      });
      (agent as any).handlePiEvent({ type: 'agent_settled' });

      expect(queuedEvents(agent).map(event => event.type)).toEqual([
        'pi_user_message_persisted',
        'complete',
      ]);
      expect((agent as any).eventQueue.isComplete).toBe(true);
    } finally {
      agent.destroy();
    }
  });

  it('does not suppress the persisted marker while discarding late aborted content', () => {
    const agent = createAgent();

    try {
      (agent as any).suppressAbortedTurnEvents = true;
      (agent as any).handlePiEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'late text' },
      });
      (agent as any).handlePiEvent({
        type: 'pi_user_message_persisted',
        clientMutationId: 'mutation-aborted',
        entryId: 'entry-aborted',
        sessionFile: '/tmp/mortise-test/session.jsonl',
      });
      (agent as any).handlePiEvent({ type: 'agent_settled' });

      expect(queuedEvents(agent).map(event => event.type)).toEqual([
        'pi_user_message_persisted',
        'complete',
      ]);
    } finally {
      agent.destroy();
    }
  });
});
