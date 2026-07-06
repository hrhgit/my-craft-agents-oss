import { describe, it, expect, beforeEach } from 'bun:test';
import type { SpawnSessionRequest, SpawnSessionResult } from '../base-agent.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

// Expose the protected preExecuteSpawnSession for direct invocation.
class SpawnTestAgent extends TestAgent {
  public invokeSpawn(input: Record<string, unknown>) {
    return this.preExecuteSpawnSession(input);
  }
}

function setup() {
  const agent = new SpawnTestAgent(createMockBackendConfig());
  const captured: SpawnSessionRequest[] = [];
  agent.onSpawnSession = async (request) => {
    captured.push(request);
    const result: SpawnSessionResult = {
      sessionId: 'spawned-id',
      name: 'spawned',
      status: 'started',
    };
    return result;
  };
  return { agent, captured };
}

describe('preExecuteSpawnSession workingDirectory compatibility', () => {
  let agent: SpawnTestAgent;
  let captured: SpawnSessionRequest[];

  beforeEach(() => {
    ({ agent, captured } = setup());
  });

  it('ignores deprecated workingDirectory overrides', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '~' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.workingDirectory).toBeUndefined();
  });

  it('passes through undefined when workingDirectory is omitted', async () => {
    await agent.invokeSpawn({ prompt: 'hi' });
    expect(captured[0]?.workingDirectory).toBeUndefined();
  });

  it('treats empty string as undefined', async () => {
    await agent.invokeSpawn({ prompt: 'hi', workingDirectory: '' });
    expect(captured[0]?.workingDirectory).toBeUndefined();
  });
});
