import { describe, expect, it } from 'bun:test';
import type { Message, StoredMessage } from '../src/types/message.ts';
import { messageToStored, storedToMessage } from '../src/types/message-mapper.ts';

const artifact = {
  schemaVersion: 1 as const,
  kind: 'plan' as const,
  artifactId: 'plan-1',
  revision: 1,
  state: 'ready' as const,
  review: { status: 'passed' as const, verdict: 'pass' as const },
  checklist: [],
  createdAt: 100,
};

describe('message persistence contract', () => {
  it('round-trips plans as assistant messages with a versioned artifact', () => {
    const message: Message = {
      id: 'assistant-plan',
      role: 'assistant',
      content: '# Plan',
      timestamp: 100,
      artifact,
    };

    const stored = messageToStored(message);
    expect(stored).toEqual({
      id: 'assistant-plan',
      type: 'assistant',
      content: '# Plan',
      timestamp: 100,
      artifact,
    });
    expect(storedToMessage(stored)).toEqual(message);
  });

  it('rejects the removed plan role at both runtime boundaries', () => {
    const removedRuntimeRole = {
      id: 'removed-runtime-plan',
      role: 'plan',
      content: '# Old plan',
      timestamp: 100,
    } as unknown as Message;
    const removedStoredRole = {
      id: 'removed-stored-plan',
      type: 'plan',
      content: '# Old plan',
      timestamp: 100,
    } as unknown as StoredMessage;

    expect(() => messageToStored(removedRuntimeRole)).toThrow('Stored message role "plan" was removed');
    expect(() => storedToMessage(removedStoredRole)).toThrow('Stored message role "plan" was removed');
  });
});
