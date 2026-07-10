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

  it('uses the ensured local RpcClient for chat prompt even if lifecycle cleanup clears the field', async () => {
    const agent = new PiAgent(createConfig());
    const prompt = mock(async () => {
      throw new Error('Agent process exited (code=1 signal=null). Stderr: boom');
    });
    const fakeClient = {
      prompt,
      stop: mock(async () => undefined),
      getStderr: () => 'boom',
    };
    (agent as any).ensureRpcClient = async () => {
      (agent as any).rpcClient = null;
      return fakeClient;
    };

    const events: unknown[] = [];
    for await (const event of agent.chat('hello')) {
      events.push(event);
    }

    expect(prompt).toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'typed_error',
      error: expect.objectContaining({
        title: 'Pi Process Exited',
      }),
    }));

    agent.destroy();
  });

  it('does not let stale failed ready waiters clear a replacement RpcClient', async () => {
    const agent = new PiAgent(createConfig());
    const staleClient = { stop: mock(async () => undefined) };
    const replacementClient = { stop: mock(async () => undefined) };
    const staleReady = Promise.reject(new Error('stale startup failed'));
    void staleReady.catch(() => undefined);
    const replacementReady = Promise.resolve();
    let starts = 0;

    (agent as any).rpcClient = staleClient;
    (agent as any).rpcClientReady = staleReady;
    (agent as any).startRpcClient = mock(async () => {
      starts += 1;
      (agent as any).rpcClient = replacementClient;
      (agent as any).rpcClientReady = replacementReady;
    });

    const [first, second] = await Promise.all([
      (agent as any).ensureRpcClient(),
      (agent as any).ensureRpcClient(),
    ]);

    expect(starts).toBe(1);
    expect(first).toBe(replacementClient);
    expect(second).toBe(replacementClient);
    expect((agent as any).rpcClientReady).toBe(replacementReady);

    agent.destroy();
  });

  it('rejects stalled RpcClient startup with the host-side deadline', async () => {
    const agent = new PiAgent(createConfig());
    const originalSetTimeout = globalThis.setTimeout;
    let observedDelayMs: number | undefined;
    ;(globalThis as typeof globalThis & { setTimeout: typeof setTimeout }).setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number) => {
      observedDelayMs = timeout;
      queueMicrotask(() => {
        if (typeof handler === 'function') handler();
      });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const startup = (agent as any).withRpcStartupTimeout(new Promise<void>(() => {}));
      await expect(startup).rejects.toThrow('Pi RpcClient startup timed out after 15000ms');
      expect(observedDelayMs).toBe(15_000);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      agent.destroy();
    }
  });
});
