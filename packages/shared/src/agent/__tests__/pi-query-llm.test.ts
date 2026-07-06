/**
 * PiAgent.queryLlm contract under the public Pi RpcClient backend.
 *
 * The deleted pi-agent-server bridge exposed a Craft-private llm_query RPC.
 * PiAgent now delegates to Pi's public RpcClient typed API.
 */
import { describe, expect, it, mock } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as any,
    session: {
      craftId: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/craft-agent-test',
    } as any,
    isHeadless: true,
    ...overrides,
  };
}

describe('PiAgent.queryLlm with RpcClient', () => {
  it('delegates queryLlm to Pi RpcClient and maps usage', async () => {
    const agent = new PiAgent(createConfig());
    const queryLlm = mock(async () => ({
      text: 'hello from pi',
      model: 'gpt-test',
      provider: 'openai',
      usage: { input: 3, output: 4 },
      stopReason: 'stop',
    }));
    (agent as any).rpcClient = { queryLlm, stop: mock(async () => undefined) };
    (agent as any).rpcClientReady = Promise.resolve();

    const result = await agent.queryLlm({ prompt: 'hi' });

    expect(queryLlm).toHaveBeenCalledWith({ prompt: 'hi' });
    expect(result).toEqual({
      text: 'hello from pi',
      model: 'gpt-test',
      inputTokens: 3,
      outputTokens: 4,
      warning: undefined,
    });

    agent.destroy();
  });

  it('delegates runMiniCompletion to Pi RpcClient', async () => {
    const agent = new PiAgent(createConfig());
    const runMiniCompletion = mock(async () => 'short title');
    (agent as any).rpcClient = { runMiniCompletion, stop: mock(async () => undefined) };
    (agent as any).rpcClientReady = Promise.resolve();

    await expect(agent.runMiniCompletion('summarize')).resolves.toBe('short title');
    expect(runMiniCompletion).toHaveBeenCalledWith('summarize');

    agent.destroy();
  });
});
