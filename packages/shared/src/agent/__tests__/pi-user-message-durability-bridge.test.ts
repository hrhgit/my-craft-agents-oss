import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@mortise/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { EventQueue } from '../backend/event-queue.ts';
import { PiAgent } from '../pi-agent.ts';

function createAgent(): { agent: PiAgent; eventQueue: EventQueue } {
  const agent = new PiAgent({
    provider: 'pi',
    workspace: {
      schemaVersion: 2,
      id: 'ws-test',
      name: 'Test Workspace',
      nameSource: 'custom',
      slug: 'test-workspace',
      revision: 1,
      primaryLocationId: 'primary',
      locations: [{
        id: 'primary',
        name: 'Primary',
        rootName: 'mortise-test',
        endpoint: { kind: 'local', rootPath: '/tmp/mortise-test' },
      }],
      createdAt: Date.now(),
    } as any,
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
  const eventQueue = new EventQueue();
  (agent as any).activeEventStream = { queue: eventQueue };
  return { agent, eventQueue };
}

describe('Pi user-message durability bridge', () => {
  it('queues the persisted marker before logical completion', () => {
    const { agent, eventQueue } = createAgent();

    try {
      (agent as any).handlePiEvent({
        type: 'pi_user_message_persisted',
        clientMutationId: 'mutation-1',
        entryId: 'entry-1',
        sessionFile: '/tmp/mortise-test/session.jsonl',
      });
      (agent as any).handlePiEvent({ type: 'agent_settled' });

      expect(((eventQueue as any).queue as AgentEvent[]).map(event => event.type)).toEqual([
        'pi_user_message_persisted',
        'complete',
      ]);
      expect(eventQueue.isComplete).toBe(true);
    } finally {
      agent.destroy();
    }
  });

  it('does not suppress the persisted marker while discarding late aborted content', () => {
    const { agent, eventQueue } = createAgent();

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

      expect(((eventQueue as any).queue as AgentEvent[]).map(event => event.type)).toEqual([
        'pi_user_message_persisted',
        'complete',
      ]);
    } finally {
      agent.destroy();
    }
  });
});
