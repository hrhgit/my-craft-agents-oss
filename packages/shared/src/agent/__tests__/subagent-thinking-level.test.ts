/**
 * Verifies that `subagent` forwards `thinkingLevel` through the
 * `SubagentRequest` object to the current parent Session adapter.
 *
 * Pairs with the corresponding fix in SessionManager.createSession that
 * reads `options?.thinkingLevel` as the first-precedence source before the
 * global default. Without that fix, this field
 * on the request would be silently dropped.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { THINKING_LEVEL_IDS } from '../thinking-levels.ts';
import type { SubagentRequest, SubagentTask } from '../base-agent.ts';
import { TestAgent, createMockBackendConfig } from './test-utils.ts';

class SubagentTestAgent extends TestAgent {
  public invokeSpawn(input: Record<string, unknown>) {
    return this.preExecuteSubagent(input);
  }
}

function setup() {
  const agent = new SubagentTestAgent(createMockBackendConfig());
  const captured: SubagentRequest[] = [];
  agent.onSubagent = async (request) => {
    captured.push(request);
    const result: SubagentTask = {
      taskId: 'spawned-id',
      status: 'running',
    };
    return result;
  };
  return { agent, captured };
}

describe('subagent thinkingLevel forwarding', () => {
  let agent: SubagentTestAgent;
  let captured: SubagentRequest[];

  beforeEach(() => {
    ({ agent, captured } = setup());
  });

  it('forwards an explicit thinkingLevel to onSubagent', async () => {
    await agent.invokeSpawn({ prompt: 'hi', thinkingLevel: 'high' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.thinkingLevel).toBe('high');
  });

  it('forwards each valid thinking level unchanged', async () => {
    const levels = [...THINKING_LEVEL_IDS];
    for (const level of levels) {
      const { agent: a, captured: c } = setup();
      await a.invokeSpawn({ prompt: 'hi', thinkingLevel: level });
      expect(c[0]?.thinkingLevel).toBe(level);
    }
  });

  it('passes through undefined when thinkingLevel is omitted', async () => {
    await agent.invokeSpawn({ prompt: 'hi' });
    expect(captured[0]?.thinkingLevel).toBeUndefined();
  });

  it('does not drop thinkingLevel when other optional fields are also set', async () => {
    await agent.invokeSpawn({
      prompt: 'hi',
      thinkingLevel: 'xhigh',
      model: 'claude-opus-4-7',
    });
    expect(captured[0]?.thinkingLevel).toBe('xhigh');
    expect(captured[0]?.model).toBe('claude-opus-4-7');
  });
});
