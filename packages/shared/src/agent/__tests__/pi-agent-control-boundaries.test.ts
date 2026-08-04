import { describe, expect, it, mock } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    runtime: { piAuthProvider: 'anthropic' },
    workspace: {
      schemaVersion: 2,
      id: 'ws-control-boundaries',
      revision: 0,
      primaryLocationId: 'primary',
      locations: [{
        id: 'primary',
        name: 'Primary',
        rootName: 'mortise-control-boundaries',
        endpoint: { kind: 'local', rootPath: '/tmp/mortise-control-boundaries' },
      }],
      name: 'Control Boundaries',
      nameSource: 'custom',
      slug: 'control-boundaries',
      createdAt: Date.now(),
    } as BackendConfig['workspace'],
    session: {
      mortiseId: 'session-control-boundaries',
      workspaceRootPath: '/tmp/mortise-control-boundaries',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as NonNullable<BackendConfig['session']>,
    isHeadless: true,
  };
}

describe('PiAgent control boundaries', () => {
  it('sends a plain user turn to Pi without prepended runtime context', async () => {
    const agent = new PiAgent(createConfig());
    const internals = agent as any;
    const prompt = mock(async () => {
      internals.eventQueue.enqueue({ type: 'complete' });
      internals.eventQueue.complete();
    });
    internals.ensureRpcClient = async () => ({ prompt });

    for await (const _event of internals.chatImpl('  exact user text  ')) {
      // Drain the mocked completion event.
    }

    expect(prompt).toHaveBeenCalledWith(
      '  exact user text  ',
      undefined,
      expect.objectContaining({ appendSystemPrompt: '' }),
    );
    agent.destroy();
  });

  it('does not accept a steer until Pi acknowledges it', async () => {
    const agent = new PiAgent(createConfig());
    const steer = mock(async () => {
      throw new Error('steer rejected');
    });
    const internals = agent as any;
    internals._isProcessing = true;
    internals.eventQueue.reset();
    internals.rpcClient = { steer };

    await expect(agent.redirect('new direction', 'mutation-1')).resolves.toBe(false);
    expect(steer).toHaveBeenCalledWith('new direction', undefined, { clientMutationId: 'mutation-1' });
    expect(internals.eventQueue.isComplete).toBe(false);

    internals.rpcClient = null;
    agent.destroy();
  });

  it('reports model controls without terminating an active message stream', async () => {
    const agent = new PiAgent(createConfig());
    const setModel = mock(async () => {
      throw new Error('model rejected');
    });
    const setThinkingLevel = mock(async () => {
      throw new Error('thinking level rejected');
    });
    const internals = agent as any;
    internals._isProcessing = true;
    internals.eventQueue.reset();
    internals.rpcClient = { setModel, setThinkingLevel };

    agent.setModel('test-model');
    agent.setThinkingLevel('high');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(setModel).toHaveBeenCalledWith('anthropic', 'test-model');
    expect(setThinkingLevel).toHaveBeenCalledWith('high');
    expect(internals.eventQueue.isComplete).toBe(false);
    expect(internals.eventQueue.queue).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining('model rejected') }),
      expect.objectContaining({ type: 'error', message: expect.stringContaining('thinking level rejected') }),
    ]);

    internals.rpcClient = null;
    agent.destroy();
  });
});
